// End-to-end test of the web login (phase 5) and medicine-line propagation, against the
// REHEARSAL server only (VPS 127.0.0.1:3999 through an SSH tunnel; DB satpuda_check_v2).
// Never point this at the live server: it creates logins, bills and purchases.
//
//   WEB_TEST_BASE=http://127.0.0.1:3999  WEB_TEST_STORE=<test store id>
//   WEB_TEST_ADMIN_USER=<rehearsal admin>  WEB_TEST_ADMIN_PW_FILE=<file holding its password>
//   node test/web-rehearsal.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

const BASE = process.env.WEB_TEST_BASE || 'http://127.0.0.1:3999';
if (!/^http:\/\/127\.0\.0\.1:3999$/.test(BASE)) throw new Error('Rehearsal only: WEB_TEST_BASE must be http://127.0.0.1:3999');
const STORE = process.env.WEB_TEST_STORE;
const ADMIN = process.env.WEB_TEST_ADMIN_USER;
const ADMIN_PW = fs.readFileSync(process.env.WEB_TEST_ADMIN_PW_FILE, 'utf8').trim();
const tag = Date.now().toString(36);

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data: data.data, error: data.error, details: data.details };
}
async function okCall(method, path, opts) {
  const r = await call(method, path, opts);
  if (r.status !== 200) throw new Error(`${method} ${path} -> ${r.status} ${r.error}`);
  return r.data;
}
let passed = 0;
function step(name) { passed += 1; console.log(`ok ${passed} - ${name}`); }

// ── admin creates the owner login ────────────────────────────────────────────
const adminTok = (await okCall('POST', '/api/auth/admin/login', { body: { username: ADMIN, password: ADMIN_PW } })).token;
const perms = await okCall('GET', '/api/admin/web-permissions', { token: adminTok });
assert.ok(perms.permissions.find((p) => p.key === 'billing'));
const ownerMade = await okCall('POST', `/api/admin/stores/${STORE}/web-users`, {
  token: adminTok, body: { username: `owner-${tag}`, full_name: 'Test Owner', role: 'owner' },
});
assert.equal(ownerMade.user.role, 'owner');
assert.ok(ownerMade.password.length >= 10, 'generated password returned once');
step('admin creates the owner login with a generated password');
const list = await okCall('GET', `/api/admin/stores/${STORE}/web-users`, { token: adminTok });
assert.ok(!JSON.stringify(list).includes(ownerMade.password), 'password never listed');
assert.ok(!JSON.stringify(list).includes('scrypt$'), 'hash never listed');
step('the login list never shows the password or its hash');

// ── owner signs in, must set own password ────────────────────────────────────
const bad = await call('POST', '/api/web/auth/login', { body: { username: `owner-${tag}`, password: 'wrong-password-1' } });
assert.equal(bad.status, 401);
let owner = (await okCall('POST', '/api/web/auth/login', { body: { username: `OWNER-${tag}`, password: ownerMade.password } })).token;
const blocked = await call('GET', '/api/web/inventory', { token: owner });
assert.equal(blocked.status, 403);
assert.equal(blocked.details?.code, 'password_change_required');
const ownerPw = `Owner${tag}9x`;
await okCall('POST', '/api/web/me/password', { token: owner, body: { current: ownerMade.password, next: ownerPw } });
const me = await okCall('GET', '/api/web/me', { token: owner });
assert.equal(me.user.must_change_password, false);
assert.ok(me.permissions.includes('staff'));
step('owner signs in (ID not case sensitive), must change the password, then has every permission');

// ── owner adds a staff member with counter permissions ───────────────────────
const staffMade = await okCall('POST', '/api/web/staff', {
  token: owner, body: { username: `counter-${tag}`, full_name: 'Counter One', permissions: ['billing', 'sales_view'] },
});
assert.deepEqual(staffMade.user.permissions, ['billing', 'sales_view']);
let staff = (await okCall('POST', '/api/web/auth/login', { body: { username: `counter-${tag}`, password: staffMade.password } })).token;
const staffPw = `Staff${tag}7y`;
await okCall('POST', '/api/web/me/password', { token: staff, body: { current: staffMade.password, next: staffPw } });
step('owner adds a staff login; staff sets own password');
const ownerTry = await call('PATCH', `/api/web/staff/${ownerMade.user.id}`, { token: owner, body: { is_active: false } });
assert.equal(ownerTry.status, 403, 'the web cannot change the owner login');
step('the owner login cannot be changed from the web Staff section');

