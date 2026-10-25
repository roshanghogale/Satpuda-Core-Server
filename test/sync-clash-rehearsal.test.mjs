// Clashes only the server can see (services/clashRules.js), end to end over HTTP: two registered
// devices of the rehearsal test shop push sync v2 events the way two offline PCs / phones would.
// REHEARSAL server only (VPS 127.0.0.1:3999 through an SSH tunnel); it makes medicines, bills,
// returns and purchases in the test shop.
//
//   V2_TEST_BASE=http://127.0.0.1:3999  V2_TEST_KEY=SC-V2TEST01  node test/sync-clash-rehearsal.test.mjs
import assert from 'node:assert/strict';

const BASE = process.env.V2_TEST_BASE || 'http://127.0.0.1:3999';
if (!/^http:\/\/127\.0\.0\.1:3999$/.test(BASE)) throw new Error('Rehearsal only: V2_TEST_BASE must be http://127.0.0.1:3999');
const KEY = process.env.V2_TEST_KEY || 'SC-V2TEST01';
const tag = Date.now().toString(36);
const DAY = new Date().toISOString().slice(0, 10);

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status !== 200) throw new Error(`${method} ${path} -> ${res.status} ${data.error || ''}`);
  return data.data;
}
let passed = 0;
function step(name) { passed += 1; console.log(`ok ${passed} - ${name}`); }

class Device {
  constructor(name) { this.install = `clash-${name}-${tag}`; this.seq = 0; this.n = 0; }
  async start() {
    this.token = (await call('POST', '/api/auth/pair', { body: { android_key: KEY, device_id: this.install, device_type: 'pc' } })).token;
    const reg = await call('POST', '/api/sync/v2/register', { token: this.token, body: { install_id: this.install, device_type: 'pc', device_name: this.install } });
    this.base = Number(reg.id_base);
    this.seq = Number(reg.last_seq || 0);
    return this;
  }
  id() { this.n += 1; return this.base + 1000 + this.n; }
  ev(op, collection, doc, extra = {}) {
    this.seq += 1;
    return { seq: this.seq, event_uuid: `${this.install}-e${this.seq}`, op, collection, doc, device_time: new Date().toISOString(), ...extra };
  }
  stock(ops) {
    this.seq += 1;
    return {
      seq: this.seq, event_uuid: `${this.install}-e${this.seq}`, op: 'stock', collection: 'stock_operations',
      stock_ops: ops.map(([mid, d], i) => ({ op_uuid: `${this.install}:s${this.seq}:${i}`, medicine_id: mid, op: 'adjust', qty_delta: d })),
    };
  }
  async push(events) {
    const out = await call('POST', '/api/sync/v2/push', { token: this.token, body: { install_id: this.install, events } });
    assert.equal(out.missing_from, null, 'no gap');
    return out;
  }
}

async function stockOf(dev, mid) {
  const s = await call('POST', '/api/sync/v2/stock', { token: dev.token, body: { ids: [mid] } });
  return Number(s.stock[0][1]);
}
const byId = (out) => new Map(out.results.map((r) => [r.seq, r]));

const A = await new Device('a').start();
const B = await new Device('b').start();
step('two devices registered on the rehearsal test shop');

// A medicine with 100 in stock.
const M = A.id();
await A.push([
  A.ev('upsert', 'medicines', { id: M, name: `CLASH SYRUP ${tag}`.toUpperCase(), type: 'Syrup', unit: '1', rate: 10, mrp: 10, batch_no: 'B1', expiry_date: '2028-12-01', stock_qty: 0, device_id: A.install }),
  A.stock([[M, 100]]),
]);
assert.equal(await stockOf(A, M), 100);

const sale = (id, qty, extra = {}) => ({
  id, bill_date: DAY, customer_name: 'CLASH TEST', total_amount: qty * 10, amount_paid: qty * 10, cash_paid: qty * 10,
  items: qty ? [{ medicine_id: M, name: 'CLASH SYRUP', qty, rate: 10, amount: qty * 10 }] : [], ...extra,
});

