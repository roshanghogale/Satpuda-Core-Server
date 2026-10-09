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
const blank = await okCall('PUT', `/api/web/inventory/${para.id}`, { token: owner, body: { mrp: 36 } });
assert.equal(blank.note, '', 'a price edit touches no old line');
assert.equal((await okCall('GET', `/api/web/sales/${sale.id}`, { token: owner })).items.find((i) => i.medicine_id === para.id).rate, 3.5);
step('an MRP edit does not re-price old bills');

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
}

// clean up the logins this run made
await okCall('DELETE', `/api/admin/stores/${STORE}/web-users/${staffMade.user.id}`, { token: adminTok });
await okCall('DELETE', `/api/admin/stores/${STORE}/web-users/${ownerMade.user.id}`, { token: adminTok });
console.log(`\nall ${passed} steps passed`);