// ── owner enters a purchase: new supplier, two new medicines ─────────────────
const medName = `WEBTEST PARA ${tag}`.toUpperCase();
const syrName = `WEBTEST SYRUP ${tag}`.toUpperCase();
const pPrev = await okCall('POST', '/api/web/purchases/preview', { token: owner, body: {
  gst_calc_method: 'discount_before_gst', items: [{ qty: 10, rate: 20, gst_pct: 12 }, { qty: 5, rate: 50, gst_pct: 5 }],
} });
assert.equal(pPrev.subtotal, 450);
const pur = await okCall('POST', '/api/web/purchases', { token: owner, body: {
  supplier_name: `WEB SUPPLIER ${tag}`, bill_number: `INV-${tag}`, gst_calc_method: 'discount_before_gst', cash_paid: 0,
  items: [
    { name: medName, batch_no: 'B1', expiry: '12/28', type: 'Tablet', unit: '10', qty: 10, free_qty: 1, rate: 20, mrp: 35, gst_pct: 12, hsn_code: '3004' },
    { name: syrName, batch_no: 'S1', expiry: '06/28', type: 'Syrup', unit: '100ML', qty: 5, rate: 50, mrp: 80, gst_pct: 5 },
  ],
} });
assert.match(pur.purchase_no, /^\d+\/FY\d{4}-\d{2}$/);
assert.equal(pur.purchase.items.length, 2);
const dup = await call('POST', '/api/web/purchases', { token: owner, body: {
  supplier_id: pur.purchase.supplier_id, bill_number: `INV-${tag}`, items: [{ name: medName, batch_no: 'B1', qty: 1, rate: 20, mrp: 35 }],
} });
assert.equal(dup.status, 409, 'same supplier bill twice refused');
step(`purchase ${pur.purchase_no} saved; the same supplier bill again is refused`);

const inv1 = await okCall('GET', `/api/web/inventory?q=${encodeURIComponent(`WEBTEST PARA ${tag}`)}`, { token: owner });
const para = inv1.rows[0];
assert.equal(para.stock_qty, 110, '(10 + 1 free) strips x 10 tablets');
const syr = (await okCall('GET', `/api/web/inventory?q=${encodeURIComponent(`WEBTEST SYRUP ${tag}`)}`, { token: owner })).rows[0];
assert.equal(syr.stock_qty, 5);
step('purchase stock arrived through stock operations: 110 tablets, 5 bottles');

// ── staff bills: preview, then save ──────────────────────────────────────────
const body = { customer_name: `WEB CUSTOMER ${tag}`, doctor_name: '', items: [
  { medicine_id: para.id, qty: 15 }, { medicine_id: syr.id, qty: 2, disc_pct: 10 }], cash_paid: 100 };
const prev = await okCall('POST', '/api/web/sales/preview', { token: staff, body });
// 15 tablets x 3.5 = 52.50; 2 x 80 = 160 less 10% = 144.00; 196.50 -> rounds to 197 (Python half-even on .5 rupee? auto_round is floor(x+0.5))
assert.equal(prev.summary.subtotal, 196.5);
assert.equal(prev.summary.total_amount, 197);
const sale = await okCall('POST', '/api/web/sales', { token: staff, body });
assert.match(sale.bill_no, /^SCB\d+\/FY\d{4}-\d{2}$/);
assert.equal(sale.sale.total_amount, 197);
assert.equal(sale.sale.due_amount, 97);
assert.equal(sale.made_by ?? sale.sale.made_by, `counter-${tag}`);
step(`staff made bill ${sale.bill_no} for 197 (paid 100, due 97); made_by recorded`);
const after = (await okCall('GET', `/api/web/inventory?q=${encodeURIComponent(`WEBTEST PARA ${tag}`)}`, { token: owner })).rows[0];
assert.equal(after.stock_qty, 95);
step('the bill took 15 tablets off the shelf (110 -> 95)');
const over = await call('POST', '/api/web/sales', { token: staff, body: { customer_name: 'X', items: [{ medicine_id: syr.id, qty: 99 }] } });
assert.equal(over.status, 409);
step('selling more than the stock is refused');