// 1. two offline edits of one bill ------------------------------------------------------
{
  const S = A.id();
  await A.push([A.ev('upsert', 'sales', { ...sale(S, 5), device_id: A.install }, { base_version: 0 }), A.stock([[M, -5]])]);
  // A edits 5 -> 3 (v2); B, from v1, edits 5 -> 4 and sends the lines it edited from.
  await A.push([A.ev('upsert', 'sales', { ...sale(S, 3), device_id: A.install }, { base_version: 1, base_lines: [[M, 5]] }), A.stock([[M, 2]])]);
  const out = await B.push([
    B.ev('upsert', 'sales', { ...sale(S, 4), device_id: B.install }, { base_version: 1, base_lines: [[M, 5]] }),
    B.stock([[M, 1]]),
  ]);
  const r = out.results[0];
  assert.equal(r.outcome, 'flagged');
  assert.equal(r.flag_code, 'concurrent_edit');
  assert.equal(r.replaced, true);
  assert.equal(r.replaced_version, 2);
  assert.deepEqual(r.stock_fix, [{ medicine_id: M, qty_delta: -2 }]);
  assert.match(r.flag_detail, /stock was put back/);
  assert.equal(out.results[1].outcome, 'applied', 'the queue goes on');
  assert.equal(await stockOf(A, M), 96, 'stock ends on the winning bill (4 sold)');
  // A replay of the same push changes nothing.
  const again = await call('POST', '/api/sync/v2/push', { token: B.token, body: { install_id: B.install, events: [] } });
  assert.equal(again.results.length, 0);
  step('two offline edits of one bill: later push wins, stock ends on its lines (96)');

  // An older device (no base_lines): taken and flagged as before, nothing put back.
  const S2 = A.id();
  await A.push([A.ev('upsert', 'sales', { ...sale(S2, 5), device_id: A.install }, { base_version: 0 }), A.stock([[M, -5]])]);
  await A.push([A.ev('upsert', 'sales', { ...sale(S2, 3), device_id: A.install }, { base_version: 1 }), A.stock([[M, 2]])]);
  const old = await B.push([B.ev('upsert', 'sales', { ...sale(S2, 4), device_id: B.install }, { base_version: 1 }), B.stock([[M, 1]])]);
  assert.equal(old.results[0].flag_code, 'concurrent_edit');
  assert.equal(old.results[0].stock_fix, undefined);
  assert.equal(old.results[1].outcome, 'applied');
  assert.equal(await stockOf(A, M), 94, 'as before: 96 - 5 + 2 + 1');
  await A.push([A.stock([[M, 2]])]);                       // tidy the test stock back to 96
  step('an older device without base_lines is taken exactly as before');
}

// 2. returns above what was sold --------------------------------------------------------
let S3;
{
  S3 = A.id();
  await A.push([A.ev('upsert', 'sales', { ...sale(S3, 4), device_id: A.install }, { base_version: 0 }), A.stock([[M, -4]])]);
  const ret = (id, qty) => ({ id, return_no: `SRX${tag}-${id % 100000}`, sale_id: S3, return_date: DAY, refund_amount: qty * 10,
    items: [{ medicine_id: M, qty, rate: 10, amount: qty * 10 }] });
  const R1 = A.id();
  const R2 = B.id();
  const a = await A.push([A.ev('upsert', 'sales_returns', { ...ret(R1, 4), device_id: A.install }, { base_version: 0 }), A.stock([[M, 4]])]);
  assert.equal(a.results[0].outcome, 'applied');
  const b = await B.push([B.ev('upsert', 'sales_returns', { ...ret(R2, 4), device_id: B.install }, { base_version: 0 }), B.stock([[M, 4]])]);
  assert.equal(b.results[0].outcome, 'flagged');
  assert.equal(b.results[0].flag_code, 'over_return');
  assert.match(b.results[0].flag_detail, /sold 4, returned before 4, this return 4/);
  assert.equal(b.results[1].outcome, 'applied', 'the queue goes on');
  const flags = await call('GET', '/api/sync/v2/flags', { token: B.token });
  assert.ok(flags.some((f) => f.collection === 'sales_returns' && Number(f.local_id) === R2 && f.flag_code === 'over_return'));
  step('two returns of the remaining quantity: both kept, the second flagged over_return');
}

