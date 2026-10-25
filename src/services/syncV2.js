/**
 * Offline-first sync, v2 (owner's design doc "Satpuda Core: Offline-First Server Design",
 * 7 Oct 2026). The PC and the phone are the truth for what they recorded; the server only
 * adds every device's records together.
 *
 *   register      a device gets a small device_no; the ids it makes itself start at
 *                 device_no * LEGACY_ID_LIMIT, so two offline devices never make the same id.
 *   number-block  the next N bill / purchase numbers of a financial year, reserved for one
 *                 device so it can print them offline.
 *   push          the device's saves as events numbered 1, 2, 3 ... Each is applied with the
 *                 same rules as /bundle and kept for ever in device_events, whatever happens
 *                 to it: applied, flagged (kept, and shown to the owner) or quarantined (could
 *                 not be applied; kept whole for repair). Events must arrive in order: a gap
 *                 is answered with missing_from and nothing after it is taken, so the device
 *                 resends; a device keeps every event until the server's last_seq covers it.
 *   status        what the server holds from this device, for the "sent / held" line on screen.
 *
 * Pull is unchanged: GET /api/sync/changes/full.
 */
import { query, withTransaction } from '../db/pool.js';
import { AppError } from '../utils/http.js';
import {
  COLLECTIONS,
  LEGACY_ID_LIMIT,
  applyBundleInTx,
  emitSyncHint,
  fetchDocsByLocalIds,
  lockStorePush,
  billSerialColumns,
  reserveNumberBlockInTx,
} from './syncService.js';
import { ensureStoreSyncState, newSyncHint } from './syncRevision.js';
import { assertDeviceSawWipe, storeWipeState } from './storeWipe.js';
import {
  RETURN_COLLECTIONS,
  duplicateSupplierBill,
  fixOps,
  parseBaseLines,
  replacedSaleFix,
  returnRules,
} from './clashRules.js';

/** device_no * 1e9 stays an exact integer in JavaScript and Kotlin up to here (9e12 < 2^53). */
export const MAX_DEVICE_NO = 9000;
export const MAX_EVENTS_PER_PUSH = 200;

const INSTALL_RX = /^[A-Za-z0-9._:-]{8,128}$/;
const OPS = new Set(['upsert', 'delete', 'stock']);
const SINGLETONS = new Set(['pharmacy_profile', 'dropdowns', 'shelf_settings', 'settings']);
const DOC_COLLECTIONS = new Set(COLLECTIONS.filter((c) => c !== 'stock_operations'));

let _spSeq = 0;

function cleanInstallId(raw) {
  const s = String(raw ?? '').trim();
  if (!INSTALL_RX.test(s)) throw new AppError(400, 'install_id required (8-128 letters, digits, . _ : -)');
  return s;
}