// ── permissions on the server, not only in menus ─────────────────────────────
for (const [m, p, b] of [['POST', '/api/web/purchases', {}], ['DELETE', `/api/web/sales/${sale.id}`], ['PUT', `/api/web/sales/${sale.id}`, {}],
  ['GET', '/api/web/reports'], ['GET', '/api/web/staff'], ['GET', '/api/web/inventory'], ['POST', '/api/web/payments/customers', {}]]) {
  const r = await call(m, p, { token: staff, body: b });
  assert.equal(r.status, 403, `${m} ${p} must be refused for counter staff`);
}
step('counter staff are refused purchases, bill edit/delete, reports, staff, inventory, payments');

// ── owner edits the bill, then a schedule change reaches it ──────────────────
const edited = await okCall('PUT', `/api/web/sales/${sale.id}`, { token: owner, body: {
  version: sale.sale.version, customer_id: sale.sale.customer_id, items: [{ medicine_id: para.id, qty: 20 }, { medicine_id: syr.id, qty: 2, disc_pct: 10 }], cash_paid: 100 } });
assert.equal(edited.sale.total_amount, 214);
assert.equal((await okCall('GET', `/api/web/inventory?q=${encodeURIComponent(`WEBTEST PARA ${tag}`)}`, { token: owner })).rows[0].stock_qty, 90);
step('owner edits the bill (15 -> 20 tablets): total 214, stock 95 -> 90');

const medEdit = await okCall('PUT', `/api/web/inventory/${para.id}`, { token: owner, body: { schedule: 'H1', content_drug: 'Paracetamol 500' } });
assert.equal(medEdit.lines_updated.sales, 1);
assert.equal(medEdit.lines_updated.purchases, 1);
assert.match(medEdit.note, /^Schedule changed: 1 old sale, 1 purchase updated$/);
const saleNow = await okCall('GET', `/api/web/sales/${sale.id}`, { token: owner });
assert.equal(saleNow.items.find((i) => i.medicine_id === para.id).schedule, 'H1');
assert.equal(saleNow.items.find((i) => i.medicine_id === para.id).rate, 3.5, 'rate as billed');
assert.equal(saleNow.total_amount, 214, 'bill not re-priced');
const rep = await okCall('GET', '/api/web/reports', { token: owner });
assert.ok(rep.schedule_register.some((r) => r.sale_id === sale.id && r.schedule === 'H1'));
step(`schedule H1 flows into the old bill (${medEdit.note}); price and total unchanged; bill is in the schedule register`);

// 17 Oct 2026: the page reads the figures without the register, and the register on its own.
const repLite = await okCall('GET', '/api/web/reports?register=0', { token: owner });
assert.equal(repLite.schedule_register, null, 'register=0 leaves the register out');
assert.deepEqual(repLite.gst_sales, rep.gst_sales, 'the figures are the same without it');
const reg = await okCall('GET', '/api/web/reports/register', { token: owner });
assert.ok(reg.schedules.includes('H1'));
const billNo = rep.schedule_register.find((r) => r.sale_id === sale.id).bill_no;
assert.ok(reg.rows.some((r) => r.bill_no === billNo && r.schedule === 'H1'));
assert.equal(reg.rows.length, rep.schedule_register.length, 'the same lines as the full report');
assert.ok(!('customer_address' in reg.rows[0]), 'only the columns the page shows');
const regH1 = await okCall('GET', '/api/web/reports/register?schedule=H1', { token: owner });
assert.ok(regH1.rows.length >= 1 && regH1.rows.every((r) => r.schedule === 'H1'));
assert.equal((await call('GET', '/api/web/reports/register', { token: staff })).status, 403);
step('reports: figures without the register (register=0); register on its own, filtered by schedule on the server, staff refused');
const blank = await okCall('PUT', `/api/web/inventory/${para.id}`, { token: owner, body: { mrp: 36 } });
assert.equal(blank.note, '', 'a price edit touches no old line');
assert.equal((await okCall('GET', `/api/web/sales/${sale.id}`, { token: owner })).items.find((i) => i.medicine_id === para.id).rate, 3.5);
step('an MRP edit does not re-price old bills');