// 3. a return of a bill another device deleted -------------------------------------------
{
  const S4 = A.id();
  await A.push([A.ev('upsert', 'sales', { ...sale(S4, 5), device_id: A.install }, { base_version: 0 }), A.stock([[M, -5]])]);
  const before = await stockOf(A, M);
  await A.push([A.ev('delete', 'sales', { id: S4 }, { base_version: 1 }), A.stock([[M, 5]])]);
  const R3 = B.id();
  const out = await B.push([
    B.ev('upsert', 'sales_returns', { id: R3, return_no: `SRD${tag}`, sale_id: S4, return_date: DAY, refund_amount: 20,
      items: [{ medicine_id: M, qty: 2, rate: 10, amount: 20 }], device_id: B.install }, { base_version: 0 }),
    B.stock([[M, 2]]),
  ]);
  const r = out.results[0];
  assert.equal(r.outcome, 'flagged');
  assert.equal(r.flag_code, 'bill_deleted');
  assert.equal(r.kept_deleted, true);
  assert.deepEqual(r.stock_fix, [{ medicine_id: M, qty_delta: -2 }]);
  assert.equal(out.results[1].outcome, 'applied');
  assert.equal(await stockOf(A, M), before + 5, 'the bill deleted, the return moved nothing');
  step('a return of a bill another device deleted: kept deleted, its stock put back');

  // A return deleted on one device, edited (2 -> 3) on another that sends base_lines.
  const S5 = A.id();
  await A.push([A.ev('upsert', 'sales', { ...sale(S5, 4), device_id: A.install }, { base_version: 0 }), A.stock([[M, -4]])]);
  const R4 = A.id();
  const r4 = (qty, dev) => ({ id: R4, return_no: `SRE${tag}`, sale_id: S5, return_date: DAY, refund_amount: qty * 10,
    items: [{ medicine_id: M, qty, rate: 10, amount: qty * 10 }], device_id: dev.install });
  await A.push([A.ev('upsert', 'sales_returns', r4(2, A), { base_version: 0 }), A.stock([[M, 2]])]);
  await A.push([A.ev('delete', 'sales_returns', { id: R4 }, { base_version: 1 }), A.stock([[M, -2]])]);
  const s0 = await stockOf(A, M);
  const e = await B.push([
    B.ev('upsert', 'sales_returns', r4(3, B), { base_version: 1, base_lines: [[M, 2]] }),
    B.stock([[M, 1]]),
  ]);
  assert.equal(e.results[0].kept_deleted, true);
  assert.match(e.results[0].flag_code, /deleted_elsewhere/);
  assert.deepEqual(e.results[0].stock_fix, [{ medicine_id: M, qty_delta: -1 }]);
  assert.equal(await stockOf(A, M), s0);
  step('a return deleted on one device and edited on another stays deleted, stock put back');
}

// 4. one supplier bill on two offline devices ------------------------------------------
{
  const bill = `INV-${tag}`;
  const pur = (id, dev) => ({ id, supplier_name: `CLASH AGENCY ${tag}`.toUpperCase(), bill_number: bill, purchase_date: DAY,
    total_amount: 50, final_amount: 50, items: [{ medicine_id: M, name: 'CLASH SYRUP', qty: 5, rate: 10, item_amount: 50 }], device_id: dev.install });
  const P1 = A.id();
  const P2 = B.id();
  const a = await A.push([A.ev('upsert', 'purchases', pur(P1, A), { base_version: 0 })]);
  assert.equal(a.results[0].outcome, 'applied');
  const b = await B.push([B.ev('upsert', 'purchases', pur(P2, B), { base_version: 0 }), B.stock([[M, 1]])]);
  assert.equal(b.results[0].outcome, 'flagged');
  assert.equal(b.results[0].flag_code, 'duplicate_supplier_bill');
  assert.match(b.results[0].flag_detail, new RegExp(bill));
  assert.equal(b.results[1].outcome, 'applied');
  // Editing the flagged purchase again does not flag it again.
  const b2 = await B.push([B.ev('upsert', 'purchases', { ...pur(P2, B), total_amount: 51 }, { base_version: 1 })]);
  assert.equal(b2.results[0].outcome, 'applied');
  step('one supplier bill saved on two devices: the second applied and flagged, not dropped');
}

console.log(`\n${passed} passed`);
