import { query, withTransaction } from '../db/pool.js';
import { config } from '../config/index.js';
import { AppError } from '../utils/http.js';
import { parseTs, toBool, fyStartYearForDate, encodeSalesBillNo, encodePurchaseNo, fyLabel, displaySalesBillNo, displayPurchaseNo } from '../utils/fy.js';
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
  upsertMedicineMaster,
} from './extraUpserts.js';

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
  'medicines_master',
];

export const SPECIAL_COLLECTIONS = [
  'pharmacy_profile',
  'dropdowns',
  'shelf_settings',
  'settings',
];

/** Conflict resolution: higher version → newer updated_at → device_id → skip */
export function shouldAcceptIncoming(existing, incoming) {
  if (!existing) return 'accept';
  if (incoming.deleted && !existing.deleted) return 'accept';

  const ev = Number(existing.version || 1);
  const iv = Number(incoming.version || 1);
  if (iv > ev) return 'accept';
  if (iv < ev) return 'skip';

  const et = parseTs(existing.updated_at)?.getTime() || 0;
  const it = parseTs(incoming.updated_at)?.getTime() || 0;
  if (it > et) return 'accept';
  if (it < et) return 'skip';

  const ed = existing.device_id || '';
  const id = incoming.device_id || '';
  if (id && !ed) return 'accept';
  if (ed && !id) return 'skip';
  if (id && ed && id > ed) return 'accept';
  if (id && ed && id < ed) return 'skip';
  return 'skip';
}

function syncMeta(doc) {
  return {
    updated_at: parseTs(doc.updated_at) || parseTs(doc.synced_at) || new Date(),
    version: Number(doc.version || 1),
    device_id: doc.device_id || null,
    deleted: toBool(doc.deleted),
    sync_status: doc.sync_status || 'synced',
  };
}

