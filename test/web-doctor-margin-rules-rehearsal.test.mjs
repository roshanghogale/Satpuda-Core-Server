// End-to-end: doctor margin BY RULES on the web, against the REHEARSAL server only (VPS
// 127.0.0.1:3999 through an SSH tunnel; DB satpuda_check_v2). Never point this at the live
// server: it creates logins, a purchase, bills, a return and changes the store's rules.
//
//   WEB_TEST_BASE=http://127.0.0.1:3999  WEB_TEST_STORE=<test store id>
//   WEB_TEST_ADMIN_USER=<rehearsal admin>  WEB_TEST_ADMIN_PW_FILE=<file holding its password>
//   node test/web-doctor-margin-rules-rehearsal.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { r2 } from '../src/services/doctorMarginRules.js';

const BASE = process.env.WEB_TEST_BASE || 'http://127.0.0.1:3999';
if (!/^http:\/\/127\.0\.0\.1:3999$/.test(BASE)) throw new Error('Rehearsal only: WEB_TEST_BASE must be http://127.0.0.1:3999');
const STORE = process.env.WEB_TEST_STORE;
const ADMIN = process.env.WEB_TEST_ADMIN_USER;
const ADMIN_PW = fs.readFileSync(process.env.WEB_TEST_ADMIN_PW_FILE, 'utf8').trim();
const tag = Date.now().toString(36);
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data: data.data, error: data.error };
}
async function okCall(method, path, opts) {
  const r = await call(method, path, opts);
  if (r.status !== 200) throw new Error(`${method} ${path} -> ${r.status} ${r.error}`);
  return r.data;
}
let passed = 0;
function step(name) { passed += 1; console.log(`ok ${passed} - ${name}`); }

// ── logins ───────────────────────────────────────────────────────────────────
const adminTok = (await okCall('POST', '/api/auth/admin/login', { body: { username: ADMIN, password: ADMIN_PW } })).token;
const ownerMade = await okCall('POST', `/api/admin/stores/${STORE}/web-users`, {
  token: adminTok, body: { username: `dmowner-${tag}`, full_name: 'DM Owner', role: 'owner' },
});
let owner = (await okCall('POST', '/api/web/auth/login', { body: { username: `dmowner-${tag}`, password: ownerMade.password } })).token;
await okCall('POST', '/api/web/me/password', { token: owner, body: { current: ownerMade.password, next: `Dm${tag}Own9x` } });
owner = (await okCall('POST', '/api/web/auth/login', { body: { username: `dmowner-${tag}`, password: `Dm${tag}Own9x` } })).token;
const staffMade = await okCall('POST', '/api/web/staff', {
  token: owner, body: { username: `dmstaff-${tag}`, full_name: 'DM Staff', permissions: ['billing', 'sales_view'] },
});
let staff = (await okCall('POST', '/api/web/auth/login', { body: { username: `dmstaff-${tag}`, password: staffMade.password } })).token;
await okCall('POST', '/api/web/me/password', { token: staff, body: { current: staffMade.password, next: `Dm${tag}Stf7y` } });
staff = (await okCall('POST', '/api/web/auth/login', { body: { username: `dmstaff-${tag}`, password: `Dm${tag}Stf7y` } })).token;
step('owner and a counter login (billing + sales history only)');

const before = await okCall('GET', '/api/web/reports/doctor-margin/rules', { token: owner });
const today = (await okCall('GET', '/api/web/me', { token: owner })).today;

// ── a purchase: an injection with free goods, a strip tablet ─────────────────
const INJ = `DMTEST INJ ${tag}`.toUpperCase();
const TAB = `DMTEST TAB ${tag}`.toUpperCase();
const pur = await okCall('POST', '/api/web/purchases', { token: owner, body: {
  supplier_name: `DM SUPPLIER ${tag}`, bill_number: `DM-${tag}`, gst_calc_method: 'discount_before_gst', cash_paid: 0,
  items: [
    { name: INJ, batch_no: 'Z1', expiry: '12/28', type: 'Injection', unit: '1', qty: 10, free_qty: 5, rate: 10, mrp: 66.64, gst_pct: 12 },
    { name: TAB, batch_no: 'T1', expiry: '12/28', type: 'Tablet', unit: '10', qty: 2, rate: 50, mrp: 100, gst_pct: 12 },
  ],
} });
const inv = async (name) => (await okCall('GET', `/api/web/inventory?q=${encodeURIComponent(name)}`, { token: owner })).rows[0];
const inj = await inv(INJ);
const tab = await inv(TAB);
assert.equal(inj.stock_qty, 15);
assert.equal(tab.stock_qty, 20);
step(`purchase ${pur.purchase_no}: ${INJ} 10 + 5 free at Rs 10, ${TAB} 2 strips of 10 at Rs 50`);

