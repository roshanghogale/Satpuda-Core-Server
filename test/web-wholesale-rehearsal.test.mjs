// End-to-end test of the web's wholesale store (owner, 18-19 Oct 2026) against the REHEARSAL
// server only (VPS 127.0.0.1:3999 through an SSH tunnel; DB satpuda_check_v2). Never point this
// at the live server: it switches wholesale on for the test store, makes logins, parties, bills.
//
//   WEB_TEST_BASE=http://127.0.0.1:3999  WEB_TEST_STORE=<retail test store pk>
//   WEB_TEST_ADMIN_USER=<rehearsal admin>  WEB_TEST_ADMIN_PW_FILE=<file holding its password>
//   node test/web-wholesale-rehearsal.test.mjs
//
// The store's wholesale switch and its companion's profile are put back as they were at the end.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { calcInvoice, unitsPerPack, amountInWords } from '../src/services/wholesaleSale.js';

const BASE = process.env.WEB_TEST_BASE || 'http://127.0.0.1:3999';
if (!/^http:\/\/127\.0\.0\.1:3999$/.test(BASE)) throw new Error('Rehearsal only: WEB_TEST_BASE must be http://127.0.0.1:3999');
const STORE = process.env.WEB_TEST_STORE;
const ADMIN = process.env.WEB_TEST_ADMIN_USER;
const ADMIN_PW = fs.readFileSync(process.env.WEB_TEST_ADMIN_PW_FILE, 'utf8').trim();
const tag = Date.now().toString(36);
const WS = { 'X-Satpuda-Store': 'wholesale' };

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
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
const wcall = (method, path, opts = {}) => call(method, path, { ...opts, headers: WS });
const wok = (method, path, opts = {}) => okCall(method, path, { ...opts, headers: WS });
async function allChanges(token, after = 0) {
  const out = [];
  for (;;) {
    const page = await okCall('GET', `/api/sync/changes/full?after=${after}&limit=1000`, { token });
    out.push(...(page.changes || []));
    if (!page.has_more || !page.changes?.length) return out;
    after = page.to_revision;
  }
}
let passed = 0;
function step(name) { passed += 1; console.log(`ok ${passed} - ${name}`); }
const near = (a, b, what) => assert.ok(Math.abs(Number(a) - Number(b)) < 0.005, `${what}: ${a} != ${b}`);

/** A valid GSTIN for a state code (the check character worked out). */
function gstin(state, pan) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const base = `${state}${pan}1Z`;
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const v = chars.indexOf(base[i]) * (i % 2 ? 2 : 1);
    total += Math.trunc(v / 36) + (v % 36);
  }
  return base + chars[(36 - (total % 36)) % 36];
}

