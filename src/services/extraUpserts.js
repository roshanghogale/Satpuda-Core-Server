/**
 * Extra collection upserts: shelves, disposals, orders, general products, medicine_suppliers, settings.
 */
import { upsertSimple, syncMeta, localIdOf, shouldAcceptIncoming } from './upsertHelper.js';
import { parseTs, toBool } from '../utils/fy.js';

const num = (v) => (v == null || v === '' ? null : Number(v));
const num0 = (v) => Number(v || 0);
const str = (v) => (v == null ? null : String(v));
const bool = (v) => toBool(v);
const ts = (v) => parseTs(v);
const date = (v) => (v ? String(v).slice(0, 10) : null);

export async function upsertGeneralProduct(client, storePk, doc) {
  return upsertSimple(client, {
    table: 'general_products', storePk, doc,
    columns: [
      { key: 'name', transform: (v) => String(v || '').toUpperCase() },
      { key: 'rate', transform: num0 },
      { key: 'mrp', transform: num0 },
      { key: 'created_at', transform: ts },
    ],
  });
}

export async function upsertStockDisposal(client, storePk, doc) {
  return upsertSimple(client, {
    table: 'stock_disposals', storePk, doc,
    columns: [
      { key: 'disposal_no', transform: str },
      { key: 'medicine_id', transform: num },
      { key: 'batch_no', transform: str },
      { key: 'supplier_id', transform: num },
      { key: 'purchase_id', transform: num },
      { key: 'bill_number', transform: str },
      { key: 'qty', transform: (v, d) => num0(v ?? d.quantity) },
      { key: 'original_purchase_qty', transform: num },
      { key: 'disposal_type', transform: str },
      { key: 'reason', transform: str },
      { key: 'expected_credit_note', transform: bool },
      { key: 'notes', transform: str },
      { key: 'disposal_date', transform: date },
      { key: 'created_at', transform: ts },
    ],
  });
}

export async function upsertPendingOrder(client, storePk, doc) {
  return upsertSimple(client, {
    table: 'pending_orders', storePk, doc,
    columns: [
      { key: 'order_no', transform: str },
      { key: 'medicine_id', transform: num },
      { key: 'medicine_name', transform: str },
      { key: 'pack_size', transform: str },
      { key: 'supplier_id', transform: num },
      { key: 'supplier_name_manual', transform: str },
      { key: 'supplier_phone', transform: str },
      { key: 'supplier_email', transform: str },
      { key: 'order_offline', transform: bool },
      { key: 'offline_note', transform: str },
      { key: 'qty', transform: (v, d) => num0(v ?? d.quantity) },
      { key: 'unit_price', transform: num0 },
      { key: 'current_stock', transform: num0 },
      { key: 'min_stock', transform: num0 },
      { key: 'order_date', transform: date },
      { key: 'expected_delivery_date', transform: date },
      { key: 'order_group_id', transform: str },
      { key: 'status', transform: (v) => v || 'draft' },
      { key: 'notes', transform: str },
      { key: 'created_at', transform: ts },
    ],
  });
}

export async function upsertRack(client, storePk, doc) {
  return upsertSimple(client, {
    table: 'racks', storePk, doc,
    columns: [
      { key: 'name', transform: str },
      { key: 'created_at', transform: ts },
    ],
  });
}

export async function upsertSection(client, storePk, doc) {
  return upsertSimple(client, {
    table: 'sections', storePk, doc,
    columns: [
      { key: 'rack_id', transform: num },
      { key: 'name', transform: str },
      { key: 'created_at', transform: ts },
    ],
  });
}

export async function upsertBox(client, storePk, doc) {
  return upsertSimple(client, {
    table: 'boxes', storePk, doc,
    columns: [
      { key: 'section_id', transform: num },
      { key: 'name', transform: str },
      { key: 'created_at', transform: ts },
    ],
  });
}

