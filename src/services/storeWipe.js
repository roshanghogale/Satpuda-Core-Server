/**
 * "Delete all data" for ONE store: every business row of the store goes, the store stays.
 *
 * The owner's complaint (Oct 2026): Settings > Data & System > Delete all data emptied only the
 * PC it was pressed on. The server was never told, so an offline-first PC pulled everything
 * back, and every other PC and phone of the shop kept its copy.
 *
 * What goes: medicines, the stock ledger, sales, purchases, returns, payments, parties,
 * doctors, the cash register, shelves, the shop-data settings rows (a customer's regular
 * medicines, party GSTINs, GST-filed marks, doctor-margin rules), the change log, the device
 * events and the number blocks / FY counters (bill numbers start again at 1).
 *
 * What stays: the store row (licence, expiry, keys), its device pairings and sync
 * registrations, web logins, the audit log, and -- unless the caller asks for `alsoProfile` --
 * the shop profile (name, address, GSTIN, bill heading, bank, pictures, dropdowns).
 *
 * How every device learns of it: store_sync_state.wipe_generation goes up by one and
 * wipe_revision records the head revision at the wipe. /sync/status, /sync/changes(/full) and
 * /sync/v2/register carry both; a device that holds an older generation clears its own copy of
 * the store (keeping its pairing) and pulls again from wipe_revision. /sync/v2/push refuses a
 * device that has not caught up, so an outbox made before the wipe can never bring the old
 * records back.
 *
 * Safety, the same way storeDelete.js does it: the export is written (gzip JSON, 0600,
 * fsynced) BEFORE anything is deleted, inside the same transaction that holds the store's push
 * lock, so nothing can land between the export and the delete; the audit row goes in with the
 * delete; a failed transaction takes its export back off the disk.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { pool } from '../db/pool.js';
import { AppError } from '../utils/http.js';

const gzip = promisify(zlib.gzip);
const here = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(here, '..', '..');

/** The word typed on the PC, checked again here. */
export const WIPE_CONFIRM = 'DELETE ALL TABLES';

/**
 * Business data: every row of the store goes, after being exported. Parents first (the order a
 * restore would insert them); the delete runs the list backwards.
 *
 * Written out by hand, like storeDelete.CASCADE_TABLES: a table added next year joins a
 * destructive operation only after somebody decides it is shop data. wipeClassification()
 * compares the lists with the live schema, and the tests call it.
 */
export const WIPE_TABLES = [
  'customers',
  'suppliers',
  'doctors',
  'medicines',
  'medicines_master',           // only this store's own rows; the global catalog has store_pk NULL
  'general_products',
  'racks',
  'sections',
  'boxes',
  'shelves',
  'medicine_shelf',
  'medicine_suppliers',
  'sales',
  'sales_items',
  'purchases',
  'purchase_items',
  'customer_payments',
  'supplier_payments',
  'sales_returns',
  'sales_return_items',
  'purchase_returns',
  'purchase_return_items',
  'stock_disposals',
  'stock_operations',
  'pending_orders',
  'cash_days',
  'cash_expenses',
  'doctor_margin_rules_history',
  'fy_serials',                 // FY counters: bill numbers start again at 1
  'number_blocks',              // the blocks devices reserved in the old numbering
  'stock_snapshots',
  'sync_check_runs',            // sync_check_items go with them (ON DELETE CASCADE, exported below)
  'device_events',              // every event carries a whole bill / medicine
  'sync_changes',
  'sync_watermarks',
];

/** The shop profile: kept unless alsoProfile. */
export const PROFILE_TABLES = ['pharmacy_profiles', 'store_dropdowns', 'shelf_settings'];

/** store_settings: these rows are shop data and always go; with alsoProfile every row goes. */
export const SHOP_DATA_SETTING_PREFIXES = ['regular_meds:', 'customer_gst:', 'gst_filed:'];
export const SHOP_DATA_SETTING_NAMES = ['doctor_margin_rules', 'doctor_margin_rules_recalc'];

/** Never touched: who the store is, which devices are paired, who may sign in, what happened. */
export const KEEP_TABLES = [
  'stores',                     // its own companion-store link (parent_store_id)
  'store_devices',
  'store_api_tokens',
  'store_provisions',
  'store_sync_state',           // updated: head + 1, wipe_generation + 1
  'sync_devices',               // device numbers / id ranges / last_seq stay, so no id is reused
  'device_sync_state',
  'web_users',
  'web_sessions',
  'web_audit',
];

/** Where wipe exports live. Override with STORE_WIPE_DIR (tests do). */
export function wipeExportDir() {
  return process.env.STORE_WIPE_DIR || path.join(APP_ROOT, 'backups', 'store-wipes');
}

