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
} from './upsertHelper.js';
import {
  ensureStoreSyncState,
  recordAcceptedChange,
  newSyncHint,
} from './syncRevision.js';
import { broadcastSyncHint } from '../ws/syncHub.js';

export { shouldAcceptIncoming } from './upsertHelper.js';

function emitSyncHint(hint) {
  if (!hint?.revisions?.length) return;
  broadcastSyncHint(hint.storePk, {
    head_revision: Math.max(...hint.revisions),
    source_device_id: hint.sourceDeviceId || null,
  });
}

async function noteAcceptedChange(client, hint, storePk, collection, doc, status, overrides = {}) {
  if (!isAcceptedWrite(status)) return;
  const meta = doc && typeof doc === 'object' ? syncMeta(doc) : {};
  const localId =
    overrides.localId != null
      ? Number(overrides.localId)
      : doc && typeof doc === 'object'
        ? localIdOf(doc)
        : Number(doc);
  await recordAcceptedChange(client, hint, {
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
  });
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
async function multiUpsert(client, table, columns, updateCols, rows, { batchSize = 150 } = {}) {
  if (!rows?.length) return;
  const colSql = columns.join(', ');
  const width = columns.length;
  const updates = updateCols.map((c) => `${c}=EXCLUDED.${c}`).join(', ');
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

async function prefetchExisting(client, table, storePk, localIds) {
  if (!localIds.length) return new Map();
  const res = await client.query(
    `SELECT local_id, id, version, updated_at, device_id, deleted
     FROM ${table}
     WHERE store_pk=$1 AND local_id = ANY($2::bigint[])`,
    [storePk, localIds]
  );
  return new Map(res.rows.map((r) => [Number(r.local_id), r]));
}

const FLAT_BULK = new Set([
  'customers',
  'suppliers',
  'doctors',
  'medicines',
  'customer_payments',
  'supplier_payments',
]);

async function pushFlatBulk(client, storePk, collection, docs, hint = null) {
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
        doc.phone || null, doc.address || null, doc.document_name || null,
        Number(doc.total_due || 0), Number(doc.total_credit || 0),
        parseTs(doc.created_at), parseTs(doc.last_updated),
        writeAt, meta.version, meta.device_id, meta.deleted, meta.sync_status,
      ]);
    } else if (collection === 'suppliers') {
      rows.push([
        storePk, localId, String(doc.name || '').toUpperCase(),
        doc.address || null, doc.phone || null, doc.gstin || null, doc.dl_numbers || null,
        Number(doc.total_due || 0), Number(doc.total_credit || 0), parseTs(doc.created_at),
        writeAt, meta.version, meta.device_id, meta.deleted, meta.sync_status,
      ]);
    } else if (collection === 'doctors') {
      rows.push([
        storePk, localId, String(doc.name || '').toUpperCase(),
        doc.phone || null, doc.registration_number || null, parseTs(doc.created_at),
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
    ], rows);
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
      'is_hidden', 'synced_at', 'created_at',
      'updated_at', 'version', 'device_id', 'deleted', 'sync_status',
    ], [
      'name', 'type', 'stock_qty', 'unit', 'gst_percent', 'mrp', 'rate',
      'manufacturer', 'batch_no', 'expiry_date', 'hsn_code', 'schedule', 'location',
      'content_drug', 'is_hidden', 'synced_at',
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

  for (const doc of acceptedDocs) {
    await noteAcceptedChange(client, hint, storePk, collection, doc, 'upserted');
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

async function upsertCustomer(client, storePk, doc) {
  const localId = localIdOf(doc);
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT version, updated_at, device_id, deleted FROM customers WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (shouldAcceptIncoming(existing.rows[0], { ...meta }) === 'skip') {
    return { id: localId, status: 'skipped' };
  }
  await client.query(
    `INSERT INTO customers (
       store_pk, local_id, name, phone, address, document_name,
       total_due, total_credit, created_at, last_updated,
       updated_at, version, device_id, deleted, sync_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (store_pk, local_id) DO UPDATE SET
       name=EXCLUDED.name, phone=EXCLUDED.phone, address=EXCLUDED.address,
       document_name=EXCLUDED.document_name, total_due=EXCLUDED.total_due,
       total_credit=EXCLUDED.total_credit, last_updated=EXCLUDED.last_updated,
       updated_at=EXCLUDED.updated_at, version=EXCLUDED.version,
       device_id=EXCLUDED.device_id, deleted=EXCLUDED.deleted, sync_status=EXCLUDED.sync_status`,
    [
      storePk, localId,
      String(doc.name || '').toUpperCase(),
      doc.phone || null, doc.address || null, doc.document_name || null,
      Number(doc.total_due || 0), Number(doc.total_credit || 0),
      parseTs(doc.created_at), parseTs(doc.last_updated),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  return { id: localId, status: 'upserted' };
}

async function upsertSupplier(client, storePk, doc) {
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
      Number(doc.total_due || 0), Number(doc.total_credit || 0), parseTs(doc.created_at),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
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
      doc.phone || null, doc.registration_number || null, parseTs(doc.created_at),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  return { id: localId, status: 'upserted' };
}

async function upsertMedicine(client, storePk, doc) {
  const localId = localIdOf(doc);
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT version, updated_at, device_id, deleted, stock_qty FROM medicines WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  const decision = shouldAcceptIncoming(existing.rows[0], { ...meta });
  // When LWW skips (stale updated_at) but stock_qty changed — e.g. Android sale
  // decreased stock without bumping sync meta — still apply the stock figure.
  if (decision === 'skip') {
    const prevQty = Number(existing.rows[0]?.stock_qty ?? 0);
    const nextQty = Number(doc.stock_qty || 0);
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
      return { id: localId, status: 'stock_patched' };
    }
    return { id: localId, status: 'skipped' };
  }

  await client.query(
    `INSERT INTO medicines (
       store_pk, local_id, name, type, stock_qty, unit, gst_percent, mrp, rate,
       manufacturer, batch_no, expiry_date, hsn_code, schedule, location, content_drug,
       is_hidden, synced_at, created_at,
       updated_at, version, device_id, deleted, sync_status
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
     )
     ON CONFLICT (store_pk, local_id) DO UPDATE SET
       name=EXCLUDED.name, type=EXCLUDED.type, stock_qty=EXCLUDED.stock_qty, unit=EXCLUDED.unit,
       gst_percent=EXCLUDED.gst_percent, mrp=EXCLUDED.mrp, rate=EXCLUDED.rate,
       manufacturer=EXCLUDED.manufacturer, batch_no=EXCLUDED.batch_no, expiry_date=EXCLUDED.expiry_date,
       hsn_code=EXCLUDED.hsn_code, schedule=EXCLUDED.schedule, location=EXCLUDED.location,
       content_drug=EXCLUDED.content_drug, is_hidden=EXCLUDED.is_hidden, synced_at=EXCLUDED.synced_at,
       updated_at=EXCLUDED.updated_at, version=EXCLUDED.version, device_id=EXCLUDED.device_id,
       deleted=EXCLUDED.deleted, sync_status=EXCLUDED.sync_status`,
    [
      storePk, localId, String(doc.name || '').toUpperCase(), doc.type || null,
      Number(doc.stock_qty || 0), doc.unit || null,
      doc.gst_percent ?? null, doc.mrp ?? null, doc.rate ?? null,
      doc.manufacturer || null, doc.batch_no || null,
      parseDateOnly(doc.expiry_date), doc.hsn_code || null, doc.schedule || null,
      doc.location || null, doc.content_drug || null,
      toBool(doc.is_hidden), parseTs(doc.synced_at), parseTs(doc.created_at),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  return { id: localId, status: 'upserted' };
}

async function upsertSale(client, storePk, doc) {
  const localId = localIdOf(doc);
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT id, version, updated_at, device_id, deleted FROM sales WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (shouldAcceptIncoming(existing.rows[0], { ...meta }) === 'skip') {
    return { id: localId, status: 'skipped' };
  }

  const billNo = doc.bill_no || encodeSalesBillNo(doc.fy_serial || localId, doc.fy_start_year || fyStartYearForDate(doc.bill_date));
  const fyStart = doc.fy_start_year ?? fyStartYearForDate(doc.bill_date);

  const result = await client.query(
    `INSERT INTO sales (
       store_pk, local_id, bill_no, customer_id, bill_date, total_amount, discount, discount_pct,
       rounding, amount_paid, cash_paid, online_paid, previous_due, previous_credit,
       due_amount, credit_amount, total_due, paid_due, bill_cleared, account_cleared,
       doctor_name, is_autosave, fy_start_year, fy_serial,
       customer_name, customer_phone, customer_address, item_count, created_at,
       updated_at, version, device_id, deleted, sync_status
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
       $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34
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
       deleted=EXCLUDED.deleted, sync_status=EXCLUDED.sync_status
     RETURNING id`,
    [
      storePk, localId, billNo, doc.customer_id ?? null, doc.bill_date,
      Number(doc.total_amount || 0), Number(doc.discount || 0), Number(doc.discount_pct || 0),
      Number(doc.rounding || 0), Number(doc.amount_paid || 0), Number(doc.cash_paid || 0),
      Number(doc.online_paid || 0), Number(doc.previous_due || 0), Number(doc.previous_credit || 0),
      Number(doc.due_amount || 0), Number(doc.credit_amount || 0), Number(doc.total_due || 0),
      Number(doc.paid_due || 0), toBool(doc.bill_cleared), toBool(doc.account_cleared),
      doc.doctor_name || null, toBool(doc.is_autosave), fyStart, doc.fy_serial ?? null,
      doc.customer_name || null, doc.customer_phone || null, doc.customer_address || null,
      Number(doc.item_count || (doc.items?.length || 0)), parseTs(doc.created_at),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  const salePk = result.rows[0].id;
  await client.query(`DELETE FROM sales_items WHERE sale_id = $1`, [salePk]);
  const items = Array.isArray(doc.items) ? doc.items : [];
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
  // Keep FY serial table in sync for server-side allocation
  if (fyStart && doc.fy_serial && !toBool(doc.is_autosave)) {
    await client.query(
      `INSERT INTO fy_serials (store_pk, kind, fy_start_year, last_serial)
       VALUES ($1, 'sales', $2, $3)
       ON CONFLICT (store_pk, kind, fy_start_year) DO UPDATE
         SET last_serial = GREATEST(fy_serials.last_serial, EXCLUDED.last_serial)`,
      [storePk, fyStart, Number(doc.fy_serial)]
    );
  }
  return { id: localId, status: 'upserted', bill_no: billNo, display_bill_no: displaySalesBillNo(billNo), fy_label: fyLabel(fyStart) };
}

async function upsertPurchase(client, storePk, doc) {
  const localId = localIdOf(doc);
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT id, version, updated_at, device_id, deleted FROM purchases WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (shouldAcceptIncoming(existing.rows[0], { ...meta }) === 'skip') {
    return { id: localId, status: 'skipped' };
  }
  const fyStart = doc.fy_start_year ?? fyStartYearForDate(doc.purchase_date);
  const purchaseNo = doc.purchase_no || encodePurchaseNo(doc.fy_serial || localId, fyStart);

  const result = await client.query(
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
     ON CONFLICT (store_pk, local_id) DO UPDATE SET
       purchase_no=EXCLUDED.purchase_no, supplier_id=EXCLUDED.supplier_id, purchase_date=EXCLUDED.purchase_date,
       bill_number=EXCLUDED.bill_number, subtotal=EXCLUDED.subtotal, total_gst=EXCLUDED.total_gst,
       cgst=EXCLUDED.cgst, sgst=EXCLUDED.sgst, total_amount=EXCLUDED.total_amount,
       overall_discount=EXCLUDED.overall_discount, rounding=EXCLUDED.rounding,
       need_to_pay=EXCLUDED.need_to_pay, final_amount=EXCLUDED.final_amount,
       amount_paid=EXCLUDED.amount_paid, amount_paid_at_entry=EXCLUDED.amount_paid_at_entry,
       cash_paid_at_entry=EXCLUDED.cash_paid_at_entry, online_paid_at_entry=EXCLUDED.online_paid_at_entry,
       previous_due=EXCLUDED.previous_due, previous_credit=EXCLUDED.previous_credit,
       due=EXCLUDED.due, current_credit=EXCLUDED.current_credit, total_due=EXCLUDED.total_due,
       due_amount=EXCLUDED.due_amount, credit_amount=EXCLUDED.credit_amount, paid_due=EXCLUDED.paid_due,
       bill_cleared=EXCLUDED.bill_cleared, account_cleared=EXCLUDED.account_cleared,
       gst_calc_method=EXCLUDED.gst_calc_method, expenditure=EXCLUDED.expenditure,
       is_autosave=EXCLUDED.is_autosave, fy_start_year=EXCLUDED.fy_start_year, fy_serial=EXCLUDED.fy_serial,
       supplier_name=EXCLUDED.supplier_name, supplier_phone=EXCLUDED.supplier_phone,
       item_count=EXCLUDED.item_count, updated_at=EXCLUDED.updated_at, version=EXCLUDED.version,
       device_id=EXCLUDED.device_id, deleted=EXCLUDED.deleted, sync_status=EXCLUDED.sync_status
     RETURNING id`,
    [
      storePk, localId, purchaseNo, doc.supplier_id ?? null, doc.purchase_date, doc.bill_number || null,
      Number(doc.subtotal || 0), Number(doc.total_gst || 0), Number(doc.cgst || 0), Number(doc.sgst || 0),
      Number(doc.total_amount || 0), Number(doc.overall_discount || 0), Number(doc.rounding || 0),
      Number(doc.need_to_pay || 0), Number(doc.final_amount || 0), Number(doc.amount_paid || 0),
      Number(doc.amount_paid_at_entry || 0), Number(doc.cash_paid_at_entry || 0),
      Number(doc.online_paid_at_entry || 0), Number(doc.previous_due || 0), Number(doc.previous_credit || 0),
      Number(doc.due || 0), Number(doc.current_credit || 0), Number(doc.total_due || 0),
      Number(doc.due_amount || 0), Number(doc.credit_amount || 0), Number(doc.paid_due || 0),
      toBool(doc.bill_cleared), toBool(doc.account_cleared), doc.gst_calc_method || null,
      Number(doc.expenditure || 0), toBool(doc.is_autosave), fyStart, doc.fy_serial ?? null,
      doc.supplier_name || null, doc.supplier_phone || null,
      Number(doc.item_count || (doc.items?.length || 0)), parseTs(doc.created_at),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  const purchasePk = result.rows[0].id;
  await client.query(`DELETE FROM purchase_items WHERE purchase_id = $1`, [purchasePk]);
  await multiInsert(
    client,
    'purchase_items',
    [
      'store_pk', 'purchase_id', 'medicine_id', 'name', 'qty', 'free_qty', 'type', 'hsn_code', 'gst_pct',
      'mrp', 'rate', 'manufacturer', 'batch_no', 'expiry_date', 'schedule', 'discount_pct',
      'taxable', 'gst_amt', 'item_amount',
    ],
    (doc.items || []).map((it) => [
      storePk, purchasePk, it.medicine_id ?? null, it.name || null,
      Number(it.qty || 0), Number(it.free_qty || 0), it.type || null, it.hsn_code || null,
      Number(it.gst_pct ?? it.gst_percent ?? 0), Number(it.mrp || 0), Number(it.rate || 0),
      it.manufacturer || null, it.batch_no || null, it.expiry_date || null, it.schedule || null,
      Number(it.discount_pct ?? it.discount_percent ?? 0),
      Number(it.taxable || 0), Number(it.gst_amt ?? it.gst_value ?? 0),
      Number(it.item_amount ?? it.amount ?? 0),
    ])
  );
  if (fyStart && doc.fy_serial && !toBool(doc.is_autosave)) {
    await client.query(
      `INSERT INTO fy_serials (store_pk, kind, fy_start_year, last_serial)
       VALUES ($1, 'purchases', $2, $3)
       ON CONFLICT (store_pk, kind, fy_start_year) DO UPDATE
         SET last_serial = GREATEST(fy_serials.last_serial, EXCLUDED.last_serial)`,
      [storePk, fyStart, Number(doc.fy_serial)]
    );
  }
  return { id: localId, status: 'upserted', purchase_no: purchaseNo, display_purchase_no: displayPurchaseNo(purchaseNo), fy_label: fyLabel(fyStart) };
}

async function upsertCustomerPayment(client, storePk, doc) {
  const localId = localIdOf(doc);
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
      doc.reference_no || null, doc.note || null, parseTs(doc.created_at),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  return { id: localId, status: 'upserted' };
}

async function upsertSupplierPayment(client, storePk, doc) {
  const localId = localIdOf(doc);
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
      Number(doc.due_before || 0), Number(doc.due_after || 0), parseTs(doc.created_at),
      writeTimestamp(meta, existing.rows[0]), meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  return { id: localId, status: 'upserted' };
}

async function upsertSalesReturn(client, storePk, doc) {
  const localId = localIdOf(doc);
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT id, version, updated_at, device_id, deleted FROM sales_returns WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (shouldAcceptIncoming(existing.rows[0], { ...meta }) === 'skip') return { id: localId, status: 'skipped' };
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
      doc.customer_id ?? null, doc.customer_name || null, doc.return_date,
      Number(doc.refund_amount || 0), Number(doc.discount || 0), doc.reason || null,
      Number(doc.item_count || (doc.items?.length || 0)), parseTs(doc.created_at),
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
  return { id: localId, status: 'upserted' };
}

async function upsertPurchaseReturn(client, storePk, doc) {
  const localId = localIdOf(doc);
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT id, version, updated_at, device_id, deleted FROM purchase_returns WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (shouldAcceptIncoming(existing.rows[0], { ...meta }) === 'skip') return { id: localId, status: 'skipped' };
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
      doc.supplier_id ?? null, doc.supplier_name || null, doc.return_date,
      Number(doc.refund_amount || 0), Number(doc.discount || 0), doc.reason || null,
      Number(doc.item_count || (doc.items?.length || 0)), parseTs(doc.created_at),
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
    await ensureStoreSyncState(client, storePk);
    if (FLAT_BULK.has(collection)) {
      return pushFlatBulk(client, storePk, collection, docs, hint);
    }
    const results = [];
    let upserted = 0;
    let skipped = 0;
    for (const doc of docs) {
      const r = await fn(client, storePk, doc);
      results.push(r);
      if (isAcceptedWrite(r.status)) {
        upserted++;
        await noteAcceptedChange(client, hint, storePk, collection, doc, r.status);
      } else {
        skipped++;
      }
    }
    return { results, upserted, skipped };
  });
  emitSyncHint(hint);
  return out;
}

export async function pushBundle(storePk, bundle) {
  // Masters first, then transactions, then local feature tables
  const order = [
    'customers', 'suppliers', 'medicines', 'doctors',
    'sales', 'purchases', 'customer_payments', 'supplier_payments',
    'sales_returns', 'purchase_returns',
    'general_products', 'stock_disposals', 'pending_orders',
    'racks', 'sections', 'boxes', 'shelves', 'medicine_shelf', 'medicine_suppliers',
  ];
  const summary = {};
  const hint = newSyncHint(storePk);
  await withTransaction(async (client) => {
    await ensureStoreSyncState(client, storePk);
    for (const col of order) {
      const docs = bundle[col];
      if (!docs?.length) continue;
      if (FLAT_BULK.has(col)) {
        summary[col] = await pushFlatBulk(client, storePk, col, docs, hint);
        continue;
      }
      const fn = UPSERT_MAP[col];
      const results = [];
      let upserted = 0;
      let skipped = 0;
      for (const doc of docs) {
        const r = await fn(client, storePk, doc);
        results.push(r);
        if (isAcceptedWrite(r.status)) {
          upserted++;
          await noteAcceptedChange(client, hint, storePk, col, doc, r.status);
        } else {
          skipped++;
        }
      }
      summary[col] = { upserted, skipped, results };
    }
    if (bundle.pharmacy_profile) {
      const pr = await upsertPharmacyProfile(client, storePk, bundle.pharmacy_profile);
      summary.pharmacy_profile = {
        upserted: pr?.status === 'skipped' ? 0 : 1,
        skipped: pr?.status === 'skipped' ? 1 : 0,
      };
      if (isAcceptedWrite(pr?.status)) {
        await noteAcceptedChange(
          client, hint, storePk, 'pharmacy_profile', bundle.pharmacy_profile, pr.status,
          { localId: 0 },
        );
      }
    }
    if (bundle.dropdowns) {
      const dr = await upsertDropdowns(client, storePk, bundle.dropdowns);
      summary.dropdowns = {
        upserted: dr?.status === 'skipped' ? 0 : 1,
        skipped: dr?.status === 'skipped' ? 1 : 0,
      };
      if (isAcceptedWrite(dr?.status)) {
        await noteAcceptedChange(
          client, hint, storePk, 'dropdowns', bundle.dropdowns, dr.status,
          { localId: 0 },
        );
      }
    }
    if (bundle.shelf_settings) {
      const sr = await upsertShelfSettings(client, storePk, bundle.shelf_settings);
      summary.shelf_settings = {
        upserted: sr?.status === 'skipped' ? 0 : 1,
        skipped: sr?.status === 'skipped' ? 1 : 0,
      };
      if (isAcceptedWrite(sr?.status)) {
        await noteAcceptedChange(
          client, hint, storePk, 'shelf_settings', bundle.shelf_settings, sr.status,
          { localId: 0 },
        );
      }
    }
    if (bundle.settings) {
      summary.settings = await upsertSettingsKv(client, storePk, bundle.settings);
      if (summary.settings.upserted > 0) {
        const first = Array.isArray(bundle.settings) ? bundle.settings[0] : bundle.settings;
        await noteAcceptedChange(client, hint, storePk, 'settings', null, 'upserted', {
          localId: 0,
          deviceId: first?.device_id,
        });
      }
    }
    return summary;
  });
  emitSyncHint(hint);
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
    await noteAcceptedChange(client, hint, storePk, collection, null, 'soft_deleted', {
      localId: Number(localId),
      entityVersion: Number(rows[0].version),
      entityUpdatedAt: rows[0].updated_at,
      deviceId: rows[0].device_id || deviceId,
    });
    return { deleted: true, id: Number(localId), status: 'soft_deleted' };
  });
  emitSyncHint(hint);
  return out;
}

async function upsertPharmacyProfile(client, storePk, doc) {
  const incoming = {
    name: doc.name || null,
    address: doc.address || null,
    phone: doc.phone || null,
    email: doc.email || null,
    gstin: doc.gstin || null,
    dl_number: doc.dl_number || null,
    gst_enabled: toBool(doc.gst_enabled ?? true),
    fssai_number: doc.fssai_number || null,
    show_fssai_on_bill: toBool(doc.show_fssai_on_bill),
    logo_path: doc.logo_path || null,
    version: Number(doc.version || 1),
    device_id: doc.device_id || null,
  };
  const { rows } = await client.query(
    `SELECT name, address, phone, email, gstin, dl_number, gst_enabled,
            fssai_number, show_fssai_on_bill, logo_path, version, device_id, updated_at
     FROM pharmacy_profiles WHERE store_pk=$1`,
    [storePk]
  );
  const existing = rows[0];
  if (
    existing &&
    sameScalarFields(existing, incoming, [
      'name', 'address', 'phone', 'email', 'gstin', 'dl_number', 'gst_enabled',
      'fssai_number', 'show_fssai_on_bill', 'logo_path', 'version', 'device_id',
    ])
  ) {
    return { status: 'skipped' };
  }
  const meta = syncMeta(doc);
  const writeAt = writeTimestamp(meta, existing);
  await client.query(
    `INSERT INTO pharmacy_profiles (
       store_pk, name, address, phone, email, gstin, dl_number, gst_enabled,
       fssai_number, show_fssai_on_bill, logo_path, updated_at, version, device_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (store_pk) DO UPDATE SET
       name=EXCLUDED.name, address=EXCLUDED.address, phone=EXCLUDED.phone,
       email=EXCLUDED.email, gstin=EXCLUDED.gstin, dl_number=EXCLUDED.dl_number,
       gst_enabled=EXCLUDED.gst_enabled, fssai_number=EXCLUDED.fssai_number,
       show_fssai_on_bill=EXCLUDED.show_fssai_on_bill, logo_path=EXCLUDED.logo_path,
       updated_at=EXCLUDED.updated_at, version=EXCLUDED.version, device_id=EXCLUDED.device_id`,
    [
      storePk, incoming.name, incoming.address, incoming.phone, incoming.email,
      incoming.gstin, incoming.dl_number, incoming.gst_enabled,
      incoming.fssai_number, incoming.show_fssai_on_bill, incoming.logo_path,
      writeAt, incoming.version, incoming.device_id,
    ]
  );
  return { status: 'upserted' };
}

async function upsertDropdowns(client, storePk, doc) {
  const villages = JSON.stringify(doc.villages || []);
  const medTypes = JSON.stringify(doc.med_types || []);
  const schedules = JSON.stringify(doc.schedules || []);
  const defaultVillage = doc.default_village || null;
  const { rows } = await client.query(
    `SELECT villages, default_village, med_types, schedules, updated_at
     FROM store_dropdowns WHERE store_pk=$1`,
    [storePk]
  );
  const existing = rows[0];
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
    `SELECT * FROM sales_items WHERE sale_id = ANY($1::bigint[])`,
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
    `SELECT * FROM purchase_items WHERE purchase_id = ANY($1::bigint[])`,
    [ids]
  );
  const byP = new Map();
  for (const it of items) {
    if (!byP.has(it.purchase_id)) byP.set(it.purchase_id, []);
    byP.get(it.purchase_id).push({
      medicine_id: it.medicine_id, name: it.name, qty: Number(it.qty), free_qty: Number(it.free_qty),
      type: it.type, hsn_code: it.hsn_code, gst_pct: Number(it.gst_pct), mrp: Number(it.mrp),
      rate: Number(it.rate), manufacturer: it.manufacturer, batch_no: it.batch_no,
      expiry_date: it.expiry_date, schedule: it.schedule, discount_pct: Number(it.discount_pct),
      taxable: Number(it.taxable), gst_amt: Number(it.gst_amt), item_amount: Number(it.item_amount),
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
                    is_hidden, synced_at, created_at, updated_at, version, device_id, deleted, sync_status
             FROM medicines WHERE store_pk=$1${idFilter}${delClause}`;
      break;
    case 'sales':
      sql = `SELECT id AS _pk, local_id AS id, bill_no, customer_id, bill_date, total_amount, discount,
                    discount_pct, rounding, amount_paid, cash_paid, online_paid, previous_due, previous_credit,
                    due_amount, credit_amount, total_due, paid_due, bill_cleared, account_cleared,
                    doctor_name, is_autosave, fy_start_year, fy_serial, customer_name, customer_phone,
                    customer_address, item_count, created_at, updated_at, version, device_id, deleted, sync_status
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
                    item_count, created_at, updated_at, version, device_id, deleted, sync_status
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
    const { rows } = await query(`SELECT * FROM pharmacy_profiles WHERE store_pk = $1`, [storePk]);
    return rows[0] || null;
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
                    is_hidden, synced_at, created_at, updated_at, version, device_id, deleted, sync_status
             FROM medicines WHERE store_pk=$1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      break;
    case 'sales':
      sql = `SELECT id AS _pk, local_id AS id, bill_no, customer_id, bill_date, total_amount, discount,
                    discount_pct, rounding, amount_paid, cash_paid, online_paid, previous_due, previous_credit,
                    due_amount, credit_amount, total_due, paid_due, bill_cleared, account_cleared,
                    doctor_name, is_autosave, fy_start_year, fy_serial, customer_name, customer_phone,
                    customer_address, item_count, created_at, updated_at, version, device_id, deleted, sync_status
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
                    item_count, created_at, updated_at, version, device_id, deleted, sync_status
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

/** Highest existing FY serial on sales/purchases (handles pre-counter data / migrations). */
async function maxExistingFySerial(client, storePk, kind, fy) {
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
       AND COALESCE(deleted, FALSE)=FALSE
       AND (
         fy_start_year = $2
         OR (${dateCol} >= $3 AND ${dateCol} <= $4)
       )`,
    [storePk, fy, from, to]
  );
  let maxSerial = Number(rows[0]?.m || 0);
  // Parse stored codes too (fy_serial may be null after older imports)
  const { rows: codes } = await client.query(
    `SELECT ${codeCol} AS code
     FROM ${table}
     WHERE store_pk=$1
       AND COALESCE(is_autosave, FALSE)=FALSE
       AND COALESCE(deleted, FALSE)=FALSE
       AND (
         fy_start_year = $2
         OR (${dateCol} >= $3 AND ${dateCol} <= $4)
       )`,
    [storePk, fy, from, to]
  );
  for (const row of codes) {
    const raw = String(row.code || '');
    const display = raw.includes('/FY') ? raw.split('/FY')[0] : raw;
    let n = null;
    if (kind === 'sales') {
      const m = display.match(/^SCB(\d+)$/i);
      if (m) n = Number(m[1]);
    } else if (/^\d+$/.test(display)) {
      n = Number(display);
    }
    if (Number.isFinite(n)) maxSerial = Math.max(maxSerial, n);
  }
  return maxSerial;
}

/** Allocate next FY serial atomically (seeded from existing bills so we never restart at 1). */
export async function allocateFySerial(storePk, kind, dateValue) {
  const fy = fyStartYearForDate(dateValue);
  return withTransaction(async (client) => {
    const dataMax = await maxExistingFySerial(client, storePk, kind, fy);
    await client.query(
      `INSERT INTO fy_serials (store_pk, kind, fy_start_year, last_serial)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (store_pk, kind, fy_start_year) DO UPDATE
         SET last_serial = GREATEST(fy_serials.last_serial, EXCLUDED.last_serial)`,
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
  });
}

export { upsertPharmacyProfile, upsertDropdowns };