// ── the rules: owner only (a version 1 value, as a PC of 22 Oct sends it: read as version 2) ──
const v1 = { rate_basis: 'purchase_free', sets: [{ doctor: '', types: [
  { type: 'Injection', mode: 'groups', rest: null, groups: [{ name: 'Own', margin: { kind: 'mrp_rate' }, items: [{ product: INJ.toLowerCase() }] }] },
  { type: 'Tablet', mode: 'type', margin: { kind: 'fixed', value: 1 } },
] }] };
assert.equal((await call('PUT', '/api/web/reports/doctor-margin/rules', { token: staff, body: { rules: v1 } })).status, 403);
const bad = await call('PUT', '/api/web/reports/doctor-margin/rules', { token: owner, body: { rules: { sets: [{ doctor: '', types: [
  { type: 'Tablet', mode: 'type', margin: { kind: 'pct_mrp', value: 140 } }] }] } } });
assert.equal(bad.status, 400);
assert.equal(bad.error, 'A % of MRP margin must be 0 to 100.');
const saved1 = await okCall('PUT', '/api/web/reports/doctor-margin/rules', { token: owner, body: { rules: v1 } });
assert.equal(saved1.rules.sets[0].types[0].groups[0].items[0].product, INJ, 'kept in the one shape (upper case)');
assert.equal(saved1.rules.version, 2, 'always written as version 2');
assert.deepEqual(saved1.rules.sets[0].types[1], { type: 'Tablet', mode: 'groups', groups: [
  { name: 'All Tablet', margin: { kind: 'fixed', value: 1 }, all: true, items: [] }] }, 'v1 whole type = one All-products group');
