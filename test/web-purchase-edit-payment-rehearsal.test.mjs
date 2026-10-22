// A saved purchase's payment changed by a web edit reaches the purchase, the supplier's due and
// Payments (owner, 22 Oct 2026: "make sure the same error of the sales edit payment should not be
// in the purchase"). REHEARSAL server only (VPS 127.0.0.1:3999 through an SSH tunnel): it creates a
// login, suppliers, medicines and purchases.
//
//   WEB_TEST_BASE=http://127.0.0.1:3999  WEB_TEST_STORE=<test store id>  WEB_TEST_KEY=SC-V2TEST01
//   WEB_TEST_ADMIN_USER=<rehearsal admin>  WEB_TEST_ADMIN_PW_FILE=<file holding its password>
//   node test/web-purchase-edit-payment-rehearsal.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { purchaseEntryPaid } from '../web/src/api.js';

const BASE = process.env.WEB_TEST_BASE || 'http://127.0.0.1:3999';
if (!/^http:\/\/127\.0\.0\.1:3999$/.test(BASE)) throw new Error('Rehearsal only: WEB_TEST_BASE must be http://127.0.0.1:3999');
const STORE = process.env.WEB_TEST_STORE;
const KEY = process.env.WEB_TEST_KEY || 'SC-V2TEST01';
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
  return { status: res.status, data: data.data, error: data.error };
}
async function okCall(method, path, opts) {
  const r = await call(method, path, opts);
  if (r.status !== 200) throw new Error(`${method} ${path} -> ${r.status} ${r.error}`);
  return r.data;
}
let passed = 0;
function step(name) { passed += 1; console.log(`ok ${passed} - ${name}`); }

// ── an owner login on the test store ─────────────────────────────────────────
const adminTok = (await okCall('POST', '/api/auth/admin/login', { body: { username: ADMIN, password: ADMIN_PW } })).token;
const made = await okCall('POST', `/api/admin/stores/${STORE}/web-users`, {
  token: adminTok, body: { username: `purpay-${tag}`, full_name: 'Purchase Pay Test', role: 'owner' },
});
let owner = (await okCall('POST', '/api/web/auth/login', { body: { username: `purpay-${tag}`, password: made.password } })).token;
const pw = `Purpay${tag}9x`;
await okCall('POST', '/api/web/me/password', { token: owner, body: { current: made.password, next: pw } });
owner = (await okCall('POST', '/api/web/auth/login', { body: { username: `purpay-${tag}`, password: pw } })).token;
step('owner login on the rehearsal test store');

const TOTAL = 100; // 10 strips x Rs 10, no GST
function body(supplier, bill, cash, online, items) {
  return {
    supplier_name: supplier, bill_number: bill, gst_calc_method: 'discount_before_gst', cash_paid: cash, online_paid: online,
    items: items || [{ name: `WEBPP TAB ${tag}`.toUpperCase(), batch_no: 'WP1', expiry: '12/28', type: 'Tablet', unit: '10',
      qty: 10, rate: 10, mrp: 20, gst_pct: 0 }],
  };
}
function sameLines(p) {
  return p.items.map((it) => ({ medicine_id: it.medicine_id, name: it.name, batch_no: it.batch_no, expiry: '12/28',
    type: it.type, unit: it.unit, qty: it.qty, rate: it.rate, mrp: it.mrp, gst_pct: it.gst_pct }));
}

async function check(label, id, cash, online) {
  const paid = Math.round((cash + online) * 100) / 100;
  const due = Math.max(0, Math.round((TOTAL - paid) * 100) / 100);
  const p = await okCall('GET', `/api/web/purchases/${id}`, { token: owner });
  assert.equal(Number(p.amount_paid), paid, `${label}: paid on the purchase`);
  assert.equal(Number(p.amount_paid_at_entry), paid, `${label}: paid at entry`);
  assert.equal(Number(p.cash_paid_at_entry), cash, `${label}: cash at entry`);
  assert.equal(Number(p.online_paid_at_entry), online, `${label}: online at entry`);
  assert.equal(Number(p.due_amount), due, `${label}: the purchase's due`);
  assert.equal(Boolean(p.bill_cleared), due === 0, `${label}: bill_cleared`);
  assert.equal(Boolean(p.account_cleared), due === 0, `${label}: account_cleared`);
  const sups = await okCall('GET', `/api/web/suppliers?q=${encodeURIComponent(p.supplier_name)}`, { token: owner });
  const rows = Array.isArray(sups) ? sups : (sups.rows || []);
  const sup = rows.find((s) => Number(s.local_id ?? s.id) === Number(p.supplier_id));
  assert.ok(sup, `${label}: supplier listed`);
  assert.equal(Number(sup.total_due), due, `${label}: the supplier's due (Payments)`);
  const open = await okCall('GET', `/api/web/suppliers/${p.supplier_id}/open-bills`, { token: owner });
  assert.deepEqual(open.map((b) => [b.bill_id, b.owes]), due ? [[Number(id), due]] : [], `${label}: open purchase bills`);
  const info = await okCall('GET', `/api/web/purchases/${id}/due`, { token: owner });
  assert.equal(info.bill_due, due, `${label}: pay-from-history bill due`);
  assert.equal(info.party_due, due, `${label}: pay-from-history supplier due`);
  return p;
}