function slug(name) {
  return String(name || 'store')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'store';
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function settingIsShopData(name) {
  const n = String(name || '');
  return SHOP_DATA_SETTING_NAMES.includes(n) || SHOP_DATA_SETTING_PREFIXES.some((p) => n.startsWith(p));
}

/** The wipe columns on store_sync_state (additive; also in sync_v2_schema.sql). */
export async function ensureWipeColumns(db = pool) {
  await db.query(
    `ALTER TABLE store_sync_state
       ADD COLUMN IF NOT EXISTS wipe_generation INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS wipe_revision BIGINT NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS wiped_at TIMESTAMPTZ,
       ADD COLUMN IF NOT EXISTS wipe_request_id TEXT,
       ADD COLUMN IF NOT EXISTS wipe_also_profile BOOLEAN NOT NULL DEFAULT FALSE`,
  );
}

/** { wipe_generation, wipe_revision } of a store_sync_state row (0 / 0 before any wipe, and on
 *  a server whose table has no wipe columns yet). */
export function wipeInfo(row) {
  return {
    wipe_generation: Number(row?.wipe_generation || 0),
    wipe_revision: Number(row?.wipe_revision || 0),
    wipe_also_profile: Boolean(row?.wipe_also_profile),
  };
}

/** The wipe state of a store; SELECT * so a table without the columns still answers. */
export async function storeWipeState(storePk, db = pool) {
  const { rows } = await db.query(`SELECT * FROM store_sync_state WHERE store_pk = $1`, [storePk]);
  return wipeInfo(rows[0]);
}

/**
 * Refuse a sync v2 push from a device that has not seen the latest wipe: its outbox was made on
 * the old records. Call inside the push transaction, after the store's push lock.
 */
export async function assertDeviceSawWipe(client, storePk, deviceGeneration) {
  const { rows } = await client.query(`SELECT * FROM store_sync_state WHERE store_pk = $1`, [storePk]);
  const info = wipeInfo(rows[0]);
  if (info.wipe_generation <= 0) return info;
  const seen = Number(deviceGeneration);
  if (Number.isFinite(seen) && seen >= info.wipe_generation) return info;
  throw new AppError(
    409,
    'store_wiped: all data of this store was deleted on the server. This device clears its copy and '
      + 'its unsent changes, then copies the store again.',
    { code: 'store_wiped', ...info },
  );
}

async function existingTables(db, names) {
  const { rows } = await db.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
    [names],
  );
  const have = new Set(rows.map((r) => r.name));
  return names.filter((t) => have.has(t));
}

/**
 * Every table that points at stores(id), against the lists above. Anything unlisted is LEFT
 * ALONE by the wipe (never deleted unexported) and named here, so a test fails until someone
 * classifies it.
 */
export async function wipeClassification(db = pool) {
  const { rows } = await db.query(
    `SELECT DISTINCT conrelid::regclass::text AS table_name
       FROM pg_constraint WHERE confrelid = 'stores'::regclass AND contype = 'f'`,
  );
  const known = new Set([...WIPE_TABLES, ...PROFILE_TABLES, ...KEEP_TABLES, 'store_settings']);
  const tables = rows.map((r) => String(r.table_name).replace(/^public\./, ''));
  const unclassified = tables.filter((t) => !known.has(t)).sort();
  return { ok: unclassified.length === 0, unclassified, tables: tables.sort() };
}

async function loadStore(db, storePk) {
  const { rows } = await db.query(`SELECT * FROM stores WHERE id = $1`, [storePk]);
  if (!rows[0]) throw new AppError(404, 'Store not found');
  return rows[0];
}