// Owner, 9 Oct 2026: GST %, batch and expiry follow the medicine too; amounts never change.
const purBefore = await okCall('GET', `/api/web/purchases/${pur.id}`, { token: owner });
const gstEdit = await okCall('PUT', `/api/web/inventory/${para.id}`, { token: owner, body: { gst_percent: 5, batch_no: 'B1X', expiry_date: '11/28' } });
assert.match(gstEdit.note, /^GST %, Batch, Expiry changed: 1 old sale, 1 purchase updated$/);
const saleGst = (await okCall('GET', `/api/web/sales/${sale.id}`, { token: owner })).items.find((i) => i.medicine_id === para.id);
assert.deepEqual([saleGst.gst_percent, saleGst.batch_no, String(saleGst.expiry_date).slice(0, 10), saleGst.rate, saleGst.amount],
  [5, 'B1X', '2028-11-01', 3.5, 70]);
const purLine = (await okCall('GET', `/api/web/purchases/${pur.id}`, { token: owner })).items.find((i) => i.medicine_id === para.id);
const purLine0 = purBefore.items.find((i) => i.medicine_id === para.id);
assert.deepEqual([purLine.gst_pct, purLine.batch_no, purLine.gst_amt, purLine.taxable, purLine.item_amount],
  [5, 'B1X', purLine0.gst_amt, purLine0.taxable, purLine0.item_amount]);
const noBlank = await okCall('PUT', `/api/web/inventory/${para.id}`, { token: owner, body: { batch_no: '' } });
assert.equal((await okCall('GET', `/api/web/sales/${sale.id}`, { token: owner })).items.find((i) => i.medicine_id === para.id).batch_no, 'B1X');
step(`GST %, batch and expiry flow into old lines (${gstEdit.note}); amounts as billed; a blank batch blanks no old line (${noBlank.note || 'no note'})`);

// ── a scheduled medicine now needs a doctor ──────────────────────────────────
const noDoc = await call('POST', '/api/web/sales', { token: staff, body: { customer_name: 'Y', items: [{ medicine_id: para.id, qty: 1 }] } });
assert.equal(noDoc.status, 400);
step('a Schedule H1 sale without a doctor is refused');

// ── returns, payments, dues ──────────────────────────────────────────────────
const ret = await okCall('POST', '/api/web/returns/sales', { token: owner, body: { sale_id: sale.id, items: [{ medicine_id: para.id, qty: 5 }] } });
assert.equal(ret.refund_amount, 17.5);
const tooMany = await call('POST', '/api/web/returns/sales', { token: owner, body: { sale_id: sale.id, items: [{ medicine_id: para.id, qty: 16 }] } });
assert.equal(tooMany.status, 400);
step(`sales return ${ret.return_no} for 17.50; returning more than is left is refused`);
const cust = (await okCall('GET', `/api/web/customers?q=${encodeURIComponent(`WEB CUSTOMER ${tag}`)}`, { token: owner })).rows[0];
const pay = await okCall('POST', '/api/web/payments/customers', { token: owner, body: { customer_id: cust.id, amount: 50, mode: 'cash' } });
assert.ok(pay.id > 0);
const cust2 = (await okCall('GET', `/api/web/customers?q=${encodeURIComponent(`WEB CUSTOMER ${tag}`)}`, { token: owner })).rows[0];
assert.equal(Math.round(cust2.total_due * 100) / 100, Math.round((214 - 100 - 17.5 - 50) * 100) / 100);
step(`customer due from the ledger: 214 - 100 paid - 17.50 return - 50 receipt = ${cust2.total_due}`);
const sup = (await okCall('GET', `/api/web/suppliers?q=${encodeURIComponent(`WEB SUPPLIER ${tag}`)}`, { token: owner })).rows[0];
const sp = await okCall('POST', '/api/web/payments/suppliers', { token: owner, body: { supplier_id: sup.id, amount: 100, mode: 'online' } });
assert.match(sp.payment_no, /^PAY\d+-\d+$/);
step(`supplier payment ${sp.payment_no}`);