function cleanText(raw, max) {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function devicePayload(row) {
  const no = Number(row.device_no);
  return {
    device_no: no,
    id_base: no * LEGACY_ID_LIMIT,
    id_max: (no + 1) * LEGACY_ID_LIMIT - 1,
    last_seq: Number(row.last_seq || 0),
  };
}

async function deviceRow(storePk, installId) {
  const { rows } = await query(
    `SELECT * FROM sync_devices WHERE store_pk=$1 AND install_id=$2`,
    [storePk, cleanInstallId(installId)],
  );
  if (!rows[0]) throw new AppError(404, 'This device is not registered for sync v2 yet', { code: 'not_registered' });
  return rows[0];
}

export async function registerDevice(storePk, { installId, deviceType, deviceName, appVersion } = {}) {
  const id = cleanInstallId(installId);
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(4243, $1::int)`, [Number(storePk)]);
    const { rows } = await client.query(
      `SELECT * FROM sync_devices WHERE store_pk=$1 AND install_id=$2`, [storePk, id],
    );
    let row = rows[0];
    if (!row) {
      const { rows: mx } = await client.query(
        `SELECT COALESCE(MAX(device_no), 0) AS m FROM sync_devices WHERE store_pk=$1`, [storePk],
      );
      const no = Number(mx[0]?.m || 0) + 1;
      if (no > MAX_DEVICE_NO) throw new AppError(409, 'Too many devices registered for this store');
      ({ rows: [row] } = await client.query(
        `INSERT INTO sync_devices (store_pk, install_id, device_no, device_type, device_name, app_version, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING *`,
        [storePk, id, no, cleanText(deviceType, 16), cleanText(deviceName, 64), cleanText(appVersion, 32)],
      ));
    } else {
      ({ rows: [row] } = await client.query(
        `UPDATE sync_devices
            SET device_type=COALESCE($2, device_type), device_name=COALESCE($3, device_name),
                app_version=COALESCE($4, app_version), last_seen_at=NOW()
          WHERE id=$1 RETURNING *`,
        [row.id, cleanText(deviceType, 16), cleanText(deviceName, 64), cleanText(appVersion, 32)],
      ));
    }
    const wipe = await storeWipeState(storePk, client);
    return { ...devicePayload(row), ...(await deviceFloors(client, storePk, Number(row.device_no))), ...wipe };
  });
}

/** What this device already used: the highest id it made per collection, and the highest of
 *  its own document numbers (SR3-17 ...). A reinstalled device carries on after them instead
 *  of starting again at 1 and colliding with its own earlier records. */
const DOC_NUMBER_COLUMNS = [
  ['SR', 'sales_returns', 'return_no'],
  ['PR', 'purchase_returns', 'return_no'],
  ['PAY', 'supplier_payments', 'payment_no'],
  ['SD', 'stock_disposals', 'disposal_no'],
  ['RO', 'pending_orders', 'order_no'],
];
export async function deviceFloors(client, storePk, deviceNo) {
  const lo = deviceNo * LEGACY_ID_LIMIT;
  const hi = (deviceNo + 1) * LEGACY_ID_LIMIT - 1;
  const idFloor = {};
  for (const col of DOC_COLLECTIONS) {
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(local_id), 0)::bigint AS m FROM ${col}
        WHERE store_pk=$1 AND local_id BETWEEN $2 AND $3`,
      [storePk, lo, hi],
    );
    const m = Number(rows[0]?.m || 0);
    if (m) idFloor[col] = m;
  }
  const docFloor = {};
  for (const [prefix, table, column] of DOC_NUMBER_COLUMNS) {
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(NULLIF(substring(${column} from $2), '')::bigint), 0) AS m
         FROM ${table} WHERE store_pk=$1 AND ${column} LIKE $3`,
      [storePk, `^${prefix}${deviceNo}-([0-9]+)$`, `${prefix}${deviceNo}-%`],
    );
    const m = Number(rows[0]?.m || 0);
    if (m) docFloor[prefix] = m;
  }
  // Number blocks this device still has numbers left in (current and last year): a
  // reinstalled device, or one switched on again, carries on in them instead of leaving a
  // gap of up to a whole block in the shop's bill book. "Used" counts deleted bills too, so
  // a number is never handed out twice.
  const openBlocks = [];
  const { rows: blocks } = await client.query(
    `SELECT kind, fy_start_year, from_serial, to_serial FROM number_blocks
      WHERE store_pk=$1 AND device_no=$2
        AND fy_start_year >= EXTRACT(YEAR FROM NOW() - INTERVAL '3 months')::int - 1
      ORDER BY kind, fy_start_year, from_serial`,
    [storePk, deviceNo],
  );
  for (const b of blocks) {
    const fy = Number(b.fy_start_year);
    const { ranges: [used] } = await takenNumbers(
      client, storePk, b.kind, fy, [[Number(b.from_serial), Number(b.to_serial)]],
    );
    if (used < Number(b.to_serial)) {
      openBlocks.push({
        kind: b.kind, fy_start_year: fy,
        from_serial: Number(b.from_serial), to_serial: Number(b.to_serial),
        next_serial: Math.max(Number(b.from_serial), used + 1),
      });
    }
  }
  return { id_floor: idFloor, doc_floor: docFloor, open_blocks: openBlocks };
}

/**
 * The numbers a store already holds in one financial year's bill (or purchase) book: `head`,
 * the highest number any bill of the year holds (imported ones too), and for each [from, to]
 * the highest number held inside it (0 when none). Every row counts -- deleted and draft bills
 * too, read from the code or from fy_serial -- so a number reported free is free.
 */
export async function takenNumbers(client, storePk, kind, fy, ranges = []) {
  const k = kind === 'sales' ? 'sales' : 'purchases';
  const dateCol = k === 'sales' ? 'bill_date' : 'purchase_date';
  const params = [storePk, Number(fy), `${fy}-04-01`, `${Number(fy) + 1}-03-31`];
  const cols = ranges.map(([lo, hi], i) => {
    params.push(Number(lo), Number(hi));
    const p = `$${params.length - 1} AND $${params.length}`;
    return `GREATEST(COALESCE(MAX(a) FILTER (WHERE a BETWEEN ${p}), 0),
                     COALESCE(MAX(b) FILTER (WHERE b BETWEEN ${p}), 0)) AS r${i}`;
  });
  const { rows } = await client.query(
    `SELECT GREATEST(COALESCE(MAX(a), 0), COALESCE(MAX(b), 0)) AS head${cols.map((c) => `,
            ${c}`).join('')}
       FROM (SELECT ${billSerialColumns(k)} FROM ${k}
              WHERE store_pk=$1 AND (fy_start_year = $2 OR (${dateCol} >= $3 AND ${dateCol} <= $4))) s`,
    params,
  );
  const row = rows[0] || {};
  return { head: Number(row.head || 0), ranges: ranges.map((_, i) => Number(row[`r${i}`] || 0)) };
}

const MAX_HEAD_RANGES = 10;

/** "51-200,301-500" -> [[51, 200], [301, 500]]; anything else is refused. */
function parseRanges(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const out = s.split(',').map((part) => {
    const m = part.trim().match(/^(\d{1,9})-(\d{1,9})$/);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) {
      throw new AppError(400, 'ranges must look like 51-200,301-500');
    }
    return [Number(m[1]), Number(m[2])];
  });
  if (out.length > MAX_HEAD_RANGES) throw new AppError(400, `at most ${MAX_HEAD_RANGES} ranges per kind`);
  return out;
}

/**
 * GET /number-head: can a device still print the numbers left in its blocks? It sends the part
 * of each block it has not printed yet (sales=51-200&purchases=11-50); `taken` above 0 means
 * some other bill already holds a number in there (a data import, a restored backup), so the
 * device drops that block and reserves a fresh one, which starts after every number issued.
 * `head` is the highest number of the year on the server. Read-only.
 */
export async function numberHead(storePk, { fyStartYear, sales, purchases } = {}) {
  const fy = Number(fyStartYear);
  if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) throw new AppError(400, 'fy required (e.g. 2026)');
  const out = { fy_start_year: fy };
  const asked = { sales: parseRanges(sales), purchases: parseRanges(purchases) };
  for (const kind of ['sales', 'purchases']) {
    const r = await takenNumbers({ query }, storePk, kind, fy, asked[kind]);
    out[kind] = {
      head: r.head,
      ranges: asked[kind].map(([lo, hi], i) => ({ from: lo, to: hi, taken: r.ranges[i] })),
    };
  }
  return out;
}

export async function reserveNumberBlock(storePk, { installId, kind, fyStartYear, size } = {}) {
  const dev = await deviceRow(storePk, installId);
  if (!['sales', 'purchases'].includes(kind)) throw new AppError(400, 'kind must be sales|purchases');
  return withTransaction((client) => reserveNumberBlockInTx(client, storePk, {
    kind, fyStartYear, deviceNo: dev.device_no, size,
  }));
}

function normalizeEvent(raw) {
  const ev = raw && typeof raw === 'object' ? raw : {};
  const seq = Number(ev.seq);
  if (!Number.isInteger(seq) || seq <= 0) throw new AppError(400, 'every event needs seq 1, 2, 3 ...');
  const uuid = String(ev.event_uuid || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(uuid)) throw new AppError(400, `event ${seq}: event_uuid required`);
  const op = String(ev.op || 'upsert');
  if (!OPS.has(op)) throw new AppError(400, `event ${seq}: op must be upsert|delete|stock`);
  const collection = op === 'stock' ? 'stock_operations' : String(ev.collection || '');
  if (op !== 'stock' && !DOC_COLLECTIONS.has(collection) && !SINGLETONS.has(collection)) {
    throw new AppError(400, `event ${seq}: unknown collection ${collection}`);
  }
  const doc = ev.doc && typeof ev.doc === 'object' ? ev.doc : null;
  const stockOps = Array.isArray(ev.stock_ops) ? ev.stock_ops : [];
  if (op !== 'stock' && !doc) throw new AppError(400, `event ${seq}: doc required`);
  if (op === 'stock' && !stockOps.length) throw new AppError(400, `event ${seq}: stock_ops required`);
  const localId = doc ? Number(doc.id ?? doc.local_id ?? 0) : null;
  return {
    seq,
    event_uuid: uuid,
    op,
    collection,
    doc,
    stock_ops: stockOps,
    local_id: Number.isFinite(localId) ? localId : null,
    base_version: Number.isFinite(Number(ev.base_version)) ? Number(ev.base_version) : null,
    // Optional (newer devices): the bill's lines as the device saw them before its change,
    // [[medicine_id, qty], ...]. Lets the server put stock straight on a clash (clashRules.js).
    base_lines: parseBaseLines(ev.base_lines),
    device_time: ev.device_time || null,
    raw: ev,
  };
}

function resultOf(summary, collection) {
  const part = summary?.[collection];
  if (!part) return null;
  if (Array.isArray(part.results) && part.results.length) return part.results[0];
  return part;
}

async function storedRow(client, storePk, collection, localId) {
  if (!DOC_COLLECTIONS.has(collection) || !Number.isFinite(localId) || localId <= 0) return null;
  const { rows } = await client.query(
    `SELECT version, device_id, to_jsonb(t) AS doc FROM ${collection} t WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId],
  );
  return rows[0] || null;
}