async function countRows(db, table, storePk) {
  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE store_pk = $1`, [storePk]);
  return Number(rows[0]?.n) || 0;
}

/** What "Delete all data" would remove from this store, and which devices it reaches. Read-only. */
export async function storeWipePreview(storePk, { alsoProfile = false } = {}, { db = pool } = {}) {
  const store = await loadStore(db, storePk);
  const tables = await existingTables(db, WIPE_TABLES);
  const counts = {};
  for (const t of tables) counts[t] = await countRows(db, t, storePk);
  const { rows: settings } = await db.query(
    `SELECT name FROM store_settings WHERE store_pk = $1`, [storePk],
  );
  counts.store_settings = settings.filter((r) => alsoProfile || settingIsShopData(r.name)).length;
  const profile = {};
  for (const t of await existingTables(db, PROFILE_TABLES)) profile[t] = await countRows(db, t, storePk);
  if (alsoProfile) Object.assign(counts, profile);
  const { rows: devices } = await db.query(
    `SELECT device_id, device_name, device_type, last_seen_at FROM store_devices
      WHERE store_pk = $1 ORDER BY last_seen_at DESC NULLS LAST`,
    [storePk],
  );
  return {
    store: { id: store.id, store_id: store.store_id, store_name: store.store_name },
    also_profile: Boolean(alsoProfile),
    counts,
    total_rows: Object.values(counts).reduce((n, v) => n + v, 0),
    profile_kept: !alsoProfile,
    devices,
    ...(await storeWipeState(storePk, db).catch(() => wipeInfo(null))),
    confirm_word: WIPE_CONFIRM,
  };
}

async function writeExport(dir, store, payload) {
  const body = await gzip(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 6 });
  // The file holds the store's keys and every customer's name and phone: owner-only.
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.promises.chmod(dir, 0o700);
  } catch { /* a directory we do not own: the 0600 file still holds */ }
  const file = path.join(
    dir,
    `${stamp()}_store${store.id}_${slug(store.store_name)}_wipe_${crypto.randomBytes(3).toString('hex')}.json.gz`,
  );
  const fh = await fs.promises.open(file, 'wx', 0o600);
  try {
    await fh.writeFile(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    const dh = await fs.promises.open(dir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* directory fsync is best-effort */ }
  return { path: file, bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };
}

/**
 * Delete every business row of one store (see the top of this file).
 *
 * @param {number} storePk                 the store, from the caller's STORE token (never a body field)
 * @param {object} opts
 * @param {string} opts.confirm            must be WIPE_CONFIRM
 * @param {boolean} [opts.alsoProfile]     also the shop profile and every settings row
 * @param {string} [opts.requestId]        the same id twice = one wipe (a retried request)
 * @param {string} [opts.expectStoreId]    the store the device thinks it is wiping; refused if not this one
 * @param {string} [opts.actorId]          for the audit row
 */
export async function wipeStoreData(storePk, {
  confirm,
  alsoProfile = false,
  requestId = null,
  expectStoreId = null,
  actorId = null,
  deviceId = null,
  exportDir: dir = wipeExportDir(),
} = {}, { db = pool } = {}) {
  if (String(confirm ?? '') !== WIPE_CONFIRM) {
    throw new AppError(400, `Type "${WIPE_CONFIRM}" exactly to delete all data of this store`);
  }
  const reqId = requestId == null ? null : String(requestId).trim().slice(0, 80) || null;
  await ensureWipeColumns(db);
  const wipeTables = await existingTables(db, WIPE_TABLES);
  const profileTables = alsoProfile ? await existingTables(db, PROFILE_TABLES) : [];
  const hasCheckItems = (await existingTables(db, ['sync_check_items'])).length > 0;

  const client = await db.connect();
  let exported = null;
  let committed = false;
  try {
    await client.query('BEGIN');
    // The push lock (every save of every device takes it) and the register lock: nothing
    // lands in this store between the export below and the delete.
    await client.query(`SELECT pg_advisory_xact_lock(4242, $1::int)`, [Number(storePk)]);
    await client.query(`SELECT pg_advisory_xact_lock(4243, $1::int)`, [Number(storePk)]);
    const { rows: locked } = await client.query(`SELECT * FROM stores WHERE id = $1 FOR UPDATE`, [storePk]);
    const store = locked[0];
    if (!store) throw new AppError(404, 'Store not found');
    if (expectStoreId != null && String(expectStoreId).trim()
        && String(expectStoreId).trim() !== String(store.store_id)) {
      throw new AppError(409, 'This device is signed in to a different store than the one it asked to wipe; nothing was deleted', {
        code: 'store_mismatch', store_id: store.store_id,
      });
    }
    await client.query(
      `INSERT INTO store_sync_state (store_pk, head_revision) VALUES ($1, 0) ON CONFLICT (store_pk) DO NOTHING`,
      [storePk],
    );
    const { rows: st } = await client.query(
      `SELECT * FROM store_sync_state WHERE store_pk = $1 FOR UPDATE`, [storePk],
    );
    const state = st[0] || {};
    if (reqId && state.wipe_request_id === reqId) {
      // The same request again (a retry after a lost answer): it was done once, not twice.
      await client.query('COMMIT');
      committed = true;
      return { wiped: true, repeated: true, store_pk: Number(storePk), ...wipeInfo(state) };
    }

    // ── the export, read through the locked transaction ─────────────────────────────────
    const tables = {};
    const counts = {};
    for (const t of wipeTables) {
      const { rows } = await client.query(`SELECT * FROM ${t} WHERE store_pk = $1`, [storePk]);
      tables[t] = rows;
      counts[t] = rows.length;
    }
    if (hasCheckItems) {
      const { rows } = await client.query(
        `SELECT i.* FROM sync_check_items i JOIN sync_check_runs r ON r.id = i.run_id WHERE r.store_pk = $1`,
        [storePk],
      );
      tables.sync_check_items = rows;
      counts.sync_check_items = rows.length;
    }
    const { rows: settingRows } = await client.query(
      `SELECT * FROM store_settings WHERE store_pk = $1`, [storePk],
    );
    const goingSettings = settingRows.filter((r) => alsoProfile || settingIsShopData(r.name));
    tables.store_settings = goingSettings;
    counts.store_settings = goingSettings.length;
    for (const t of profileTables) {
      const { rows } = await client.query(`SELECT * FROM ${t} WHERE store_pk = $1`, [storePk]);
      tables[t] = rows;
      counts[t] = rows.length;
    }
    const totalRows = Object.values(counts).reduce((n, v) => n + v, 0);
    const dbName = (await client.query('SELECT current_database() AS db')).rows[0]?.db || null;
    exported = await writeExport(dir, store, {
      format: 'satpuda-store-wipe-export',
      version: 1,
      exported_at: new Date().toISOString(),
      server_database: dbName,
      store,
      also_profile: Boolean(alsoProfile),
      counts,
      total_rows: totalRows,
      wipe_tables: wipeTables,
      profile_tables: profileTables,
      store_sync_state_before: state,
      tables,
    });

    // ── the delete (children first) ──────────────────────────────────────────────────
    for (const t of [...wipeTables].reverse()) {
      await client.query(`DELETE FROM ${t} WHERE store_pk = $1`, [storePk]);
    }
    if (alsoProfile) {
      await client.query(`DELETE FROM store_settings WHERE store_pk = $1`, [storePk]);
    } else if (goingSettings.length) {
      await client.query(
        `DELETE FROM store_settings WHERE store_pk = $1 AND name = ANY($2::text[])`,
        [storePk, goingSettings.map((r) => r.name)],
      );
    }
    for (const t of profileTables) {
      await client.query(`DELETE FROM ${t} WHERE store_pk = $1`, [storePk]);
    }

    // ── every device learns of it ────────────────────────────────────────────────────
    const { rows: bumped } = await client.query(
      `UPDATE store_sync_state
          SET head_revision = head_revision + 1,
              wipe_generation = wipe_generation + 1,
              wipe_revision = head_revision + 1,
              wiped_at = NOW(),
              wipe_request_id = $2,
              wipe_also_profile = $3,
              updated_at = NOW()
        WHERE store_pk = $1
        RETURNING head_revision, wipe_generation, wipe_revision, wiped_at, wipe_also_profile`,
      [storePk, reqId, Boolean(alsoProfile)],
    );
    const after = bumped[0] || {};

    const { rows: audit } = await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, store_pk, meta)
       VALUES ('admin', $1, 'store.wipe_data', $2, $3::jsonb) RETURNING id`,
      [
        actorId ? String(actorId) : null,
        storePk,
        JSON.stringify({
          store_id: store.store_id,
          store_name: store.store_name,
          also_profile: Boolean(alsoProfile),
          device_id: deviceId || null,
          request_id: reqId,
          counts,
          total_rows: totalRows,
          wipe_generation: Number(after.wipe_generation || 0),
          wipe_revision: Number(after.wipe_revision || 0),
          export_path: exported.path,
          export_sha256: exported.sha256,
          export_bytes: exported.bytes,
        }),
      ],
    );
    await client.query('COMMIT');
    committed = true;
    return {
      wiped: true,
      repeated: false,
      store_pk: Number(storePk),
      store_id: store.store_id,
      store_name: store.store_name,
      also_profile: Boolean(alsoProfile),
      counts,
      total_rows: totalRows,
      head_revision: Number(after.head_revision || 0),
      wipe_generation: Number(after.wipe_generation || 0),
      wipe_revision: Number(after.wipe_revision || 0),
      audit_id: Number(audit[0]?.id || 0),
      export: exported,
    };
  } catch (err) {
    if (!committed) {
      await client.query('ROLLBACK').catch(() => {});
      // Nothing was deleted: the export is an unreferenced copy of a live store. Take it back.
      if (exported) await fs.promises.unlink(exported.path).catch(() => {});
    }
    throw err;
  } finally {
    client.release();
  }
}

/** After the commit: drop the auth cache and tell every device of the store at once. */
export async function announceWipe(storePk, result) {
  if (!result || result.repeated) return;
  try {
    const { invalidateStoreAuthCache } = await import('../middleware/auth.js');
    invalidateStoreAuthCache(storePk);
  } catch { /* best-effort */ }
  try {
    const { broadcastSyncHint } = await import('../ws/syncHub.js');
    broadcastSyncHint(storePk, {
      head_revision: result.head_revision,
      source_device_id: null,
      changes: [],
      full_refresh: true,
      wipe_generation: result.wipe_generation,
      wipe_revision: result.wipe_revision,
      wipe_also_profile: result.also_profile,
    });
  } catch { /* best-effort: the next status / pull tells them anyway */ }
}