// Pay a due from history (owner, 12 Oct 2026): what is open on the bill, then an ordinary
// payment with the bill number as reference, given to this bill (17 Oct 2026).
const billDue = await okCall('GET', `/api/web/sales/${sale.id}/due`, { token: owner });
assert.equal(Math.round(billDue.bill_due * 100) / 100, Math.round((214 - 100 - 17.5 - 50) * 100) / 100);
assert.equal(billDue.to_clear, billDue.bill_due);
assert.equal((await call('GET', `/api/web/sales/${sale.id}/due`, { token: staff })).status, 403);
await okCall('POST', '/api/web/payments/customers', { token: owner,
  body: { customer_id: billDue.party_id, amount: billDue.to_clear, mode: 'online', reference: billDue.bill_no } });
const paidBill = await okCall('GET', `/api/web/sales/${sale.id}`, { token: owner });
assert.ok(Number(paidBill.total_due) <= 0.009 && paidBill.bill_cleared, JSON.stringify({ d: paidBill.total_due, c: paidBill.bill_cleared }));
const purDue = await okCall('GET', `/api/web/purchases/${pur.id}/due`, { token: owner });
assert.ok(purDue.bill_due > 0);
await okCall('POST', '/api/web/payments/suppliers', { token: owner,
  body: { supplier_id: purDue.party_id, amount: purDue.to_clear, mode: 'cash', reference: purDue.bill_no } });
const paidPur = await okCall('GET', `/api/web/purchases/${pur.id}/due`, { token: owner });
assert.ok(paidPur.bill_due <= 0.009, JSON.stringify(paidPur));
step(`pay from history: bill ${billDue.bill_no} (${billDue.bill_due}) and purchase ${purDue.bill_no} (${purDue.bill_due}) cleared; counter staff refused`);

// Payments given to chosen bills (owner, 17 Oct 2026): the chosen bill clears, older bills
// keep their due, and the payment list / report say which bill each payment cleared.
const twoName = `WEB TWO BILLS ${tag}`;
const b1 = await okCall('POST', '/api/web/sales', { token: owner, body: { customer_name: twoName, items: [{ medicine_id: syr.id, qty: 1 }], cash_paid: 0 } });
const b2 = await okCall('POST', '/api/web/sales', { token: owner, body: { customer_name: twoName, items: [{ medicine_id: syr.id, qty: 1 }], cash_paid: 0 } });
const two = (await okCall('GET', `/api/web/customers?q=${encodeURIComponent(twoName)}`, { token: owner })).rows[0];
const open2 = await okCall('GET', `/api/web/customers/${two.id}/open-bills`, { token: owner });
assert.deepEqual(open2.map((b) => b.bill_id), [b1.id, b2.id], 'open bills oldest first');
const tooMuch = await call('POST', '/api/web/payments/customers', { token: owner,
  body: { customer_id: two.id, amount: 500, mode: 'cash', allocations: [{ bill_id: b2.id, amount: open2[1].owes + 1 }] } });
assert.equal(tooMuch.status, 400, 'more than the bill owes is refused');
const shortPay = await call('POST', '/api/web/payments/customers', { token: owner,
  body: { customer_id: two.id, amount: 10, mode: 'cash', allocations: [{ bill_id: b2.id, amount: open2[1].owes }] } });
assert.equal(shortPay.status, 400, 'ticked bills needing more than the amount is refused');
const chosen = await okCall('POST', '/api/web/payments/customers', { token: owner,
  body: { customer_id: two.id, amount: open2[1].owes, mode: 'cash', allocations: [{ bill_id: b2.id, bill_no: open2[1].bill_no, amount: open2[1].owes }] } });