for (const [label, from, to] of [
  ['LOWER', [100, 0], [40, 0]],
  ['RAISE', [30, 0], [100, 0]],
  ['TODUE', [100, 0], [0, 0]],
  ['FROMDUE', [0, 0], [100, 0]],
  ['SPLIT', [50, 50], [20, 0]],
]) {
  const supplier = `WEBPP ${label} ${tag}`.toUpperCase();
  const bill = `W${tag}${label.slice(0, 3)}`;
  const pur = await okCall('POST', '/api/web/purchases', { token: owner, body: body(supplier, bill, ...from) });
  await check(`${label} saved`, pur.id, ...from);
  const p = await okCall('GET', `/api/web/purchases/${pur.id}`, { token: owner });
  await okCall('PUT', `/api/web/purchases/${pur.id}`, {
    token: owner, body: { ...body(supplier, bill, ...to, sameLines(p)), supplier_id: p.supplier_id, version: p.version },
  });
  await check(`${label} edited`, pur.id, ...to);
  step(`web edit ${label}: cash ${from.join('+')} -> ${to.join('+')} reaches the purchase, the supplier's due and Payments`);
}

// ── an edit that says nothing about the payment keeps it ─────────────────────
{
  const supplier = `WEBPP KEEP ${tag}`.toUpperCase();
  const pur = await okCall('POST', '/api/web/purchases', { token: owner, body: body(supplier, `W${tag}KEP`, 60, 0) });
  const p = await okCall('GET', `/api/web/purchases/${pur.id}`, { token: owner });
  const { cash_paid: _c, online_paid: _o, ...noPay } = body(supplier, `W${tag}KEP`, 0, 0, sameLines(p));
  await okCall('PUT', `/api/web/purchases/${pur.id}`, { token: owner, body: { ...noPay, supplier_id: p.supplier_id, version: p.version } });
  await check('KEEP edited without payment fields', pur.id, 60, 0);
  step('a web edit without Cash / Online keeps what the purchase was paid');
}

// ── a purchase a device stored without the cash/online split ─────────────────
{
  const supplier = `WEBPP NOSPLIT ${tag}`.toUpperCase();
  const pur = await okCall('POST', '/api/web/purchases', { token: owner, body: body(supplier, `W${tag}NSP`, 100, 0) });
  const dev = (await okCall('POST', '/api/auth/pair', { body: { android_key: KEY, device_id: `purpay-dev-${tag}`, device_type: 'pc' } })).token;
  const doc = await okCall('GET', `/api/sync/purchases/${pur.id}`, { token: dev });
  const old = { ...doc, cash_paid_at_entry: 0, online_paid_at_entry: 0, amount_paid_at_entry: 100, amount_paid: 100,
    version: Number(doc.version || 1) + 1, updated_at: new Date().toISOString(), device_id: `purpay-dev-${tag}` };
  const pushed = await okCall('POST', '/api/sync/bundle', { token: dev, body: { purchases: [old] } });
  assert.ok(JSON.stringify(pushed).includes('upserted'), 'the device copy was stored');
  const p = await okCall('GET', `/api/web/purchases/${pur.id}`, { token: owner });
  assert.equal(Number(p.cash_paid_at_entry), 0);
  assert.equal(Number(p.amount_paid_at_entry), 100);
  assert.equal(Number(p.due_amount), 0, 'the ledger reads it as paid');
  // What the web's edit form starts from (Purchases.jsx), sent back unchanged.
  const form = purchaseEntryPaid(p);
  assert.deepEqual(form, { cash: 100, online: 0 }, 'the edit form opens it paid in cash');
  await okCall('PUT', `/api/web/purchases/${pur.id}`, {
    token: owner, body: { ...body(supplier, `W${tag}NSP`, form.cash, form.online, sameLines(p)), supplier_id: p.supplier_id, version: p.version },
  });
  await check('NOSPLIT edited as the form opened it', pur.id, 100, 0);
  step('a purchase paid without a cash/online split opens paid and stays paid through a web edit');
  // The device wrote the purchase last; the web's edit must not be taken for that device's own
  // echo (syncV2 applyServerSideSave), or the device would never take it and could push its
  // older copy over it.
  const after = await okCall('GET', `/api/sync/purchases/${pur.id}`, { token: dev });
  assert.notEqual(String(after.device_id || ''), `purpay-dev-${tag}`, 'the web edit names the web as its writer');
  const stale = { ...old, version: Number(old.version), updated_at: new Date(Date.now() - 60_000).toISOString() };
  const replay = await okCall('POST', '/api/sync/bundle', { token: dev, body: { purchases: [stale] } });
  assert.ok(JSON.stringify(replay).includes('skipped'), 'the device copy older than the web edit is skipped');
  step('the web edit is not the device\'s echo, and the device\'s older copy does not go over it');
}

console.log(`# ${passed} steps passed`);
