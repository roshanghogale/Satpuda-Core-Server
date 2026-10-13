// Shivkrupa (store 4), 13 Oct 2026: two purchase returns imported from eVitalRx reached the
// server with only their FIRST line (Purchase_Return_Register.xlsx, 8 Aug 2026), so the stock
// of the other lines was never taken out:
//   PR1  (local 33) Ganeshwari 25-11-25: Metrogyl 400 kept; Rinifol 150, Rabemac DSR 15,
//        Metrogyl 200 50 missing.
//   PR34 (local 34) Nahar Meditrade 21-05-26: Zerodol Spas kept; Pan 40 135, Pan D 60 missing.
// The returns' refund_amount already counts every line, so the suppliers' dues are right;
// only the lines and the stock are put right here.
//
// Through the server's own pushBundle (sync changes for the devices, stock log): each return
// is saved again with all its lines, and the missing lines' stock goes out as stock
// operations. Pan D has 46 left and 60 were returned: it goes to 0 (-46), not below.
//
// DATABASE_URL: the DB to write (a rehearsal copy first). Dry unless --write.
import { pool } from '../src/db/pool.js';
import { pushBundle } from '../src/services/syncService.js';

const STORE = 4;
const DEVICE = 'fix-shivkrupa-returns-2026-10-13';
const WRITE = process.argv.includes('--write');

// medicine local_id -> the missing line (qty in strips as the return lines hold it; units for stock)
const RETURNS = {
  33: {
    keep: 15548, refund: 1017.49,
    add: [
      { medicine_id: 15547, name: 'RINIFOL CAPSULE', batch_no: 'RFC5E010', qty: 10, amount: 679.0, units: 150 },
      { medicine_id: 15777, name: 'RABEMAC DSR CAPSULE', batch_no: '18251592A', qty: 1, amount: 165.38, units: 15 },
      { medicine_id: 15549, name: 'METROGYL 200 TABLET', batch_no: 'BM225010', qty: 5, amount: 69.4, units: 50 },
    ],
  },
  34: {
    keep: 15802, refund: 2476.12,
    add: [
      { medicine_id: 15849, name: 'PAN 40 TABLET', batch_no: '25440890', qty: 9, amount: 1166.07, units: 135 },
      { medicine_id: 15805, name: 'PAN D CAPSULE', batch_no: '25440701', qty: 4, amount: 703.95, units: 60 },
    ],
  },
};

const now = new Date().toISOString();
const docs = [];
const ops = [];
for (const [lid, want] of Object.entries(RETURNS)) {
  const h = (await pool.query(
    `SELECT * FROM purchase_returns WHERE store_pk=$1 AND local_id=$2 AND NOT deleted`, [STORE, Number(lid)])).rows[0];
  if (!h) throw new Error(`return ${lid} not found`);
  const items = (await pool.query(
    `SELECT medicine_id, name, batch_no, qty, rate, amount FROM purchase_return_items WHERE return_id=$1 ORDER BY id`, [h.id])).rows;
  if (items.length !== 1 || Number(items[0].medicine_id) !== want.keep) {
    throw new Error(`return ${lid} no longer holds just its first line -- stop and look again (${items.length} lines)`);
  }
  if (Math.abs(Number(h.refund_amount) - want.refund) > 0.01) throw new Error(`return ${lid} refund changed: ${h.refund_amount}`);
  const lines = [
    ...items.map((it) => ({ medicine_id: Number(it.medicine_id), name: it.name, batch_no: it.batch_no,
      qty: Number(it.qty), rate: Number(it.rate), amount: Number(it.amount) })),
    ...want.add.map((a) => ({ medicine_id: a.medicine_id, name: a.name, batch_no: a.batch_no,
      qty: a.qty, rate: Math.round((a.amount / a.qty) * 100) / 100, amount: a.amount })),
  ];
  const sum = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  if (Math.abs(sum - want.refund) > 0.05) throw new Error(`return ${lid}: lines add to ${sum}, refund ${want.refund}`);
  docs.push({
    id: Number(lid), return_no: h.return_no, purchase_id: h.purchase_id, purchase_no: h.purchase_no,
    supplier_id: h.supplier_id, supplier_name: h.supplier_name,
    return_date: String(h.return_date instanceof Date ? h.return_date.toISOString() : h.return_date).slice(0, 10),
    refund_amount: Number(h.refund_amount), discount: Number(h.discount || 0), reason: h.reason,
    item_count: lines.length, items: lines, created_at: h.created_at,
    version: Number(h.version || 1) + 1, updated_at: now, device_id: DEVICE, sync_status: 'synced', deleted: false,
  });
  for (const a of want.add) {
    const m = (await pool.query(
      `SELECT stock_qty, batch_no FROM medicines WHERE store_pk=$1 AND local_id=$2 AND NOT deleted`, [STORE, a.medicine_id])).rows[0];
    if (!m || m.batch_no !== a.batch_no) throw new Error(`medicine ${a.medicine_id} is not batch ${a.batch_no}`);
    const out = Math.min(a.units, Math.max(0, Number(m.stock_qty)));   // never below zero
    if (out > 0) {
      ops.push({ op_uuid: `${DEVICE}-${a.medicine_id}`, medicine_id: a.medicine_id, op: 'purchase_return',
        qty_delta: -out, ref_collection: 'purchase_returns', ref_id: Number(lid), device_id: DEVICE });
    }
    console.log(`${a.name} ${a.batch_no}: stock ${m.stock_qty} -> ${Number(m.stock_qty) - out} (returned ${a.units})`);
  }
}

if (!WRITE) {
  console.log('dry: nothing written (pass --write)');
  await pool.end();
  process.exit(0);
}
const res = await pushBundle(STORE, { purchase_returns: docs, stock_operations: ops });
console.log(JSON.stringify(res, null, 1).slice(0, 2500));
for (const o of ops) {
  const m = (await pool.query(`SELECT name, stock_qty FROM medicines WHERE store_pk=$1 AND local_id=$2`, [STORE, o.medicine_id])).rows[0];
  console.log(`after: ${m.name} ${m.stock_qty}`);
}
await pool.end();