const adminTok = (await okCall('POST', '/api/auth/admin/login', { body: { username: ADMIN, password: ADMIN_PW } })).token;
const before = await okCall('GET', `/api/admin/stores/${STORE}`, { token: adminTok });
const wasOn = before.store.wholesale_enabled === true;
let owner; let staff; let ownerMade; let staffMade; let dev = null; let oldProfile = null;
try {
  // ── the admin switches wholesale on: the companion store is offered ─────────────────
  await okCall('PATCH', `/api/admin/stores/${STORE}`, { token: adminTok, body: { wholesale_enabled: true } });
  const st = await okCall('GET', `/api/admin/stores/${STORE}`, { token: adminTok });
  const comp = st.wholesale_link?.companion;
  assert.ok(comp?.id && comp.android_key, JSON.stringify(st.wholesale_link));
  step(`wholesale on for store ${STORE}: companion ${comp.id} "${comp.store_name}"`);

  ownerMade = await okCall('POST', `/api/admin/stores/${STORE}/web-users`, { token: adminTok, body: { username: `wsowner-${tag}`, role: 'owner' } });
  owner = (await okCall('POST', '/api/web/auth/login', { body: { username: `wsowner-${tag}`, password: ownerMade.password } })).token;
  await okCall('POST', '/api/web/me/password', { token: owner, body: { current: ownerMade.password, next: `Owner${tag}9x` } });
  const meR = await okCall('GET', '/api/web/me', { token: owner });
  assert.equal(meR.store_kind, 'retail');
  assert.equal(meR.switchable, true);
  assert.equal(meR.wholesale_store.store_name, comp.store_name);
  const meW = await wok('GET', '/api/web/me', { token: owner });
  assert.equal(meW.store_kind, 'wholesale');
  assert.equal(meW.store_name, comp.store_name);
  assert.deepEqual(meW.permissions, meR.permissions, 'same permissions in both stores');
  step('the retail login can act for the wholesale store (X-Satpuda-Store), same permissions');

  staffMade = await wok('POST', '/api/web/staff', { token: owner, body: { username: `wsstaff-${tag}`, permissions: ['billing', 'sales_view'] } });
  const staffList = await okCall('GET', '/api/web/staff', { token: owner });
  assert.ok(staffList.users.some((u) => u.username === `wsstaff-${tag}`), 'staff made from the wholesale side live in the retail store');
  staff = (await okCall('POST', '/api/web/auth/login', { body: { username: `wsstaff-${tag}`, password: staffMade.password } })).token;
  await okCall('POST', '/api/web/me/password', { token: staff, body: { current: staffMade.password, next: `Staff${tag}7y` } });
  assert.equal((await wcall('POST', '/api/web/purchases', { token: staff, body: {} })).status, 403);
  assert.equal((await wcall('GET', '/api/web/wholesale/reports/register', { token: staff })).status, 403);
  step('staff logins stay in the retail store; a counter login is refused wholesale purchases and reports');

  // the companion's own profile: a GSTIN so the shop's state is known (CGST+SGST vs IGST)
  dev = await okCall('POST', '/api/auth/pair', { body: { android_key: comp.android_key, device_id: `wswebtest-${tag}`, device_type: 'pc' } });
  oldProfile = (await okCall('GET', `/api/admin/stores/${comp.id}`, { token: adminTok })).profile || {};
  await okCall('PUT', '/api/sync/settings/pharmacy_profile', { token: dev.token, body: {
    name: oldProfile.name || comp.store_name, address: 'Main Road, Testpur, 425405', gstin: gstin('27', 'AAAPT1234T'),
    dl_number: '20B-TEST, 21B-TEST', phone: '9000000000' } });
  step('a PC paired with the wholesale store sets its profile (shop GSTIN state 27)');

  // ── retail screens refuse in the wholesale store ───────────────────────────────────
  const retailTry = await wcall('POST', '/api/web/sales', { token: owner, body: { items: [] } });
  assert.equal(retailTry.status, 409);
  assert.equal(retailTry.details?.code, 'wholesale_store');
  step('a retail bill is refused in the wholesale store');

  // ── wholesale purchase: Rate A required; rates go onto the batch ───────────────────
  const tabName = `WSWEB TAB ${tag}`.toUpperCase();
  const syrName = `WSWEB SYRUP ${tag}`.toUpperCase();
  const noA = await wcall('POST', '/api/web/purchases', { token: owner, body: {
    supplier_name: `WS SUPPLIER ${tag}`, gst_calc_method: 'discount_before_gst',
    items: [{ name: tabName, batch_no: 'T1', expiry: '12/28', type: 'Tablet', unit: '10', qty: 20, rate: 40, gst_pct: 12 }] } });
  assert.equal(noA.status, 400);
  assert.equal(noA.details?.code, 'rate_a_required');
  const pur = await wok('POST', '/api/web/purchases', { token: owner, body: {
    supplier_name: `WS SUPPLIER ${tag}`, bill_number: `WSINV-${tag}`, gst_calc_method: 'discount_before_gst', cash_paid: 0,
    items: [
      { name: tabName, batch_no: 'T1', expiry: '12/28', type: 'Tablet', unit: '10', qty: 20, free_qty: 2, rate: 40, gst_pct: 12,
        hsn_code: '3004', rate_a: 46, rate_b: 48.5, rate_c: 50 },
      { name: syrName, batch_no: 'S1', expiry: '06/28', type: 'Syrup', unit: '100ML', qty: 30, rate: 55, gst_pct: 5, hsn_code: '3003', rate_a: 62 },
    ] } });
  const tab = (await wok('GET', `/api/web/inventory?q=${encodeURIComponent(tabName)}`, { token: owner })).rows[0];
  const syr = (await wok('GET', `/api/web/inventory?q=${encodeURIComponent(syrName)}`, { token: owner })).rows[0];
  assert.equal(tab.stock_qty, 220, '(20 + 2 free) strips x 10');
  assert.equal(syr.stock_qty, 30);
  const tabDoc = await wok('GET', `/api/web/inventory/${tab.id}`, { token: owner });
  assert.deepEqual([tabDoc.rate_a, tabDoc.rate_b, tabDoc.rate_c, tabDoc.purchase_rate], [46, 48.5, 50, 40]);
  const purDoc = await wok('GET', `/api/web/purchases/${pur.id}`, { token: owner });
  assert.ok(JSON.stringify(purDoc.items).includes('"rate_a"') || purDoc.items.some((i) => i.extra_fields?.rate_a === 46), JSON.stringify(purDoc.items[0]));
  const retailInv = await okCall('GET', `/api/web/inventory?q=${encodeURIComponent(tabName)}`, { token: owner });
  assert.equal(retailInv.rows.length, 0, 'the retail store never sees the wholesale stock');
  step(`wholesale purchase ${pur.purchase_no}: no Rate A refused; rates A/B/C + purchase rate on the batch; retail store untouched`);

  // ── parties: medical party fields, GSTIN kept where the PC keeps it ────────────────
  const badG = await wcall('POST', '/api/web/wholesale/parties', { token: owner, body: { name: `X ${tag}`, gstin: '27AAAPA1234A1Z4' } });
  assert.equal(badG.status, 400);
  const p1 = await wok('POST', '/api/web/wholesale/parties', { token: owner, body: {
    name: `WS MEDICAL ONE ${tag}`, phone: '9111111111', address: 'Station Road, Testpur', party_type: 'medical',
    gstin: gstin('27', 'BBBPB1234B'), dl_numbers: '20B-11  21B-12', rate_tier: 'B', credit_limit: 500, credit_days: 30 } });
  assert.equal(p1.party_type, 'medical');
  assert.equal(p1.state_code, '27');
  assert.equal(p1.rate_tier, 'B');
  assert.equal(p1.dl_numbers, '20B-11 21B-12');
  const p2 = await wok('POST', '/api/web/wholesale/parties', { token: owner, body: {
    name: `WS MEDICAL TWO ${tag}`, party_type: 'medical', gstin: gstin('24', 'CCCPC1234C'), rate_tier: 'C', credit_days: 15 } });
  assert.equal(p2.state_code, '24');
  const list = await wok('GET', `/api/web/wholesale/parties?q=${encodeURIComponent(`WS MEDICAL`)}`, { token: owner });
  assert.ok(list.find((r) => r.id === p1.id && r.gstin === p1.gstin));
  step('medical parties saved (GSTIN checked, state from GSTIN, tier, credit terms); a bad GSTIN refused');

  // ── a line takes the party's tier, else Rate A ─────────────────────────────────────
  const lB = await wok('POST', '/api/web/wholesale/line', { token: owner, body: { medicine_id: tab.id, rate_tier: 'B' } });
  assert.equal(lB.rate, 48.5); assert.equal(lB.rate_tier, 'B'); assert.equal(lB.units_per_pack, 10); assert.equal(lB.stock_packs, 22);
  const lC = await wok('POST', '/api/web/wholesale/line', { token: owner, body: { medicine_id: syr.id, rate_tier: 'C' } });
  assert.equal(lC.rate, 62); assert.equal(lC.rate_tier, 'A'); assert.match(lC.warning, /Rate A used/);
  step('a line takes Rate B for a tier-B party; no Rate C falls back to Rate A with a warning');

  // ── sale 1: same state, Due, CGST + SGST ──────────────────────────────────────────
  const items1 = [
    { medicine_id: tab.id, qty: 10, free: 1, rate: 48.5, rate_tier: 'B', disc_pct: 5, scheme_pct: 2, gst_percent: 12, hsn_code: '3004' },
    { medicine_id: syr.id, qty: 4, free: 0, rate: 62, rate_tier: 'A', disc_pct: 0, scheme_pct: 0, gst_percent: 5, hsn_code: '3003' },
  ];
  const want1 = calcInvoice(items1, { shopState: '27', pos: '27' });
  const calc1 = await wok('POST', '/api/web/wholesale/sales/calc', { token: owner, body: { customer_id: p1.id, items: items1, payment_mode: 'Due' } });
  assert.equal(calc1.intra_state, true);
  near(calc1.grand_total, want1.grand_total, 'grand total');
  near(calc1.cgst_total, want1.cgst_total, 'cgst');
  assert.equal(calc1.warnings.length, 1, 'the screen warns before the save');
  const s1 = await wok('POST', '/api/web/wholesale/sales', { token: owner, body: {
    customer_id: p1.id, items: items1, payment_mode: 'Due', transport: 'Test Transport', lr_no: `LR-${tag}`, eway_bill_no: '' } });
  near(s1.total_amount, want1.grand_total, 'saved total');
  assert.equal(s1.sale.due_date, (() => { const d = new Date(`${s1.sale.bill_date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 30); return d.toISOString().slice(0, 10); })());
  assert.ok(s1.warnings.length === 1 && /Credit limit crossed/.test(s1.warnings[0]), 'over the 500 limit: a warning, never a refusal');
  const tabAfter = (await wok('GET', `/api/web/inventory/${tab.id}`, { token: owner })).stock_qty;
  assert.equal(tabAfter, 220 - 110, '(10 + 1 free) strips x 10 left the shelf');
  step(`wholesale bill ${s1.display_bill_no} for ${s1.total_amount} (Due): PC sums, due date +30 days, credit warning, stock in units`);

  // what a PC pulls: exactly the PC's columns and keys
  const ch = await allChanges(dev.token);
  const pulled = ch.findLast((c) => c.collection === 'sales' && Number(c.local_id) === Number(s1.id))?.doc;
  assert.ok(pulled, 'the PC pulls the web wholesale bill');
  assert.equal(pulled.invoice_mode, 'wholesale');
  assert.equal(pulled.buyer_gstin, p1.gstin);
  assert.equal(pulled.buyer_dl, '20B-11 21B-12');
  assert.equal(pulled.place_of_supply, '27');
  near(pulled.taxable_total, want1.taxable_total, 'taxable_total');
  near(pulled.cgst_total, want1.cgst_total, 'cgst_total'); near(pulled.sgst_total, want1.sgst_total, 'sgst_total');
  near(pulled.igst_total, 0, 'igst_total');
  assert.equal(pulled.transport, 'Test Transport'); assert.equal(pulled.lr_no, `LR-${tag}`);
  near(pulled.rounding, want1.round_off, 'rounding');
  near(pulled.total_amount, want1.grand_total, 'total');
  near(pulled.due_amount, want1.grand_total, 'due');
  const li = pulled.items.find((i) => Number(i.medicine_id) === Number(tab.id));
  const w0 = want1.lines[0];
  assert.equal(Number(li.qty), (10 + 1) * unitsPerPack('Tablet', '10'));
  near(li.amount, w0.amount, 'line amount'); near(li.rate, Math.round((w0.amount / 110) * 10000) / 10000, 'line rate = amount / qty');
  near(li.item_discount, w0.disc_amt + w0.scheme_amt, 'item discount = disc + scheme');
  assert.equal(li.rate_tier, 'B'); near(li.free_qty, 1, 'free'); near(li.scheme_pct, 2, 'scheme');
  near(li.taxable, w0.taxable, 'taxable'); near(li.gst_amt, w0.gst_amt, 'gst');
  assert.equal(li.hsn_code, '3004'); assert.equal(li.batch_no, 'T1');
  step('a paired PC pulls the bill with the PC\'s columns and invoice keys (qty in units, rate = amount/qty, free in strips)');

  // the screen reads it back in strips
  const back = await wok('GET', `/api/web/wholesale/sales/${s1.id}`, { token: owner });
  const bl = back.items.find((i) => i.id === tab.id);
  assert.deepEqual([bl.qty, bl.free, bl.rate, bl.disc_pct, bl.scheme_pct], [10, 1, 48.5, 5, 2]);
  step('the saved bill opens again in strips: qty 10 + 1 free at 48.50, disc 5 %, scheme 2 %');

  // ── sale 2: another state -> IGST; cash ─────────────────────────────────────────────
  const items2 = [{ medicine_id: tab.id, qty: 5, free: 0, rate: 50, rate_tier: 'C', disc_pct: 0, scheme_pct: 0, gst_percent: 12, hsn_code: '3004' }];
  const want2 = calcInvoice(items2, { shopState: '27', pos: '24' });
  const s2 = await wok('POST', '/api/web/wholesale/sales', { token: owner, body: {
    customer_id: p2.id, items: items2, payment_mode: 'Cash', cash_paid: want2.grand_total } });
  const b2 = await wok('GET', `/api/web/wholesale/sales/${s2.id}`, { token: owner });
  near(b2.igst_total, want2.igst_total, 'igst'); near(b2.cgst_total, 0, 'no cgst');
  assert.equal(b2.place_of_supply, '24'); near(b2.due_amount, 0, 'paid in cash');
  const inv2 = await wok('GET', `/api/web/wholesale/sales/${s2.id}/invoice?paper=A5`, { token: owner });
  assert.ok(inv2.html.includes('IGST%') && inv2.html.includes('Place of Supply : Gujarat (24)') && inv2.html.includes('(CASH)'), 'IGST invoice');
  assert.ok(inv2.html.includes('size: 210mm 148mm'), 'A5 landscape page');
  step(`bill ${s2.display_bill_no} to another state: IGST ${b2.igst_total}; the A5 invoice prints IGST and the place of supply`);

  // ── edit bill 1: 10 -> 12 strips; a retail edit of it is refused ─────────────────────
  const retailEdit = await wcall('PUT', `/api/web/sales/${s1.id}`, { token: owner, body: { items: [] } });
  assert.equal(retailEdit.status, 409);
  const items1b = [{ ...items1[0], qty: 12 }, items1[1]];
  const want1b = calcInvoice(items1b, { shopState: '27', pos: '27' });
  const e1 = await wok('PUT', `/api/web/wholesale/sales/${s1.id}`, { token: owner, body: {
    customer_id: p1.id, items: items1b, payment_mode: 'Due', version: back.version, transport: 'Test Transport', lr_no: `LR-${tag}` } });
  near(e1.total_amount, want1b.grand_total, 'edited total');
  assert.equal((await wok('GET', `/api/web/inventory/${tab.id}`, { token: owner })).stock_qty, 220 - 130 - 50);
  step(`bill edited to 12 strips: total ${e1.total_amount}, stock 40 units left; a retail edit of a tax invoice is refused`);

  // ── a return in strips, then its credit settled in a new bill ─────────────────────
  const rt = await wok('GET', `/api/web/sales/${s2.id}/returnable`, { token: owner });
  const rl = rt.lines.find((l) => Number(l.medicine_id) === Number(tab.id));
  assert.equal(rt.wholesale, true); assert.equal(rl.units_per_pack, 10);
  const ret = await wok('POST', '/api/web/returns/sales', { token: owner, body: { sale_id: s2.id, settle_mode: 'ledger',
    items: [{ medicine_id: tab.id, qty: 2 * rl.units_per_pack }] } });
  const open = await wok('GET', `/api/web/wholesale/parties/${p2.id}/open-returns`, { token: owner });
  const o = open.find((x) => x.return_id === ret.id);
  assert.ok(o, 'the return is offered'); assert.equal(o.items[0].qty, 2, 'counted in strips');
  step(`return ${ret.return_no}: 2 strips of a cash bill back (${ret.refund_amount}), offered as 2 strips`);

  const items3 = [{ medicine_id: syr.id, qty: 3, free: 0, rate: 62, rate_tier: 'A', disc_pct: 0, scheme_pct: 0, gst_percent: 5 }];
  const s3 = await wok('POST', '/api/web/wholesale/sales', { token: owner, body: {
    customer_id: p2.id, items: items3, payment_mode: 'Due', apply_returns: [ret.id] } });
  assert.ok(s3.returns_applied > 0);
  const inv3 = await wok('GET', `/api/web/wholesale/sales/${s3.id}/invoice?paper=A4`, { token: owner });
  assert.ok(inv3.html.includes(`Return ${ret.return_no}`), 'Return rows on the invoice');
  assert.ok(inv3.html.includes('CR/DR NOTE') && inv3.html.includes(`-${s3.returns_applied.toFixed(2)}`), 'CR/DR NOTE');
  assert.ok(inv3.html.includes('size: 210mm 297mm'), 'A4: two A5 halves');
  step(`bill ${s3.display_bill_no} settles ${s3.returns_applied} of return credit: Return rows and CR/DR NOTE on the invoice`);

  // ── a NEW party typed on the bill (owner, 20 Oct 2026: "the party can be created same as
  //    the retail saves the customer"): made once from the boxes, then reused by name ─────
  const newName = `WS NEW PARTY ${tag}`.toUpperCase();
  const newG = gstin('27', 'AAAPN4321N');
  const items4 = [{ medicine_id: syr.id, qty: 1, free: 0, rate: 62, rate_tier: 'A', disc_pct: 0, scheme_pct: 0, gst_percent: 5 }];
  const noName = await wcall('POST', '/api/web/wholesale/sales', { token: owner, body: { customer_id: 0, customer_name: '', items: items4, payment_mode: 'Due' } });
  assert.equal(noName.status, 400); assert.equal(noName.details?.code, 'party_required');
  const s4 = await wok('POST', '/api/web/wholesale/sales', { token: owner, body: {
    customer_id: 0, customer_name: newName.toLowerCase(), customer_phone: '9111111111', customer_address: 'Testpur',
    buyer_gstin: newG, buyer_dl: '20B-NEW 21B-NEW', items: items4, payment_mode: 'Due' } });
  const made = (await wok('GET', `/api/web/wholesale/parties?q=${encodeURIComponent(newName)}`, { token: owner })).filter((r) => r.name === newName);
  assert.equal(made.length, 1, 'one party made');
  const madeDoc = await wok('GET', `/api/web/wholesale/parties/${made[0].id}`, { token: owner });
  assert.equal(madeDoc.gstin, newG); assert.equal(madeDoc.phone, '9111111111'); assert.equal(madeDoc.rate_tier, 'A');
  assert.equal(madeDoc.state_code, '27'); assert.equal(madeDoc.dl_numbers, '20B-NEW 21B-NEW'); assert.equal(madeDoc.address, 'Testpur');
  const b4 = await wok('GET', `/api/web/wholesale/sales/${s4.id}`, { token: owner });
  assert.equal(Number(b4.customer_id), Number(made[0].id));
  const s5 = await wok('POST', '/api/web/wholesale/sales', { token: owner, body: {
    customer_id: 0, customer_name: `  ${newName.toLowerCase()} `, items: items4, payment_mode: 'Due' } });
  const b5 = await wok('GET', `/api/web/wholesale/sales/${s5.id}`, { token: owner });
  assert.equal(Number(b5.customer_id), Number(made[0].id), 'the same name again uses the same party');
  assert.equal((await wok('GET', `/api/web/wholesale/parties?q=${encodeURIComponent(newName)}`, { token: owner })).filter((r) => r.name === newName).length, 1);
  const pulledParty = (await allChanges(dev.token)).findLast((c) => c.collection === 'customers' && Number(c.local_id) === Number(made[0].id))?.doc;
  assert.equal(pulledParty?.name, newName, 'a paired PC pulls the new party');
  step(`new party "${newName}" typed on bill ${s4.display_bill_no}: made once (GSTIN, phone, tier A, state 27), reused by name on ${s5.display_bill_no}; no name refused`);

  // ── a payment with a receipt number ────────────────────────────────────────────────
  const pay = await wok('POST', '/api/web/payments/customers', { token: owner, body: {
    customer_id: p1.id, amount: 100, mode: 'cash', receipt_no: `R-${tag}`, allocations: [{ bill_id: s1.id, amount: 100 }] } });
  const pays = await wok('GET', `/api/web/payments/customers?q=${encodeURIComponent(`R-${tag}`)}`, { token: owner });
  assert.equal(pays.rows[0]?.receipt_no, `R-${tag}`, 'listed and searchable by receipt no');
  const rep = await wok('GET', `/api/web/payments/report?kind=customers&party_id=${p1.id}`, { token: owner });
  assert.equal(rep.rows.find((r) => r.id === pay.id)?.receipt_no, `R-${tag}`);
  const inv1 = await wok('GET', `/api/web/wholesale/sales/${s1.id}/invoice`, { token: owner });
  assert.ok(inv1.html.includes(`(Rcpt R-${tag})`), 'the invoice shows the receipt that paid it');
  const pPulled = (await allChanges(dev.token)).findLast((c) => c.collection === 'customer_payments' && Number(c.local_id) === Number(pay.id))?.doc;
  assert.equal(pPulled?.receipt_no, `R-${tag}`);
  const sp = await wok('POST', '/api/web/payments/suppliers', { token: owner, body: { supplier_id: purDoc.supplier_id, amount: 50, mode: 'cash', receipt_no: `SR-${tag}` } });
  const sps = await wok('GET', `/api/web/payments/suppliers?q=${encodeURIComponent(`SR-${tag}`)}`, { token: owner });
  assert.equal(sps.rows[0]?.id, sp.id);
  step('customer and supplier payments keep the receipt no.: listed, searchable, in the report, on the invoice, pulled by the PC');

  // ── reports ────────────────────────────────────────────────────────────────────────
  const reg = await wok('GET', '/api/web/wholesale/reports/register', { token: owner });
  const regRows = reg.sections[0].rows.filter((r) => [s1, s2, s3].some((s) => s.display_bill_no === r[0]));
  assert.equal(regRows.length, 3);
  const r1 = regRows.find((r) => r[0] === s1.display_bill_no);
  near(r1[8], want1b.grand_total, 'register total'); near(r1[11], want1b.grand_total - 100, "balance after the receipt");
  const out = await wok('GET', `/api/web/wholesale/reports/outstanding?party_id=${p1.id}`, { token: owner });
  assert.equal(out.sections[0].rows.length, 1);
  near(out.sections[0].rows[0][5], out.sections[0].rows[0][4], 'every open bill is Not Due yet (30 days credit)');
  assert.equal(out.sections[0].rows[0][12], 'Yes', 'limit 500 crossed');
  for (const name of ['party', 'items', 'price_list']) {
    const r = await wok('GET', `/api/web/wholesale/reports/${name}`, { token: owner });
    assert.ok(r.sections[0].columns.length > 3, name);
  }
  step(`reports: register (3 invoices, balance ${r1[11]}), outstanding with ageing, party, items, price list`);

  // ── the switch off: wholesale requests refused, never done in retail ───────────────
  await okCall('PATCH', `/api/admin/stores/${STORE}`, { token: adminTok, body: { wholesale_enabled: false } });
  const off = await wcall('GET', '/api/web/wholesale/parties', { token: owner });
  assert.equal(off.status, 409); assert.equal(off.details?.code, 'wholesale_off');
  const meOff = await wok('GET', '/api/web/me', { token: owner });
  assert.equal(meOff.store_kind, 'retail'); assert.equal(meOff.switchable, false);
  step('wholesale switched off: the web falls back to retail; wholesale requests are refused');
  console.log(`\nall ${passed} steps passed (invoice words: ${amountInWords(want1b.grand_total)})`);
} finally {
  if (dev?.token && oldProfile) {
    await call('PUT', '/api/sync/settings/pharmacy_profile', { token: dev.token, body: {
      address: oldProfile.address ?? '', gstin: oldProfile.gstin ?? '', dl_number: oldProfile.dl_number ?? '', phone: oldProfile.phone ?? '' } });
  }
  await call('PATCH', `/api/admin/stores/${STORE}`, { token: adminTok, body: { wholesale_enabled: wasOn } });
  if (staffMade) await call('DELETE', `/api/admin/stores/${STORE}/web-users/${staffMade.user.id}`, { token: adminTok });
  if (ownerMade) await call('DELETE', `/api/admin/stores/${STORE}/web-users/${ownerMade.user.id}`, { token: adminTok });
  console.log(`cleanup: wholesale_enabled back to ${wasOn}; test logins removed`);
}
