// Shivkrupa (store 4), 13 Oct 2026, owner: MAPDOX DT 100 TABLET (local 15535, batch D24L01CE,
// exp 10/26, 50 tablets = 5 strips on the books) -- 4 strips went back to APEKSHA MEDICAL STORES
// and 1 strip expired. Bought on Apeksha purchase 14/FY2025-26 (local 2658): 5 strips + 1 free
// for Rs 573.97, so a strip is valued 573.97 / 5 = 114.79 and the return 4 x 114.79 = 459.18.
//
// Through pushBundle (sync changes, supplier cascade, stock log), like the app's own saves:
//   1. a purchase return to Apeksha: 4 strips, Rs 459.18, stock -40;
//   2. an expiry write-off: 1 strip (10 tablets), stock -10.
// DATABASE_URL: the DB to write (a rehearsal copy first). Dry unless --write.
import { pool } from '../src/db/pool.js';
import { pushBundle, allocateLocalIds } from '../src/services/syncService.js';

const STORE = 4;
const MED = 15535;
const PURCHASE = 2658;
const SUPPLIER = 265;
const DEVICE = 'shivkrupa-mapdox-2026-10-13';
const WRITE = process.argv.includes('--write');

const m = (await pool.query(
  `SELECT name, batch_no, stock_qty FROM medicines WHERE store_pk=$1 AND local_id=$2 AND NOT deleted`, [STORE, MED])).rows[0];
if (!m || m.batch_no !== 'D24L01CE' || Number(m.stock_qty) !== 50) {
  throw new Error(`Mapdox is not as expected (stock ${m?.stock_qty}, batch ${m?.batch_no}) -- stop and look again`);
}
const p = (await pool.query(
  `SELECT purchase_no, bill_number, supplier_id, supplier_name FROM purchases WHERE store_pk=$1 AND local_id=$2 AND NOT deleted`,
  [STORE, PURCHASE])).rows[0];
if (!p || Number(p.supplier_id) !== SUPPLIER) throw new Error('purchase 2658 is not the Apeksha purchase');
const done = (await pool.query(
  `SELECT 1 FROM stock_operations WHERE store_pk=$1 AND device_id=$2 LIMIT 1`, [STORE, DEVICE])).rows[0];
if (done) throw new Error('already done');

const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); // IST
const now = new Date().toISOString();
console.log(`${m.name} ${m.batch_no}: stock 50 -> 0 (return 40 to ${p.supplier_name}, expired 10)`);
if (!WRITE) {
  console.log('dry: nothing written (pass --write)');
  await pool.end();
  process.exit(0);
}
const ids = (await allocateLocalIds(STORE, [
  { collection: 'purchase_returns', count: 1 }, { collection: 'stock_disposals', count: 1 },
])).ids;
const retId = Number(ids.purchase_returns);
const dispId = Number(ids.stock_disposals);
const ret = {
  id: retId, return_no: `PR${retId}`, purchase_id: PURCHASE, purchase_no: p.purchase_no,
  supplier_id: SUPPLIER, supplier_name: p.supplier_name, return_date: today,
  refund_amount: 459.18, discount: 0, reason: 'Returned to supplier (4 strips)',
  item_count: 1, items: [{ medicine_id: MED, name: m.name, batch_no: m.batch_no, qty: 4, rate: 114.79, amount: 459.18 }],
  created_at: now, updated_at: now, version: 1, device_id: DEVICE, sync_status: 'synced', deleted: false,
};
const disp = {
  id: dispId, disposal_no: `SD${today.replace(/-/g, '')}${String(dispId).padStart(4, '0')}`,
  medicine_id: MED, batch_no: m.batch_no, supplier_id: SUPPLIER, purchase_id: PURCHASE,
  bill_number: p.bill_number || '', quantity: 10, qty: 10, original_purchase_qty: 60,
  disposal_type: 'writeoff', reason: 'Expired', expected_credit_note: 0, notes: '1 strip expired',
  disposal_date: today, created_at: now, updated_at: now, version: 1, device_id: DEVICE,
  sync_status: 'synced', deleted: false,
};
const ops = [
  { op_uuid: `${DEVICE}-return-${retId}`, medicine_id: MED, op: 'purchase_return', qty_delta: -40,
    ref_collection: 'purchase_returns', ref_id: retId, device_id: DEVICE },
  { op_uuid: `stock_disposals:${dispId}:med:${MED}:v1`, medicine_id: MED, op: 'writeoff', qty_delta: -10,
    ref_collection: 'stock_disposals', ref_id: dispId, device_id: DEVICE },
];
const res = await pushBundle(STORE, { purchase_returns: [ret], stock_disposals: [disp], stock_operations: ops });
console.log(JSON.stringify(res, null, 1).slice(0, 2000));
const after = (await pool.query(`SELECT stock_qty FROM medicines WHERE store_pk=$1 AND local_id=$2`, [STORE, MED])).rows[0];
const sup = (await pool.query(`SELECT total_due, total_credit FROM suppliers WHERE store_pk=$1 AND local_id=$2`, [STORE, SUPPLIER])).rows[0];
console.log(`after: stock ${after.stock_qty}; ${ret.return_no} Rs 459.18; write-off ${disp.disposal_no}; Apeksha due ${sup.total_due} credit ${sup.total_credit}`);
await pool.end();