/** Apply one event inside the push transaction. Never throws for a bad event: the event is
 *  rolled back to its savepoint and answered as quarantined, so the rest still lands. */
async function applyEvent(client, storePk, device, ev, hint, deleteBase) {
  const flags = [];
  let replaced = null;
  let bundle;
  let fix = [];          // server stock operations that put a clash straight (clashRules.js)
  let keptDeleted = false;
  if (ev.op === 'stock') {
    bundle = { stock_operations: ev.stock_ops.map((o) => ({ ...o, device_id: o.device_id || device.install_id })) };
  } else if (SINGLETONS.has(ev.collection)) {
    bundle = { [ev.collection]: ev.collection === 'settings' ? [].concat(ev.doc.settings || ev.doc) : ev.doc };
  } else {
    let doc = { ...ev.doc };
    if (ev.op === 'delete') {
      if (!deleteBase) {
        return { outcome: 'flagged', flag_code: 'delete_missing', flag_detail: 'nothing on the server to delete' };
      }
      // The stored copy names whoever wrote it last; the delete is THIS device's write.
      doc = { ...deleteBase, ...doc, deleted: true, device_id: doc.device_id || device.install_id };
    }
    const localId = ev.local_id;
    if (!Number.isFinite(localId) || localId <= 0) {
      return { outcome: 'quarantined', flag_code: 'no_id', flag_detail: 'document has no id' };
    }
    const stored = await storedRow(client, storePk, ev.collection, localId);
    const base = ev.base_version ?? 0;
    let concurrent = false;
    if (stored) {
      const sv = Number(stored.version || 0);
      // A clash is ANOTHER device's change this device had not seen. The server's own
      // bookkeeping (the dues cascade re-stamps a bill's version) leaves device_id alone,
      // so a version that moved under this device's own last write is not a clash.
      const lastWriter = String(stored.device_id || '');
      if (sv > base && lastWriter !== device.install_id) {
        concurrent = true;
        // Someone else changed it since this device last saw it. Both edits are facts: this
        // one is applied (the later one wins), the replaced copy is kept here, the owner is told.
        flags.push(['concurrent_edit', `server had version ${sv}, the device edited version ${base}`]);
        replaced = stored.doc;
      }
      doc.version = Math.max(Number(doc.version) || 0, sv + 1);
    } else {
      doc.version = Math.max(1, Number(doc.version) || 1);
      const own = localId >= device.id_base && localId <= device.id_max;
      if (localId >= LEGACY_ID_LIMIT && !own) {
        flags.push(['foreign_id', `new ${ev.collection}/${localId} is outside this device's id range`]);
      }
    }
    const ref = { eventUuid: ev.event_uuid, refCollection: ev.collection, refId: localId, deviceId: device.install_id };
    if (ev.collection === 'sales' && replaced && ev.base_lines) {
      // Two edits of one bill: this one wins, and the stock the replaced copy moved since the
      // lines this device edited from goes back.
      fix = fixOps(await replacedSaleFix(client, stored.doc, ev.base_lines), { ...ref, tag: 'clash' });
      if (fix.length) {
        const c = flags.find((f) => f[0] === 'concurrent_edit');
        if (c) c[1] += `; the replaced copy's stock was put back (${fix.map((o) => `medicine ${o.medicine_id} ${o.qty_delta > 0 ? '+' : ''}${o.qty_delta}`).join(', ')})`;
      }
    } else if (ev.op === 'upsert' && RETURN_COLLECTIONS.has(ev.collection)) {
      const rr = await returnRules(client, {
        storePk, collection: ev.collection, doc, localId,
        stored: stored ? stored.doc : null, concurrent, base: ev.base_lines,
      });
      flags.push(...rr.flags);
      if (rr.keepDeleted) {
        keptDeleted = true;
        doc.deleted = true;
        fix = fixOps(rr.fix, { ...ref, tag: 'deleted' });
      }
    } else if (ev.op === 'upsert' && ev.collection === 'purchases') {
      const dup = await duplicateSupplierBill(client, { storePk, doc, localId, stored: stored ? stored.doc : null });
      if (dup) flags.push(dup);
    }
    if (ev.collection === 'medicines') {
      // Stock moves only through ledger lines (stock events), never through the figure a
      // device happens to hold: that figure already includes its own unsent movements.
      doc.stock_qty = stored ? Number(stored.doc?.stock_qty || 0) : 0;
      delete doc.stock_ops;
      delete doc.stockOps;
    }
    doc.updated_at = new Date().toISOString();
    doc.device_id = doc.device_id || device.install_id;
    bundle = { [ev.collection]: [doc] };
    if (ev.stock_ops.length || fix.length) {
      bundle.stock_operations = [
        ...ev.stock_ops.map((o) => ({ ...o, device_id: o.device_id || device.install_id })),
        ...fix,
      ];
    }
  }

  const sp = `v2ev_${++_spSeq}`;
  await client.query(`SAVEPOINT ${sp}`);
  let summary;
  try {
    summary = await applyBundleInTx(client, storePk, bundle, hint);
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return { outcome: 'quarantined', flag_code: 'error', flag_detail: String(err.message || err).slice(0, 500) };
  }
  const main = ev.op === 'stock' ? null : resultOf(summary, ev.collection);
  if (main && main.status === 'failed') {
    // Not half an event: the stock ops that came with it go back too.
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return {
      outcome: 'quarantined',
      flag_code: main.code || 'failed',
      flag_detail: String(main.error || 'not applied').slice(0, 500),
    };
  }
  await client.query(`RELEASE SAVEPOINT ${sp}`);
  if (main && main.status === 'skipped') flags.push(['not_applied', main.reason || 'skipped by the server']);
  const stockFailed = (summary?.stock_operations?.results || []).filter((r) => r.status === 'failed');
  if (stockFailed.length) {
    flags.push(['stock_op_conflict', stockFailed.map((r) => r.error || r.reason).join('; ').slice(0, 500)]);
  }
  return {
    outcome: flags.length ? 'flagged' : 'applied',
    flag_code: flags.map((f) => f[0]).join(',') || null,
    flag_detail: flags.map((f) => f[1]).join(' | ') || null,
    replaced,
    fix,
    kept_deleted: keptDeleted,
    result: main,
  };
}