assert.match(saved1.rules.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
const seen = await okCall('GET', '/api/web/reports/doctor-margin/rules', { token: staff });
assert.equal(seen.rules.updated, saved1.rules.updated, 'staff may see the rules');
assert.equal(seen.versions.length, before.versions.length + 1, 'every version kept');
step('rules saved by the owner (staff refused, a % over 100 refused with the reason); staff can read them');

const prods = await okCall('GET', `/api/web/reports/doctor-margin/rules/products?type=injection&find=${encodeURIComponent(`DMTEST INJ ${tag}`)}`, { token: owner });
assert.deepEqual(prods.products.map((p) => [p.product, p.batches.map((b) => b.batch), p.stock]), [[INJ, ['Z1'], 15]]);
step('the product pick list of a type, with batches and stock');

// ── bills ────────────────────────────────────────────────────────────────────
const DOC = `DR DM ${tag}`.toUpperCase();
await wait(1200);
const s1 = await okCall('POST', '/api/web/sales', { token: staff, body: {
  customer_name: `DM PATIENT ${tag}`, doctor_name: DOC, items: [{ medicine_id: inj.id, qty: 3 }, { medicine_id: tab.id, qty: 10 }], cash_paid: 0 } });
const s1Before = await okCall('GET', `/api/web/sales/${s1.sale.id}`, { token: owner });
const rep = (extra = {}, token = owner) => okCall('GET', `/api/web/reports/doctor-margin/by-rules?${new URLSearchParams({
  from: today, to: today, doctors: DOC, ...extra })}`, { token });
let r = await rep();
const injRow = r.rows.find((x) => x.name === INJ);
assert.deepEqual([injRow.qty, injRow.mrp, injRow.rate, injRow.margin_unit, injRow.value, injRow.rule],
  [3, 66.64, 6.6667, 59.9733, 179.92, 'Injection > Own']);
const tabRow = r.rows.find((x) => x.name === TAB);
assert.deepEqual([tabRow.qty, tabRow.mrp, tabRow.rate, tabRow.margin_unit, tabRow.value], [10, 10, 5, 1, 10]);
assert.deepEqual(r.totals, { qty: 13, value: 189.92, lines: 2 });
assert.deepEqual(r.doctors.map((d) => [d.doctor, d.value]), [[DOC, 189.92]]);
assert.deepEqual(r.sales.rows, [], 'no type on total sales yet');
assert.deepEqual(r.grand.totals, { profit: 189.92, sales_value: 0, commission: 0, total: 189.92 });
assert.equal(r.products.length, 2);
const asBilled = await rep({ rate_basis: 'purchase' });
assert.equal(asBilled.rows.find((x) => x.name === INJ).value, 169.92, '(66.64 - 10) x 3: the rate choice');
assert.equal((await rep({}, staff)).totals.value, 189.92, 'staff with sales history see the report');
step('bill 1: injection (66.64 - 100/15) x 3 = 179.92, tablet Rs 1 x 10 = 10; TOTAL 189.92; purchase rate as billed 169.92');

// ── the rules change: old bills keep theirs, new bills take the new ones ──────
await wait(1200);
await okCall('PUT', '/api/web/reports/doctor-margin/rules', { token: owner, body: { rules: { rate_basis: 'purchase', sets: [{ doctor: '', types: [
  { type: 'Injection', mode: 'type', margin: { kind: 'fixed', value: 2 } }, { type: 'Tablet', mode: 'none' }] }] } } });
await wait(1200);
const s2 = await okCall('POST', '/api/web/sales', { token: staff, body: {
  customer_name: `DM PATIENT2 ${tag}`, doctor_name: DOC.toLowerCase(), items: [{ medicine_id: inj.id, qty: 4 }, { medicine_id: tab.id, qty: 5 }], cash_paid: 0 } });
r = await rep();
assert.deepEqual(r.totals, { qty: 17, value: 197.92, lines: 3 }, 'bill 1 as saved (189.92) + bill 2 with the new rules (Rs 2 x 4)');
step('rules changed: bill 1 keeps 189.92, bill 2 is Rs 2 x 4 = 8 (tablets give nothing now)');

const ret = await okCall('POST', '/api/web/returns/sales', { token: owner, body: { sale_id: s2.sale.id, items: [{ medicine_id: inj.id, qty: 1 }], settle_mode: 'ledger' } });
r = await rep();
assert.equal(r.totals.value, 195.92);
assert.equal(r.rows.find((x) => x.bill_no === s2.bill_no.split('/FY')[0]).qty_returned, 1);
step(`return ${ret.return_no} of 1 injection: bill 2 gives 3 x 2 = 6; TOTAL 195.92`);

// ── Recalculate period: today's rules for every bill of the period ───────────
assert.equal((await call('POST', '/api/web/reports/doctor-margin/recalculate', { token: staff, body: { from: today, to: today } })).status, 403);
await wait(1200);
r = await okCall('POST', '/api/web/reports/doctor-margin/recalculate', { token: owner, body: { from: today, to: today, doctors: DOC } });
assert.equal(r.sync.recalculated, true);
assert.deepEqual(r.totals, { qty: 6, value: 12, lines: 2 }, 'bill 1: 3 x 2 (tablets none) + bill 2: 3 x 2');
assert.equal((await rep()).totals.value, 12, 'and it stays so');
const after = await okCall('GET', '/api/web/reports/doctor-margin/rules', { token: owner });
assert.ok(after.recalculated.some((x) => x.from === today && x.to === today));
await wait(1200);
const s3 = await okCall('POST', '/api/web/sales', { token: staff, body: {
  customer_name: `DM PATIENT3 ${tag}`, doctor_name: DOC, items: [{ medicine_id: inj.id, qty: 1 }], cash_paid: 0 } });
assert.equal((await rep()).totals.value, 14, 'a bill after the recalculation: today\'s rules');
step(`Recalculate today (staff refused): TOTAL 12; bill ${s3.bill_no} after it adds 2`);

// ── nothing outside the doctor report changed ───────────────────────────────
const s1After = await okCall('GET', `/api/web/sales/${s1.sale.id}`, { token: owner });
const pick = (s) => ({ total: s.total_amount, due: s.due_amount, items: s.items.map((i) => [i.medicine_id, i.qty, i.rate, i.amount, i.cost_price]) });
assert.deepEqual(pick(s1After), pick(s1Before));
assert.equal((await inv(INJ)).stock_qty, 15 - 3 - 4 + 1 - 1);
step('bill 1 and the stock are exactly as before (rules and recalculation touch only the report)');

const det = await rep({ view: 'detail', rate_basis: 'purchase_free' });
assert.equal(det.filters.view, 'detail');
assert.deepEqual(det.products.map((p) => [p.name, p.value]), [[INJ, 14]]);
step('customer-wise product-batch layout: one product, sub-total = TOTAL');

// ── rules version 2: on profit (an All-products group) and on total sales (a %) ──
const badPct = await call('PUT', '/api/web/reports/doctor-margin/rules', { token: owner, body: { rules: { sets: [{ doctor: '', sales_pct: 140, types: [] }] } } });
assert.equal(badPct.status, 400);
assert.equal(badPct.error, 'A % of total sales must be 0 to 100.');
await wait(1200);
const two = await okCall('PUT', '/api/web/reports/doctor-margin/rules', { token: owner, body: { rules: { version: 2, rate_basis: 'purchase', sets: [
  { doctor: '', sales_pct: 10, types: [
    { type: 'Injection', mode: 'groups', groups: [{ name: 'All injections', all: true, margin: { kind: 'fixed', value: 3 }, items: [] }] },
    { type: 'Tablet', mode: 'sales' }] },
  { doctor: DOC.toLowerCase(), sales_pct: 12.5, types: [] },
] } } });
assert.deepEqual(two.rules.sets.map((x) => [x.doctor, x.sales_pct]), [['', 10], [DOC, 12.5]]);
assert.equal(two.has_rules, true);
await wait(1200);
const s4 = await okCall('POST', '/api/web/sales', { token: staff, body: {
  customer_name: `DM PATIENT4 ${tag}`, doctor_name: DOC, items: [{ medicine_id: inj.id, qty: 2 }, { medicine_id: tab.id, qty: 4, disc_pct: 10 }], cash_paid: 0 } });
const s4Bill = await okCall('GET', `/api/web/sales/${s4.sale.id}`, { token: owner });
const tabLine = s4Bill.items.find((i) => i.medicine_id === tab.id);
assert.ok(tabLine.amount > 0 && tabLine.amount < 40, `the tablet line's amount, its 10% discount off (${tabLine.amount})`);
r = await rep();
const s4No = s4.bill_no.split('/FY')[0];
assert.deepEqual(r.rows.filter((x) => x.bill_no === s4No).map((x) => [x.name, x.qty, x.margin_unit, x.value, x.rule]),
  [[INJ, 2, 3, 6, 'Injection > All injections']], 'on profit: the All-products group');
assert.equal(r.totals.value, 20, 'the earlier bills as they were (14) + 2 x 3');
assert.deepEqual(r.sales.rows.map((x) => [x.bill_no, x.name, x.qty, x.sale_rate, x.disc, x.value, x.kind_value, x.pack]),
  [[s4No, TAB, 4, tabLine.rate, r2(tabLine.item_discount), r2(tabLine.amount), 12.5, '10']], 'on total sales: the line as billed');
let sd = r.sales.doctors[0];
assert.deepEqual(sd.by_pct, [{ pct: 12.5, value: r2(tabLine.amount), commission: r2(r2(tabLine.amount) * 12.5 / 100) }]);
assert.deepEqual(sd.products.map((p) => [p.name, p.pack, p.qty, p.value]), [[TAB, '10', 4, r2(tabLine.amount)]]);
assert.deepEqual(r.grand.doctors, [{ doctor: DOC, profit: 20, sales_value: r2(tabLine.amount), commission: sd.commission, total: r2(20 + sd.commission) }]);
step(`rules v2: bill ${s4.bill_no} injection on profit (All products, Rs 3 x 2) + tablets on total sales ${r2(tabLine.amount)} at the doctor's 12.5% = ${sd.commission}; doctor's margin ${r.grand.totals.total}`);

await okCall('POST', '/api/web/returns/sales', { token: owner, body: { sale_id: s4.sale.id, items: [{ medicine_id: tab.id, qty: 1 }], settle_mode: 'ledger' } });
r = await rep();
const net = r2((tabLine.amount * 3) / 4);
assert.deepEqual(r.sales.rows.map((x) => [x.qty, x.qty_returned, x.value]), [[3, 1, net]], 'the return takes its share off');
sd = r.sales.doctors[0];
assert.equal(sd.commission, r2(net * 12.5 / 100));
assert.equal(r.grand.totals.total, r2(20 + sd.commission));
const freeRate = await rep({ rate_basis: 'purchase_free' });
assert.deepEqual(freeRate.sales, r.sales, 'the rate choice never touches the total-sales part');
step(`a return of 1 tablet: sale value ${net}, commission ${sd.commission}`);

// put the store's rules back as they were
await okCall('PUT', '/api/web/reports/doctor-margin/rules', { token: owner, body: { rules: before.rules } });
step('the store\'s rules put back');
console.log(`# ${passed} passed`);