const s1 = await okCall('GET', `/api/web/sales/${b1.id}`, { token: owner });
const s2 = await okCall('GET', `/api/web/sales/${b2.id}`, { token: owner });
assert.ok(Number(s2.total_due) <= 0.009 && s2.bill_cleared, 'the chosen (newer) bill is cleared');
assert.equal(Number(s1.total_due), open2[0].owes, 'the older bill keeps its due');
const listed = (await okCall('GET', `/api/web/payments/customers?customer_id=${two.id}&with_cleared=1`, { token: owner })).rows;
const row = listed.find((p) => Number(p.id) === Number(chosen.id));
assert.deepEqual(row.cleared.map((c) => [c.bill_id, c.amount, c.how]), [[b2.id, open2[1].owes, 'chosen']]);
const payRep = await okCall('GET', `/api/web/payments/report?kind=customers&party_id=${two.id}`, { token: owner });
assert.equal(payRep.totals.count, 1);
assert.equal(payRep.totals.cleared, open2[1].owes);
const rest = await okCall('POST', '/api/web/payments/customers', { token: owner, body: { customer_id: two.id, amount: open2[0].owes + 5, mode: 'cash' } });
const rep2 = await okCall('GET', `/api/web/payments/report?kind=customers&party_id=${two.id}`, { token: owner });
const restRow = rep2.rows.find((p) => Number(p.id) === Number(rest.id));
assert.deepEqual(restRow.cleared.map((c) => [c.bill_id, c.how]), [[b1.id, 'oldest']]);
assert.equal(restRow.left_as_credit, 5);
// The chosen bill deleted: its money goes back to the oldest-first rule (and the stock back).
await okCall('DELETE', `/api/web/sales/${b2.id}`, { token: owner });
const rep3 = await okCall('GET', `/api/web/payments/report?kind=customers&party_id=${two.id}`, { token: owner });
assert.ok(rep3.rows.find((p) => Number(p.id) === Number(chosen.id)).cleared.every((c) => c.how === 'oldest'));
await okCall('DELETE', `/api/web/sales/${b1.id}`, { token: owner });
step(`payment given to the newer bill ${b2.bill_no} clears it, ${b1.bill_no} keeps its due; report shows chosen / oldest / credit`);

// Returns as credit settled in the next bill (owner, 17 Oct 2026): a return kept as credit is
// offered when billing that customer; the new bill shows it and owes only the rest.
const rcName = `WEB RET CREDIT ${tag}`;
const c1 = await okCall('POST', '/api/web/sales', { token: owner, body: { customer_name: rcName, items: [{ medicine_id: syr.id, qty: 1 }], cash_paid: 80 } });
assert.equal(c1.sale.due_amount, 0);
const rc = (await okCall('GET', `/api/web/customers?q=${encodeURIComponent(rcName)}`, { token: owner })).rows[0];
const ret2 = await okCall('POST', '/api/web/returns/sales', { token: owner, body: { sale_id: c1.id, items: [{ medicine_id: syr.id, qty: 1 }] } });
const offered = await okCall('GET', `/api/web/customers/${rc.id}/open-returns`, { token: owner });
assert.deepEqual(offered.map((r) => [r.return_no, r.left]), [[ret2.return_no, ret2.refund_amount]]);
assert.equal(offered[0].items[0].qty, 1);
const c2 = await okCall('POST', '/api/web/sales', { token: owner, body: { customer_id: rc.id, customer_name: rcName,
  items: [{ medicine_id: syr.id, qty: 1 }], cash_paid: 0, apply_returns: [ret2.id] } });
