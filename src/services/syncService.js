import { query, withTransaction } from '../db/pool.js';
import { config } from '../config/index.js';
import { AppError } from '../utils/http.js';
import { parseTs, parseDateOnly, toBool, fyStartYearForDate, encodeSalesBillNo, encodePurchaseNo, fyLabel, displaySalesBillNo, displayPurchaseNo } from '../utils/fy.js';
import {
  upsertGeneralProduct,
  upsertStockDisposal,
  upsertPendingOrder,
  upsertRack,
  upsertSection,
  upsertBox,
  upsertShelf,
  upsertMedicineShelf,
  upsertMedicineSupplier,
  upsertShelfSettings,
  upsertSettingsKv,
} from './extraUpserts.js';
import {
  shouldAcceptIncoming,
  syncMeta,
  localIdOf,
  writeTimestamp,
  sameScalarFields,
  isAcceptedWrite,
  changelogOperation,
  keepFilledText,
} from './upsertHelper.js';
import {
  ensureStoreSyncState,
  recordAcceptedChange,
  recordAcceptedChanges,
  newSyncHint,
} from './syncRevision.js';
import { broadcastSyncHint } from '../ws/syncHub.js';
import { changedFields, propagateMedicineLines, propagationNote } from './medicineLines.js';
import {
  resolveLocalIdByClientUuid,
  persistClientUuid,
  normalizeClientUuid,
} from './clientUuid.js';
import {
  applyStockOperation,
  applyEmbeddedStockOps,
  recordAbsoluteStockPatch,
  fetchStockOpsByLocalIds,
} from './stockOperations.js';
import {
  cascadeCustomerAfterLedgerChange,
  cascadeSupplierAfterLedgerChange,
} from './partyDueCascade.js';

/** Ids below this are the store's shared (legacy) range, handed out by MAX+1. A device on
 *  sync v2 makes its own ids from device_no * LEGACY_ID_LIMIT up, so two offline devices
 *  can never create the same id. Every id in use on 7 Oct 2026 was below 1,000,000. */
export const LEGACY_ID_LIMIT = 1000000000;

export { shouldAcceptIncoming } from './upsertHelper.js';

export function emitSyncHint(hint) {
  if (!hint?.revisions?.length) return;
  const changes = Array.isArray(hint.changes) ? hint.changes : [];
  broadcastSyncHint(hint.storePk, {
    head_revision: Math.max(...hint.revisions),
    source_device_id: hint.sourceDeviceId || null,
    changes,
    full_refresh: false,
  });
}

/**
 * A pack written as a volume or a weight -- "30ML", "15gm", "1KG", "500MG" -- is the
 * size of one bottle, tube or tablet, never a count of tablets in a strip. Reading its
 * digits as one turned a Tablet line typed "35GM" into 35 tablets a strip, and the next
 * edit of that purchase took 35 times the stock back off (store 4: 17583, 17585, 17590,
 * 17603). Same whole-string test as the clients (mac2
 * bill_import_normalize.pack_is_volume_or_weight, Android
 * BillImportNormalize.packIsVolumeOrWeight), widened for the run-together forms stored
 * lines already hold ("100Mml", "1LITml", "15GRMg").
 */
const VOLUME_OR_WEIGHT_PACK =
  /^\d+(?:\.\d+)?(?:m?ml|md|mg|mcg|kg|grms?|gms?|g|ltrs?|lit(?:re|er)?s?|lt|li|l)(?:ml|g)?$/i;

export function packIsVolumeOrWeight(unitStr) {
  const s = String(unitStr || '').replace(/\s+/g, '');
  return s !== '' && VOLUME_OR_WEIGHT_PACK.test(s);
}

export function parseTabletsPerStripe(unitStr) {
  const s = String(unitStr || '').trim();
  if (!s) return 0;
  // 0 is "not a strip count": purchaseItemPack then stores no tablets_per_stripe and
  // the client reads the pack itself (both clients already skip volume packs).
  if (packIsVolumeOrWeight(s)) return 0;
  const oneBy = s.match(/^1\s*[Xx×*]\s*(\d+)$/);
  if (oneBy) return Math.max(1, parseInt(oneBy[1], 10) || 0);
  const asNum = Number(s);
  if (Number.isFinite(asNum) && asNum > 0) return Math.floor(asNum);
  const digits = s.match(/\d+/);
  return digits ? Math.max(1, parseInt(digits[0], 10) || 0) : 0;
}

function purchaseItemPack(it, medUnit) {
  let unit = String(
    it?.unit || it?.quantity_value || it?.pack || medUnit || '',
  ).trim();
  let tps = Number(it?.tablets_per_stripe ?? it?.tablets_per_strip ?? 0);
  if (!Number.isFinite(tps) || tps <= 0) tps = parseTabletsPerStripe(unit);
  if (!unit && tps > 0) unit = String(tps);
  return {
    unit: unit || null,
    tablets_per_stripe: tps > 0 ? Math.round(tps) : null,
  };
}

async function loadMedicineUnits(db, storePk, items) {
  const medUnit = new Map();
  const ids = [...new Set(
    (items || [])
      .filter((it) => {
        if (!it?.medicine_id) return false;
        const pack = purchaseItemPack(it);
        return !pack.unit && !pack.tablets_per_stripe;
      })
      .map((it) => Number(it.medicine_id))
      .filter((n) => n > 0)
  )];
  if (!ids.length || !storePk) return medUnit;
  const res = await db.query(
    `SELECT local_id, unit FROM medicines
     WHERE store_pk=$1 AND local_id = ANY($2::bigint[])`,
    [storePk, ids]
  );
  for (const m of res.rows) medUnit.set(Number(m.local_id), m.unit);
  return medUnit;
}

function acceptedChangeEntry(storePk, collection, doc, status, overrides = {}) {
  if (!isAcceptedWrite(status)) return null;
  const meta = doc && typeof doc === 'object' ? syncMeta(doc) : {};
  const localId =
    overrides.localId != null
      ? Number(overrides.localId)
      : doc && typeof doc === 'object'
        ? localIdOf(doc)
        : Number(doc);
  return {
    storePk,
    collection,
    localId,
    operation: changelogOperation(status),
    entityVersion:
      overrides.entityVersion != null
        ? overrides.entityVersion
        : meta.version ?? null,
    entityUpdatedAt:
      overrides.entityUpdatedAt != null
        ? overrides.entityUpdatedAt
        : meta.updated_at ?? null,
    deviceId:
      overrides.deviceId != null
        ? overrides.deviceId
        : meta.device_id ?? null,
  };
}

async function noteAcceptedChange(client, hint, storePk, collection, doc, status, overrides = {}) {
  const entry = acceptedChangeEntry(storePk, collection, doc, status, overrides);
  if (!entry) return;
  await recordAcceptedChange(client, hint, entry);
}

async function noteAcceptedChangeMany(client, hint, entries) {
  const list = (entries || []).filter(Boolean);
  if (!list.length) return;
  await recordAcceptedChanges(client, hint, list);
}

/** Multi-row INSERT — cuts hundreds of round-trips for nested line items. */
async function multiInsert(client, table, columns, rows, { batchSize = 200 } = {}) {
  if (!rows?.length) return;
  const colSql = columns.join(', ');
  const width = columns.length;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const params = [];
    const placeholders = slice.map((row, ri) => {
      const base = ri * width;
      params.push(...row);
      return `(${Array.from({ length: width }, (_, ci) => `$${base + ci + 1}`).join(',')})`;
    }).join(',');
    await client.query(`INSERT INTO ${table} (${colSql}) VALUES ${placeholders}`, params);
  }
}

/** Multi-row UPSERT for flat (store_pk, local_id) tables. */
async function multiUpsert(client, table, columns, updateCols, rows, { batchSize = 150, keepFilledCols = [] } = {}) {
  if (!rows?.length) return;
  const colSql = columns.join(', ');
  const width = columns.length;
  const keep = new Set(keepFilledCols);
  const updates = updateCols.map((c) => (
    keep.has(c)
      ? `${c}=COALESCE(NULLIF(TRIM(EXCLUDED.${c}), ''), ${table}.${c})`
      : `${c}=EXCLUDED.${c}`
  )).join(', ');
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const params = [];
    const placeholders = slice.map((row, ri) => {
      const base = ri * width;
      params.push(...row);
      return `(${Array.from({ length: width }, (_, ci) => `$${base + ci + 1}`).join(',')})`;
    }).join(',');
    await client.query(
      `INSERT INTO ${table} (${colSql}) VALUES ${placeholders}
       ON CONFLICT (store_pk, local_id) DO UPDATE SET ${updates}`,
      params
    );
  }
}

/**
 * created_at for a row being INSERTED: the client's, else the moment the server first
 * saw the row. 782 store-4 rows (every purchase, every supplier payment, 393 PC sales)
 * were stored with none, so nobody could tell when they were entered. Every ON CONFLICT
 * branch leaves created_at out, so an existing value -- or an existing NULL -- is never
 * overwritten through this.
 */
function createdAtOrNow(doc) {
  return parseTs(doc?.created_at) || new Date();
}

async function prefetchExisting(client, table, storePk, localIds) {
  if (!localIds.length) return new Map();
  const extra = table === 'customers' ? ', phone, address' : '';
  const res = await client.query(
    `SELECT local_id, id, version, updated_at, device_id, deleted${extra}
     FROM ${table}
     WHERE store_pk=$1 AND local_id = ANY($2::bigint[])`,
    [storePk, localIds]
  );
  return new Map(res.rows.map((r) => [Number(r.local_id), r]));
}

// Medicines intentionally NOT flat-bulk: B4 stock_ops + client_uuid need upsertMedicine.
// Payments intentionally NOT flat-bulk either: upsertCustomerPayment /
// upsertSupplierPayment run the party-due FIFO cascade, and the flat multiUpsert
// path skips it entirely — which left dues stale and made a saved payment look
// like it had never cleared any bill. Desktop papered over this by repairing dues
// client-side; Android did not, so the payment appeared "unsaved" there.
const FLAT_BULK = new Set([
  'customers',
  'suppliers',
  'doctors',
]);

async function pushFlatBulk(client, storePk, collection, docs, hint = null, partyRecompute = null) {
  const localIds = docs.map((d) => localIdOf(d));
  const existingById = await prefetchExisting(client, collection, storePk, localIds);
  const results = [];
  const rows = [];
  const acceptedDocs = [];

  for (const doc of docs) {
    const localId = localIdOf(doc);
    const meta = syncMeta(doc);
    const existing = existingById.get(localId);
    if (shouldAcceptIncoming(existing, { ...meta }) === 'skip') {
      results.push({ id: localId, status: 'skipped' });
      continue;
    }
    acceptedDocs.push(doc);
    const writeAt = writeTimestamp(meta, existing);
    if (collection === 'customers') {
      rows.push([
        storePk, localId,
        String(doc.name || '').toUpperCase(),
        keepFilledText(doc.phone, existing?.phone),
        keepFilledText(doc.address, existing?.address),
        doc.document_name || null,
        Number(doc.total_due || 0), Number(doc.total_credit || 0),
        createdAtOrNow(doc), parseTs(doc.last_updated),
        writeAt, meta.version, meta.device_id, meta.deleted, meta.sync_status,
      ]);
    } else if (collection === 'suppliers') {
      rows.push([
        storePk, localId, String(doc.name || '').toUpperCase(),
        doc.address || null, doc.phone || null, doc.gstin || null, doc.dl_numbers || null,
        Number(doc.total_due || 0), Number(doc.total_credit || 0), createdAtOrNow(doc),
        writeAt, meta.version, meta.device_id, meta.deleted, meta.sync_status,
      ]);
    } else if (collection === 'doctors') {
      rows.push([
        storePk, localId, String(doc.name || '').toUpperCase(),
        doc.phone || null, doc.registration_number || null, createdAtOrNow(doc),
        writeAt, meta.version, meta.device_id, meta.deleted, meta.sync_status,
      ]);
    } else if (collection === 'medicines') {
      rows.push([
        storePk, localId, String(doc.name || '').toUpperCase(), doc.type || null,
        Number(doc.stock_qty || 0), doc.unit || null,
        doc.gst_percent ?? null, doc.mrp ?? null, doc.rate ?? null,
        doc.manufacturer || null, doc.batch_no || null,
        parseDateOnly(doc.expiry_date), doc.hsn_code || null, doc.schedule || null,
        doc.location || null, doc.content_drug || null,
        doc.supplier_name || null,
        toBool(doc.is_hidden), parseTs(doc.synced_at), parseTs(doc.created_at),
        writeAt, meta.version, meta.device_id, meta.deleted, meta.sync_status,
      ]);
    } else if (collection === 'customer_payments') {
      rows.push([
        storePk, localId, Number(doc.customer_id), doc.customer_name || null, doc.payment_date,
        Number(doc.amount || 0), doc.payment_mode || 'cash',
        Number(doc.cash_amount || 0), Number(doc.online_amount || 0),
        doc.reference_no || null, doc.note || null, parseTs(doc.created_at),
        writeAt, meta.version, meta.device_id, meta.deleted, meta.sync_status,
      ]);
    } else if (collection === 'supplier_payments') {
      const paymentNo = doc.payment_no || `SP${localId}`;
      rows.push([
        storePk, localId, paymentNo, Number(doc.supplier_id), doc.supplier_name || null, doc.payment_date,
        Number(doc.amount || 0), doc.mode || 'Cash', doc.reference || null,
        Number(doc.due_before || 0), Number(doc.due_after || 0), parseTs(doc.created_at),
        writeAt, meta.version, meta.device_id, meta.deleted, meta.sync_status,
      ]);
    }
    results.push({ id: localId, status: 'upserted' });
  }

  if (collection === 'customers') {
    await multiUpsert(client, 'customers', [
      'store_pk', 'local_id', 'name', 'phone', 'address', 'document_name',
      'total_due', 'total_credit', 'created_at', 'last_updated',
      'updated_at', 'version', 'device_id', 'deleted', 'sync_status',
    ], [
      'name', 'phone', 'address', 'document_name', 'total_due', 'total_credit', 'last_updated',
      'updated_at', 'version', 'device_id', 'deleted', 'sync_status',
    ], rows, { keepFilledCols: ['phone', 'address'] });
  } else if (collection === 'suppliers') {
    await multiUpsert(client, 'suppliers', [
      'store_pk', 'local_id', 'name', 'address', 'phone', 'gstin', 'dl_numbers',
      'total_due', 'total_credit', 'created_at',
      'updated_at', 'version', 'device_id', 'deleted', 'sync_status',
    ], [
      'name', 'address', 'phone', 'gstin', 'dl_numbers', 'total_due', 'total_credit',
      'updated_at', 'version', 'device_id', 'deleted', 'sync_status',
    ], rows);
  } else if (collection === 'doctors') {
    await multiUpsert(client, 'doctors', [
      'store_pk', 'local_id', 'name', 'phone', 'registration_number', 'created_at',
      'updated_at', 'version', 'device_id', 'deleted', 'sync_status',
    ], [
      'name', 'phone', 'registration_number',
      'updated_at', 'version', 'device_id', 'deleted', 'sync_status',
    ], rows);
  } else if (collection === 'medicines') {
    await multiUpsert(client, 'medicines', [
      'store_pk', 'local_id', 'name', 'type', 'stock_qty', 'unit', 'gst_percent', 'mrp', 'rate',
      'manufacturer', 'batch_no', 'expiry_date', 'hsn_code', 'schedule', 'location', 'content_drug',
      'supplier_name',
      'is_hidden', 'synced_at', 'created_at',
      'updated_at', 'version', 'device_id', 'deleted', 'sync_status',
    ], [
      'name', 'type', 'stock_qty', 'unit', 'gst_percent', 'mrp', 'rate',
      'manufacturer', 'batch_no', 'expiry_date', 'hsn_code', 'schedule', 'location',
      'content_drug', 'supplier_name', 'is_hidden', 'synced_at',
      'updated_at', 'version', 'device_id', 'deleted', 'sync_status',
    ], rows);
  } else if (collection === 'customer_payments') {
    await multiUpsert(client, 'customer_payments', [
      'store_pk', 'local_id', 'customer_id', 'customer_name', 'payment_date', 'amount', 'payment_mode',
      'cash_amount', 'online_amount', 'reference_no', 'note', 'created_at',
      'updated_at', 'version', 'device_id', 'deleted', 'sync_status',
    ], [
      'customer_id', 'customer_name', 'payment_date', 'amount', 'payment_mode',
      'cash_amount', 'online_amount', 'reference_no', 'note',
      'updated_at', 'version', 'device_id', 'deleted', 'sync_status',
    ], rows);
  } else if (collection === 'supplier_payments') {
    await multiUpsert(client, 'supplier_payments', [
      'store_pk', 'local_id', 'payment_no', 'supplier_id', 'supplier_name', 'payment_date', 'amount', 'mode',
      'reference', 'due_before', 'due_after', 'created_at',
      'updated_at', 'version', 'device_id', 'deleted', 'sync_status',
    ], [
      'payment_no', 'supplier_id', 'supplier_name', 'payment_date', 'amount', 'mode',
      'reference', 'due_before', 'due_after',
      'updated_at', 'version', 'device_id', 'deleted', 'sync_status',
    ], rows);
  }

  await noteAcceptedChangeMany(
    client,
    hint,
    acceptedDocs.map((doc) => acceptedChangeEntry(storePk, collection, doc, 'upserted')),
  );

  // The device's due/credit figures were written above only so the row exists. The
  // balance itself belongs to the ledger: recompute it for every party this push
  // accepted, so a stale or doubled figure from any client never stands.
  // A bundle passes `partyRecompute` and runs this at its END instead: recomputing here
  // re-clears the party's bills and bumps their versions BEFORE the sale or purchase
  // edit travelling in the same bundle is applied, and that edit would then be skipped
  // as stale.
  if (collection === 'customers' || collection === 'suppliers') {
    for (const doc of acceptedDocs) {
      if (syncMeta(doc).deleted) continue;
      if (partyRecompute) partyRecompute[collection].add(localIdOf(doc));
      else await recomputePartyAfterPush(client, hint, storePk, collection, localIdOf(doc));
    }
  }

  const upserted = results.filter((r) => r.status === 'upserted').length;
  const skipped = results.length - upserted;
  return { results, upserted, skipped };
}