/** The parts of an event's outcome a newer device acts on (older devices ignore them):
 *  replaced -- this edit overwrote another device's copy (its version named);
 *  stock_fix -- stock the server put back with it; kept_deleted -- the record is held deleted. */
function clashAnswer(r) {
  const out = {};
  if (r.replaced) {
    out.replaced = true;
    out.replaced_version = Number(r.replaced.version || 0) || null;
  }
  if (r.fix?.length) out.stock_fix = r.fix.map((o) => ({ medicine_id: o.medicine_id, qty_delta: o.qty_delta }));
  if (r.kept_deleted) out.kept_deleted = true;
  return out;
}

export async function pushEvents(storePk, { installId, events, wipeGeneration = null } = {}) {
  const dev = await deviceRow(storePk, installId);
  const device = { ...dev, ...devicePayload(dev) };
  const list = (Array.isArray(events) ? events : []).map(normalizeEvent).sort((a, b) => a.seq - b.seq);
  if (list.length > MAX_EVENTS_PER_PUSH) list.length = MAX_EVENTS_PER_PUSH;

  // A delete needs the whole stored document (the upserts rewrite whole rows).
  const deleteBases = new Map();
  for (const ev of list) {
    if (ev.op !== 'delete' || !DOC_COLLECTIONS.has(ev.collection) || !(ev.local_id > 0)) continue;
    const [full] = await fetchDocsByLocalIds(storePk, ev.collection, [ev.local_id]);
    if (full) deleteBases.set(ev.event_uuid, full);
  }

  const hint = newSyncHint(storePk);
  const out = await withTransaction(async (client) => {
    await lockStorePush(client, storePk);
    await ensureStoreSyncState(client, storePk);
    // After "Delete all data" (storeWipe.js) an outbox made on the old records must never land.
    await assertDeviceSawWipe(client, storePk, wipeGeneration);
    const { rows } = await client.query(
      `SELECT last_seq FROM sync_devices WHERE id=$1 FOR UPDATE`, [dev.id],
    );
    let last = Number(rows[0]?.last_seq || 0);
    const results = [];
    let missingFrom = null;
    for (const ev of list) {
      if (ev.seq <= last) {
        const { rows: had } = await client.query(
          `SELECT event_uuid, outcome FROM device_events WHERE store_pk=$1 AND device_no=$2 AND seq=$3`,
          [storePk, dev.device_no, ev.seq],
        );
        if (had[0] && had[0].event_uuid === ev.event_uuid) {
          results.push({ seq: ev.seq, event_uuid: ev.event_uuid, outcome: 'duplicate', stored_outcome: had[0].outcome });
        } else {
          // The device used a number the server has already filled with another event
          // (a reset counter). Not acknowledged: the device must renumber from last_seq + 1.
          results.push({ seq: ev.seq, event_uuid: ev.event_uuid, outcome: 'seq_conflict' });
        }
        continue;
      }
      if (ev.seq > last + 1) {
        missingFrom = last + 1;
        break;
      }
      const r = await applyEvent(client, storePk, device, ev, hint, deleteBases.get(ev.event_uuid));
      const ins = await client.query(
        `INSERT INTO device_events (
           store_pk, device_no, seq, event_uuid, collection, op, local_id, base_version,
           payload, outcome, flag_code, flag_detail, replaced_doc, device_time
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (store_pk, event_uuid) DO NOTHING`,
        [
          storePk, dev.device_no, ev.seq, ev.event_uuid, ev.collection, ev.op, ev.local_id,
          ev.base_version, JSON.stringify(ev.raw), r.outcome, r.flag_code || null,
          r.flag_detail || null, r.replaced ? JSON.stringify(r.replaced) : null,
          ev.device_time ? new Date(ev.device_time) : null,
        ],
      );
      last = ev.seq;
      results.push({
        seq: ev.seq,
        event_uuid: ev.event_uuid,
        outcome: ins.rowCount ? r.outcome : 'duplicate_uuid',
        flag_code: r.flag_code || null,
        flag_detail: r.flag_detail || null,
        result: r.result || null,
        ...clashAnswer(r),
      });
    }
    await client.query(
      `UPDATE sync_devices SET last_seq=$2, last_seen_at=NOW() WHERE id=$1`, [dev.id, last],
    );
    return { last_seq: last, results, missing_from: missingFrom };
  });
  emitSyncHint(hint);
  return { ...out, revisions: hint.revisions.slice() };
}