function localIdOf(doc) {
  const id = doc.id ?? doc.local_id;
  if (id === undefined || id === null || id === '') throw new AppError(400, 'Document id required');
  return Number(id);
}

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
      meta.updated_at, meta.version, meta.device_id, meta.deleted, meta.sync_status,
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
      meta.updated_at, meta.version, meta.device_id, meta.deleted, meta.sync_status,
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
      meta.updated_at, meta.version, meta.device_id, meta.deleted, meta.sync_status,
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
  // Medicine stock: if skip on metadata, still allow stock merge from newer stock? Keep LWW for simplicity;
  // when accepting, take incoming stock_qty as source of truth (client already merged).
  if (decision === 'skip') return { id: localId, status: 'skipped' };

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
      doc.expiry_date || null, doc.hsn_code || null, doc.schedule || null,
      doc.location || null, doc.content_drug || null,
      toBool(doc.is_hidden), parseTs(doc.synced_at), parseTs(doc.created_at),
      meta.updated_at, meta.version, meta.device_id, meta.deleted, meta.sync_status,
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
      meta.updated_at, meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  const salePk = result.rows[0].id;
  await client.query(`DELETE FROM sales_items WHERE sale_id = $1`, [salePk]);
  const items = Array.isArray(doc.items) ? doc.items : [];
  for (const it of items) {
    await client.query(
      `INSERT INTO sales_items (
         store_pk, sale_id, medicine_id, name, type, batch_no, expiry_date, hsn_code,
         schedule, manufacturer, qty, rate, gst_percent, amount, item_discount, cost_price
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        storePk, salePk, it.medicine_id ?? null, it.name || null, it.type || null,
        it.batch_no || null, it.expiry_date || null, it.hsn_code || null,
        it.schedule || null, it.manufacturer || null,
        Number(it.qty || 0), Number(it.rate || 0), it.gst_percent ?? null,
        Number(it.amount || 0), Number(it.item_discount || 0), Number(it.cost_price || 0),
      ]
    );
  }
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
      meta.updated_at, meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  const purchasePk = result.rows[0].id;
  await client.query(`DELETE FROM purchase_items WHERE purchase_id = $1`, [purchasePk]);
  for (const it of (doc.items || [])) {
    await client.query(
      `INSERT INTO purchase_items (
         store_pk, purchase_id, medicine_id, name, qty, free_qty, type, hsn_code, gst_pct,
         mrp, rate, manufacturer, batch_no, expiry_date, schedule, discount_pct,
         taxable, gst_amt, item_amount
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        storePk, purchasePk, it.medicine_id ?? null, it.name || null,
        Number(it.qty || 0), Number(it.free_qty || 0), it.type || null, it.hsn_code || null,
        Number(it.gst_pct ?? it.gst_percent ?? 0), Number(it.mrp || 0), Number(it.rate || 0),
        it.manufacturer || null, it.batch_no || null, it.expiry_date || null, it.schedule || null,
        Number(it.discount_pct ?? it.discount_percent ?? 0),
        Number(it.taxable || 0), Number(it.gst_amt ?? it.gst_value ?? 0),
        Number(it.item_amount ?? it.amount ?? 0),
      ]
    );
  }
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
      meta.updated_at, meta.version, meta.device_id, meta.deleted, meta.sync_status,
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
      meta.updated_at, meta.version, meta.device_id, meta.deleted, meta.sync_status,
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
      meta.updated_at, meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  const retPk = result.rows[0].id;
  await client.query(`DELETE FROM sales_return_items WHERE return_id = $1`, [retPk]);
  for (const it of (doc.items || [])) {
    await client.query(
      `INSERT INTO sales_return_items (store_pk, return_id, medicine_id, name, batch_no, qty, rate, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [storePk, retPk, it.medicine_id ?? null, it.name || null, it.batch_no || it.batch || null,
        Number(it.qty || 0), Number(it.rate || 0), Number(it.amount || 0)]
    );
  }
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
      meta.updated_at, meta.version, meta.device_id, meta.deleted, meta.sync_status,
    ]
  );
  const retPk = result.rows[0].id;
  await client.query(`DELETE FROM purchase_return_items WHERE return_id = $1`, [retPk]);
  for (const it of (doc.items || [])) {
    await client.query(
      `INSERT INTO purchase_return_items (store_pk, return_id, medicine_id, name, batch_no, qty, rate, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [storePk, retPk, it.medicine_id ?? null, it.name || null, it.batch_no || it.batch || null,
        Number(it.qty || 0), Number(it.rate || 0), Number(it.amount || 0)]
    );
  }
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
  medicines_master: upsertMedicineMaster,
};

export async function pushDocs(storePk, collection, docs) {
  if (collection === 'settings') {
    return withTransaction(async (client) => upsertSettingsKv(client, storePk, docs));
  }
  if (collection === 'shelf_settings') {
    return withTransaction(async (client) => {
      const r = await upsertShelfSettings(client, storePk, Array.isArray(docs) ? docs[0] : docs);
      return { results: [r], upserted: 1, skipped: 0 };
    });
  }
  const fn = UPSERT_MAP[collection];
  if (!fn) throw new AppError(400, `Unknown collection: ${collection}`);
  if (!Array.isArray(docs) || !docs.length) return { results: [], upserted: 0, skipped: 0 };

  return withTransaction(async (client) => {
    const results = [];
    let upserted = 0;
    let skipped = 0;
    for (const doc of docs) {
      const r = await fn(client, storePk, doc);
      results.push(r);
      if (r.status === 'upserted') upserted++;
      else skipped++;
    }
    return { results, upserted, skipped };
  });
}