assert.equal(c2.returns_applied, Math.min(ret2.refund_amount, c2.sale.total_amount));
const c2d = await okCall('GET', `/api/web/sales/${c2.id}`, { token: owner });
assert.deepEqual(c2d.returns_in_bill.map((r) => [r.return_no, r.amount]), [[ret2.return_no, c2.returns_applied]]);
assert.ok(Math.abs(Number(c2d.total_due) - (c2.sale.total_amount - c2.returns_applied)) < 0.01, JSON.stringify({ d: c2d.total_due }));
assert.deepEqual(await okCall('GET', `/api/web/customers/${rc.id}/open-returns`, { token: owner }), []);
const staffRets = await call('GET', `/api/web/customers/${rc.id}/open-returns`, { token: staff });
assert.equal(staffRets.status, 200, 'billing staff see the return credit');
await okCall('DELETE', `/api/web/sales/${c2.id}`, { token: owner });
assert.equal((await okCall('GET', `/api/web/customers/${rc.id}/open-returns`, { token: owner })).length, 1, 'deleting the bill frees the credit');
step(`return ${ret2.return_no} kept as credit is offered and settled in bill ${c2.bill_no} (Return row, owes ${(c2.sale.total_amount - c2.returns_applied).toFixed(2)})`);

// Doctor Margin Report (owner, 17 Oct 2026): this run's bills by doctor, both styles agree,
// the summary carries no patient names, the injection report never uses the percentage.
const dmOpts = await okCall('GET', '/api/web/reports/doctor-margin/options', { token: owner });
assert.ok(dmOpts.doctors.includes('(No doctor)'));
const day = new Date().toISOString().slice(0, 10);
const dmA = await okCall('GET', `/api/web/reports/doctor-margin?from=2026-04-01&to=${day}&pct=10`, { token: owner });
const dmB = await okCall('GET', `/api/web/reports/doctor-margin?from=2026-04-01&to=${day}&pct=15`, { token: owner });
assert.ok(dmA.rows.length > 0);
assert.ok(Math.abs(dmA.totals.commission * 1.5 - dmB.totals.commission) < 0.05, 'commission follows the percentage');
const sumOf = (list, k) => list.reduce((x, r) => x + r[k], 0);
assert.ok(Math.abs(sumOf(dmA.rows, 'amount') - sumOf(dmA.summary, 'amount')) < 0.01, 'summary = detailed');
assert.ok(!JSON.stringify(dmA.summary).includes(`WEB CUSTOMER ${tag}`), 'no patient in the summary');
const dmInj = await okCall('GET', `/api/web/reports/doctor-margin?from=2026-04-01&to=${day}&mode=injection&pct=50`, { token: owner });
assert.equal(dmInj.pct, 100);
assert.ok(dmInj.rows.every((r) => /inj/i.test(r.type)));
assert.equal((await call('GET', `/api/web/reports/doctor-margin?from=${day}&to=2026-04-01`, { token: owner })).status, 400);
step(`doctor margin report: ${dmA.rows.length} lines, 10% -> 15% scales the commission, styles reconcile, injection uses 100% of profit`);

// Walk-in (owner, 9 Oct 2026): no customer name = the shop's COUNTER SALE customer, paid in full.
const walk = await okCall('POST', '/api/web/sales', { token: staff, body: { items: [{ medicine_id: syr.id, qty: 1 }], cash_paid: 80 } });
assert.equal(walk.sale.customer_name, 'COUNTER SALE');
assert.equal(walk.sale.due_amount, 0);
const walkDue = await call('POST', '/api/web/sales', { token: staff, body: { items: [{ medicine_id: syr.id, qty: 1 }], cash_paid: 0 } });
assert.equal(walkDue.status, 400);
const walkSched = await call('POST', '/api/web/sales', { token: staff, body: { doctor_name: 'DR X', items: [{ medicine_id: para.id, qty: 1 }], cash_paid: 10 } });
assert.equal(walkSched.status, 400, 'a scheduled medicine still needs a real customer name');
await okCall('DELETE', `/api/web/sales/${walk.id}`, { token: owner });
step(`walk-in bill ${walk.bill_no} goes to COUNTER SALE; unpaid walk-in and scheduled walk-in refused`);