/** All syncable collections (Firebase + SQLite parity) */
export const COLLECTIONS = [
  'customers',
  'suppliers',
  'medicines',
  'doctors',
  'sales',
  'purchases',
  'customer_payments',
  'supplier_payments',
  'sales_returns',
  'purchase_returns',
  'general_products',
  'stock_disposals',
  'stock_operations',
  'pending_orders',
  'racks',
  'sections',
  'boxes',
  'shelves',
  'medicine_shelf',
  'medicine_suppliers',
  // medicines_master is global — use /api/master-medicines, not store sync
];

export const SPECIAL_COLLECTIONS = [
  'pharmacy_profile',
  'dropdowns',
  'shelf_settings',
  'settings',
];

// ─── Upsert helpers per collection ────────────────────────────────────────────

async function upsertCustomer(client, storePk, doc, hint = null) {
  const localId = localIdOf(doc);
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT version, updated_at, device_id, deleted, phone, address
     FROM customers WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (shouldAcceptIncoming(existing.rows[0], { ...meta }) === 'skip') {
    return { id: localId, status: 'skipped' };
  }
  const prev = existing.rows[0] || null;
  const phone = keepFilledText(doc.phone, prev?.phone);
  const address = keepFilledText(doc.address, prev?.address);
  await client.query(
    `INSERT INTO customers (
       store_pk, local_id, name, phone, address, document_name,
       total_due, total_credit, created_at, last_updated,
       updated_at, version, device_id, deleted, sync_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (store_pk, local_id) DO UPDATE SET
       name=EXCLUDED.name,
       phone=COALESCE(NULLIF(TRIM(EXCLUDED.phone), ''), customers.phone),
       address=COALESCE(NULLIF(TRIM(EXCLUDED.address), ''), customers.address),
       document_name=EXCLUDED.document_name, total_due=EXCLUDED.total_due,
       total_credit=EXCLUDED.total_credit, last_updated=EXCLUDED.last_updated,
       updated_at=EXCLUDED.updated_at, version=EXCLUDED.version,
       device_id=EXCLUDED.device_id, deleted=EXCLUDED.deleted, sync_status=EXCLUDED.sync_status`,
    [
      storePk, localId,
      String(doc.name || '').toUpperCase(),
      phone, address, doc.document_name || null,
      Number(doc.total_due || 0), Number(doc.total_credit || 0),
      createdAtOrNow(doc), parseTs(doc.last_updated),
      writeTimestamp(meta, prev), meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  if (!meta.deleted) {
    await recomputePartyAfterPush(client, hint, storePk, 'customers', localId);
  }
  return { id: localId, status: 'upserted' };
}

async function upsertSupplier(client, storePk, doc, hint = null) {
  const localId = localIdOf(doc);
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT version, updated_at, device_id, deleted FROM suppliers WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (shouldAcceptIncoming(existing.rows[0], { ...meta }) === 'skip') {
    return { id: localId, status: 'skipped' };
  }
  await client.query(
    `INSERT INTO suppliers (
       store_pk, local_id, name, address, phone, gstin, dl_numbers,
       total_due, total_credit, created_at,
       updated_at, version, device_id, deleted, sync_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (store_pk, local_id) DO UPDATE SET
       name=EXCLUDED.name, address=EXCLUDED.address, phone=EXCLUDED.phone,
       gstin=EXCLUDED.gstin, dl_numbers=EXCLUDED.dl_numbers,
       total_due=EXCLUDED.total_due, total_credit=EXCLUDED.total_credit,
       updated_at=EXCLUDED.updated_at, version=EXCLUDED.version,
       device_id=EXCLUDED.device_id, deleted=EXCLUDED.deleted, sync_status=EXCLUDED.sync_status`,
    [
      storePk, localId, String(doc.name || '').toUpperCase(),
      doc.address || null, doc.phone || null, doc.gstin || null, doc.dl_numbers || null,
      Number(doc.total_due || 0), Number(doc.total_credit || 0), createdAtOrNow(doc),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  if (!meta.deleted) {
    await recomputePartyAfterPush(client, hint, storePk, 'suppliers', localId);
  }
  return { id: localId, status: 'upserted' };
}

async function upsertDoctor(client, storePk, doc) {
  const localId = localIdOf(doc);
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT version, updated_at, device_id, deleted FROM doctors WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (shouldAcceptIncoming(existing.rows[0], { ...meta }) === 'skip') {
    return { id: localId, status: 'skipped' };
  }
  await client.query(
    `INSERT INTO doctors (
       store_pk, local_id, name, phone, registration_number, created_at,
       updated_at, version, device_id, deleted, sync_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (store_pk, local_id) DO UPDATE SET
       name=EXCLUDED.name, phone=EXCLUDED.phone, registration_number=EXCLUDED.registration_number,
       updated_at=EXCLUDED.updated_at, version=EXCLUDED.version,
       device_id=EXCLUDED.device_id, deleted=EXCLUDED.deleted, sync_status=EXCLUDED.sync_status`,
    [
      storePk, localId, String(doc.name || '').toUpperCase(),
      doc.phone || null, doc.registration_number || null, createdAtOrNow(doc),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  return { id: localId, status: 'upserted' };
}

async function upsertMedicine(client, storePk, doc, hint = null) {
  // A medicine push that names its row is applied to THAT row. Both Online clients take
  // medicine ids from /allocate-ids, so the id is the store's own. Following the
  // client_uuid instead landed old PC pushes -- which stamp the name+batch uuid -- on
  // whichever row already owned that uuid, usually a deleted twin: store 127's deleted
  // 570, 627, 968 and 1128 were rewritten 472 times while the live rows the PC was
  // editing never changed. The uuid is then not adopted (the other row keeps it), and
  // the answer says so. A push without an id still resolves by client_uuid.
  const { localId, clientUuid, uuidConflict } = await resolveLocalIdByClientUuid(
    client, 'medicines', storePk, doc, { namedIdWins: true },
  );
  if (!Number.isFinite(localId) || localId <= 0) {
    throw new AppError(400, 'Document id required');
  }
  let answer = (r) => r;
  if (uuidConflict) {
    console.warn(
      `[sync] medicines/${localId} store=${storePk} pushed with client_uuid ${uuidConflict.client_uuid} ` +
      `held by medicines/${uuidConflict.owner_id}${uuidConflict.owner_deleted ? ' (deleted)' : ''}; ` +
      `applied to ${localId}, uuid not adopted`,
    );
    const conflict = {
      ...uuidConflict,
      note:
        `client_uuid belongs to medicines/${uuidConflict.owner_id}; this document was taken ` +
        `as medicines/${localId}, the id it names, and the uuid was not adopted.`,
    };
    answer = (r) => ({ ...r, client_uuid_conflict: conflict });
  }
  const meta = syncMeta(doc);
  const hasStockOps = Array.isArray(doc.stock_ops || doc.stockOps)
    && (doc.stock_ops || doc.stockOps).length > 0;
  const existing = await client.query(
    `SELECT version, updated_at, device_id, deleted, stock_qty, client_uuid,
            name, type, hsn_code, schedule, manufacturer
     FROM medicines WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  const decision = shouldAcceptIncoming(existing.rows[0], { ...meta });
  // An accepted edit of a live medicine carries its descriptive fields into its old bill
  // lines (services/medicineLines.js); prices, GST %, batch and expiry never move.
  const withLines = async (r) => {
    const before = existing.rows[0];
    if (!before || before.deleted || toBool(doc.deleted)) return r;
    // Only fields the document actually carries: a push that leaves one out must not blank
    // it on every old bill.
    const after = {};
    for (const f of ['name', 'type', 'hsn_code', 'schedule', 'manufacturer']) {
      if (Object.prototype.hasOwnProperty.call(doc, f)) after[f] = f === 'name' ? String(doc.name || '').toUpperCase() : doc[f];
    }
    const changes = changedFields(before, after);
    if (!Object.keys(changes).length) return r;
    const counts = await propagateMedicineLines(client, storePk, localId, changes);
    return { ...r, lines_updated: counts, lines_note: propagationNote(counts) };
  };
  // B4.2: prefer stock_ops deltas over absolute LWW when provided.
  if (hasStockOps) {
    if (decision !== 'skip') {
      // A row created in the same push as its deltas must start at 0: the ops
      // carry the quantity. Seeding from the incoming absolute -- which the
      // client has ALREADY incremented -- and then applying the delta on top
      // double-counted, so an Android purchase of 20 strips x 10/strip landed
      // 400 instead of 200. The existing-row branch already ignores the
      // absolute for exactly this reason; new rows must behave the same.
      const keepQty = existing.rows[0]
        ? Number(existing.rows[0].stock_qty || 0)
        : 0;
      await client.query(
        `INSERT INTO medicines (
           store_pk, local_id, name, type, stock_qty, unit, gst_percent, mrp, rate,
           manufacturer, batch_no, expiry_date, hsn_code, schedule, location, content_drug,
           supplier_name,
           is_hidden, synced_at, created_at,
           updated_at, version, device_id, deleted, sync_status, client_uuid
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
         )
         ON CONFLICT (store_pk, local_id) DO UPDATE SET
           name=EXCLUDED.name, type=EXCLUDED.type, unit=EXCLUDED.unit,
           gst_percent=EXCLUDED.gst_percent, mrp=EXCLUDED.mrp, rate=EXCLUDED.rate,
           manufacturer=EXCLUDED.manufacturer, batch_no=EXCLUDED.batch_no, expiry_date=EXCLUDED.expiry_date,
           hsn_code=EXCLUDED.hsn_code, schedule=EXCLUDED.schedule, location=EXCLUDED.location,
           content_drug=EXCLUDED.content_drug,
           supplier_name=COALESCE(EXCLUDED.supplier_name, medicines.supplier_name),
           is_hidden=EXCLUDED.is_hidden, synced_at=EXCLUDED.synced_at,
           updated_at=EXCLUDED.updated_at, version=EXCLUDED.version, device_id=EXCLUDED.device_id,
           deleted=EXCLUDED.deleted, sync_status=EXCLUDED.sync_status,
           client_uuid=COALESCE(medicines.client_uuid, EXCLUDED.client_uuid)`,
        [
          storePk, localId, String(doc.name || '').toUpperCase(), doc.type || null,
          keepQty, doc.unit || null,
          doc.gst_percent ?? null, doc.mrp ?? null, doc.rate ?? null,
          doc.manufacturer || null, doc.batch_no || null,
          parseDateOnly(doc.expiry_date), doc.hsn_code || null, doc.schedule || null,
          doc.location || null, doc.content_drug || null,
          doc.supplier_name || null,
          toBool(doc.is_hidden), parseTs(doc.synced_at), parseTs(doc.created_at),
          writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
          clientUuid,
        ]
      );
    }
    const applied = await applyEmbeddedStockOps(client, storePk, { ...doc, id: localId }, hint);
    await persistClientUuid(client, 'medicines', storePk, localId, clientUuid);
    const r = answer({ id: localId, status: applied || decision !== 'skip' ? 'upserted' : 'skipped' });
    return decision !== 'skip' ? withLines(r) : r;
  }

  // When LWW skips but stock_qty changed — e.g. an Android sale decreased stock
  // without bumping sync meta — still apply the stock figure.
  //
  // GUARD: this used to apply ANY stale document's stock_qty, which meant conflict
  // resolution was bypassed for the single most important field in the system. A
  // device that had been offline could come back, push its old copy, and silently
  // overwrite the current stock — verified: pushing version 2 against version 6
  // set stock from 7 to 999. The write was rejected by LWW and applied anyway.
  //
  // The legitimate case always carries a FRESH timestamp (the device just made the
  // sale; only its version counter is behind). Genuinely stale state carries an old
  // timestamp. Requiring the incoming write to be newer than what we hold keeps the
  // intended behaviour and drops the dangerous one.
  if (decision === 'skip') {
    const prevQty = Number(existing.rows[0]?.stock_qty ?? 0);
    const nextQty = Number(doc.stock_qty || 0);
    const existingTs = parseTs(existing.rows[0]?.updated_at)?.getTime() ?? 0;
    const incomingTs = parseTs(meta.updated_at)?.getTime() ?? 0;
    const isNewerInformation = incomingTs > existingTs;
    if (existing.rows[0] && prevQty !== nextQty && !isNewerInformation) {
      console.warn(
        `[sync] medicines/${localId} stale stock patch refused: ` +
        `incoming v${meta.version} qty=${nextQty} is older than stored qty=${prevQty}`,
      );
      await persistClientUuid(client, 'medicines', storePk, localId, clientUuid);
      return answer({ id: localId, status: 'skipped', reason: 'stale_stock' });
    }
    if (existing.rows[0] && prevQty !== nextQty) {
      await client.query(
        `UPDATE medicines SET stock_qty=$3,
           updated_at=GREATEST(COALESCE(updated_at, NOW()), NOW()),
           version=COALESCE(version,0)+1,
           device_id=COALESCE($4, device_id),
           sync_status='synced'
         WHERE store_pk=$1 AND local_id=$2`,
        [storePk, localId, nextQty, meta.device_id || null]
      );
      await recordAbsoluteStockPatch(client, storePk, {
        medicineId: localId,
        prevQty,
        nextQty,
        deviceId: meta.device_id,
        hint,
      });
      await persistClientUuid(client, 'medicines', storePk, localId, clientUuid);
      return answer({ id: localId, status: 'stock_patched' });
    }
    await persistClientUuid(client, 'medicines', storePk, localId, clientUuid);
    return answer({ id: localId, status: 'skipped' });
  }

  // The stock ledger must hold every change for the nightly check (stock = snapshot +
  // ledger). This absolute write (a device pushing stock_qty without stock_ops) never left
  // a line; it now leaves the same audit-only line the skipped path already wrote.
  {
    const prevQty = existing.rows[0] ? Number(existing.rows[0].stock_qty || 0) : 0;
    const nextQty = Number(doc.stock_qty || 0);
    if (prevQty !== nextQty) {
      await recordAbsoluteStockPatch(client, storePk, {
        medicineId: localId, prevQty, nextQty, deviceId: meta.device_id, hint,
      });
    }
  }
  await client.query(
    `INSERT INTO medicines (
       store_pk, local_id, name, type, stock_qty, unit, gst_percent, mrp, rate,
       manufacturer, batch_no, expiry_date, hsn_code, schedule, location, content_drug,
       supplier_name,
       is_hidden, synced_at, created_at,
       updated_at, version, device_id, deleted, sync_status, client_uuid
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
     )
     ON CONFLICT (store_pk, local_id) DO UPDATE SET
       name=EXCLUDED.name, type=EXCLUDED.type, stock_qty=EXCLUDED.stock_qty, unit=EXCLUDED.unit,
       gst_percent=EXCLUDED.gst_percent, mrp=EXCLUDED.mrp, rate=EXCLUDED.rate,
       manufacturer=EXCLUDED.manufacturer, batch_no=EXCLUDED.batch_no, expiry_date=EXCLUDED.expiry_date,
       hsn_code=EXCLUDED.hsn_code, schedule=EXCLUDED.schedule, location=EXCLUDED.location,
       content_drug=EXCLUDED.content_drug,
       supplier_name=COALESCE(EXCLUDED.supplier_name, medicines.supplier_name),
       is_hidden=EXCLUDED.is_hidden, synced_at=EXCLUDED.synced_at,
       updated_at=EXCLUDED.updated_at, version=EXCLUDED.version, device_id=EXCLUDED.device_id,
       deleted=EXCLUDED.deleted, sync_status=EXCLUDED.sync_status,
       client_uuid=COALESCE(medicines.client_uuid, EXCLUDED.client_uuid)`,
    [
      storePk, localId, String(doc.name || '').toUpperCase(), doc.type || null,
      Number(doc.stock_qty || 0), doc.unit || null,
      doc.gst_percent ?? null, doc.mrp ?? null, doc.rate ?? null,
      doc.manufacturer || null, doc.batch_no || null,
      parseDateOnly(doc.expiry_date), doc.hsn_code || null, doc.schedule || null,
      doc.location || null, doc.content_drug || null,
      doc.supplier_name || null,
      toBool(doc.is_hidden), parseTs(doc.synced_at), parseTs(doc.created_at),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
      clientUuid,
    ]
  );
  return withLines(answer({ id: localId, status: 'upserted' }));
}

async function upsertSale(client, storePk, doc, hint = null) {
  const { localId, clientUuid } = await resolveLocalIdByClientUuid(
    client, 'sales', storePk, doc,
  );
  if (!Number.isFinite(localId) || localId <= 0) {
    throw new AppError(400, 'Document id required');
  }
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT id, version, updated_at, device_id, deleted, customer_id,
            amount_paid, cash_paid, online_paid, previous_due, previous_credit,
            due_amount, credit_amount, total_due, paid_due, bill_cleared, account_cleared,
            total_amount, discount, discount_pct, rounding,
            bill_no, fy_start_year, fy_serial, item_count
     FROM sales WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (shouldAcceptIncoming(existing.rows[0], { ...meta }) === 'skip') {
    await persistClientUuid(client, 'sales', storePk, localId, clientUuid);
    // A retried push is answered with the number the server HOLDS for this bill. A
    // skip used to carry no number at all, so a retry kept whatever it had allocated
    // for itself -- the likely way SCB1251/FY2026-27 (store 4) went unused.
    return withStoredSaleNumber({ id: localId, status: 'skipped' }, existing.rows[0]);
  }

  const prev = existing.rows[0] || null;
  const money = (key, fallback = 0) => {
    if (Object.prototype.hasOwnProperty.call(doc, key) && doc[key] !== null && doc[key] !== undefined && doc[key] !== '') {
      return Number(doc[key]);
    }
    if (prev && prev[key] != null) return Number(prev[key]);
    return fallback;
  };

  const fyFromBillDate = fyStartYearForDate(doc.bill_date);
  let fyStart = doc.fy_start_year ?? fyFromBillDate;
  // An edit that leaves the number out keeps the bill's own number. It used to fall
  // through to "no number at all" below and be handed the next free one.
  let billNo = doc.bill_no || (prev?.bill_no ? String(prev.bill_no) : '');
  // Same for the serial: an edit that omits fy_serial keeps the one its number carries
  // (or the row already had) instead of writing NULL over it.
  let saleSerial = doc.fy_serial ?? null;
  if (saleSerial == null && billNo) {
    const inCode = salesSerialInCode(billNo);
    if (inCode != null && fyStartYearInCode(billNo) === Number(fyStart)) {
      saleSerial = inCode;
    } else if (prev && String(prev.bill_no || '') === String(billNo)) {
      saleSerial = prev.fy_serial ?? null;
    }
  }
  // Same rule as purchases: the bill's own date decides its financial year,
  // and a missing serial is allocated rather than taken from the row id.
  if (doc.bill_date && Number(fyStart) !== Number(fyFromBillDate)) {
    console.warn(
      `[fy] sale local_id=${localId} store=${storePk} claimed FY ${fyStart} ` +
      `for date ${doc.bill_date}; refiling under FY ${fyFromBillDate}`
    );
    fyStart = fyFromBillDate;
    saleSerial = await reallocateSerialForFy(client, storePk, 'sales', fyStart, localId);
    billNo = encodeSalesBillNo(saleSerial, fyStart);
  }
  if (!billNo) {
    if (!saleSerial) {
      saleSerial = await serialWhenMissing(client, storePk, 'sales', fyStart, localId);
    }
    billNo = encodeSalesBillNo(saleSerial, fyStart);
  }
  // item_count is the number of lines the bill has. Taken from the client it drifted
  // (10 PC bills in stores 4 and 127 disagree with their own lines), and a push without
  // items or a count wrote 0 over a bill whose lines were kept.
  const itemCount = Array.isArray(doc.items)
    ? doc.items.length
    : (doc.item_count != null && doc.item_count !== ''
      ? (Number(doc.item_count) || 0)
      : Number(prev?.item_count || 0));

  const result = await client.query(
    `INSERT INTO sales (
       store_pk, local_id, bill_no, customer_id, bill_date, total_amount, discount, discount_pct,
       rounding, amount_paid, cash_paid, online_paid, previous_due, previous_credit,
       due_amount, credit_amount, total_due, paid_due, bill_cleared, account_cleared,
       doctor_name, is_autosave, fy_start_year, fy_serial,
       customer_name, customer_phone, customer_address, item_count, created_at,
       updated_at, version, device_id, deleted, sync_status, client_uuid
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
       $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35
     )
     ON CONFLICT (store_pk, local_id) DO UPDATE SET
       bill_no=EXCLUDED.bill_no, customer_id=EXCLUDED.customer_id, bill_date=EXCLUDED.bill_date,
       total_amount=EXCLUDED.total_amount, discount=EXCLUDED.discount, discount_pct=EXCLUDED.discount_pct,
       rounding=EXCLUDED.rounding, amount_paid=EXCLUDED.amount_paid, cash_paid=EXCLUDED.cash_paid,
       online_paid=EXCLUDED.online_paid, previous_due=EXCLUDED.previous_due, previous_credit=EXCLUDED.previous_credit,
       due_amount=EXCLUDED.due_amount, credit_amount=EXCLUDED.credit_amount, total_due=EXCLUDED.total_due,
       paid_due=EXCLUDED.paid_due, bill_cleared=EXCLUDED.bill_cleared, account_cleared=EXCLUDED.account_cleared,
       doctor_name=EXCLUDED.doctor_name, is_autosave=EXCLUDED.is_autosave,
       fy_start_year=EXCLUDED.fy_start_year, fy_serial=EXCLUDED.fy_serial,
       customer_name=EXCLUDED.customer_name, customer_phone=EXCLUDED.customer_phone,
       customer_address=EXCLUDED.customer_address, item_count=EXCLUDED.item_count,
       updated_at=EXCLUDED.updated_at, version=EXCLUDED.version, device_id=EXCLUDED.device_id,
       deleted=EXCLUDED.deleted, sync_status=EXCLUDED.sync_status,
       client_uuid=COALESCE(sales.client_uuid, EXCLUDED.client_uuid)
     RETURNING id, bill_no, fy_start_year`,
    [
      storePk, localId, billNo, doc.customer_id ?? null, doc.bill_date,
      money('total_amount'), money('discount'), money('discount_pct'),
      money('rounding'), money('amount_paid'), money('cash_paid'),
      money('online_paid'), money('previous_due'), money('previous_credit'),
      money('due_amount'), money('credit_amount'), money('total_due'),
      money('paid_due'),
      Object.prototype.hasOwnProperty.call(doc, 'bill_cleared')
        ? toBool(doc.bill_cleared)
        : toBool(prev?.bill_cleared),
      Object.prototype.hasOwnProperty.call(doc, 'account_cleared')
        ? toBool(doc.account_cleared)
        : toBool(prev?.account_cleared),
      doc.doctor_name || null, toBool(doc.is_autosave), fyStart, saleSerial ?? null,
      doc.customer_name || null, doc.customer_phone || null, doc.customer_address || null,
      itemCount, createdAtOrNow(doc),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
      clientUuid,
    ]
  );
  const stored = result.rows[0];
  const salePk = stored.id;
  if (Array.isArray(doc.items)) {
    await client.query(`DELETE FROM sales_items WHERE sale_id = $1`, [salePk]);
    const items = doc.items;
    await multiInsert(
      client,
      'sales_items',
      [
        'store_pk', 'sale_id', 'medicine_id', 'name', 'type', 'batch_no', 'expiry_date', 'hsn_code',
        'schedule', 'manufacturer', 'qty', 'rate', 'gst_percent', 'amount', 'item_discount', 'cost_price',
      ],
      items.map((it) => [
        storePk, salePk, it.medicine_id ?? null, it.name || null, it.type || null,
        it.batch_no || null, it.expiry_date || null, it.hsn_code || null,
        it.schedule || null, it.manufacturer || null,
        Number(it.qty || 0), Number(it.rate || 0), it.gst_percent ?? null,
        Number(it.amount || 0), Number(it.item_discount || 0), Number(it.cost_price || 0),
      ])
    );
  }
  // Keep FY serial table in sync for server-side allocation
  if (fyStart && saleSerial && !toBool(doc.is_autosave)) {
    await client.query(
      `INSERT INTO fy_serials (store_pk, kind, fy_start_year, last_serial)
       VALUES ($1, 'sales', $2, $3)
       ON CONFLICT (store_pk, kind, fy_start_year) DO UPDATE
         SET last_serial = GREATEST(fy_serials.last_serial, EXCLUDED.last_serial)`,
      [storePk, fyStart, Number(saleSerial)]
    );
  }
  await persistClientUuid(client, 'sales', storePk, localId, clientUuid);
  if (prev && String(prev.bill_no || '') !== String(stored.bill_no || '')) {
    await noteNumberChange(client, storePk, {
      action: 'sale_bill_no_changed',
      localId,
      from: prev.bill_no,
      to: stored.bill_no,
      deviceId: meta.device_id,
      detail: { bill_date: doc.bill_date ?? null, version: meta.version },
    });
  }
  const customerId = Number(doc.customer_id);
  if (customerId > 0 && !toBool(doc.is_autosave)) {
    try {
      const cascaded = await cascadeCustomerAfterLedgerChange(client, storePk, customerId, hint);
      await noteCascadeChanges(client, hint, storePk, 'customers', customerId, 'sales', cascaded);
    } catch (e) {
      console.warn('[cascade] customer after sale:', e.message);
    }
  }
  // An edit that moved the bill to another customer: the one it left owes less now.
  const leftCustomer = Number(prev?.customer_id);
  if (leftCustomer > 0 && leftCustomer !== customerId) {
    try {
      const cascaded = await cascadeCustomerAfterLedgerChange(client, storePk, leftCustomer, hint);
      await noteCascadeChanges(client, hint, storePk, 'customers', leftCustomer, 'sales', cascaded);
    } catch (e) {
      console.warn('[cascade] customer the sale left:', e.message);
    }
  }
  return withStoredSaleNumber({ id: localId, status: 'upserted' }, stored, fyStart);
}

async function upsertPurchase(client, storePk, doc, hint = null) {
  const requestedId = Number(doc?.id ?? doc?.local_id ?? 0);
  let { localId, clientUuid } = await resolveLocalIdByClientUuid(
    client, 'purchases', storePk, doc,
  );
  if (!Number.isFinite(localId) || localId <= 0) {
    throw new AppError(400, 'Document id required');
  }

  // Every header column, so an edit that leaves a field out can keep it (below).
  const loadPurchase = (id) => client.query(
    `SELECT id, version, updated_at, device_id, deleted, purchase_no,
            fy_start_year, fy_serial, client_uuid,
            supplier_id, purchase_date, bill_number, subtotal, total_gst, cgst, sgst,
            total_amount, overall_discount, rounding, need_to_pay, final_amount,
            amount_paid, amount_paid_at_entry, cash_paid_at_entry, online_paid_at_entry,
            previous_due, previous_credit, due, current_credit, total_due, due_amount,
            credit_amount, paid_due, bill_cleared, account_cleared, gst_calc_method,
            expenditure, is_autosave, supplier_name, supplier_phone, item_count
     FROM purchases WHERE store_pk=$1 AND local_id=$2`,
    [storePk, id]
  );

  let existing = await loadPurchase(localId);

  // Purchase edit of a bill that has no client_uuid (typical after import):
  // a new uuid remaps to a fresh local_id, then INSERT reuses purchase_no and
  // hits purchases_store_pk_purchase_no_key. Stay on the original bill.
  // New purchase save is unchanged: requested local_id is unused, so this is skipped.
  if (!existing.rows[0] && requestedId > 0 && requestedId !== localId) {
    const orig = await loadPurchase(requestedId);
    const origRow = orig.rows[0];
    if (origRow) {
      const origUuid = origRow.client_uuid ? String(origRow.client_uuid).trim() : '';
      const docNo = String(doc.purchase_no || '').trim();
      const origNo = String(origRow.purchase_no || '').trim();
      const sameBill = !origUuid || origUuid === (clientUuid || '') || !docNo || docNo === origNo;
      if (sameBill) {
        localId = requestedId;
        existing = orig;
      }
    }
  }

  const meta = syncMeta(doc);
  if (shouldAcceptIncoming(existing.rows[0], { ...meta }) === 'skip') {
    await persistClientUuid(client, 'purchases', storePk, localId, clientUuid);
    // A retried push is answered with the number the store holds for this purchase.
    return withStoredPurchaseNumber({ id: localId, status: 'skipped' }, existing.rows[0]);
  }
  const existingRow = existing.rows[0] || null;

  // A field the client left out keeps what the row holds; only a field sent with a
  // real value is written. The UPDATE used to write Number(undefined || 0) for every
  // missing column: the PC's supplier-payment step re-pushes purchases from a list
  // that carries only the due fields, and on 2026-09-11 that zeroed total_amount,
  // subtotal and total_gst on 99/FY2026-27 and 105/FY2026-27 (store 4, Rs 7,117.98).
  // Same rule upsertSale already applies to its money fields. A new row (no
  // existingRow) is written exactly as before.
  const sent = (key) => Object.prototype.hasOwnProperty.call(doc, key) && doc[key] !== undefined;
  const filled = (key) => sent(key) && doc[key] !== null && doc[key] !== '';
  const money = (key) => {
    if (filled(key)) return Number(doc[key]);
    if (existingRow && existingRow[key] != null) return Number(existingRow[key]);
    return 0;
  };
  const text = (key) => {
    if (sent(key)) return doc[key] || null;
    return existingRow ? (existingRow[key] ?? null) : null;
  };
  const flag = (key) => {
    if (sent(key)) return toBool(doc[key]);
    return existingRow ? Boolean(existingRow[key]) : false;
  };
  const supplierIdValue = sent('supplier_id')
    ? (doc.supplier_id ?? null)
    : (existingRow?.supplier_id ?? null);
  const purchaseDate = filled('purchase_date') || !existingRow
    ? doc.purchase_date
    : existingRow.purchase_date;
  const isAutosave = flag('is_autosave');
  const itemCount = Array.isArray(doc.items)
    ? doc.items.length
    : (filled('item_count') ? (Number(doc.item_count) || 0) : Number(existingRow?.item_count || 0));

  const fyFromDate = fyStartYearForDate(purchaseDate);
  const dateKnown = purchaseDate != null && String(purchaseDate).trim() !== '';
  const storedNo = existingRow ? String(existingRow.purchase_no || '').trim() : '';
  let fyStart;
  let fySerial;
  let purchaseNo;

  if (existingRow) {
    // An edit keeps the store's number -- unless that number is filed under another
    // financial year than the purchase's own date. Owner's rule (2026-09-13): the /FY
    // tag is tested against the date on ANY edit, so a stale tag re-files. The UPDATE
    // used to leave purchase_no alone while fy_start_year and fy_serial moved, so the
    // store kept "5/FY2025-26" filed as serial 8 of FY2026-27 while the phone showed 8.
    purchaseNo = storedNo;
    const heldFy = fyStartYearInCode(storedNo);
    if (heldFy != null) {
      fyStart = heldFy;
      // fy_serial always follows the number it belongs to.
      fySerial = purchaseSerialInCode(storedNo) ?? existingRow.fy_serial ?? null;
    } else {
      // No /FY tag (an old PUR... or APU... number): never renumbered and never stamped
      // with a serial. A stamped serial counts towards the year's highest live number,
      // so the next real purchase would skip one (store 127 holds 138 such purchases).
      fyStart = dateKnown ? fyFromDate : (existingRow.fy_start_year ?? fyFromDate);
      fySerial = existingRow.fy_serial ?? null;
    }
    if (!purchaseNo) {
      fyStart = fyFromDate;
      fySerial = await serialWhenMissing(client, storePk, 'purchases', fyStart, localId);
      purchaseNo = encodePurchaseNo(fySerial, fyStart);
    } else if (
      heldFy != null && dateKnown && heldFy !== Number(fyFromDate)
      && !meta.deleted && !isAutosave
    ) {
      console.warn(
        `[fy] purchase local_id=${localId} store=${storePk} number ${storedNo} is filed ` +
        `under FY ${heldFy} but dated ${purchaseDate}; refiling under FY ${fyFromDate}`
      );
      fyStart = fyFromDate;
      fySerial = await reallocateSerialForFy(client, storePk, 'purchases', fyStart, localId);
      purchaseNo = encodePurchaseNo(fySerial, fyStart);
    }
  } else {
    purchaseNo = String(doc.purchase_no || '').trim();
    fyStart = Number(doc.fy_start_year) || fyFromDate;
    fySerial = Number(doc.fy_serial) || null;
    // The year must match the bill's own date, whatever the client claimed. A number
    // that carries a /FY tag claims that year.
    const claimedFy = fyStartYearInCode(purchaseNo) ?? fyStart;
    if (doc.purchase_date && Number(claimedFy) !== Number(fyFromDate)) {
      console.warn(
        `[fy] purchase local_id=${localId} store=${storePk} claimed FY ${claimedFy} ` +
        `for date ${doc.purchase_date}; refiling under FY ${fyFromDate}`
      );
      fyStart = fyFromDate;
      fySerial = await reallocateSerialForFy(client, storePk, 'purchases', fyStart, localId);
      purchaseNo = encodePurchaseNo(fySerial, fyStart);
    }
    const inCode = purchaseSerialInCode(purchaseNo);
    if (inCode != null && fyStartYearInCode(purchaseNo) === Number(fyStart)) {
      // The serial is the one in the number, never a different one sent beside it.
      fySerial = inCode;
    } else if (!purchaseNo || !fySerial) {
      // No number at all. Never fall back to the row's internal id.
      if (!fySerial) {
        fySerial = await serialWhenMissing(client, storePk, 'purchases', fyStart, localId);
      }
      purchaseNo = encodePurchaseNo(fySerial, fyStart);
    }
  }

  // Another LIVE purchase holding this number: the client was handed a number someone
  // else saved first. Deleted rows do not count -- uq_purchases_live_purchase_no ignores
  // them -- and counting them made the purchase after a deleted newest one skip its
  // number (262/FY2025-26, store 4). The next number is the year's highest LIVE number
  // + 1 (owner's rule), and fy_serial moves with it.
  if (purchaseNo !== storedNo && !meta.deleted
      && await livePurchaseNoTaken(client, storePk, purchaseNo, localId)) {
    const taken = purchaseNo;
    await lockFySeries(client, storePk, 'purchases', fyStart);
    let serial = (await maxExistingFySerial(client, storePk, 'purchases', Number(fyStart), localId)) + 1;
    purchaseNo = encodePurchaseNo(serial, fyStart);
    for (let i = 0; i < 50 && await livePurchaseNoTaken(client, storePk, purchaseNo, localId); i += 1) {
      serial += 1;
      purchaseNo = encodePurchaseNo(serial, fyStart);
    }
    fySerial = serial;
    console.warn(
      `[fy] purchase local_id=${localId} store=${storePk} number ${taken} is held by ` +
      `another live purchase; stored as ${purchaseNo}`
    );
  }

  const moneyFields = [
    supplierIdValue, purchaseDate, text('bill_number'),
    money('subtotal'), money('total_gst'), money('cgst'), money('sgst'),
    money('total_amount'), money('overall_discount'), money('rounding'),
    money('need_to_pay'), money('final_amount'), money('amount_paid'),
    money('amount_paid_at_entry'), money('cash_paid_at_entry'),
    money('online_paid_at_entry'), money('previous_due'), money('previous_credit'),
    money('due'), money('current_credit'), money('total_due'),
    money('due_amount'), money('credit_amount'), money('paid_due'),
    flag('bill_cleared'), flag('account_cleared'), text('gst_calc_method'),
    money('expenditure'), isAutosave, fyStart, fySerial,
    text('supplier_name'), text('supplier_phone'),
    itemCount,
    writeTimestamp(meta, existingRow), meta.version, meta.device_id, meta.deleted, meta.sync_status,
  ];

  let result;
  if (existingRow) {
    result = await client.query(
      `UPDATE purchases SET
         supplier_id=$3, purchase_date=$4, bill_number=$5,
         subtotal=$6, total_gst=$7, cgst=$8, sgst=$9, total_amount=$10,
         overall_discount=$11, rounding=$12, need_to_pay=$13, final_amount=$14,
         amount_paid=$15, amount_paid_at_entry=$16, cash_paid_at_entry=$17,
         online_paid_at_entry=$18, previous_due=$19, previous_credit=$20,
         due=$21, current_credit=$22, total_due=$23, due_amount=$24,
         credit_amount=$25, paid_due=$26, bill_cleared=$27, account_cleared=$28,
         gst_calc_method=$29, expenditure=$30, is_autosave=$31,
         fy_start_year=$32, fy_serial=$33, supplier_name=$34, supplier_phone=$35,
         item_count=$36, updated_at=$37, version=$38, device_id=$39,
         deleted=$40, sync_status=$41, purchase_no=$42
       WHERE store_pk=$1 AND local_id=$2
       RETURNING id, purchase_no, fy_start_year`,
      [storePk, localId, ...moneyFields, purchaseNo]
    );
  } else {
    result = await client.query(
      `INSERT INTO purchases (
         store_pk, local_id, purchase_no, supplier_id, purchase_date, bill_number,
         subtotal, total_gst, cgst, sgst, total_amount, overall_discount, rounding,
         need_to_pay, final_amount, amount_paid, amount_paid_at_entry, cash_paid_at_entry,
         online_paid_at_entry, previous_due, previous_credit, due, current_credit, total_due,
         due_amount, credit_amount, paid_due, bill_cleared, account_cleared, gst_calc_method,
         expenditure, is_autosave, fy_start_year, fy_serial, supplier_name, supplier_phone,
         item_count, created_at, updated_at, version, device_id, deleted, sync_status
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
         $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43
       )
       RETURNING id, purchase_no, fy_start_year`,
      [
        storePk, localId, purchaseNo, ...moneyFields.slice(0, -5),
        createdAtOrNow(doc), ...moneyFields.slice(-5),
      ]
    );
  }
  const stored = result.rows[0];
  const purchasePk = stored.id;
  if (Array.isArray(doc.items)) {
    await client.query(`DELETE FROM purchase_items WHERE purchase_id = $1`, [purchasePk]);
    const incomingItems = doc.items;
    const medUnit = await loadMedicineUnits(client, storePk, incomingItems);
    await multiInsert(
      client,
      'purchase_items',
      [
        'store_pk', 'purchase_id', 'medicine_id', 'name', 'qty', 'free_qty', 'type', 'hsn_code', 'gst_pct',
        'mrp', 'rate', 'manufacturer', 'batch_no', 'expiry_date', 'schedule', 'discount_pct',
        'taxable', 'gst_amt', 'item_amount', 'unit', 'tablets_per_stripe',
      ],
      incomingItems.map((it) => {
        const pack = purchaseItemPack(it, medUnit.get(Number(it.medicine_id)));
        return [
          storePk, purchasePk, it.medicine_id ?? null,
          it.name || it.medicine_name || null,
          Number(it.qty || 0), Number(it.free_qty || 0), it.type || null, it.hsn_code || null,
          Number(it.gst_pct ?? it.gst_percent ?? 0), Number(it.mrp || 0), Number(it.rate || 0),
          it.manufacturer || null, it.batch_no || null, it.expiry_date || null, it.schedule || null,
          Number(it.discount_pct ?? it.discount_percent ?? 0),
          Number(it.taxable || 0), Number(it.gst_amt ?? it.gst_value ?? 0),
          Number(it.item_amount ?? it.amount ?? 0),
          pack.unit, pack.tablets_per_stripe,
        ];
      })
    );
  }
  if (!existingRow && fyStart && fySerial && !isAutosave) {
    await client.query(
      `INSERT INTO fy_serials (store_pk, kind, fy_start_year, last_serial)
       VALUES ($1, 'purchases', $2, $3)
       ON CONFLICT (store_pk, kind, fy_start_year) DO UPDATE
         SET last_serial = GREATEST(fy_serials.last_serial, EXCLUDED.last_serial)`,
      [storePk, fyStart, Number(fySerial)]
    );
  }
  await persistClientUuid(client, 'purchases', storePk, localId, clientUuid);
  const storedNow = String(stored.purchase_no || '');
  const askedNo = String(doc.purchase_no || '').trim();
  if (existingRow ? storedNo !== storedNow : (askedNo !== '' && askedNo !== storedNow)) {
    await noteNumberChange(client, storePk, {
      action: existingRow ? 'purchase_no_changed' : 'purchase_no_reassigned',
      localId,
      from: existingRow ? storedNo : askedNo,
      to: storedNow,
      deviceId: meta.device_id,
      detail: { purchase_date: purchaseDate ?? null, version: meta.version },
    });
  }
  const supplierId = Number(supplierIdValue);
  if (supplierId > 0) {
    try {
      const cascaded = await cascadeSupplierAfterLedgerChange(client, storePk, supplierId, hint);
      await noteCascadeChanges(client, hint, storePk, 'suppliers', supplierId, 'purchases', cascaded);
    } catch (e) {
      console.warn('[cascade] supplier after purchase:', e.message);
    }
  }
  // An edit that moved the purchase to another supplier: the one it left is owed less.
  // Store 4, 6 Oct 2026: purchase 106 went from TULJAI to VINOD and TULJAI's due kept the
  // Rs 1503 of a bill it no longer had.
  const leftSupplier = Number(existingRow?.supplier_id);
  if (leftSupplier > 0 && leftSupplier !== supplierId) {
    try {
      const cascaded = await cascadeSupplierAfterLedgerChange(client, storePk, leftSupplier, hint);
      await noteCascadeChanges(client, hint, storePk, 'suppliers', leftSupplier, 'purchases', cascaded);
    } catch (e) {
      console.warn('[cascade] supplier the purchase left:', e.message);
    }
  }
  return withStoredPurchaseNumber({ id: localId, status: 'upserted' }, stored, fyStart);
}

/** Turn a temporary id into a real one before a payment is stored.
 *
 *  A client that cannot reach the id allocator stamps a temporary NEGATIVE id
 *  on the record so it can queue. If that id is stored as the payment's
 *  permanent local_id the shop can never delete the payment again -- the app
 *  looks it up and reports "payment not found". Ten payments were stranded that
 *  way in one store, including an accidental duplicate that left the supplier's
 *  due short by its own amount.
 */
async function realPaymentLocalId(client, storePk, table, localId) {
  if (Number(localId) > 0) return Number(localId);
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(local_id),0) AS mx FROM ${table}
      WHERE store_pk=$1 AND local_id > 0 AND local_id < ${LEGACY_ID_LIMIT}`,
    [storePk]
  );
  const next = Math.max(1, Number(rows[0].mx) + 1);
  console.warn(`[ids] ${table} arrived with temporary id ${localId}; stored as ${next}`);
  return next;
}

async function upsertCustomerPayment(client, storePk, doc, hint = null) {
  const localId = await realPaymentLocalId(client, storePk, 'customer_payments', localIdOf(doc));
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT version, updated_at, device_id, deleted FROM customer_payments WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (shouldAcceptIncoming(existing.rows[0], { ...meta }) === 'skip') return { id: localId, status: 'skipped' };
  await client.query(
    `INSERT INTO customer_payments (
       store_pk, local_id, customer_id, customer_name, payment_date, amount, payment_mode,
       cash_amount, online_amount, reference_no, note, created_at,
       updated_at, version, device_id, deleted, sync_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (store_pk, local_id) DO UPDATE SET
       customer_id=EXCLUDED.customer_id, customer_name=EXCLUDED.customer_name,
       payment_date=EXCLUDED.payment_date, amount=EXCLUDED.amount, payment_mode=EXCLUDED.payment_mode,
       cash_amount=EXCLUDED.cash_amount, online_amount=EXCLUDED.online_amount,
       reference_no=EXCLUDED.reference_no, note=EXCLUDED.note,
       updated_at=EXCLUDED.updated_at, version=EXCLUDED.version, device_id=EXCLUDED.device_id,
       deleted=EXCLUDED.deleted, sync_status=EXCLUDED.sync_status`,
    [
      storePk, localId, Number(doc.customer_id), doc.customer_name || null, doc.payment_date,
      Number(doc.amount || 0), doc.payment_mode || 'cash',
      Number(doc.cash_amount || 0), Number(doc.online_amount || 0),
      doc.reference_no || null, doc.note || null, createdAtOrNow(doc),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  const customerId = Number(doc.customer_id);
  if (customerId > 0) {
    try {
      const cascaded = await cascadeCustomerAfterLedgerChange(client, storePk, customerId, hint);
      await noteCascadeChanges(client, hint, storePk, 'customers', customerId, 'sales', cascaded);
    } catch (e) {
      console.warn('[cascade] customer after payment:', e.message);
    }
  }
  return { id: localId, status: 'upserted' };
}

async function upsertSupplierPayment(client, storePk, doc, hint = null) {
  const localId = await realPaymentLocalId(client, storePk, 'supplier_payments', localIdOf(doc));
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT version, updated_at, device_id, deleted FROM supplier_payments WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (shouldAcceptIncoming(existing.rows[0], { ...meta }) === 'skip') return { id: localId, status: 'skipped' };
  const paymentNo = doc.payment_no || `SP${localId}`;
  await client.query(
    `INSERT INTO supplier_payments (
       store_pk, local_id, payment_no, supplier_id, supplier_name, payment_date, amount, mode,
       reference, due_before, due_after, created_at,
       updated_at, version, device_id, deleted, sync_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (store_pk, local_id) DO UPDATE SET
       payment_no=EXCLUDED.payment_no, supplier_id=EXCLUDED.supplier_id, supplier_name=EXCLUDED.supplier_name,
       payment_date=EXCLUDED.payment_date, amount=EXCLUDED.amount, mode=EXCLUDED.mode,
       reference=EXCLUDED.reference, due_before=EXCLUDED.due_before, due_after=EXCLUDED.due_after,
       updated_at=EXCLUDED.updated_at, version=EXCLUDED.version, device_id=EXCLUDED.device_id,
       deleted=EXCLUDED.deleted, sync_status=EXCLUDED.sync_status`,
    [
      storePk, localId, paymentNo, Number(doc.supplier_id), doc.supplier_name || null, doc.payment_date,
      Number(doc.amount || 0), doc.mode || 'Cash', doc.reference || null,
      Number(doc.due_before || 0), Number(doc.due_after || 0), createdAtOrNow(doc),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  const supplierId = Number(doc.supplier_id);
  if (supplierId > 0) {
    try {
      const cascaded = await cascadeSupplierAfterLedgerChange(client, storePk, supplierId, hint);
      await noteCascadeChanges(client, hint, storePk, 'suppliers', supplierId, 'purchases', cascaded);
    } catch (e) {
      console.warn('[cascade] supplier after payment:', e.message);
    }
  }
  return { id: localId, status: 'upserted' };
}

/**
 * Coerce a client date into something a NOT NULL `date` column accepts.
 *
 * sales_returns.return_date / purchase_returns.return_date are `date NOT NULL`
 * with no default, but were bound straight from the document. Clients omitting the
 * field — or sending a truncated string like "202" / "-12-01" — made the INSERT throw,
 * which aborted the WHOLE bundle transaction and discarded every other row in the push.
 * That was 546 of the 651 recorded HTTP 500s on /api/sync/bundle.
 *
 * Backward compatible: a valid date is returned unchanged; only previously-fatal
 * values are rescued.
 */
/**
 * Emit changelog entries for everything a party-due cascade just rewrote.
 *
 * The cascade FIFO-clears bills and updates the party total directly in SQL. Without
 * this, those writes carry no revision, so clients syncing via /api/sync/changes/full
 * never learn the bills were cleared — the party total moves but the individual bills
 * stay "unpaid" on every other device. That is the "payment not clearing all bills" bug.
 */
async function noteCascadeChanges(
  client, hint, storePk, partyCollection, partyLocalId, billCollection, cascaded,
  { includeParty = true } = {},
) {
  if (!hint) return;
  const entries = [];
  const pid = Number(partyLocalId);
  if (pid > 0 && includeParty) {
    entries.push(acceptedChangeEntry(storePk, partyCollection, { id: pid, local_id: pid }, 'upserted', { localId: pid }));
  }
  for (const lid of cascaded?.dirtyLocalIds || []) {
    const v = Number(lid);
    if (!Number.isFinite(v) || v <= 0) continue;
    entries.push(acceptedChangeEntry(storePk, billCollection, { id: v, local_id: v }, 'upserted', { localId: v }));
  }
  await noteAcceptedChangeMany(client, hint, entries);
}

/**
 * A pushed customer's or supplier's due and credit are the ledger's, not the device's.
 *
 * upsertCustomer / upsertSupplier (and the bulk path) stored whatever total the device
 * sent. A device that rebuilt the figure from a stale catalogue, or replayed a queued
 * push, overwrote a correct balance: store 127 had customers owing Rs 809 that exists
 * only on abandoned drafts, and the PC queue replay doubled a customer's due.
 *
 * The device's figure is still written first (so the row exists and old clients keep
 * working), then the party cascade recomputes it from bills, payments and returns and
 * clears the bills FIFO. The party row is rewritten -- new version, updated_at NOW()
 * -- only when the device's figure was wrong, so that device pulls the real one next
 * time and a device that was right is not made to re-pull. Its own savepoint: a
 * failure here leaves the push exactly as it was before this existed.
 */
async function recomputePartyAfterPush(client, hint, storePk, collection, localId) {
  const pid = Number(localId);
  if (!(pid > 0)) return null;
  const isSupplier = collection === 'suppliers';
  const sp = `sp_party_${++_spSeq}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    const cascaded = isSupplier
      ? await cascadeSupplierAfterLedgerChange(client, storePk, pid, hint, { onlyIfChanged: true })
      : await cascadeCustomerAfterLedgerChange(client, storePk, pid, hint, { onlyIfChanged: true });
    await noteCascadeChanges(
      client, hint, storePk, collection, pid, isSupplier ? 'purchases' : 'sales', cascaded,
      { includeParty: Boolean(cascaded?.partyUpdated) },
    );
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return cascaded;
  } catch (e) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    console.warn(`[cascade] ${collection}/${pid} after push:`, e.message);
    return null;
  }
}

/**
 * A return changes the party balance — the cascade already subtracts
 * SUM(refund_amount) — but nothing called it from the return handlers, so the due
 * stayed stale until an unrelated sale or payment happened to run it.
 */
async function cascadeAfterSalesReturn(client, storePk, doc, hint) {
  const customerId = Number(doc?.customer_id);
  if (!(customerId > 0)) return;
  try {
    const c = await cascadeCustomerAfterLedgerChange(client, storePk, customerId, hint);
    await noteCascadeChanges(client, hint, storePk, 'customers', customerId, 'sales', c);
  } catch (e) {
    console.warn('[cascade] customer after sales return:', e.message);
  }
}

async function cascadeAfterPurchaseReturn(client, storePk, doc, hint) {
  const supplierId = Number(doc?.supplier_id);
  if (!(supplierId > 0)) return;
  try {
    const c = await cascadeSupplierAfterLedgerChange(client, storePk, supplierId, hint);
    await noteCascadeChanges(client, hint, storePk, 'suppliers', supplierId, 'purchases', c);
  } catch (e) {
    console.warn('[cascade] supplier after purchase return:', e.message);
  }
}

let _spSeq = 0;

/**
 * The Postgres SQLSTATE of a failed document (40P01 deadlock, 55P03 lock timeout,
 * 57014 cancel, 23505 unique...), so a client can tell a temporary refusal from a
 * permanent one without reading the message. null when the failure is not a Postgres
 * error (a refused document, a stock-op conflict).
 */
function sqlStateOf(err) {
  const c = err?.code;
  return typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c) ? c : null;
}

/**
 * Run one document's upsert inside a SAVEPOINT so a bad row cannot destroy the batch.
 *
 * pushBundle wraps the entire push in one transaction. Before this, ONE malformed
 * document aborted the transaction and discarded every other sale, purchase, medicine
 * and payment in the same push — 651 of 2278 bundle pushes (28.6%) failed that way.
 *
 * Backward compatible: successful documents return exactly what they returned before.
 * A failing document previously produced HTTP 500 and lost the batch; it now yields a
 * per-document {status:'failed'} entry while its siblings commit. Older clients ignore
 * the extra field and simply stop losing data.
 */
async function applyIsolated(client, collection, doc, run) {
  const sp = `sp_${++_spSeq}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    const r = await run();
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return r;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    let localId = null;
    try { localId = localIdOf(doc); } catch { /* malformed doc */ }
    console.error(
      `[sync] ${collection}/${localId ?? '?'} rejected, batch continues:`,
      err.message,
    );
    return {
      id: localId, status: 'failed', error: err.message, constraint: err.constraint || null,
      code: sqlStateOf(err),
    };
  }
}

function requiredDate(...candidates) {
  for (const c of candidates) {
    const d = parseDateOnly(c);
    if (d) return d;
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function upsertSalesReturn(client, storePk, doc, hint = null) {
  const localId = localIdOf(doc);
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT id, version, updated_at, device_id, deleted FROM sales_returns WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (shouldAcceptIncoming(existing.rows[0], { ...meta }) === 'skip') {
    // A re-pushed return must still settle the ledger, or the refund is never applied.
    await cascadeAfterSalesReturn(client, storePk, doc, hint);
    return { id: localId, status: 'skipped' };
  }
  const returnNo = doc.return_no || `SR${localId}`;
  const result = await client.query(
    `INSERT INTO sales_returns (
       store_pk, local_id, return_no, sale_id, bill_no, customer_id, customer_name,
       return_date, refund_amount, discount, reason, item_count, created_at,
       updated_at, version, device_id, deleted, sync_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (store_pk, local_id) DO UPDATE SET
       return_no=EXCLUDED.return_no, sale_id=EXCLUDED.sale_id, bill_no=EXCLUDED.bill_no,
       customer_id=EXCLUDED.customer_id, customer_name=EXCLUDED.customer_name,
       return_date=EXCLUDED.return_date, refund_amount=EXCLUDED.refund_amount,
       discount=EXCLUDED.discount, reason=EXCLUDED.reason, item_count=EXCLUDED.item_count,
       updated_at=EXCLUDED.updated_at, version=EXCLUDED.version, device_id=EXCLUDED.device_id,
       deleted=EXCLUDED.deleted, sync_status=EXCLUDED.sync_status
     RETURNING id`,
    [
      storePk, localId, returnNo, doc.sale_id ?? null, doc.bill_no || null,
      doc.customer_id ?? null, doc.customer_name || null,
      requiredDate(doc.return_date, doc.created_at),
      Number(doc.refund_amount || 0), Number(doc.discount || 0), doc.reason || null,
      Number(doc.item_count || (doc.items?.length || 0)), createdAtOrNow(doc),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  const retPk = result.rows[0].id;
  await client.query(`DELETE FROM sales_return_items WHERE return_id = $1`, [retPk]);
  await multiInsert(
    client,
    'sales_return_items',
    ['store_pk', 'return_id', 'medicine_id', 'name', 'batch_no', 'qty', 'rate', 'amount'],
    (doc.items || []).map((it) => [
      storePk, retPk, it.medicine_id ?? null, it.name || null, it.batch_no || it.batch || null,
      Number(it.qty || 0), Number(it.rate || 0), Number(it.amount || 0),
    ])
  );
  await cascadeAfterSalesReturn(client, storePk, doc, hint);
  return { id: localId, status: 'upserted' };
}

async function upsertPurchaseReturn(client, storePk, doc, hint = null) {
  const localId = localIdOf(doc);
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT id, version, updated_at, device_id, deleted FROM purchase_returns WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (shouldAcceptIncoming(existing.rows[0], { ...meta }) === 'skip') {
    await cascadeAfterPurchaseReturn(client, storePk, doc, hint);
    return { id: localId, status: 'skipped' };
  }
  const returnNo = doc.return_no || `PR${localId}`;
  const result = await client.query(
    `INSERT INTO purchase_returns (
       store_pk, local_id, return_no, purchase_id, purchase_no, supplier_id, supplier_name,
       return_date, refund_amount, discount, reason, item_count, created_at,
       updated_at, version, device_id, deleted, sync_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (store_pk, local_id) DO UPDATE SET
       return_no=EXCLUDED.return_no, purchase_id=EXCLUDED.purchase_id, purchase_no=EXCLUDED.purchase_no,
       supplier_id=EXCLUDED.supplier_id, supplier_name=EXCLUDED.supplier_name,
       return_date=EXCLUDED.return_date, refund_amount=EXCLUDED.refund_amount,
       discount=EXCLUDED.discount, reason=EXCLUDED.reason, item_count=EXCLUDED.item_count,
       updated_at=EXCLUDED.updated_at, version=EXCLUDED.version, device_id=EXCLUDED.device_id,
       deleted=EXCLUDED.deleted, sync_status=EXCLUDED.sync_status
     RETURNING id`,
    [
      storePk, localId, returnNo, doc.purchase_id ?? null, doc.purchase_no || null,
      doc.supplier_id ?? null, doc.supplier_name || null,
      requiredDate(doc.return_date, doc.created_at),
      Number(doc.refund_amount || 0), Number(doc.discount || 0), doc.reason || null,
      Number(doc.item_count || (doc.items?.length || 0)), createdAtOrNow(doc),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  const retPk = result.rows[0].id;
  await client.query(`DELETE FROM purchase_return_items WHERE return_id = $1`, [retPk]);
  await multiInsert(
    client,
    'purchase_return_items',
    ['store_pk', 'return_id', 'medicine_id', 'name', 'batch_no', 'qty', 'rate', 'amount'],
    (doc.items || []).map((it) => [
      storePk, retPk, it.medicine_id ?? null, it.name || null, it.batch_no || it.batch || null,
      Number(it.qty || 0), Number(it.rate || 0), Number(it.amount || 0),
    ])
  );
  await cascadeAfterPurchaseReturn(client, storePk, doc, hint);
  return { id: localId, status: 'upserted' };
}

const UPSERT_MAP = {
  customers: upsertCustomer,
  suppliers: upsertSupplier,
  doctors: upsertDoctor,
  medicines: upsertMedicine,
  sales: upsertSale,
  purchases: upsertPurchase,
  customer_payments: upsertCustomerPayment,
  supplier_payments: upsertSupplierPayment,
  sales_returns: upsertSalesReturn,
  purchase_returns: upsertPurchaseReturn,
  general_products: upsertGeneralProduct,
  stock_disposals: upsertStockDisposal,
  pending_orders: upsertPendingOrder,
  racks: upsertRack,
  sections: upsertSection,
  boxes: upsertBox,
  shelves: upsertShelf,
  medicine_shelf: upsertMedicineShelf,
  medicine_suppliers: upsertMedicineSupplier,
};

export async function pushDocs(storePk, collection, docs) {
  const hint = newSyncHint(storePk);

  if (collection === 'stock_operations') {
    if (!Array.isArray(docs) || !docs.length) return { results: [], upserted: 0, skipped: 0 };
    const out = await withTransaction(async (client) => {
      await lockStorePush(client, storePk);
      await ensureStoreSyncState(client, storePk);
      const results = [];
      let upserted = 0;
      let skipped = 0;
      let failed = 0;
      for (const doc of docs) {
        const r = await applyStockOperation(client, storePk, doc, hint);
        results.push(r.status === 'failed' ? { ...r, code: r.code ?? null } : r);
        if (r.status === 'applied') upserted++;
        else if (r.status === 'failed') failed++;
        else skipped++;
      }
      return { results, upserted, skipped, failed };
    });
    emitSyncHint(hint);
    return { ...out, revisions: hint.revisions.slice() };
  }

  if (collection === 'settings') {
    const out = await withTransaction(async (client) => {
      await ensureStoreSyncState(client, storePk);
      const result = await upsertSettingsKv(client, storePk, docs);
      if (result.upserted > 0) {
        await noteAcceptedChange(client, hint, storePk, 'settings', null, 'upserted', {
          localId: 0,
          deviceId: Array.isArray(docs) ? docs[0]?.device_id : docs?.device_id,
        });
      }
      return result;
    });
    emitSyncHint(hint);
    return out;
  }
  if (collection === 'shelf_settings') {
    const out = await withTransaction(async (client) => {
      await ensureStoreSyncState(client, storePk);
      const doc = Array.isArray(docs) ? docs[0] : docs;
      const r = await upsertShelfSettings(client, storePk, doc);
      if (isAcceptedWrite(r.status)) {
        await noteAcceptedChange(client, hint, storePk, 'shelf_settings', doc, r.status, {
          localId: 0,
        });
      }
      return {
        results: [r],
        upserted: isAcceptedWrite(r.status) ? 1 : 0,
        skipped: isAcceptedWrite(r.status) ? 0 : 1,
      };
    });
    emitSyncHint(hint);
    return out;
  }
  const fn = UPSERT_MAP[collection];
  if (!fn) throw new AppError(400, `Unknown collection: ${collection}`);
  if (!Array.isArray(docs) || !docs.length) return { results: [], upserted: 0, skipped: 0 };

  const out = await withTransaction(async (client) => {
    await lockStorePush(client, storePk);
    await ensureStoreSyncState(client, storePk);
    if (FLAT_BULK.has(collection)) {
      return pushFlatBulk(client, storePk, collection, docs, hint);
    }
    const results = [];
    let upserted = 0;
    let skipped = 0;
    let failed = 0;
    const accepted = [];
    for (const doc of docs) {
      const r = await applyIsolated(client, collection, doc, () => fn(client, storePk, doc, hint));
      results.push(r);
      if (r.status === 'failed') {
        failed++;
      } else if (isAcceptedWrite(r.status)) {
        upserted++;
        accepted.push(acceptedChangeEntry(storePk, collection, doc, r.status, {
          localId: r.id,
        }));
      } else {
        skipped++;
      }
    }
    await noteAcceptedChangeMany(client, hint, accepted);
    return { results, upserted, skipped, failed };
  });
  emitSyncHint(hint);
  return { ...out, revisions: hint.revisions.slice() };
}

export async function pushBundle(storePk, bundle) {
  const hint = newSyncHint(storePk);
  const summary = await withTransaction((client) => applyBundleInTx(client, storePk, bundle, hint));
  emitSyncHint(hint);
  return { ...summary, revisions: hint.revisions.slice() };
}

/** Writes that move stock or ledgers for one store run one at a time (the nightly check
 *  reads stock and the ledger under the same lock, so it never sees half a push). */
export async function lockStorePush(client, storePk) {
  await client.query(`SELECT pg_advisory_xact_lock(4242, $1::int)`, [Number(storePk)]);
}

/**
 * Everything pushBundle does, inside the caller's transaction, so a caller (sync v2) can
 * write its own records in the same transaction: all of it lands, or none of it.
 */
export async function applyBundleInTx(client, storePk, bundle, hint) {
  // Masters first, then transactions, then local feature tables
  const order = [
    'customers', 'suppliers', 'medicines', 'doctors',
    'sales', 'purchases', 'customer_payments', 'supplier_payments',
    'sales_returns', 'purchase_returns',
    'general_products', 'stock_disposals', 'stock_operations', 'pending_orders',
    'racks', 'sections', 'boxes', 'shelves', 'medicine_shelf', 'medicine_suppliers',
  ];
  const summary = {};
  {
    await lockStorePush(client, storePk);
    await ensureStoreSyncState(client, storePk);
    const deferredChanges = [];
    const partyRecompute = { customers: new Set(), suppliers: new Set() };
    for (const col of order) {
      const docs = bundle[col];
      if (!docs?.length) continue;
      if (col === 'stock_operations') {
        const results = [];
        let upserted = 0;
        let skipped = 0;
        let failed = 0;
        for (const doc of docs) {
          const r = await applyStockOperation(client, storePk, doc, hint);
          results.push(r.status === 'failed' ? { ...r, code: r.code ?? null } : r);
          if (r.status === 'applied') upserted++;
          else if (r.status === 'failed') failed++;
          else skipped++;
        }
        summary[col] = { results, upserted, skipped, failed };
        continue;
      }
      if (FLAT_BULK.has(col)) {
        summary[col] = await pushFlatBulk(client, storePk, col, docs, hint, partyRecompute);
        continue;
      }
      const fn = UPSERT_MAP[col];
      const results = [];
      let upserted = 0;
      let skipped = 0;
      let failed = 0;
      for (const doc of docs) {
        const r = await applyIsolated(client, col, doc, () => fn(client, storePk, doc, hint));
        results.push(r);
        if (r.status === 'failed') {
          failed++;
        } else if (isAcceptedWrite(r.status)) {
          upserted++;
          deferredChanges.push(acceptedChangeEntry(storePk, col, doc, r.status, {
            localId: r.id,
          }));
        } else {
          skipped++;
        }
      }
      summary[col] = { upserted, skipped, failed, results };
    }
    // Customers and suppliers pushed in this bundle, recomputed from the ledger now that
    // every bill, payment and return in it has been applied.
    for (const partyCollection of ['customers', 'suppliers']) {
      for (const partyId of partyRecompute[partyCollection]) {
        await recomputePartyAfterPush(client, hint, storePk, partyCollection, partyId);
      }
    }
    if (bundle.pharmacy_profile) {
      const pr = await upsertPharmacyProfile(client, storePk, bundle.pharmacy_profile);
      summary.pharmacy_profile = {
        upserted: pr?.status === 'skipped' ? 0 : 1,
        skipped: pr?.status === 'skipped' ? 1 : 0,
      };
      if (isAcceptedWrite(pr?.status)) {
        deferredChanges.push(acceptedChangeEntry(
          storePk, 'pharmacy_profile', bundle.pharmacy_profile, pr.status,
          { localId: 0, entityVersion: pr.version },
        ));
      }
    }
    if (bundle.dropdowns) {
      const dr = await upsertDropdowns(client, storePk, bundle.dropdowns);
      summary.dropdowns = {
        upserted: dr?.status === 'skipped' ? 0 : 1,
        skipped: dr?.status === 'skipped' ? 1 : 0,
      };
      if (isAcceptedWrite(dr?.status)) {
        deferredChanges.push(acceptedChangeEntry(
          storePk, 'dropdowns', bundle.dropdowns, dr.status, { localId: 0 },
        ));
      }
    }
    if (bundle.shelf_settings) {
      const sr = await upsertShelfSettings(client, storePk, bundle.shelf_settings);
      summary.shelf_settings = {
        upserted: sr?.status === 'skipped' ? 0 : 1,
        skipped: sr?.status === 'skipped' ? 1 : 0,
      };
      if (isAcceptedWrite(sr?.status)) {
        deferredChanges.push(acceptedChangeEntry(
          storePk, 'shelf_settings', bundle.shelf_settings, sr.status, { localId: 0 },
        ));
      }
    }
    if (bundle.settings) {
      summary.settings = await upsertSettingsKv(client, storePk, bundle.settings);
      if (summary.settings.upserted > 0) {
        const first = Array.isArray(bundle.settings) ? bundle.settings[0] : bundle.settings;
        deferredChanges.push(acceptedChangeEntry(storePk, 'settings', null, 'upserted', {
          localId: 0,
          deviceId: first?.device_id,
        }));
      }
    }
    await noteAcceptedChangeMany(client, hint, deferredChanges);
  }
  return summary;
}

/** Soft-delete one entity and append changelog (operation=delete). */
export async function softDeleteDoc(storePk, collection, localId, deviceId = null) {
  if (!COLLECTIONS.includes(collection)) {
    throw new AppError(400, 'Unknown collection');
  }
  const hint = newSyncHint(storePk);
  const out = await withTransaction(async (client) => {
    await ensureStoreSyncState(client, storePk);
    const { rows, rowCount } = await client.query(
      `UPDATE ${collection}
       SET deleted = TRUE, updated_at = NOW(), version = version + 1,
           device_id = COALESCE($3, device_id)
       WHERE store_pk = $1 AND local_id = $2
       RETURNING version, updated_at, device_id`,
      [storePk, Number(localId), deviceId]
    );
    if (!rowCount) throw new AppError(404, 'Document not found');

    // Whatever this document was, the party's account has just changed. The
    // cascade recomputes total_due AND the per-bill account_cleared /
    // bill_cleared flags -- it ran on every upsert but never on a delete, so
    // removing the payment that had cleared a bill left that bill still marked
    // "Cleared" with no due against it.
    const PARTY_OF = {
      supplier_payments: ['suppliers', 'supplier_id'],
      purchases: ['suppliers', 'supplier_id'],
      purchase_returns: ['suppliers', 'supplier_id'],
      customer_payments: ['customers', 'customer_id'],
      sales: ['customers', 'customer_id'],
      sales_returns: ['customers', 'customer_id'],
    };
    const party = PARTY_OF[collection];
    if (party) {
      const [partyTable, fk] = party;
      try {
        const { rows: owner } = await client.query(
          `SELECT ${fk} AS pid FROM ${collection}
            WHERE store_pk = $1 AND local_id = $2 LIMIT 1`,
          [storePk, Number(localId)],
        );
        const pid = Number((owner[0] || {}).pid || 0);
        if (pid > 0) {
          const cascaded = partyTable === 'suppliers'
            ? await cascadeSupplierAfterLedgerChange(client, storePk, pid, hint)
            : await cascadeCustomerAfterLedgerChange(client, storePk, pid, hint);
          await noteCascadeChanges(client, hint, storePk, partyTable, pid, collection, cascaded);
        }
      } catch (e) {
        console.warn(`[cascade] ${partyTable} after ${collection} delete:`, e.message);
      }
    }

    await noteAcceptedChange(client, hint, storePk, collection, null, 'soft_deleted', {
      localId: Number(localId),
      entityVersion: Number(rows[0].version),
      entityUpdatedAt: rows[0].updated_at,
      deviceId: rows[0].device_id || deviceId,
    });
    return { deleted: true, id: Number(localId), status: 'soft_deleted' };
  });
  emitSyncHint(hint);
  return { ...out, revisions: hint.revisions.slice() };
}

/**
 * Permanent delete for sales / purchases (purge rows).
 * Stock restore/reverse is done by the deleting client and pushed via medicines.
 * Purchases: refuse if any item was sold.
 */
export async function hardDeleteDoc(storePk, collection, localId, deviceId = null) {
  if (collection !== 'sales' && collection !== 'purchases') {
    throw new AppError(400, 'Hard delete only supported for sales and purchases');
  }
  const lid = Number(localId);
  if (!Number.isFinite(lid) || lid <= 0) {
    throw new AppError(400, 'Invalid local id');
  }
  const hint = newSyncHint(storePk);
  const out = await withTransaction(async (client) => {
    await ensureStoreSyncState(client, storePk);
    if (collection === 'sales') {
      const { rows: sales } = await client.query(
        `SELECT id, version, fy_start_year, bill_date, customer_id FROM sales
         WHERE store_pk=$1 AND local_id=$2 LIMIT 1`,
        [storePk, lid],
      );
      if (!sales.length) {
        await noteAcceptedChange(client, hint, storePk, 'sales', null, 'hard_deleted', {
          localId: lid,
          entityVersion: 1_000_000,
          deviceId,
        });
        return { deleted: true, hard: true, id: lid, status: 'hard_deleted' };
      }
      const salePk = sales[0].id;
      const prevVer = Number(sales[0].version || 1);
      const saleFy = sales[0].fy_start_year || fyStartYearForDate(sales[0].bill_date);
      const saleCustomerId = Number(sales[0].customer_id || 0);
      await client.query(`DELETE FROM sales_items WHERE sale_id=$1`, [salePk]);
      await client.query(`DELETE FROM sales WHERE id=$1`, [salePk]);
      await rewindFySerialCounter(client, storePk, 'sales', saleFy);
      // Same gap as purchases: the balance cascade ran on upsert but never on a
      // delete, so a removed bill kept counting towards the customer's due.
      if (saleCustomerId > 0) {
        try {
          const cascaded = await cascadeCustomerAfterLedgerChange(client, storePk, saleCustomerId, hint);
          await noteCascadeChanges(client, hint, storePk, 'customers', saleCustomerId, 'sales', cascaded);
        } catch (e) {
          console.warn('[cascade] customer after sale delete:', e.message);
        }
      }
      await noteAcceptedChange(client, hint, storePk, 'sales', null, 'hard_deleted', {
        localId: lid,
        entityVersion: prevVer + 1_000_000,
        deviceId,
      });
      return { deleted: true, hard: true, id: lid, status: 'hard_deleted' };
    }

    const { rows: purchases } = await client.query(
      `SELECT id, version, fy_start_year, purchase_date, supplier_id FROM purchases
       WHERE store_pk=$1 AND local_id=$2 LIMIT 1`,
      [storePk, lid],
    );
    if (!purchases.length) {
      await noteAcceptedChange(client, hint, storePk, 'purchases', null, 'hard_deleted', {
        localId: lid,
        entityVersion: 1_000_000,
        deviceId,
      });
      return { deleted: true, hard: true, id: lid, status: 'hard_deleted' };
    }
    const purchasePk = purchases[0].id;
    const prevPurVer = Number(purchases[0].version || 1);
    const purchaseFy = purchases[0].fy_start_year
      || fyStartYearForDate(purchases[0].purchase_date);
    // Delete means delete. Refuse in one case only: goods that came in on THIS
    // bill have since been sold, so removing it would leave those sales with no
    // purchase behind them. When that happens, name the sales so the shop can
    // act instead of being told "no".
    //
    // The previous guard compared the quantity this bill added against the
    // stock on hand and refused whenever the shelf was short. That refused far
    // too much: stock runs down in the ordinary course of trade, and a bill
    // typed wrong could then never be removed. Offline has always allowed the
    // delete and let stock go negative -- the honest record of goods sold that
    // the shop can no longer account for -- so refusing here also made the two
    // modes disagree, and the client retried the refusal forever while the shop
    // was told the bill had gone and went on seeing its supplier due.
    const { rows: soldFromThis } = await client.query(
      `SELECT s.local_id            AS sale_local_id,
              COALESCE(s.bill_no,'')  AS bill_no,
              s.bill_date           AS sale_date,
              COALESCE(m.name,'')   AS medicine_name,
              SUM(COALESCE(si.qty,0))::float AS qty_sold
         FROM purchase_items pi
         JOIN sales_items si
              ON si.store_pk = pi.store_pk
             AND si.medicine_id = pi.medicine_id
         JOIN sales s
              ON s.id = si.sale_id
             AND s.store_pk = si.store_pk
             AND COALESCE(s.deleted, FALSE) = FALSE
         LEFT JOIN medicines m
              ON m.store_pk = pi.store_pk AND m.local_id = pi.medicine_id
        WHERE pi.purchase_id = $1
          AND pi.store_pk = $2
          AND s.bill_date >= COALESCE($3, s.bill_date)
        GROUP BY s.local_id, s.bill_no, s.bill_date, m.name
        ORDER BY s.bill_date DESC, s.local_id DESC
        LIMIT 25`,
      [purchasePk, storePk, purchases[0].purchase_date || null],
    );
    if (soldFromThis.length) {
      const listed = soldFromThis
        .slice(0, 8)
        .map((r) => `${r.bill_no || ('#' + r.sale_local_id)} (${r.medicine_name || 'item'} x${Number(r.qty_sold || 0)})`)
        .join(', ');
      const more = soldFromThis.length > 8 ? ` and ${soldFromThis.length - 8} more` : '';
      const err = new AppError(
        409,
        'Cannot delete this purchase - medicines from it have been sold on: '
        + `${listed}${more}. Delete or return those sales first.`,
      );
      err.details = {
        reason: 'sold_from_this_purchase',
        sales: soldFromThis.map((r) => ({
          sale_local_id: Number(r.sale_local_id),
          bill_no: r.bill_no || '',
          sale_date: r.sale_date,
          medicine_name: r.medicine_name || '',
          qty_sold: Number(r.qty_sold || 0),
        })),
      };
      throw err;
    }
    const purSupplierId = Number(purchases[0].supplier_id || 0);
    await client.query(`DELETE FROM purchase_items WHERE purchase_id=$1`, [purchasePk]);
    await client.query(`DELETE FROM purchases WHERE id=$1`, [purchasePk]);
    await rewindFySerialCounter(client, storePk, 'purchases', purchaseFy);
    // The supplier's balance still counted this bill. The cascade runs on every
    // upsert but was never called on a delete, so a removed bill went on showing
    // as due -- the shop deleted it and the due stayed.
    if (purSupplierId > 0) {
      try {
        const cascaded = await cascadeSupplierAfterLedgerChange(client, storePk, purSupplierId, hint);
        await noteCascadeChanges(client, hint, storePk, 'suppliers', purSupplierId, 'purchases', cascaded);
      } catch (e) {
        console.warn('[cascade] supplier after purchase delete:', e.message);
      }
    }
    await noteAcceptedChange(client, hint, storePk, 'purchases', null, 'hard_deleted', {
      localId: lid,
      entityVersion: prevPurVer + 1_000_000,
      deviceId,
    });
    return { deleted: true, hard: true, id: lid, status: 'hard_deleted' };
  });
  emitSyncHint(hint);
  return { ...out, revisions: hint.revisions.slice() };
}

async function upsertPharmacyProfile(client, storePk, doc) {
  // Every column used to be built as `doc.X || null` and written unconditionally,
  // so a client that OMITTED a key nulled the stored value. The desktop's
  // "push store to server" omitted logo_path, which wiped the stored logo on
  // every full push. Rule now: a key the client sent wins (an empty string still
  // clears, deliberately); a key it did not send inherits what is stored.
  //
  // DO NOT add shouldAcceptIncoming / version-LWW to this function until every
  // deployed client round-trips `version` on this collection. pullCollection
  // does not return it today, so desktops cannot know the real version -- a gate
  // here would silently reject their edits forever inside an HTTP 200.
  const { rows } = await client.query(
    `SELECT name, address, phone, email, gstin, dl_number, gst_enabled,
            fssai_number, show_fssai_on_bill, logo_path, version, device_id, updated_at
     FROM pharmacy_profiles WHERE store_pk=$1`,
    [storePk]
  );
  const existing = rows[0];

  const BUSINESS_KEYS = [
    'name', 'address', 'phone', 'email', 'gstin', 'dl_number',
    'gst_enabled', 'fssai_number', 'show_fssai_on_bill', 'logo_path',
  ];
  const sent = (k) => Boolean(doc) && Object.prototype.hasOwnProperty.call(doc, k);
  // A body carrying only sync metadata has no profile content to apply. Without
  // this it would inherit every stored field, look like a real write, and wake
  // every peer with a changelog entry.
  if (!BUSINESS_KEYS.some(sent)) {
    return { status: 'skipped' };
  }

  const text = (k) => {
    if (!sent(k)) return existing ? existing[k] : null;
    const v = doc[k];
    if (v === null || v === undefined) return null;
    return String(v).trim() || null;
  };
  const incoming = {
    name: text('name'),
    address: text('address'),
    phone: text('phone'),
    email: text('email'),
    gstin: text('gstin'),
    dl_number: text('dl_number'),
    fssai_number: text('fssai_number'),
    logo_path: text('logo_path'),
    gst_enabled: sent('gst_enabled')
      ? toBool(doc.gst_enabled)
      : (existing ? existing.gst_enabled !== false : true),
    show_fssai_on_bill: sent('show_fssai_on_bill')
      ? toBool(doc.show_fssai_on_bill)
      : Boolean(existing && existing.show_fssai_on_bill),
    device_id: doc.device_id || null,
  };

  // The blank guard is judged on what the CLIENT SENT, not on the merged row --
  // merged values always look filled once inheritance is in play.
  const rawTxt = (k) => String((doc && doc[k]) || '').trim();
  const incomingBlank = !rawTxt('name')
    && !rawTxt('address')
    && !rawTxt('phone')
    && !rawTxt('gstin')
    && !rawTxt('dl_number');
  const existingFilled = existing && (
    String(existing.name || '').trim()
    || String(existing.address || '').trim()
    || String(existing.phone || '').trim()
    || String(existing.gstin || '').trim()
    || String(existing.dl_number || '').trim()
  );
  // Folder-replace / empty in-memory Online clients must not wipe a filled profile.
  if (existingFilled && incomingBlank) {
    return { status: 'skipped' };
  }
  if (
    existing &&
    sameScalarFields(existing, incoming, [
      'name', 'address', 'phone', 'email', 'gstin', 'dl_number', 'gst_enabled',
      'fssai_number', 'show_fssai_on_bill', 'logo_path',
    ])
  ) {
    // version/device_id are deliberately NOT compared: an identical re-push was
    // rewriting the row purely because the client's hard-coded version differed.
    return { status: 'skipped' };
  }
  const meta = syncMeta(doc);
  const writeAt = writeTimestamp(meta, existing);
  // Version is assigned by the server, in SQL, so two concurrent pushes cannot
  // both read N and both write N+1. The client cannot supply it: pullCollection
  // never returns it, so every desktop ships a hard-coded 2 on every push.
  const written = await client.query(
    `INSERT INTO pharmacy_profiles (
       store_pk, name, address, phone, email, gstin, dl_number, gst_enabled,
       fssai_number, show_fssai_on_bill, logo_path, updated_at, version, device_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13)
     ON CONFLICT (store_pk) DO UPDATE SET
       name=EXCLUDED.name, address=EXCLUDED.address, phone=EXCLUDED.phone,
       email=EXCLUDED.email, gstin=EXCLUDED.gstin, dl_number=EXCLUDED.dl_number,
       gst_enabled=EXCLUDED.gst_enabled, fssai_number=EXCLUDED.fssai_number,
       show_fssai_on_bill=EXCLUDED.show_fssai_on_bill, logo_path=EXCLUDED.logo_path,
       updated_at=EXCLUDED.updated_at, device_id=EXCLUDED.device_id,
       version=pharmacy_profiles.version + 1
     RETURNING version`,
    [
      storePk, incoming.name, incoming.address, incoming.phone, incoming.email,
      incoming.gstin, incoming.dl_number, incoming.gst_enabled,
      incoming.fssai_number, incoming.show_fssai_on_bill, incoming.logo_path,
      writeAt, incoming.device_id,
    ]
  );
  return {
    status: 'upserted',
    version: Number(written.rows[0] && written.rows[0].version) || 1,
  };
}

async function upsertDropdowns(client, storePk, doc) {
  const { rows } = await client.query(
    `SELECT villages, default_village, med_types, schedules, updated_at
     FROM store_dropdowns WHERE store_pk=$1`,
    [storePk]
  );
  const existing = rows[0];
  // Merge: omit/empty med_types or schedules must not wipe a peer's fuller layout.
  const villagesIn = Array.isArray(doc.villages) ? doc.villages : (existing?.villages ?? []);
  const defaultVillage = Object.prototype.hasOwnProperty.call(doc, 'default_village')
    ? (doc.default_village || null)
    : (existing?.default_village ?? null);
  const medTypesIn = (Array.isArray(doc.med_types) && doc.med_types.length)
    ? doc.med_types
    : (existing?.med_types ?? doc.med_types ?? []);
  const schedulesIn = (Array.isArray(doc.schedules) && doc.schedules.length)
    ? doc.schedules
    : (existing?.schedules ?? doc.schedules ?? []);
  const villages = JSON.stringify(villagesIn || []);
  const medTypes = JSON.stringify(medTypesIn || []);
  const schedules = JSON.stringify(schedulesIn || []);
  if (existing) {
    const same =
      JSON.stringify(existing.villages ?? []) === villages &&
      String(existing.default_village ?? '') === String(defaultVillage ?? '') &&
      JSON.stringify(existing.med_types ?? []) === medTypes &&
      JSON.stringify(existing.schedules ?? []) === schedules;
    if (same) return { status: 'skipped' };
  }
  await client.query(
    `INSERT INTO store_dropdowns (store_pk, villages, default_village, med_types, schedules, updated_at)
     VALUES ($1, $2::jsonb, $3, $4::jsonb, $5::jsonb, NOW())
     ON CONFLICT (store_pk) DO UPDATE SET
       villages=EXCLUDED.villages, default_village=EXCLUDED.default_village,
       med_types=EXCLUDED.med_types, schedules=EXCLUDED.schedules, updated_at=NOW()`,
    [storePk, villages, defaultVillage, medTypes, schedules]
  );
  return { status: 'upserted' };
}

// ─── Pull / list with watermark ───────────────────────────────────────────────

function watermarkCutoff(since) {
  if (!since) return new Date(0);
  const d = parseTs(since) || new Date(0);
  return new Date(d.getTime() - config.syncOverlapSeconds * 1000);
}

async function attachSaleItems(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r._pk);
  const { rows: items } = await query(
    `SELECT sale_id, medicine_id, name, type, batch_no, expiry_date, hsn_code, schedule,
            manufacturer, qty, rate, gst_percent, amount, item_discount, cost_price
     FROM sales_items WHERE sale_id = ANY($1::bigint[])`,
    [ids]
  );
  const bySale = new Map();
  for (const it of items) {
    if (!bySale.has(it.sale_id)) bySale.set(it.sale_id, []);
    bySale.get(it.sale_id).push({
      medicine_id: it.medicine_id,
      name: it.name, type: it.type, batch_no: it.batch_no, expiry_date: it.expiry_date,
      hsn_code: it.hsn_code, schedule: it.schedule, manufacturer: it.manufacturer,
      qty: it.qty, rate: Number(it.rate), gst_percent: it.gst_percent,
      amount: Number(it.amount), item_discount: Number(it.item_discount),
      cost_price: Number(it.cost_price),
    });
  }
  return rows.map(({ _pk, ...r }) => ({
    ...r,
    items: bySale.get(_pk) || [],
    display_bill_no: displaySalesBillNo(r.bill_no),
    fy_label: r.fy_start_year ? fyLabel(r.fy_start_year) : null,
  }));
}

async function attachPurchaseItems(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r._pk);
  const { rows: items } = await query(
    `SELECT purchase_id, store_pk, medicine_id, name, qty, free_qty, type, hsn_code, gst_pct, mrp,
            rate, manufacturer, batch_no, expiry_date, schedule, discount_pct, taxable, gst_amt,
            item_amount, unit, tablets_per_stripe
     FROM purchase_items WHERE purchase_id = ANY($1::bigint[])`,
    [ids]
  );
  const needMed = items.filter((it) => {
    const pack = purchaseItemPack(it);
    return it.medicine_id && !pack.unit && !pack.tablets_per_stripe;
  });
  const storePk = needMed[0]?.store_pk;
  const medUnit = await loadMedicineUnits({ query }, storePk, needMed);
  const byP = new Map();
  for (const it of items) {
    if (!byP.has(it.purchase_id)) byP.set(it.purchase_id, []);
    const pack = purchaseItemPack(it, medUnit.get(Number(it.medicine_id)));
    byP.get(it.purchase_id).push({
      medicine_id: it.medicine_id, name: it.name, qty: Number(it.qty), free_qty: Number(it.free_qty),
      type: it.type, hsn_code: it.hsn_code, gst_pct: Number(it.gst_pct), mrp: Number(it.mrp),
      rate: Number(it.rate), manufacturer: it.manufacturer, batch_no: it.batch_no,
      expiry_date: it.expiry_date, schedule: it.schedule, discount_pct: Number(it.discount_pct),
      taxable: Number(it.taxable), gst_amt: Number(it.gst_amt), item_amount: Number(it.item_amount),
      unit: pack.unit,
      tablets_per_stripe: pack.tablets_per_stripe,
      quantity_value: pack.unit,
    });
  }
  return rows.map(({ _pk, ...r }) => ({
    ...r,
    items: byP.get(_pk) || [],
    display_purchase_no: displayPurchaseNo(r.purchase_no),
    fy_label: r.fy_start_year ? fyLabel(r.fy_start_year) : null,
  }));
}

async function attachReturnItems(table, fk, rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r._pk);
  const { rows: items } = await query(
    `SELECT * FROM ${table} WHERE ${fk} = ANY($1::bigint[])`,
    [ids]
  );
  const map = new Map();
  for (const it of items) {
    const key = it[fk];
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      medicine_id: it.medicine_id, name: it.name, batch: it.batch_no, batch_no: it.batch_no,
      qty: Number(it.qty), rate: Number(it.rate), amount: Number(it.amount),
    });
  }
  return rows.map(({ _pk, ...r }) => ({ ...r, items: map.get(_pk) || [] }));
}

/**
 * Fetch entity docs by local_id list (for revision delta full pull).
 * Sales / purchases / returns include nested items[].
 */
export async function fetchDocsByLocalIds(storePk, collection, localIds) {
  const ids = [...new Set((localIds || []).map(Number).filter((n) => Number.isFinite(n)))];
  if (!ids.length) return [];

  if (collection === 'pharmacy_profile') {
    const doc = await pullCollection(storePk, 'pharmacy_profile');
    return doc ? [{ ...doc, id: 0, local_id: 0 }] : [];
  }
  if (collection === 'dropdowns') {
    const doc = await pullCollection(storePk, 'dropdowns');
    return doc ? [{ ...doc, id: 0, local_id: 0 }] : [];
  }
  if (collection === 'shelf_settings') {
    const doc = await pullCollection(storePk, 'shelf_settings');
    return doc ? [{ ...doc, id: 0, local_id: 0 }] : [];
  }
  if (collection === 'settings') {
    const { rows } = await query(
      `SELECT name, value, updated_at FROM store_settings WHERE store_pk=$1 ORDER BY name`,
      [storePk]
    );
    return [{ id: 0, local_id: 0, settings: rows }];
  }

  if (!COLLECTIONS.includes(collection)) {
    throw new AppError(400, `Unknown collection: ${collection}`);
  }

  // Reuse pullCollection mappers via a wide watermark + filter is wasteful;
  // query by local_id directly with the same SELECT shapes.
  const delClause = '';
  let sql;
  let mapper = (r) => r;
  const idFilter = ' AND local_id = ANY($2::bigint[])';

  switch (collection) {
    case 'customers':
      sql = `SELECT local_id AS id, name, phone, address, document_name, total_due, total_credit,
                    created_at, last_updated, updated_at, version, device_id, deleted, sync_status
             FROM customers WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    case 'suppliers':
      sql = `SELECT local_id AS id, name, address, phone, gstin, dl_numbers, total_due, total_credit,
                    created_at, updated_at, version, device_id, deleted, sync_status
             FROM suppliers WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    case 'doctors':
      sql = `SELECT local_id AS id, name, phone, registration_number, created_at,
                    updated_at, version, device_id, deleted, sync_status
             FROM doctors WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    case 'medicines':
      sql = `SELECT local_id AS id, name, type, stock_qty, unit, gst_percent, mrp, rate,
                    manufacturer, batch_no, expiry_date, hsn_code, schedule, location, content_drug,
                    supplier_name,
                    is_hidden, synced_at, created_at, updated_at, version, device_id, deleted, sync_status,
                    client_uuid
             FROM medicines WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    case 'sales':
      sql = `SELECT id AS _pk, local_id AS id, bill_no, customer_id, bill_date, total_amount, discount,
                    discount_pct, rounding, amount_paid, cash_paid, online_paid, previous_due, previous_credit,
                    due_amount, credit_amount, total_due, paid_due, bill_cleared, account_cleared,
                    doctor_name, is_autosave, fy_start_year, fy_serial, customer_name, customer_phone,
                    customer_address, item_count, created_at, updated_at, version, device_id, deleted, sync_status,
                    client_uuid
             FROM sales WHERE store_pk=$1${idFilter}${delClause}`;
      mapper = attachSaleItems;
      break;
    case 'purchases':
      sql = `SELECT id AS _pk, local_id AS id, purchase_no, supplier_id, purchase_date, bill_number,
                    subtotal, total_gst, cgst, sgst, total_amount, overall_discount, rounding,
                    need_to_pay, final_amount, amount_paid, amount_paid_at_entry, cash_paid_at_entry,
                    online_paid_at_entry, previous_due, previous_credit, due, current_credit, total_due,
                    due_amount, credit_amount, paid_due, bill_cleared, account_cleared, gst_calc_method,
                    expenditure, is_autosave, fy_start_year, fy_serial, supplier_name, supplier_phone,
                    item_count, created_at, updated_at, version, device_id, deleted, sync_status,
                    client_uuid
             FROM purchases WHERE store_pk=$1${idFilter}${delClause}`;
      mapper = attachPurchaseItems;
      break;
    case 'customer_payments':
      sql = `SELECT local_id AS id, customer_id, customer_name, payment_date, amount, payment_mode,
                    cash_amount, online_amount, reference_no, note, created_at,
                    updated_at, version, device_id, deleted, sync_status
             FROM customer_payments WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    case 'supplier_payments':
      sql = `SELECT local_id AS id, payment_no, supplier_id, supplier_name, payment_date, amount, mode,
                    reference, due_before, due_after, created_at,
                    updated_at, version, device_id, deleted, sync_status
             FROM supplier_payments WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    case 'sales_returns':
      sql = `SELECT id AS _pk, local_id AS id, return_no, sale_id, bill_no, customer_id, customer_name,
                    return_date, refund_amount, discount, reason, item_count, created_at,
                    updated_at, version, device_id, deleted, sync_status
             FROM sales_returns WHERE store_pk=$1${idFilter}${delClause}`;
      mapper = (rows) => attachReturnItems('sales_return_items', 'return_id', rows);
      break;
    case 'purchase_returns':
      sql = `SELECT id AS _pk, local_id AS id, return_no, purchase_id, purchase_no, supplier_id, supplier_name,
                    return_date, refund_amount, discount, reason, item_count, created_at,
                    updated_at, version, device_id, deleted, sync_status
             FROM purchase_returns WHERE store_pk=$1${idFilter}${delClause}`;
      mapper = (rows) => attachReturnItems('purchase_return_items', 'return_id', rows);
      break;
    case 'general_products':
      sql = `SELECT local_id AS id, name, rate, mrp, created_at, updated_at, version, device_id, deleted, sync_status
             FROM general_products WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    case 'stock_operations':
      sql = `SELECT local_id AS id, op_uuid, medicine_id, op, qty_delta, ref_collection, ref_id,
                    revision, device_id, created_at
             FROM stock_operations WHERE store_pk=$1${idFilter}`;
      break;
    case 'stock_disposals':
      sql = `SELECT local_id AS id, disposal_no, medicine_id, batch_no, supplier_id, purchase_id, bill_number,
                    qty AS quantity, qty, original_purchase_qty, disposal_type, reason, expected_credit_note,
                    notes, disposal_date, created_at, updated_at, version, device_id, deleted, sync_status
             FROM stock_disposals WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    case 'pending_orders':
      sql = `SELECT local_id AS id, order_no, medicine_id, medicine_name, pack_size, supplier_id,
                    supplier_name_manual, supplier_phone, supplier_email, order_offline, offline_note,
                    qty AS quantity, qty, unit_price, current_stock, min_stock, order_date,
                    expected_delivery_date, order_group_id, status, notes, created_at,
                    updated_at, version, device_id, deleted, sync_status
             FROM pending_orders WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    case 'racks':
      sql = `SELECT local_id AS id, name, created_at, updated_at, version, device_id, deleted, sync_status
             FROM racks WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    case 'sections':
      sql = `SELECT local_id AS id, rack_id, name, created_at, updated_at, version, device_id, deleted, sync_status
             FROM sections WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    case 'boxes':
      sql = `SELECT local_id AS id, section_id, name, created_at, updated_at, version, device_id, deleted, sync_status
             FROM boxes WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    case 'shelves':
      sql = `SELECT local_id AS id, shelf_no, description, created_at, updated_at, version, device_id, deleted, sync_status
             FROM shelves WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    case 'medicine_shelf':
      sql = `SELECT local_id AS id, medicine_id, shelf_id, created_at, updated_at, version, device_id, deleted, sync_status
             FROM medicine_shelf WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    case 'medicine_suppliers':
      sql = `SELECT local_id AS id, medicine_name, supplier_id, last_rate, last_purchase_date, created_at,
                    updated_at, version, device_id, deleted, sync_status
             FROM medicine_suppliers WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    default:
      throw new AppError(400, `Unknown collection: ${collection}`);
  }

  const { rows } = await query(sql, [storePk, ids]);
  return mapper(rows);
}

export async function pullCollection(
  storePk,
  collection,
  { since, afterId = 0, includeDeleted = true, limit = 5000 } = {},
) {
  const allowed = [...COLLECTIONS, ...SPECIAL_COLLECTIONS];
  if (!allowed.includes(collection)) {
    throw new AppError(400, `Unknown collection: ${collection}`);
  }
  // Keyset pagination: (updated_at, local_id). When afterId is set, use an exact
  // since timestamp (no overlap rewind) so bulk-imported rows that share one
  // updated_at still page correctly. Overlap applies only to first incremental page.
  const after = Number(afterId) || 0;
  const cutoff = after > 0
    ? (parseTs(since) || new Date(0))
    : watermarkCutoff(since);
  const lim = Math.min(Number(limit) || 5000, 5000);

  if (collection === 'pharmacy_profile') {
    const { rows } = await query(
      `SELECT name, address, phone, email, gstin, dl_number, gst_enabled,
              fssai_number, show_fssai_on_bill, logo_path
       FROM pharmacy_profiles WHERE store_pk = $1`,
      [storePk]
    );
    const r = rows[0];
    if (!r) return null;
    return {
      name: r.name || '',
      address: r.address || '',
      phone: r.phone || '',
      email: r.email || '',
      gstin: r.gstin || '',
      dl_number: r.dl_number || '',
      gst_enabled: r.gst_enabled !== false,
      fssai_number: r.fssai_number || '',
      show_fssai_on_bill: Boolean(r.show_fssai_on_bill),
      logo_path: r.logo_path || '',
    };
  }
  if (collection === 'dropdowns') {
    const { rows } = await query(`SELECT * FROM store_dropdowns WHERE store_pk = $1`, [storePk]);
    return rows[0] || null;
  }
  if (collection === 'shelf_settings') {
    const { rows } = await query(`SELECT show_location, updated_at, version, device_id FROM shelf_settings WHERE store_pk = $1`, [storePk]);
    return rows[0] || null;
  }
  if (collection === 'settings') {
    const { rows } = await query(
      `SELECT name, value, updated_at FROM store_settings WHERE store_pk=$1 AND updated_at > $2 ORDER BY name`,
      [storePk, cutoff]
    );
    return rows;
  }

  const delClause = includeDeleted ? '' : ' AND deleted = FALSE';
  let sql;
  let mapper = (r) => r;

  switch (collection) {
    case 'customers':
      sql = `SELECT local_id AS id, name, phone, address, document_name, total_due, total_credit,
                    created_at, last_updated, updated_at, version, device_id, deleted, sync_status
             FROM customers WHERE store_pk=$1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'suppliers':
      sql = `SELECT local_id AS id, name, address, phone, gstin, dl_numbers, total_due, total_credit,
                    created_at, updated_at, version, device_id, deleted, sync_status
             FROM suppliers WHERE store_pk=$1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'doctors':
      sql = `SELECT local_id AS id, name, phone, registration_number, created_at,
                    updated_at, version, device_id, deleted, sync_status
             FROM doctors WHERE store_pk=$1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'medicines':
      sql = `SELECT local_id AS id, name, type, stock_qty, unit, gst_percent, mrp, rate,
                    manufacturer, batch_no, expiry_date, hsn_code, schedule, location, content_drug,
                    supplier_name,
                    is_hidden, synced_at, created_at, updated_at, version, device_id, deleted, sync_status,
                    client_uuid
             FROM medicines WHERE store_pk=$1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'sales':
      sql = `SELECT id AS _pk, local_id AS id, bill_no, customer_id, bill_date, total_amount, discount,
                    discount_pct, rounding, amount_paid, cash_paid, online_paid, previous_due, previous_credit,
                    due_amount, credit_amount, total_due, paid_due, bill_cleared, account_cleared,
                    doctor_name, is_autosave, fy_start_year, fy_serial, customer_name, customer_phone,
                    customer_address, item_count, created_at, updated_at, version, device_id, deleted, sync_status,
                    client_uuid
             FROM sales WHERE store_pk=$1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      mapper = attachSaleItems;
      break;
    case 'purchases':
      sql = `SELECT id AS _pk, local_id AS id, purchase_no, supplier_id, purchase_date, bill_number,
                    subtotal, total_gst, cgst, sgst, total_amount, overall_discount, rounding,
                    need_to_pay, final_amount, amount_paid, amount_paid_at_entry, cash_paid_at_entry,
                    online_paid_at_entry, previous_due, previous_credit, due, current_credit, total_due,
                    due_amount, credit_amount, paid_due, bill_cleared, account_cleared, gst_calc_method,
                    expenditure, is_autosave, fy_start_year, fy_serial, supplier_name, supplier_phone,
                    item_count, created_at, updated_at, version, device_id, deleted, sync_status,
                    client_uuid
             FROM purchases WHERE store_pk=$1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      mapper = attachPurchaseItems;
      break;
    case 'customer_payments':
      sql = `SELECT local_id AS id, customer_id, customer_name, payment_date, amount, payment_mode,
                    cash_amount, online_amount, reference_no, note, created_at,
                    updated_at, version, device_id, deleted, sync_status
             FROM customer_payments WHERE store_pk=$1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'supplier_payments':
      sql = `SELECT local_id AS id, payment_no, supplier_id, supplier_name, payment_date, amount, mode,
                    reference, due_before, due_after, created_at,
                    updated_at, version, device_id, deleted, sync_status
             FROM supplier_payments WHERE store_pk=$1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'sales_returns':
      sql = `SELECT id AS _pk, local_id AS id, return_no, sale_id, bill_no, customer_id, customer_name,
                    return_date, refund_amount, discount, reason, item_count, created_at,
                    updated_at, version, device_id, deleted, sync_status
             FROM sales_returns WHERE store_pk=$1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      mapper = (rows) => attachReturnItems('sales_return_items', 'return_id', rows);
      break;
    case 'purchase_returns':
      sql = `SELECT id AS _pk, local_id AS id, return_no, purchase_id, purchase_no, supplier_id, supplier_name,
                    return_date, refund_amount, discount, reason, item_count, created_at,
                    updated_at, version, device_id, deleted, sync_status
             FROM purchase_returns WHERE store_pk=$1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      mapper = (rows) => attachReturnItems('purchase_return_items', 'return_id', rows);
      break;
    case 'general_products':
      sql = `SELECT local_id AS id, name, rate, mrp, created_at, updated_at, version, device_id, deleted, sync_status
             FROM general_products WHERE store_pk=$1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'stock_operations':
      sql = `SELECT local_id AS id, op_uuid, medicine_id, op, qty_delta, ref_collection, ref_id,
                    revision, device_id, created_at
             FROM stock_operations WHERE store_pk=$1 AND created_at > $2
             ORDER BY created_at ASC LIMIT $3`;
      break;
    case 'stock_disposals':
      sql = `SELECT local_id AS id, disposal_no, medicine_id, batch_no, supplier_id, purchase_id, bill_number,
                    qty AS quantity, qty, original_purchase_qty, disposal_type, reason, expected_credit_note,
                    notes, disposal_date, created_at, updated_at, version, device_id, deleted, sync_status
             FROM stock_disposals WHERE store_pk=$1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'pending_orders':
      sql = `SELECT local_id AS id, order_no, medicine_id, medicine_name, pack_size, supplier_id,
                    supplier_name_manual, supplier_phone, supplier_email, order_offline, offline_note,
                    qty AS quantity, qty, unit_price, current_stock, min_stock, order_date,
                    expected_delivery_date, order_group_id, status, notes, created_at,
                    updated_at, version, device_id, deleted, sync_status
             FROM pending_orders WHERE store_pk=$1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'racks':
      sql = `SELECT local_id AS id, name, created_at, updated_at, version, device_id, deleted, sync_status
             FROM racks WHERE store_pk=$1 AND updated_at > $2${delClause} ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'sections':
      sql = `SELECT local_id AS id, rack_id, name, created_at, updated_at, version, device_id, deleted, sync_status
             FROM sections WHERE store_pk=$1 AND updated_at > $2${delClause} ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'boxes':
      sql = `SELECT local_id AS id, section_id, name, created_at, updated_at, version, device_id, deleted, sync_status
             FROM boxes WHERE store_pk=$1 AND updated_at > $2${delClause} ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'shelves':
      sql = `SELECT local_id AS id, shelf_no, description, created_at, updated_at, version, device_id, deleted, sync_status
             FROM shelves WHERE store_pk=$1 AND updated_at > $2${delClause} ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'medicine_shelf':
      sql = `SELECT local_id AS id, medicine_id, shelf_id, created_at, updated_at, version, device_id, deleted, sync_status
             FROM medicine_shelf WHERE store_pk=$1 AND updated_at > $2${delClause} ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'medicine_suppliers':
      sql = `SELECT local_id AS id, medicine_name, supplier_id, last_rate, last_purchase_date, created_at,
                    updated_at, version, device_id, deleted, sync_status
             FROM medicine_suppliers WHERE store_pk=$1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'medicines_master':
      // Global catalog — clients must use GET /api/master-medicines
      return [];
    default:
      throw new AppError(400, `Unknown collection: ${collection}`);
  }

  // Stable order + keyset so clients can page past rows that share updated_at.
  if (after > 0) {
    sql = sql
      .replace(
        'updated_at > $2',
        '(updated_at > $2 OR (updated_at = $2 AND local_id > $3))',
      )
      .replace(
        'ORDER BY updated_at ASC LIMIT $3',
        'ORDER BY updated_at ASC, local_id ASC LIMIT $4',
      );
    const { rows } = await query(sql, [storePk, cutoff, after, lim]);
    return mapper(rows);
  }

  sql = sql.replace(
    'ORDER BY updated_at ASC LIMIT $3',
    'ORDER BY updated_at ASC, local_id ASC LIMIT $3',
  );
  const { rows } = await query(sql, [storePk, cutoff, lim]);
  return mapper(rows);
}

/**
 * The stock ledger one document wrote: every stock_operations row of this store whose
 * ref is (refCollection, refId), in the order they were logged. Same row shape as the
 * stock_operations pull. A purchase edit subtracts exactly these instead of paging the
 * store's whole ledger (pullDoc and the since-pull cannot filter by ref).
 */
export async function fetchStockOpsByRef(storePk, refCollection, refId) {
  const col = typeof refCollection === 'string' ? refCollection.trim() : '';
  if (!col) throw new AppError(400, 'ref_collection required');
  if (col.length > 64) throw new AppError(400, 'Invalid ref_collection');
  const raw = typeof refId === 'string' || typeof refId === 'number' ? String(refId).trim() : '';
  if (!/^\d{1,15}$/.test(raw) || Number(raw) <= 0) {
    throw new AppError(400, 'ref_id must be a positive integer');
  }
  const { rows } = await query(
    `SELECT local_id AS id, op_uuid, medicine_id, op, qty_delta, ref_collection, ref_id,
            revision, device_id, created_at
     FROM stock_operations
     WHERE store_pk=$1 AND ref_collection=$2 AND ref_id=$3
     ORDER BY local_id ASC`,
    [storePk, col, Number(raw)],
  );
  return rows;
}

/**
 * Fetch one document by local_id (same shape as pullCollection rows).
 * Sales / purchases / returns include nested items[].
 */
export async function pullDoc(storePk, collection, localId) {
  const lid = Number(localId);
  // Any non-zero whole number a JavaScript client can hold exactly. The list pulls and
  // fetchDocsByLocalIds already return rows under a negative local_id (old desktop returns
  // kept their negative temp id, e.g. ZZ Test's sales_returns -1117777925), and refusing
  // those here as "Invalid local id" left a listed document that could not be fetched.
  // Read path only: every query below matches store_pk plus this exact local_id.
  if (!Number.isSafeInteger(lid) || lid === 0) {
    throw new AppError(400, 'Invalid local id');
  }
  const allowed = [...COLLECTIONS];
  if (!allowed.includes(collection)) {
    throw new AppError(400, `Unknown collection: ${collection}`);
  }

  let sql;
  let mapper = async (rows) => rows;
  switch (collection) {
    case 'sales':
      sql = `SELECT id AS _pk, local_id AS id, bill_no, customer_id, bill_date, total_amount, discount,
                    discount_pct, rounding, amount_paid, cash_paid, online_paid, previous_due, previous_credit,
                    due_amount, credit_amount, total_due, paid_due, bill_cleared, account_cleared,
                    doctor_name, is_autosave, fy_start_year, fy_serial, customer_name, customer_phone,
                    customer_address, item_count, created_at, updated_at, version, device_id, deleted, sync_status,
                    client_uuid
             FROM sales WHERE store_pk=$1 AND local_id=$2 LIMIT 1`;
      mapper = attachSaleItems;
      break;
    case 'purchases':
      sql = `SELECT id AS _pk, local_id AS id, purchase_no, supplier_id, purchase_date, bill_number,
                    subtotal, total_gst, cgst, sgst, total_amount, overall_discount, rounding,
                    need_to_pay, final_amount, amount_paid, amount_paid_at_entry, cash_paid_at_entry,
                    online_paid_at_entry, previous_due, previous_credit, due, current_credit, total_due,
                    due_amount, credit_amount, paid_due, bill_cleared, account_cleared, gst_calc_method,
                    expenditure, is_autosave, fy_start_year, fy_serial, supplier_name, supplier_phone,
                    item_count, created_at, updated_at, version, device_id, deleted, sync_status,
                    client_uuid
             FROM purchases WHERE store_pk=$1 AND local_id=$2 LIMIT 1`;
      mapper = attachPurchaseItems;
      break;
    case 'medicines':
      sql = `SELECT local_id AS id, name, type, stock_qty, unit, gst_percent, mrp, rate,
                    manufacturer, batch_no, expiry_date, hsn_code, schedule, location, content_drug,
                    supplier_name,
                    is_hidden, synced_at, created_at, updated_at, version, device_id, deleted, sync_status,
                    client_uuid
             FROM medicines WHERE store_pk=$1 AND local_id=$2 LIMIT 1`;
      break;
    case 'customers':
      sql = `SELECT local_id AS id, name, phone, address, document_name, total_due, total_credit,
                    created_at, last_updated, updated_at, version, device_id, deleted, sync_status
             FROM customers WHERE store_pk=$1 AND local_id=$2 LIMIT 1`;
      break;
    case 'suppliers':
      sql = `SELECT local_id AS id, name, address, phone, gstin, dl_numbers, total_due, total_credit,
                    created_at, updated_at, version, device_id, deleted, sync_status
             FROM suppliers WHERE store_pk=$1 AND local_id=$2 LIMIT 1`;
      break;
    default:
      // Fallback: reuse wide pull and filter (rare collections).
      {
        const rows = await pullCollection(storePk, collection, {
          since: null,
          includeDeleted: true,
          limit: 5000,
        });
        const list = Array.isArray(rows) ? rows : [];
        const found = list.find((d) => Number(d.id) === lid || Number(d.local_id) === lid);
        if (!found) throw new AppError(404, `${collection}/${lid} not found`);
        return found;
      }
  }

  const { rows } = await query(sql, [storePk, lid]);
  if (!rows.length) throw new AppError(404, `${collection}/${lid} not found`);
  const mapped = await mapper(rows);
  return Array.isArray(mapped) ? mapped[0] : mapped;
}

export async function pullAll(storePk, { since } = {}) {
  const out = {};
  for (const col of COLLECTIONS) {
    out[col] = await pullCollection(storePk, col, { since });
  }
  out.pharmacy_profile = await pullCollection(storePk, 'pharmacy_profile');
  out.dropdowns = await pullCollection(storePk, 'dropdowns');
  out.shelf_settings = await pullCollection(storePk, 'shelf_settings');
  out.settings = await pullCollection(storePk, 'settings', { since });
  return out;
}

/** The financial year a number's /FY tag names ("5/FY2025-26" -> 2025), or null. */
function fyStartYearInCode(code) {
  const m = String(code || '').trim().match(/\/FY(\d{4})-\d{2}$/i);
  return m ? Number(m[1]) : null;
}

/** The serial of a tagged purchase number ("5/FY2025-26" -> 5), or null. */
function purchaseSerialInCode(code) {
  const m = String(code || '').trim().match(/^(\d+)\/FY\d{4}-\d{2}$/i);
  return m ? Number(m[1]) : null;
}

/** The serial of a tagged sales bill number ("SCB12/FY2026-27" -> 12), or null. */
function salesSerialInCode(code) {
  const m = String(code || '').trim().match(/^SCB(\d+)\/FY\d{4}-\d{2}$/i);
  return m ? Number(m[1]) : null;
}

/** Push answer fields for a sale, read from the row as STORED. */
function withStoredSaleNumber(base, row, fallbackFy = null) {
  const billNo = row?.bill_no ? String(row.bill_no) : '';
  if (!billNo) return base;
  const fy = row.fy_start_year ?? fallbackFy;
  return {
    ...base,
    bill_no: billNo,
    display_bill_no: displaySalesBillNo(billNo),
    fy_label: fy ? fyLabel(Number(fy)) : null,
  };
}

/** Push answer fields for a purchase, read from the row as STORED. */
function withStoredPurchaseNumber(base, row, fallbackFy = null) {
  const no = row?.purchase_no ? String(row.purchase_no) : '';
  if (!no) return base;
  const fy = row.fy_start_year ?? fallbackFy;
  return {
    ...base,
    purchase_no: no,
    display_purchase_no: displayPurchaseNo(no),
    fy_label: fy ? fyLabel(Number(fy)) : null,
  };
}

/** Is `purchaseNo` held by a LIVE purchase other than `excludeLocalId`? */
async function livePurchaseNoTaken(client, storePk, purchaseNo, excludeLocalId) {
  const { rows } = await client.query(
    `SELECT 1 FROM purchases
      WHERE store_pk=$1 AND purchase_no=$2 AND NOT COALESCE(deleted, FALSE)
        AND local_id <> $3
      LIMIT 1`,
    [storePk, purchaseNo, Number(excludeLocalId) || 0]
  );
  return rows.length > 0;
}

/** One advisory lock per store + kind + financial year, held to the end of the transaction. */
async function lockFySeries(client, storePk, kind, fy) {
  await client.query(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [
    Number(storePk),
    `fy:${kind}:${Number(fy)}`,
  ]);
}

/**
 * Leave a trail when a stored bill or purchase number changes. Nothing recorded it, so
 * a missing number (SCB1251/FY2026-27) could only be guessed at from sync_changes.
 * pm2 log plus an audit_log row, in its own savepoint: failing to write the trail must
 * never refuse the bill.
 */
async function noteNumberChange(client, storePk, { action, localId, from, to, deviceId, detail = {} }) {
  console.warn(
    `[numbering] ${action} store=${storePk} local_id=${localId}: ` +
    `${from || '(none)'} -> ${to} (device ${deviceId || '?'})`
  );
  const sp = `sp_audit_${++_spSeq}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, store_pk, meta)
       VALUES ('store', $1, $2, $3, $4::jsonb)`,
      [
        deviceId || null, action, storePk,
        JSON.stringify({ local_id: localId, from: from ?? null, to: to ?? null, ...detail }),
      ]
    );
    await client.query(`RELEASE SAVEPOINT ${sp}`);
  } catch (e) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    console.warn('[numbering] audit_log row not written:', e.message);
  }
}

/** Highest existing FY serial on sales/purchases (handles pre-counter data / migrations). */
async function maxExistingFySerial(client, storePk, kind, fy, excludeLocalId = null) {
  const table = kind === 'sales' ? 'sales' : 'purchases';
  const dateCol = kind === 'sales' ? 'bill_date' : 'purchase_date';
  const codeCol = kind === 'sales' ? 'bill_no' : 'purchase_no';
  const from = `${fy}-04-01`;
  const to = `${fy + 1}-03-31`;
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(fy_serial), 0) AS m
     FROM ${table}
     WHERE store_pk=$1
       AND COALESCE(is_autosave, FALSE)=FALSE
       -- Live bills only, so deleting the LATEST bill frees its number for the
       -- next one and the book reads without gaps -- which is how a pharmacy
       -- bill book is meant to run. This is safe ONLY because uniqueness is now
       -- a PARTIAL index (uq_sales_live_bill_no / uq_purchases_live_purchase_no,
       -- both WHERE NOT deleted): a deleted row keeps its number for the audit
       -- trail without blocking reuse. Before that index, the full UNIQUE
       -- constraint rejected the reused number, the server logged "batch
       -- continues", and the sale was silently lost while its stock and ledger
       -- writes still applied. Do not drop the partial index.
       AND COALESCE(deleted, FALSE)=FALSE
       AND (
         fy_start_year = $2
         OR (${dateCol} >= $3 AND ${dateCol} <= $4)
       )
       -- A bill being re-filed is not a rival for its own new number.
       AND ($5::bigint IS NULL OR local_id <> $5::bigint)`,
    [storePk, fy, from, to, excludeLocalId == null ? null : Number(excludeLocalId)]
  );
  let maxSerial = Number(rows[0]?.m || 0);
  // Parse stored codes too (fy_serial may be null after older imports)
  const { rows: codes } = await client.query(
    `SELECT ${codeCol} AS code
     FROM ${table}
     WHERE store_pk=$1
       AND COALESCE(is_autosave, FALSE)=FALSE
       -- Live bills only, so deleting the LATEST bill frees its number for the
       -- next one and the book reads without gaps -- which is how a pharmacy
       -- bill book is meant to run. This is safe ONLY because uniqueness is now
       -- a PARTIAL index (uq_sales_live_bill_no / uq_purchases_live_purchase_no,
       -- both WHERE NOT deleted): a deleted row keeps its number for the audit
       -- trail without blocking reuse. Before that index, the full UNIQUE
       -- constraint rejected the reused number, the server logged "batch
       -- continues", and the sale was silently lost while its stock and ledger
       -- writes still applied. Do not drop the partial index.
       AND COALESCE(deleted, FALSE)=FALSE
       AND (
         fy_start_year = $2
         OR (${dateCol} >= $3 AND ${dateCol} <= $4)
       )
       -- A bill being re-filed is not a rival for its own new number.
       AND ($5::bigint IS NULL OR local_id <> $5::bigint)`,
    [storePk, fy, from, to, excludeLocalId == null ? null : Number(excludeLocalId)]
  );
    for (const row of codes) {
    const raw = String(row.code || '');
    const display = raw.includes('/FY') ? raw.split('/FY')[0] : raw;
    let n = null;
    if (kind === 'sales') {
      const m = display.match(/^SCB(\d+)$/i) || display.match(/^(\d+)$/);
      if (m) n = Number(m[1]);
    } else {
      const m = display.match(/^(\d+)$/) || display.match(/^(?:APU)?(\d+)$/i);
      if (m) n = Number(m[1]);
    }
    if (Number.isFinite(n)) maxSerial = Math.max(maxSerial, n);
  }
  // Numbers a device has reserved in advance (sync v2 number blocks) are taken even
  // before its bills arrive: the next number handed out anywhere comes after them.
  return Math.max(maxSerial, await maxReservedSerial(client, storePk, kind, fy));
}

let _numberBlocksReady = false;
async function maxReservedSerial(client, storePk, kind, fy) {
  if (!_numberBlocksReady) {
    const { rows } = await client.query(`SELECT to_regclass('public.number_blocks') IS NOT NULL AS ok`);
    if (!rows[0]?.ok) return 0;
    _numberBlocksReady = true;
  }
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(to_serial), 0) AS m FROM number_blocks
      WHERE store_pk=$1 AND kind=$2 AND fy_start_year=$3`,
    [storePk, kind === 'sales' ? 'sales' : 'purchases', Number(fy)],
  );
  return Number(rows[0]?.m || 0);
}

/**
 * Reserve the next `size` bill (or purchase) numbers of a financial year for one device.
 * The device prints them while offline; nothing else is ever given a number inside the
 * block, so two devices never print the same one.
 */
export async function reserveNumberBlockInTx(client, storePk, { kind, fyStartYear, deviceNo, size }) {
  const k = kind === 'sales' ? 'sales' : 'purchases';
  const fy = Number(fyStartYear);
  if (!Number.isFinite(fy) || fy < 2000 || fy > 2100) throw new AppError(400, 'fy_start_year required');
  const n = Math.max(5, Math.min(200, Number(size) || 50));
  await lockFySeries(client, storePk, k, fy);
  const top = await maxExistingFySerial(client, storePk, k, fy);
  const from = top + 1;
  const to = top + n;
  await client.query(
    `INSERT INTO number_blocks (store_pk, kind, fy_start_year, device_no, from_serial, to_serial)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [storePk, k, fy, Number(deviceNo), from, to],
  );
  await client.query(
    `INSERT INTO fy_serials (store_pk, kind, fy_start_year, last_serial)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (store_pk, kind, fy_start_year) DO UPDATE
       SET last_serial = GREATEST(fy_serials.last_serial, EXCLUDED.last_serial)`,
    [storePk, k, fy, to],
  );
  return { kind: k, fy_start_year: fy, from_serial: from, to_serial: to };
}

/** Pull FY counter back to the highest live bill after the latest is deleted. */
async function rewindFySerialCounter(client, storePk, kind, fyStartYear) {
  const fy = Number(fyStartYear);
  if (!Number.isFinite(fy) || fy <= 0) return;
  const dataMax = await maxExistingFySerial(client, storePk, kind, fy);
  await client.query(
    `UPDATE fy_serials SET last_serial = $4
     WHERE store_pk=$1 AND kind=$2 AND fy_start_year=$3
       AND last_serial > $4`,
    [storePk, kind, fy, dataMax]
  );
}

/** Next FY serial without consuming a counter (for UI hints). */
export async function peekFySerial(storePk, kind, dateValue) {
  const fy = fyStartYearForDate(dateValue);
  return withTransaction(async (client) => {
    const dataMax = await maxExistingFySerial(client, storePk, kind, fy);
    const serial = dataMax + 1;
    if (kind === 'sales') {
      return {
        fy_start_year: fy,
        fy_serial: serial,
        bill_no: encodeSalesBillNo(serial, fy),
        display_bill_no: `SCB${serial}`,
        fy_label: fyLabel(fy),
      };
    }
    return {
      fy_start_year: fy,
      fy_serial: serial,
      purchase_no: encodePurchaseNo(serial, fy),
      display_purchase_no: String(serial),
      fy_label: fyLabel(fy),
    };
  });
}

/** Allocate next FY serial atomically (seeded from existing bills so we never restart at 1). */
/** Allocate a serial in `fy` for a bill whose claimed year was wrong.
 *
 *  The year is part of the number, so a bill filed under the wrong year takes
 *  the wrong year's series with it. One purchase dated 2026-08-31 arrived
 *  claiming FY 2020 and was filed as 1/FY2020-21, so the shop's numbering
 *  appeared to restart at 1 half way through the year. The date is what the
 *  shop typed and can see on screen, so the date decides.
 */
async function reallocateSerialForFy(client, storePk, kind, fy, excludeLocalId) {
  const year = Number(fy);
  // Same lock and same "highest LIVE number + 1" as /fy/allocate. This used to read
  // MAX(fy_serial) alone and take no lock, so a re-filed bill and a number a client had
  // just been handed could be the same, and the two paths disagreed on what "next" was
  // (a phone could adopt a third number the store did not hold).
  await lockFySeries(client, storePk, kind, year);
  const serial = (await maxExistingFySerial(client, storePk, kind, year, excludeLocalId)) + 1;
  await client.query(
    `INSERT INTO fy_serials (store_pk, kind, fy_start_year, last_serial)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (store_pk, kind, fy_start_year)
     DO UPDATE SET last_serial = GREATEST(fy_serials.last_serial, EXCLUDED.last_serial)`,
    [storePk, kind, year, serial]
  );
  return serial;
}

/** Allocate a serial for a bill that arrived without one at all.
 *
 *  Falling back to the row's internal id produced numbers like
 *  "3019/FY2026-27" where the shop expected 104.
 */
async function serialWhenMissing(client, storePk, kind, fy, excludeLocalId) {
  return reallocateSerialForFy(client, storePk, kind, fy, excludeLocalId);
}

export async function allocateFySerial(storePk, kind, dateValue) {
  return withTransaction((client) => allocateFySerialInTx(client, storePk, kind, dateValue));
}

/** The same allocation inside a caller's transaction (the web saves a bill and takes its
 *  number in one transaction, so a refused save never spends a number). */
export async function allocateFySerialInTx(client, storePk, kind, dateValue) {
  const fy = fyStartYearForDate(dateValue);
  await lockFySeries(client, storePk, kind, fy);
  const dataMax = await maxExistingFySerial(client, storePk, kind, fy);
  // Next number is max(LIVE bills)+1, so deleting the latest bill hands its
  // number straight back to the next one. Safe only with the partial indexes.
  await client.query(
    `INSERT INTO fy_serials (store_pk, kind, fy_start_year, last_serial)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (store_pk, kind, fy_start_year) DO UPDATE
       SET last_serial = EXCLUDED.last_serial`,
    [storePk, kind, fy, dataMax]
  );
  const { rows } = await client.query(
    `UPDATE fy_serials SET last_serial = last_serial + 1
     WHERE store_pk=$1 AND kind=$2 AND fy_start_year=$3
     RETURNING last_serial`,
    [storePk, kind, fy]
  );
  const serial = rows[0].last_serial;
  if (kind === 'sales') {
    return { fy_start_year: fy, fy_serial: serial, bill_no: encodeSalesBillNo(serial, fy), display_bill_no: `SCB${serial}`, fy_label: fyLabel(fy) };
  }
  return { fy_start_year: fy, fy_serial: serial, purchase_no: encodePurchaseNo(serial, fy), display_purchase_no: String(serial), fy_label: fyLabel(fy) };
}

/** Allocate next local_id values per collection (server-only clients, no SQLite autoincrement). */
const ALLOCATE_TABLES = new Set([
  'customers',
  'suppliers',
  'medicines',
  'doctors',
  'sales',
  'purchases',
  'customer_payments',
  'supplier_payments',
  'sales_returns',
  'purchase_returns',
  'general_products',
  'stock_disposals',
  'stock_operations',
  'pending_orders',
  'racks',
  'sections',
  'boxes',
  'shelves',
  'medicine_shelf',
  'medicine_suppliers',
]);

export async function allocateLocalIds(storePk, requests = []) {
  const list = Array.isArray(requests) ? requests : [];
  if (!list.length) throw new AppError(400, 'requests array required');
  return withTransaction(async (client) => {
    const out = {};
    for (const req of list) {
      const collection = String(req?.collection || '').trim();
      const count = Math.max(1, Math.min(100, Number(req?.count) || 1));
      if (!ALLOCATE_TABLES.has(collection)) {
        throw new AppError(400, `Cannot allocate ids for collection: ${collection}`);
      }
      await client.query(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [
        Number(storePk),
        collection,
      ]);
      const { rows } = await client.query(
        // Below LEGACY_ID_LIMIT only: ids from there up belong to devices that make their
        // own (device_no * LEGACY_ID_LIMIT + n, sync v2). MAX over the whole table would
        // hand out the next id INSIDE such a device's range.
        `SELECT COALESCE(MAX(local_id), 0)::bigint AS mx FROM ${collection}
          WHERE store_pk = $1 AND local_id < ${LEGACY_ID_LIMIT}`,
        [storePk]
      );
      // Never hand back a non-positive id. A client that persisted its own
      // negative temp id as local_id (the desktop return path did) dragged
      // MAX(local_id) negative, so the next allocation was negative too and
      // Android rejected it outright -- "Server did not allocate sales_returns
      // id" -- which broke returns on BOTH devices from that point on. One bad
      // row poisoned the whole sequence, so clamp at zero.
      let next = Math.max(0, Number(rows[0]?.mx || 0));
      const ids = [];
      for (let i = 0; i < count; i += 1) {
        next += 1;
        ids.push(next);
      }
      out[collection] = ids.length === 1 ? ids[0] : ids;
    }
    return { ids: out };
  });
}

export { upsertPharmacyProfile, upsertDropdowns };