export async function upsertShelf(client, storePk, doc) {
  return upsertSimple(client, {
    table: 'shelves', storePk, doc,
    columns: [
      { key: 'shelf_no', transform: str },
      { key: 'description', transform: str },
      { key: 'created_at', transform: ts },
    ],
  });
}

export async function upsertMedicineShelf(client, storePk, doc) {
  return upsertSimple(client, {
    table: 'medicine_shelf', storePk, doc,
    columns: [
      { key: 'medicine_id', transform: num },
      { key: 'shelf_id', transform: num },
      { key: 'created_at', transform: ts },
    ],
  });
}

export async function upsertMedicineSupplier(client, storePk, doc) {
  return upsertSimple(client, {
    table: 'medicine_suppliers', storePk, doc,
    columns: [
      { key: 'medicine_name', transform: (v) => String(v || '').toUpperCase() },
      { key: 'supplier_id', transform: num0 },
      { key: 'last_rate', transform: num0 },
      { key: 'last_purchase_date', transform: date },
      { key: 'created_at', transform: ts },
    ],
  });
}

export async function upsertShelfSettings(client, storePk, doc) {
  await client.query(
    `INSERT INTO shelf_settings (store_pk, show_location, updated_at, version, device_id)
     VALUES ($1,$2,NOW(),$3,$4)
     ON CONFLICT (store_pk) DO UPDATE SET
       show_location=EXCLUDED.show_location, updated_at=NOW(),
       version=EXCLUDED.version, device_id=EXCLUDED.device_id`,
    [storePk, toBool(doc.show_location), Number(doc.version || 1), doc.device_id || null]
  );
  return { id: storePk, status: 'upserted' };
}

export async function upsertSettingsKv(client, storePk, docs) {
  const list = Array.isArray(docs) ? docs : [docs];
  let n = 0;
  for (const doc of list) {
    const name = doc.name || doc.key;
    if (!name) continue;
    await client.query(
      `INSERT INTO store_settings (store_pk, name, value, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (store_pk, name) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [storePk, String(name), doc.value == null ? null : String(doc.value)]
    );
    n++;
  }
  return { results: [], upserted: n, skipped: 0 };
}

export async function upsertMedicineMaster(client, storePk, doc) {
  const localId = localIdOf(doc);
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT version, updated_at, device_id, deleted FROM medicines_master
     WHERE store_pk IS NOT DISTINCT FROM $1 AND local_id=$2`,
    [storePk, localId]
  );
  if (shouldAcceptIncoming(existing.rows[0], meta) === 'skip') {
    return { id: localId, status: 'skipped' };
  }
  if (existing.rows[0]) {
    await client.query(
      `UPDATE medicines_master SET
         name=$3, manufacturer=$4, mrp=$5, content_drug=$6, med_type=$7, pack_size=$8,
         updated_at=$9, version=$10, device_id=$11, deleted=$12, sync_status=$13
       WHERE store_pk IS NOT DISTINCT FROM $1 AND local_id=$2`,
      [
        storePk, localId, String(doc.name || '').toUpperCase(),
        doc.manufacturer || null, doc.mrp ?? null, doc.content_drug || null,
        doc.med_type || doc.type || null, doc.pack_size || null,
        meta.updated_at, meta.version, meta.device_id, meta.deleted, meta.sync_status,
      ]
    );
  } else {
    await client.query(
      `INSERT INTO medicines_master (
         store_pk, local_id, name, manufacturer, mrp, content_drug, med_type, pack_size,
         created_at, updated_at, version, device_id, deleted, sync_status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10,$11,$12,$13)`,
      [
        storePk, localId, String(doc.name || '').toUpperCase(),
        doc.manufacturer || null, doc.mrp ?? null, doc.content_drug || null,
        doc.med_type || doc.type || null, doc.pack_size || null,
        meta.updated_at, meta.version, meta.device_id, meta.deleted, meta.sync_status,
      ]
    );
  }
  return { id: localId, status: 'upserted' };
}