// ── inventory views and counts ───────────────────────────────────────────────
await okCall('PUT', `/api/web/inventory/${syr.id}`, { token: owner, body: { is_hidden: true } });
const hidden = await okCall('GET', `/api/web/inventory?view=hidden&q=${encodeURIComponent(`WEBTEST SYRUP ${tag}`)}`, { token: owner });
assert.equal(hidden.rows.length, 1);
const active = await okCall('GET', `/api/web/inventory?q=${encodeURIComponent(`WEBTEST SYRUP ${tag}`)}`, { token: owner });
assert.equal(active.rows.length, 0);
assert.ok(hidden.counts.hidden >= 1 && hidden.counts.all >= hidden.counts.active);
step(`inventory views: hidden medicine shows only under Hidden (counts ${JSON.stringify(hidden.counts)})`);

// ── delete the bill: stock back ──────────────────────────────────────────────
await okCall('DELETE', `/api/web/sales/${sale.id}`, { token: owner });
assert.equal((await okCall('GET', `/api/web/inventory?q=${encodeURIComponent(`WEBTEST PARA ${tag}`)}`, { token: owner })).rows[0].stock_qty, 115);
step('deleting the bill gives its 20 tablets back (90 + 5 returned + 20 = 115)');

// ── audit, disable, sign-out ─────────────────────────────────────────────────
const aud = await okCall('GET', '/api/web/audit', { token: owner });
assert.ok(aud.some((a) => a.action === 'sale.create' && a.username === `counter-${tag}`));
assert.ok(aud.some((a) => a.action === 'sale.delete' && a.username === `owner-${tag}`));
step('audit shows who made and who deleted the bill');
await okCall('PATCH', `/api/web/staff/${staffMade.user.id}`, { token: owner, body: { is_active: false } });
assert.equal((await call('GET', '/api/web/me', { token: staff })).status, 401);
step('switching a staff login off signs it out at once');
const reset = await okCall('POST', `/api/admin/stores/${STORE}/web-users/${ownerMade.user.id}/reset-password`, { token: adminTok });
assert.equal((await call('GET', '/api/web/me', { token: owner })).status, 401);
assert.ok(reset.password && reset.password !== ownerPw);
step('admin password reset signs the owner out everywhere');

// ── sync: the web bills reach PCs and phones by the normal pull ──────────────
const dev = await okCall('POST', '/api/auth/pair', { body: { android_key: 'SC-V2TEST01', device_id: `webtest-${tag}`, device_type: 'pc' } }).catch(() => null);
if (dev?.token) {
  const ch = await okCall('GET', '/api/sync/changes/full?after=0&limit=1000', { token: dev.token });
  const cols = new Set((ch.changes || []).map((c) => c.collection));
  assert.ok(cols.has('sales') && cols.has('purchases') && cols.has('medicines'));
  step('a paired device pulls the web sales, purchases and medicines');
  // The bills a payment was given travel with it; an older app's edit (no allocations key)
  // keeps them.
  const pulled = (ch.changes || []).find((c) => c.collection === 'customer_payments' && Number(c.local_id) === Number(chosen.id))?.doc;
  assert.deepEqual((pulled?.allocations || []).map((a) => a.bill_id), [b2.id], JSON.stringify(pulled));
  const oldApp = { ...pulled, note: 'edited on an older app', version: Number(pulled.version) + 1, updated_at: new Date().toISOString() };
  delete oldApp.allocations;
  await okCall('POST', '/api/sync/bundle', { token: dev.token, body: { customer_payments: [oldApp] } });
  const ch2 = await okCall('GET', '/api/sync/changes/full?after=0&limit=5000', { token: dev.token });
  const kept = (ch2.changes || []).find((c) => c.collection === 'customer_payments' && Number(c.local_id) === Number(chosen.id))?.doc;
  assert.equal(kept?.note, 'edited on an older app');
  assert.deepEqual((kept?.allocations || []).map((a) => a.bill_id), [b2.id]);
  step('the bills a payment was given reach devices, and an older app editing it keeps them');
}

// clean up the logins this run made
await okCall('DELETE', `/api/admin/stores/${STORE}/web-users/${staffMade.user.id}`, { token: adminTok });
await okCall('DELETE', `/api/admin/stores/${STORE}/web-users/${ownerMade.user.id}`, { token: adminTok });
console.log(`\nall ${passed} steps passed`);