export async function pushBundle(storePk, bundle) {
  // Masters first, then transactions, then local feature tables
  const order = [
    'customers', 'suppliers', 'medicines', 'doctors', 'medicines_master',
    'sales', 'purchases', 'customer_payments', 'supplier_payments',
    'sales_returns', 'purchase_returns',
    'general_products', 'stock_disposals', 'pending_orders',
    'racks', 'sections', 'boxes', 'shelves', 'medicine_shelf', 'medicine_suppliers',
  ];
  const summary = {};
  return withTransaction(async (client) => {
    for (const col of order) {
      const docs = bundle[col];
      if (!docs?.length) continue;
      const fn = UPSERT_MAP[col];
      const results = [];
      let upserted = 0;
      let skipped = 0;
      for (const doc of docs) {
        const r = await fn(client, storePk, doc);
        results.push(r);
        if (r.status === 'upserted') upserted++;
        else skipped++;
      }
      summary[col] = { upserted, skipped, results };
    }
    if (bundle.pharmacy_profile) {
      await upsertPharmacyProfile(client, storePk, bundle.pharmacy_profile);
      summary.pharmacy_profile = { upserted: 1 };
    }
    if (bundle.dropdowns) {
      await upsertDropdowns(client, storePk, bundle.dropdowns);
      summary.dropdowns = { upserted: 1 };
    }
    if (bundle.shelf_settings) {
      await upsertShelfSettings(client, storePk, bundle.shelf_settings);
      summary.shelf_settings = { upserted: 1 };
    }
    if (bundle.settings) {
      summary.settings = await upsertSettingsKv(client, storePk, bundle.settings);
    }
    return summary;
  });
}

async function upsertPharmacyProfile(client, storePk, doc) {
  await client.query(
    `INSERT INTO pharmacy_profiles (
       store_pk, name, address, phone, email, gstin, dl_number, gst_enabled,
       fssai_number, show_fssai_on_bill, logo_path, updated_at, version, device_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12,$13)
     ON CONFLICT (store_pk) DO UPDATE SET
       name=EXCLUDED.name, address=EXCLUDED.address, phone=EXCLUDED.phone,
       email=EXCLUDED.email, gstin=EXCLUDED.gstin, dl_number=EXCLUDED.dl_number,
       gst_enabled=EXCLUDED.gst_enabled, fssai_number=EXCLUDED.fssai_number,
       show_fssai_on_bill=EXCLUDED.show_fssai_on_bill, logo_path=EXCLUDED.logo_path,
       updated_at=NOW(), version=EXCLUDED.version, device_id=EXCLUDED.device_id`,
    [
      storePk, doc.name || null, doc.address || null, doc.phone || null, doc.email || null,
      doc.gstin || null, doc.dl_number || null, toBool(doc.gst_enabled ?? true),
      doc.fssai_number || null, toBool(doc.show_fssai_on_bill), doc.logo_path || null,
      Number(doc.version || 1), doc.device_id || null,
    ]
  );
}

async function upsertDropdowns(client, storePk, doc) {
  await client.query(
    `INSERT INTO store_dropdowns (store_pk, villages, default_village, med_types, schedules, updated_at)
     VALUES ($1, $2::jsonb, $3, $4::jsonb, $5::jsonb, NOW())
     ON CONFLICT (store_pk) DO UPDATE SET
       villages=EXCLUDED.villages, default_village=EXCLUDED.default_village,
       med_types=EXCLUDED.med_types, schedules=EXCLUDED.schedules, updated_at=NOW()`,
    [
      storePk,
      JSON.stringify(doc.villages || []),
      doc.default_village || null,
      JSON.stringify(doc.med_types || []),
      JSON.stringify(doc.schedules || []),
    ]
  );
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

export async function pullCollection(storePk, collection, { since, includeDeleted = true, limit = 5000 } = {}) {
  const allowed = [...COLLECTIONS, ...SPECIAL_COLLECTIONS];
  if (!allowed.includes(collection)) {
    throw new AppError(400, `Unknown collection: ${collection}`);
  }
  const cutoff = watermarkCutoff(since);
  const lim = Math.min(Number(limit) || 5000, 20000);

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
      sql = `SELECT local_id AS id, name, manufacturer, mrp, content_drug, med_type, pack_size, created_at,
                    updated_at, version, device_id, deleted, sync_status
             FROM medicines_master WHERE store_pk IS NOT DISTINCT FROM $1 AND updated_at > $2${delClause}
             ORDER BY updated_at ASC LIMIT $3`;
      break;
    default:
      throw new AppError(400, `Unknown collection: ${collection}`);
  }

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

/** Allocate next FY serial atomically */
export async function allocateFySerial(storePk, kind, dateValue) {
  const fy = fyStartYearForDate(dateValue);
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO fy_serials (store_pk, kind, fy_start_year, last_serial)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT DO NOTHING`,
      [storePk, kind, fy]
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
