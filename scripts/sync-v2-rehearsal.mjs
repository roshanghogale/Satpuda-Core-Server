// Rehearsal of sync v2 against a COPY of the live database (never live).
//   DATABASE_URL=<copy> BASE=http://127.0.0.1:3999 STORE_KEY=SC-V2TEST01 node scripts/sync-v2-rehearsal.mjs
import { pool, query } from '../src/db/pool.js';
import { runStoreCheck } from '../src/services/nightlyCheck.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3999';
const KEY = process.env.STORE_KEY || 'SC-V2TEST01';
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${extra ? ` -- ${extra}` : ''}`);
  if (!cond) failures += 1;
};

async function call(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return data?.data ?? data;
}

const pair = async (deviceId, type) => (await call(null, 'POST', '/api/auth/pair', {
  android_key: KEY, device_id: deviceId, device_type: type,
})).token;

const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); // the shop's date (IST)
const fy = 2026;
const saleDoc = (id, billNo, customerId, medId, qty, rate) => ({
  id, bill_no: billNo, bill_date: today, customer_id: customerId,
  total_amount: qty * rate, amount_paid: qty * rate, cash_paid: qty * rate,
  items: [{ medicine_id: medId, name: 'DOLO 650', qty, rate, amount: qty * rate, gst_percent: 12 }],
  version: 1, updated_at: new Date().toISOString(),
});

const main = async () => {
  const { rows: st } = await query(`SELECT id FROM stores WHERE android_key=$1`, [KEY]);
  const storePk = Number(st[0].id);
  const A = await pair('pc-install-0001', 'pc');
  const B = await pair('android-install-0002', 'android');

  // 1. Registration
  const ra = await call(A, 'POST', '/api/sync/v2/register', { install_id: 'pc-install-0001', device_type: 'pc', device_name: 'Counter PC' });
  const rb = await call(B, 'POST', '/api/sync/v2/register', { install_id: 'android-install-0002', device_type: 'android', device_name: 'Owner phone' });
  const ra2 = await call(A, 'POST', '/api/sync/v2/register', { install_id: 'pc-install-0001' });
  check('two devices get their own numbers', ra.device_no === 1 && rb.device_no === 2, `${ra.device_no}, ${rb.device_no}`);
  check('device ranges start at device_no x 1e9', ra.id_base === 1e9 && rb.id_base === 2e9);
  check('registering again keeps the same number', ra2.device_no === 1);

  // 2. Number blocks never overlap, and the old allocator skips them
  const ba = await call(A, 'POST', '/api/sync/v2/number-block', { install_id: 'pc-install-0001', kind: 'sales', fy_start_year: fy, size: 50 });
  const bb = await call(B, 'POST', '/api/sync/v2/number-block', { install_id: 'android-install-0002', kind: 'sales', fy_start_year: fy, size: 50 });
  check('blocks do not overlap', bb.from_serial === ba.to_serial + 1, `A ${ba.from_serial}-${ba.to_serial}, B ${bb.from_serial}-${bb.to_serial}`);
  const legacyNo = await call(A, 'POST', '/api/sync/fy/allocate', { kind: 'sales', date: today });
  const legacySerial = Number(legacyNo.fy_serial ?? legacyNo.serial ?? String(legacyNo.bill_no || '').replace(/\D+.*$/, ''));
  check('the old number allocator skips reserved blocks', legacySerial > bb.to_serial, JSON.stringify(legacyNo).slice(0, 120));

  // 3. Old id allocator stays below the device ranges
  const ids = await call(A, 'POST', '/api/sync/allocate-ids', { collection: 'sales', count: 1 });
  const legacyId = Number(ids?.ids?.sales);
  check('old id allocator stays below 1e9', legacyId > 0 && legacyId < 1e9, String(legacyId));

  // 4. A opens stock, sells; B sells offline from its own block; nothing collides
  const MED = 1e9 + 1;
  const evA = [
    { seq: 1, event_uuid: 'pcA-evt-000001', op: 'upsert', collection: 'medicines', base_version: 0,
      doc: { id: MED, name: 'DOLO 650', batch_no: 'B1', stock_qty: 0, mrp: 30, rate: 20, version: 1 },
      stock_ops: [{ op_uuid: 'pcA-open-dolo', medicine_id: MED, op: 'adjust', qty_delta: 100 }] },
    { seq: 2, event_uuid: 'pcA-evt-000002', op: 'upsert', collection: 'customers', base_version: 0,
      doc: { id: 1e9 + 1, name: 'RAM PATIL', phone: '9000000001', version: 1 } },
    { seq: 3, event_uuid: 'pcA-evt-000003', op: 'upsert', collection: 'sales', base_version: 0,
      doc: saleDoc(1e9 + 1, `SCB${ba.from_serial}/FY2026-27`, 1e9 + 1, MED, 2, 30),
      stock_ops: [{ op_uuid: 'pcA-sale1-dolo', medicine_id: MED, op: 'sale', qty_delta: -2, ref_collection: 'sales', ref_id: 1e9 + 1 }] },
  ];
  const pa = await call(A, 'POST', '/api/sync/v2/push', { install_id: 'pc-install-0001', events: evA });
  check('PC events applied in order', pa.last_seq === 3 && pa.results.every((r) => r.outcome === 'applied'),
    JSON.stringify(pa.results.map((r) => [r.seq, r.outcome, r.flag_code])));

  const evB = [
    { seq: 1, event_uuid: 'phB-evt-000001', op: 'upsert', collection: 'customers', base_version: 0,
      doc: { id: 2e9 + 1, name: 'SHAM JADHAV', version: 1 } },
    { seq: 2, event_uuid: 'phB-evt-000002', op: 'upsert', collection: 'sales', base_version: 0,
      doc: saleDoc(2e9 + 1, `SCB${bb.from_serial}/FY2026-27`, 2e9 + 1, MED, 9, 30),
      stock_ops: [{ op_uuid: 'phB-sale1-dolo', medicine_id: MED, op: 'sale', qty_delta: -9, ref_collection: 'sales', ref_id: 2e9 + 1 }] },
  ];
  const pb = await call(B, 'POST', '/api/sync/v2/push', { install_id: 'android-install-0002', events: evB });
  check('phone events applied', pb.last_seq === 2 && pb.results.every((r) => r.outcome === 'applied'),
    JSON.stringify(pb.results.map((r) => [r.seq, r.outcome, r.flag_code, r.flag_detail])));
  const stock1 = await query(`SELECT stock_qty FROM medicines WHERE store_pk=$1 AND local_id=$2`, [storePk, MED]);
  check('stock = 100 - 2 - 9 = 89', Number(stock1.rows[0]?.stock_qty) === 89, String(stock1.rows[0]?.stock_qty));
  const bills = await query(
    `SELECT local_id, bill_no FROM sales WHERE store_pk=$1 AND local_id IN ($2,$3) ORDER BY local_id`,
    [storePk, 1e9 + 1, 2e9 + 1],
  );
  check('both bills kept, with the numbers printed on the devices',
    bills.rows.length === 2 && bills.rows[0].bill_no === `SCB${ba.from_serial}/FY2026-27`
      && bills.rows[1].bill_no === `SCB${bb.from_serial}/FY2026-27`,
    JSON.stringify(bills.rows));

  // 5. A resend is recognised; a gap is refused with missing_from; nothing is skipped
  const again = await call(A, 'POST', '/api/sync/v2/push', { install_id: 'pc-install-0001', events: evA.slice(2) });
  check('resend answered duplicate, nothing applied twice', again.results[0]?.outcome === 'duplicate');
  const stock2 = await query(`SELECT stock_qty FROM medicines WHERE store_pk=$1 AND local_id=$2`, [storePk, MED]);
  check('stock unchanged by the resend', Number(stock2.rows[0]?.stock_qty) === 89);
  const gap = await call(A, 'POST', '/api/sync/v2/push', {
    install_id: 'pc-install-0001',
    events: [{ seq: 5, event_uuid: 'pcA-evt-000005', op: 'upsert', collection: 'customers', base_version: 0,
      doc: { id: 1e9 + 2, name: 'GAP TEST', version: 1 } }],
  });
  check('a gap is answered with missing_from and not taken', gap.missing_from === 4 && gap.last_seq === 3 && gap.results.length === 0);

  // 6. Two devices edit the same bill: both kept, later applies, flagged, replaced copy stored
  const editA = saleDoc(1e9 + 1, `SCB${ba.from_serial}/FY2026-27`, 1e9 + 1, MED, 3, 30);
  const editB = saleDoc(1e9 + 1, `SCB${ba.from_serial}/FY2026-27`, 1e9 + 1, MED, 1, 30);
  const e1 = await call(A, 'POST', '/api/sync/v2/push', {
    install_id: 'pc-install-0001',
    events: [
      { seq: 4, event_uuid: 'pcA-evt-000004', op: 'upsert', collection: 'sales', base_version: 1, doc: editA,
        stock_ops: [{ op_uuid: 'pcA-sale1-edit2', medicine_id: MED, op: 'sale_edit', qty_delta: -1, ref_collection: 'sales', ref_id: 1e9 + 1 }] },
      { seq: 5, event_uuid: 'pcA-evt-000005', op: 'upsert', collection: 'customers', base_version: 0,
        doc: { id: 1e9 + 2, name: 'GAP TEST', version: 1 } },
    ],
  });
  check('PC edit applied, then the event after the gap', e1.last_seq === 5 && e1.results.every((r) => r.outcome === 'applied'),
    JSON.stringify(e1.results.map((r) => [r.seq, r.outcome, r.flag_code])));
  const e2 = await call(B, 'POST', '/api/sync/v2/push', {
    install_id: 'android-install-0002',
    events: [{ seq: 3, event_uuid: 'phB-evt-000003', op: 'upsert', collection: 'sales', base_version: 1, doc: editB,
      stock_ops: [{ op_uuid: 'phB-sale1-edit', medicine_id: MED, op: 'sale_edit', qty_delta: 1, ref_collection: 'sales', ref_id: 1e9 + 1 }] }],
  });
  check('phone edit of the same version: applied and flagged concurrent_edit',
    e2.results[0]?.outcome === 'flagged' && /concurrent_edit/.test(e2.results[0]?.flag_code || ''),
    JSON.stringify(e2.results[0]).slice(0, 200));
  const ev = await query(
    `SELECT replaced_doc IS NOT NULL AS kept FROM device_events WHERE store_pk=$1 AND event_uuid='phB-evt-000003'`,
    [storePk],
  );
  check('the copy the phone replaced is kept', ev.rows[0]?.kept === true);

  // 7. A bad event is quarantined, kept whole, and the queue moves on
  const bad = await call(B, 'POST', '/api/sync/v2/push', {
    install_id: 'android-install-0002',
    events: [
      { seq: 4, event_uuid: 'phB-evt-000004', op: 'upsert', collection: 'sales', base_version: 0,
        doc: { id: 2e9 + 2, bill_no: `SCB${ba.from_serial}/FY2026-27`, bill_date: today, items: [], total_amount: 10 } },
      { seq: 5, event_uuid: 'phB-evt-000005', op: 'upsert', collection: 'customers', base_version: 0,
        doc: { id: 2e9 + 3, name: 'AFTER BAD', version: 1 } },
    ],
  });
  check('a sale with a bill number already used is quarantined, not lost',
    bad.results[0]?.outcome === 'quarantined', JSON.stringify(bad.results[0]).slice(0, 200));
  check('the next event still lands', bad.results[1]?.outcome === 'applied' && bad.last_seq === 5);
  const kept = await query(
    `SELECT payload->'doc'->>'bill_no' AS b FROM device_events WHERE store_pk=$1 AND event_uuid='phB-evt-000004'`,
    [storePk],
  );
  check('the quarantined bill is stored whole', kept.rows[0]?.b === `SCB${ba.from_serial}/FY2026-27`);

  // 8. Delete is an event too
  const del = await call(A, 'POST', '/api/sync/v2/push', {
    install_id: 'pc-install-0001',
    events: [{ seq: 6, event_uuid: 'pcA-evt-000006', op: 'delete', collection: 'customers', base_version: 1, doc: { id: 1e9 + 2 } }],
  });
  const dc = await query(`SELECT deleted, name FROM customers WHERE store_pk=$1 AND local_id=$2`, [storePk, 1e9 + 2]);
  check('delete applied, the row kept (soft) with its name', del.results[0]?.outcome === 'applied' && dc.rows[0]?.deleted === true && dc.rows[0]?.name === 'GAP TEST',
    JSON.stringify([del.results[0], dc.rows[0]]));

  // 9. Status line and flags
  const sa = await call(A, 'GET', '/api/sync/v2/status?install_id=pc-install-0001');
  check('status shows what the server holds from the PC', sa.last_seq === 6 && sa.sales_today === 1, JSON.stringify(sa));
  const flags = await call(A, 'GET', '/api/sync/v2/flags');
  check('open flags list the clash and the quarantine', flags.length === 2, JSON.stringify(flags.map((f) => [f.seq, f.outcome, f.flag_code])));

  // 10. Nightly check: baseline, clean after pushes, catches an untracked change
  const c1 = await runStoreCheck(storePk);
  check('first nightly run is a baseline', c1.baseline === true);
  await call(A, 'POST', '/api/sync/v2/push', {
    install_id: 'pc-install-0001',
    events: [{ seq: 7, event_uuid: 'pcA-evt-000007', op: 'stock', stock_ops: [{ op_uuid: 'pcA-adj-1', medicine_id: MED, op: 'adjust', qty_delta: -4 }] }],
  });
  // An old (legacy) client writes an absolute stock figure: still in the ledger now.
  await call(A, 'POST', '/api/sync/bundle', { medicines: [{ id: MED, name: 'DOLO 650', batch_no: 'B1', stock_qty: 80, version: 99, updated_at: new Date().toISOString() }] });
  const c2 = await runStoreCheck(storePk);
  check('second run: stock and dues agree with their ledgers', c2.stock_mismatches === 0, JSON.stringify(c2));
  await query(`UPDATE medicines SET stock_qty = stock_qty + 7 WHERE store_pk=$1 AND local_id=$2`, [storePk, MED]);
  const c3 = await runStoreCheck(storePk);
  check('an untracked stock change is caught the next run', c3.stock_mismatches === 1, JSON.stringify(c3));

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
};

main().catch((e) => { console.error(e); failures += 1; }).finally(async () => {
  await pool.end();
  process.exit(failures ? 1 : 0);
});