/**
 * A save made ON the server for a device that has no outbox of its own: the web login.
 *
 * The web is online-only, so it never queues anything; but its saves must follow exactly the
 * rules every PC and phone save follows. So the store's web is one more registered device
 * (install id `web-store-<pk>`), and each web save becomes that device's next event: the same
 * applyEvent (bundle rules, stock only through stock operations, dues cascade, sync revision
 * so PCs and phones pull it) and the same device_events record kept for ever.
 *
 * `build(client, device, helpers)` runs inside the transaction, under the store's push lock,
 * and returns the events to apply in order: [{ op, collection, doc, stock_ops, base_version }].
 * helpers.nextId(collection) hands out the web device's own ids (device_no * 1e9 + n), so a
 * web bill can never take an id a PC or phone made offline.
 *
 * All or nothing: a quarantined event rolls the whole save back and the caller gets the reason.
 */
export async function applyServerSideSave(storePk, { installId, deviceType = 'web', deviceName = 'Web login', appVersion = null, build }) {
  await registerDevice(storePk, { installId, deviceType, deviceName, appVersion });
  const hint = newSyncHint(storePk);
  const out = await withTransaction(async (client) => {
    await lockStorePush(client, storePk);
    await ensureStoreSyncState(client, storePk);
    const { rows } = await client.query(
      `SELECT * FROM sync_devices WHERE store_pk=$1 AND install_id=$2 FOR UPDATE`, [storePk, installId],
    );
    const dev = rows[0];
    const device = { ...dev, ...devicePayload(dev) };
    const used = new Map();
    const nextId = async (collection) => {
      if (!DOC_COLLECTIONS.has(collection)) throw new AppError(400, `unknown collection ${collection}`);
      let cur = used.get(collection);
      if (cur == null) {
        const { rows: mx } = await client.query(
          `SELECT COALESCE(MAX(local_id), $2::bigint) AS m FROM ${collection}
            WHERE store_pk=$1 AND local_id BETWEEN $2 AND $3`,
          [storePk, device.id_base, device.id_max],
        );
        cur = Number(mx[0].m);
      }
      cur += 1;
      used.set(collection, cur);
      return cur;
    };
    const events = await build(client, device, { nextId });
    let last = Number(dev.last_seq || 0);
    const results = [];
    for (const raw of events) {
      last += 1;
      // A web edit is built over the stored row ({ ...old, ... }), which names the device that
      // wrote the bill last. Left in, applyEvent kept that device as the writer of the web's
      // change: the change log and the hint said the PC or phone made it (so that device took
      // it for its own echo), and the clash check never saw that device's later stale copy as
      // a clash. The web device is the writer of everything it saves.
      const doc = raw.doc && typeof raw.doc === 'object' && !Array.isArray(raw.doc)
        ? { ...raw.doc } : raw.doc;
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) delete doc.device_id;
      const ev = normalizeEvent({
        ...raw,
        doc,
        seq: last,
        event_uuid: raw.event_uuid || `${installId}:${last}:${Date.now().toString(36)}`,
        device_time: new Date().toISOString(),
      });
      let deleteBase = null;
      if (ev.op === 'delete' && ev.local_id > 0) {
        const { rows: cur } = await client.query(
          `SELECT local_id FROM ${ev.collection} WHERE store_pk=$1 AND local_id=$2`, [storePk, ev.local_id],
        );
        if (cur[0]) [deleteBase] = await fetchDocsByLocalIds(storePk, ev.collection, [ev.local_id]);
      }
      const r = await applyEvent(client, storePk, device, ev, hint, deleteBase);
      if (r.outcome === 'quarantined' || (r.flag_code || '').includes('not_applied')) {
        throw new AppError(409, `Not saved: ${r.flag_detail || r.flag_code || 'the server refused it'}`);
      }
      await client.query(
        `INSERT INTO device_events (
           store_pk, device_no, seq, event_uuid, collection, op, local_id, base_version,
           payload, outcome, flag_code, flag_detail, replaced_doc, device_time
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          storePk, dev.device_no, ev.seq, ev.event_uuid, ev.collection, ev.op, ev.local_id,
          ev.base_version, JSON.stringify(ev.raw), r.outcome, r.flag_code || null,
          r.flag_detail || null, r.replaced ? JSON.stringify(r.replaced) : null, new Date(),
        ],
      );
      results.push({ collection: ev.collection, local_id: ev.local_id, outcome: r.outcome, flag_code: r.flag_code || null, result: r.result || null });
    }
    await client.query(`UPDATE sync_devices SET last_seq=$2, last_seen_at=NOW() WHERE id=$1`, [dev.id, last]);
    return { results };
  });
  emitSyncHint(hint);
  return out;
}

/** What the server holds from this device: the "sent / held" proof on the device's screen. */
export async function deviceStatus(storePk, installId) {
  const dev = await deviceRow(storePk, installId);
  // Bills this device MADE (its create events), as the server holds them now -- not bills
  // whose last editor it was.
  const { rows } = await query(
    `WITH made AS (
       SELECT DISTINCT local_id FROM device_events
        WHERE store_pk=$1 AND device_no=$2 AND collection='sales' AND op='upsert'
          AND COALESCE(base_version,0)=0 AND outcome <> 'quarantined'
     )
     SELECT
       (SELECT COUNT(*)::int FROM sales s JOIN made m ON m.local_id=s.local_id
          WHERE s.store_pk=$1 AND NOT s.deleted AND NOT COALESCE(s.is_autosave,FALSE)
            AND s.bill_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS sales_today,
       (SELECT COALESCE(SUM(s.total_amount),0)::float FROM sales s JOIN made m ON m.local_id=s.local_id
          WHERE s.store_pk=$1 AND NOT s.deleted AND NOT COALESCE(s.is_autosave,FALSE)
            AND s.bill_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS sales_today_amount,
       (SELECT COUNT(*)::int FROM device_events WHERE store_pk=$1 AND device_no=$2
          AND outcome <> 'applied' AND resolved_at IS NULL) AS open_flags,
       (SELECT head_revision FROM store_sync_state WHERE store_pk=$1) AS head_revision`,
    [storePk, dev.device_no],
  );
  return { ...devicePayload(dev), ...rows[0], ...(await storeWipeState(storePk)) };
}

export async function listFlags(storePk, { open = true, limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT e.id, e.device_no, d.device_name, d.device_type, e.seq, e.collection, e.op, e.local_id,
            e.outcome, e.flag_code, e.flag_detail, e.received_at, e.resolved_at, e.resolved_note
       FROM device_events e
       LEFT JOIN sync_devices d ON d.store_pk=e.store_pk AND d.device_no=e.device_no
      WHERE e.store_pk=$1 AND e.outcome <> 'applied'
        AND ($2::boolean = FALSE OR e.resolved_at IS NULL)
      ORDER BY e.received_at DESC
      LIMIT $3`,
    [storePk, Boolean(open), Math.max(1, Math.min(1000, Number(limit) || 200))],
  );
  return rows;
}

export async function resolveFlag(storePk, id, note) {
  const { rows } = await query(
    `UPDATE device_events SET resolved_at=NOW(), resolved_note=$3
      WHERE store_pk=$1 AND id=$2 AND outcome <> 'applied' RETURNING id, resolved_at`,
    [storePk, Number(id), cleanText(note, 300)],
  );
  if (!rows[0]) throw new AppError(404, 'Flag not found');
  return rows[0];
}

/** Current stock (and hidden flag) of the given medicines, or of all of them: a device sets
 *  its local stock to this plus its own movements the server does not have yet. */
export async function stockNow(storePk, ids = null) {
  const list = Array.isArray(ids)
    ? [...new Set(ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))].slice(0, 20000)
    : null;
  const { rows } = list
    ? await query(
      `SELECT local_id, stock_qty, is_hidden, version FROM medicines
        WHERE store_pk=$1 AND local_id = ANY($2::bigint[])`,
      [storePk, list],
    )
    : await query(
      `SELECT local_id, stock_qty, is_hidden, version FROM medicines WHERE store_pk=$1`,
      [storePk],
    );
  const { rows: head } = await query(
    `SELECT head_revision FROM store_sync_state WHERE store_pk=$1`, [storePk],
  );
  return {
    head_revision: Number(head[0]?.head_revision || 0),
    stock: rows.map((r) => [Number(r.local_id), Number(r.stock_qty || 0), r.is_hidden ? 1 : 0]),
  };
}

export async function listDevices(storePk) {
  const { rows } = await query(
    `SELECT device_no, install_id, device_type, device_name, app_version, last_seq,
            last_seen_at, created_at
       FROM sync_devices WHERE store_pk=$1 ORDER BY device_no`,
    [storePk],
  );
  return rows;
}
