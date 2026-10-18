/**
 * wholesale-test.mjs — the per-store "Wholesale mode (beta)" switch and the wholesale
 * fields riding on synced documents, checked without a database.
 *
 * Run from the server folder:   node wholesale-test.mjs
 *
 * Touches NO database and NO network beyond 127.0.0.1, same style as voice-test.mjs:
 * `pool.query` is replaced by a tiny in-memory `stores` table (the licence path) and the
 * REAL auth + admin routers are driven over HTTP on a random local port with real JWTs.
 * The sync part hands the REAL applyBundleInTx a recording fake client and checks the
 * statements it writes, then feeds the REAL pull functions rows that carry extra_fields.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const eq = (a, b, what) => assert(a === b, `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const deepEq = (a, b, what) => assert(JSON.stringify(a) === JSON.stringify(b),
  `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// ─── fake stores table (licence path) ─────────────────────────────────────────
const { pool } = await import('./src/db/pool.js');

const DEFAULTS = {
  app_mode: 'online', is_active: true, device_role: 'pc', notes: null,
  activation_date: null, expiry_enabled: false, expiry_date: null,
  apply_expiry_check: true, provisioned_trial: false,
  voice_enabled: false, voice_tier: 'auto', wholesale_enabled: false,
};
const stores = new Map();
let nextId = 9101;
function insertStore(extra = {}) {
  const id = nextId++;
  const row = {
    id, store_id: `store_ws_${id}`, store_key: `Store_Ws_${id}`,
    store_name: `Wholesale Test ${id}`, android_key: `SC-WSTEST${id}`,
    ...DEFAULTS, created_at: new Date(), updated_at: new Date(), ...extra,
  };
  stores.set(id, row);
  return row;
}

function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function project(row, colList) {
  const cols = splitTop(colList.replace(/\s+/g, ' '));
  if (cols.length === 1 && cols[0] === '*') return { ...row };
  const out = {};
  for (const c of cols) out[c] = row[c];
  return out;
}
function evalValue(expr, row, vals) {
  let m;
  if ((m = /^\$(\d+)$/.exec(expr))) return vals[Number(m[1]) - 1];
  if (expr === 'TRUE') return true;
  if (expr === 'FALSE') return false;
  if (expr === 'NOW()') return new Date(Date.now() + 1000);
  if ((m = /^COALESCE\((\w+),\s*\$(\d+)\)$/.exec(expr))) return row[m[1]] ?? vals[Number(m[2]) - 1];
  throw new Error(`fake db: unsupported value ${expr}`);
}

const seen = [];
/** Rows the pull checks hand back, keyed by a regex on the statement. */
let pullRows = [];
pool.query = async (text, vals = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  seen.push(sql);
  let m;
  if ((m = /^SELECT (.+) FROM stores WHERE id = \$1$/.exec(sql))) {
    const row = stores.get(Number(vals[0]));
    return { rows: row ? [project(row, m[1])] : [] };
  }
  if (/^SELECT \* FROM stores WHERE id::text = \$1 OR store_id = \$1$/.test(sql)) {
    const row = [...stores.values()].find((r) => String(r.id) === vals[0] || r.store_id === vals[0]);
    return { rows: row ? [{ ...row }] : [] };
  }
  if ((m = /^UPDATE stores SET (.+) WHERE id = \$(\d+) RETURNING (.+)$/.exec(sql))) {
    const row = stores.get(Number(vals[Number(m[2]) - 1]));
    if (!row) return { rows: [] };
    const next = { ...row };
    for (const a of splitTop(m[1])) {
      const [, col, expr] = /^(\w+) = (.+)$/.exec(a) || [];
      if (!col) throw new Error(`fake db: unsupported assignment ${a}`);
      next[col] = evalValue(expr.trim(), row, vals);
    }
    stores.set(row.id, next);
    return { rows: [project(next, m[3])] };
  }
  if (/^(UPDATE|INSERT INTO) store_devices\b/.test(sql)) return { rows: [] };
  for (const [re, rows] of pullRows) {
    if (re.test(sql)) return { rows: rows.map((r) => JSON.parse(JSON.stringify(r))) };
  }
  throw new Error(`fake db: unexpected statement: ${sql.slice(0, 160)}`);
};

// ─── the real routers on a local port ─────────────────────────────────────────
const { default: authRoutes } = await import('./src/routes/auth.js');
const { default: adminRoutes } = await import('./src/routes/admin.js');
const { errorMiddleware } = await import('./src/utils/http.js');
const { signAdminToken, signStoreToken } = await import('./src/middleware/auth.js');
const lic = await import('./src/services/licenseService.js');
const adminSvc = await import('./src/services/adminService.js');
const extras = await import('./src/services/docExtras.js');
const sync = await import('./src/services/syncService.js');
const { newSyncHint } = await import('./src/services/syncRevision.js');

const app = express();
app.use(express.json());
app.use('/api', authRoutes);
app.use('/api/admin', adminRoutes);
app.use(errorMiddleware);
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const BASE = `http://127.0.0.1:${server.address().port}`;
async function j(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const ADMIN = signAdminToken({ id: 1, username: 'wholesale-test' });
const store = insertStore();
const DEV = signStoreToken(store, 'wholesale-test-device-1');

// ─── recording client for the push checks ─────────────────────────────────────
function recordingClient() {
  const log = [];
  return {
    log,
    async query(text, vals = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      log.push({ sql, vals });
      if (/RETURNING head_revision$/.test(sql)) return { rows: [{ head_revision: log.length }] };
      if (/^INSERT INTO sales \(/.test(sql)) {
        return { rows: [{ id: 7001, bill_no: vals[2], fy_start_year: vals[22] }] };
      }
      if (/^(INSERT INTO|UPDATE) purchases\b/.test(sql) && /RETURNING id, purchase_no/.test(sql)) {
        return { rows: [{ id: 7002, purchase_no: '1/FY2026-27', fy_start_year: 2026 }] };
      }
      if (/MAX\(/i.test(sql)) return { rows: [{ mx: 0, max: 0, m: 0 }] };
      return { rows: [], rowCount: 0 };
    },
  };
}
const statements = (log, re) => log.filter((e) => re.test(e.sql));
const jsonParams = (entry) => entry.vals.filter((v) => typeof v === 'string' && v.startsWith('{'))
  .map((v) => JSON.parse(v));

const TS = '2026-10-18T10:00:00.000Z';

try {
  console.log('\nSchema');
  await check('stores.wholesale_enabled is added OFF by default', () => {
    const s = read('src/db/schema.sql');
    assert(/ALTER TABLE stores ADD COLUMN IF NOT EXISTS wholesale_enabled BOOLEAN NOT NULL DEFAULT FALSE;/.test(s),
      'missing ALTER ... wholesale_enabled BOOLEAN NOT NULL DEFAULT FALSE');
  });
  await check('every table with wholesale fields gets extra_fields JSONB', () => {
    const s = read('src/db/schema.sql');
    for (const t of extras.DOC_EXTRA_TABLES) {
      assert(new RegExp(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS extra_fields JSONB;`).test(s), `missing ${t}.extra_fields`);
    }
  });

  console.log('\nThe licence payload');
  await check('a row from before the column existed reads as OFF', () => {
    const p = lic.licensePayload({ is_active: true, expiry_enabled: false, apply_expiry_check: true });
    eq(p.wholesale_enabled, false, 'wholesale_enabled');
  });
  await check('NULL / junk values read as OFF', () => {
    eq(lic.licensePayload({ wholesale_enabled: null }).wholesale_enabled, false, 'null');
    eq(lic.licensePayload({ wholesale_enabled: 'true' }).wholesale_enabled, false, '"true" string');
    eq(lic.licensePayload({ wholesale_enabled: 1 }).wholesale_enabled, false, '1');
  });
  await check('a switched-on row carries through, voice untouched', () => {
    const p = lic.licensePayload({ wholesale_enabled: true });
    eq(p.wholesale_enabled, true, 'wholesale_enabled');
    eq(p.voice_enabled, false, 'voice_enabled');
  });
  await check('the licence and auth column lists read wholesale_enabled', () => {
    assert(/wholesale_enabled/.test(read('src/middleware/auth.js').match(/STORE_AUTH_COLS = `[^`]+`/)[0]),
      'STORE_AUTH_COLS misses wholesale_enabled');
    const ls = read('src/services/licenseService.js');
    assert(/wholesale_enabled/.test(ls.match(/LICENSE_COLS = `[^`]+`/)[0]), 'LICENSE_COLS misses it');
    assert(/provisioned_trial, voice_enabled, voice_tier, wholesale_enabled, updated_at`,\s*\r?\n\s*vals/.test(ls),
      'updateStoreLicenseRow RETURNING misses it');
  });

  console.log('\nDefault is OFF on the wire');
  await check('GET /auth/license on a new store says wholesale_enabled:false', async () => {
    const r = await j('/api/auth/license', { token: DEV });
    eq(r.status, 200, 'status');
    eq(r.body?.data?.wholesale_enabled, false, 'wholesale_enabled');
  });
  await check('admin store detail (getStore) includes the column', async () => {
    const s = await adminSvc.getStore(String(store.id));
    eq(s.wholesale_enabled, false, 'wholesale_enabled');
  });

  console.log('\nPATCH /admin/stores/:id toggles it');
  await check('turn ON', async () => {
    const r = await j(`/api/admin/stores/${store.id}`, { method: 'PATCH', token: ADMIN, body: { wholesale_enabled: true } });
    eq(r.status, 200, 'status');
    eq(r.body?.data?.wholesale_enabled, true, 'wholesale_enabled');
    eq(r.body?.data?.voice_enabled, false, 'voice left alone');
  });
  await check('GET /auth/license now carries wholesale_enabled:true', async () => {
    const r = await j('/api/auth/license', { token: DEV });
    eq(r.body?.data?.wholesale_enabled, true, 'wholesale_enabled');
  });
  await check('the cached auth row (STORE_AUTH_COLS) sees it immediately too', async () => {
    const r = await j('/api/auth/me', { token: DEV });
    eq(r.status, 200, 'status');
    eq(r.body?.data?.auth?.license?.wholesale_enabled, true, 'auth.license.wholesale_enabled');
  });
  await check('wholesale_enabled:"false" (a string) is refused, not read as true', async () => {
    const r = await j(`/api/admin/stores/${store.id}`, { method: 'PATCH', token: ADMIN, body: { wholesale_enabled: 'false' } });
    eq(r.status, 400, 'status');
    eq(stores.get(store.id).wholesale_enabled, true, 'stored value unchanged');
  });
  await check('turn OFF again', async () => {
    const r = await j(`/api/admin/stores/${store.id}`, { method: 'PATCH', token: ADMIN, body: { wholesale_enabled: false } });
    eq(r.status, 200, 'status');
    eq(r.body?.data?.wholesale_enabled, false, 'wholesale_enabled');
    const l = await j('/api/auth/license', { token: DEV });
    eq(l.body?.data?.wholesale_enabled, false, 'licence wholesale_enabled');
  });
  await check('a store token cannot use the admin PATCH', async () => {
    const r = await j(`/api/admin/stores/${store.id}`, { method: 'PATCH', token: DEV, body: { wholesale_enabled: true } });
    eq(r.status, 403, 'status');
    eq(stores.get(store.id).wholesale_enabled, false, 'stored value unchanged');
  });

  console.log('\nA device cannot set it through PUT /auth/license');
  await check('PUT {wholesale_enabled:true} leaves it OFF', async () => {
    const r = await j('/api/auth/license', {
      method: 'PUT', token: DEV, body: { wholesale_enabled: true, activation_date: '2026-10-01' },
    });
    eq(r.status, 200, 'status');
    eq(r.body?.data?.wholesale_enabled, false, 'response wholesale_enabled');
    eq(stores.get(store.id).wholesale_enabled, false, 'stored wholesale_enabled');
    eq(stores.get(store.id).activation_date, '2026-10-01', 'the legitimate field still went through');
  });
  await check('PUT {wholesale_enabled:false} cannot switch OFF what the admin switched ON', async () => {
    await j(`/api/admin/stores/${store.id}`, { method: 'PATCH', token: ADMIN, body: { wholesale_enabled: true } });
    const r = await j('/api/auth/license', { method: 'PUT', token: DEV, body: { wholesale_enabled: false } });
    eq(r.status, 200, 'status');
    eq(r.body?.data?.wholesale_enabled, true, 'response wholesale_enabled');
    eq(stores.get(store.id).wholesale_enabled, true, 'stored');
  });
  await check('the device-facing UPDATE never names wholesale_enabled', () => {
    const writes = seen.filter((s) => /^UPDATE stores SET/.test(s) && /RETURNING id, store_id/.test(s));
    assert(writes.length > 0, 'no device update was seen');
    for (const w of writes) {
      const set = w.slice(0, w.indexOf(' WHERE '));
      assert(!/wholesale_/.test(set), `device update wrote wholesale: ${set}`);
    }
  });

  console.log('\nThe signed blob');
  await check('signLicense does not sign wholesale_enabled (old blobs stay valid)', async () => {
    const keyFile = path.join(os.tmpdir(), `wholesale-test-${process.pid}.pem`);
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const prevKey = process.env.LICENSE_SIGNING_KEY_PATH;
    process.env.LICENSE_SIGNING_KEY_PATH = keyFile;
    let blob;
    try {
      const seal = await import('./src/services/licenseSeal.js');
      blob = seal.signLicense({ store: stores.get(store.id), license: lic.licensePayload(stores.get(store.id)) });
    } finally {
      if (prevKey === undefined) delete process.env.LICENSE_SIGNING_KEY_PATH;
      else process.env.LICENSE_SIGNING_KEY_PATH = prevKey;
      fs.rmSync(keyFile, { force: true });
    }
    assert(blob, 'nothing was signed with the throwaway key');
    const body = JSON.parse(Buffer.from(blob.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    assert(!('wholesale_enabled' in body), 'wholesale leaked into the signed payload');
  });

  console.log('\ndocExtras');
  await check('only the keys a document carries, cleaned', () => {
    deepEq(extras.docExtras('customers', {
      name: 'X', party_type: ' medical ', credit_limit: '5000', credit_days: 30, dl_numbers: '', other: 1,
    }), { party_type: 'medical', dl_numbers: null, credit_limit: 5000, credit_days: 30 }, 'customers');
    deepEq(extras.docExtras('customers', { name: 'retail only' }), {}, 'a retail customer carries none');
    eq(extras.docExtrasJson('customers', { name: 'retail only' }), null, 'no JSON for none');
    deepEq(extras.docExtras('medicines', { rate_a: 'abc', rate_b: null, rate_c: '9' }),
      { rate_a: null, rate_b: null, rate_c: 9 }, 'junk number -> null, text number -> number');
  });
  await check('a real column is never shadowed by an extra; items spread too', () => {
    const doc = extras.withDocExtras({
      id: 1, rate: 5, extra_fields: { rate: 99, buyer_gstin: 'G1' },
      items: [{ qty: 1, extra_fields: { free_qty: 2 } }, { qty: 3, extra_fields: null }],
    });
    eq(doc.rate, 5, 'column wins');
    eq(doc.buyer_gstin, 'G1', 'extra spread');
    assert(!('extra_fields' in doc), 'extra_fields left on the doc');
    eq(doc.items[0].free_qty, 2, 'item extra');
    assert(!('extra_fields' in doc.items[0]) && !('extra_fields' in doc.items[1]), 'extra_fields left on an item');
  });
  await check('every contract field has a home (column or extra)', () => {
    const want = {
      customers: ['party_type', 'dl_numbers', 'state_code', 'rate_tier', 'credit_limit', 'credit_days'],
      medicines: ['purchase_rate', 'rate_a', 'rate_b', 'rate_c'],
      sales: ['invoice_mode', 'buyer_gstin', 'buyer_dl', 'place_of_supply', 'taxable_total', 'cgst_total',
        'sgst_total', 'igst_total', 'due_date', 'transport', 'lr_no', 'eway_bill_no'],
      sales_items: ['rate_tier', 'free_qty', 'scheme_pct', 'taxable', 'gst_amt'],
      purchase_items: ['rate_a', 'rate_b', 'rate_c'],
      customer_payments: ['receipt_no'],
      supplier_payments: ['receipt_no'],
    };
    for (const [t, keys] of Object.entries(want)) {
      for (const k of keys) assert(k in extras.DOC_EXTRA_FIELDS[t], `${t}.${k} has no home`);
    }
  });

  console.log('\nPush keeps the wholesale fields');
  const client = recordingClient();
  const meta = { version: 1, updated_at: TS, device_id: 'wholesale-test-device-1' };
  const bundle = {
    customers: [
      { id: 11, name: 'Test Party Medical', party_type: 'medical', rate_tier: 'B', credit_limit: '5000', credit_days: 30, ...meta },
      { id: 12, name: 'Walk In', ...meta },
    ],
    medicines: [
      { id: 21, name: 'Test Med', stock_qty: 10, purchase_rate: 10, rate_a: 12.5, rate_b: 12, rate_c: 11.5, ...meta },
      { id: 22, name: 'Retail Med', stock_qty: 5, mrp: 20, ...meta },
    ],
    sales: [{
      id: 31, bill_no: '1/FY2026-27', fy_serial: 1, fy_start_year: 2026, bill_date: '2026-10-18', customer_id: 11,
      invoice_mode: 'wholesale', buyer_gstin: '27AAAAA0000A1Z5', place_of_supply: '27',
      taxable_total: 25, cgst_total: 1.5, sgst_total: 1.5, igst_total: 0, due_date: '2026-11-17', lr_no: 'LR1',
      items: [{
        medicine_id: 21, name: 'Test Med', qty: 2, rate: 12.5, amount: 28, batch_no: 'B1', expiry_date: '2027-12',
        hsn_code: '3004', rate_tier: 'B', free_qty: 1, scheme_pct: 5, taxable: 25, gst_amt: 3,
      }],
      ...meta,
    }],
    purchases: [{
      id: 41, purchase_no: '1/FY2026-27', purchase_date: '2026-10-18', supplier_id: 5,
      items: [{ medicine_id: 21, name: 'Test Med', qty: 10, rate: 10, rate_a: 12.5, rate_b: 12, rate_c: 11.5 }],
      ...meta,
    }],
    customer_payments: [{ id: 51, customer_id: 11, payment_date: '2026-10-18', amount: 100, receipt_no: ' R-17 ', ...meta }],
    supplier_payments: [{ id: 61, supplier_id: 5, payment_date: '2026-10-18', amount: 50, receipt_no: 'S-9', ...meta }],
    settings: [{ name: 'business_mode', value: 'wholesale' }],
  };
  let summary = null;
  let pushError = null;
  try {
    summary = await sync.applyBundleInTx(client, 900, bundle, newSyncHint(900));
  } catch (e) {
    pushError = e;
  }
  await check('the bundle applies (no document failed)', () => {
    assert(!pushError, `applyBundleInTx threw: ${pushError?.message}`);
    for (const [col, part] of Object.entries(summary)) {
      for (const r of part.results || []) assert(r.status !== 'failed', `${col}/${r.id} failed: ${r.error || r.message || ''}`);
    }
  });
  await check('customers (bulk): extra_fields merged key by key, retail row writes NULL', () => {
    const [up] = statements(client.log, /^INSERT INTO customers \(/);
    assert(up, 'no customers upsert');
    assert(/extra_fields=COALESCE\(customers\.extra_fields, '\{\}'::jsonb\) \|\| COALESCE\(EXCLUDED\.extra_fields, '\{\}'::jsonb\)/.test(up.sql),
      'customers extra_fields is not merged');
    const docs = jsonParams(up);
    deepEq(docs, [{ party_type: 'medical', rate_tier: 'B', credit_limit: 5000, credit_days: 30 }], 'extra JSON');
    // 16 params per row; the retail row's last is NULL.
    eq(up.vals.length, 32, 'two rows of 16');
    eq(up.vals[31], null, 'retail customer extra_fields');
  });
  await check('medicines: merged only for the one that carries rates', () => {
    const ups = statements(client.log, /^UPDATE medicines SET extra_fields/);
    eq(ups.length, 1, 'extra_fields updates');
    deepEq(JSON.parse(ups[0].vals[2]), { purchase_rate: 10, rate_a: 12.5, rate_b: 12, rate_c: 11.5 }, 'medicine extras');
    eq(ups[0].vals[1], 21, 'local_id');
  });
  await check('sales: header extras merged, line extras written with the line', () => {
    const [up] = statements(client.log, /^UPDATE sales SET extra_fields/);
    assert(up, 'no sales extra_fields update');
    deepEq(JSON.parse(up.vals[2]), {
      invoice_mode: 'wholesale', buyer_gstin: '27AAAAA0000A1Z5', place_of_supply: '27',
      taxable_total: 25, cgst_total: 1.5, sgst_total: 1.5, igst_total: 0, due_date: '2026-11-17', lr_no: 'LR1',
    }, 'sale extras');
    const [ins] = statements(client.log, /^INSERT INTO sales_items \(/);
    assert(/, extra_fields\)/.test(ins.sql), 'sales_items insert has no extra_fields');
    deepEq(JSON.parse(ins.vals[16]), { rate_tier: 'B', free_qty: 1, scheme_pct: 5, taxable: 25, gst_amt: 3 }, 'line extras');
    eq(ins.vals[5], 'B1', 'batch_no stays a real column');
    eq(ins.vals[7], '3004', 'hsn_code stays a real column');
  });
  await check('purchase lines keep Rate A / B / C', () => {
    const [ins] = statements(client.log, /^INSERT INTO purchase_items \(/);
    assert(ins, 'no purchase_items insert');
    deepEq(JSON.parse(ins.vals[ins.vals.length - 1]), { rate_a: 12.5, rate_b: 12, rate_c: 11.5 }, 'line extras');
  });
  await check('payments keep receipt_no (trimmed)', () => {
    const [cp] = statements(client.log, /^UPDATE customer_payments SET extra_fields/);
    const [sp] = statements(client.log, /^UPDATE supplier_payments SET extra_fields/);
    assert(cp && sp, 'missing a payment extra_fields update');
    deepEq(JSON.parse(cp.vals[2]), { receipt_no: 'R-17' }, 'customer payment');
    deepEq(JSON.parse(sp.vals[2]), { receipt_no: 'S-9' }, 'supplier payment');
  });
  await check('store setting business_mode is stored like any other setting', () => {
    const [ins] = statements(client.log, /^INSERT INTO store_settings/);
    assert(ins, 'no store_settings insert');
    eq(ins.vals[1], 'business_mode', 'name');
    eq(ins.vals[2], 'wholesale', 'value');
    eq(summary.settings?.upserted, 1, 'settings upserted');
    assert(statements(client.log, /INSERT INTO sync_changes/).some((e) => e.vals.includes('settings')),
      'no changelog entry for settings (other devices would not hear of it)');
  });
  await check('an older client that sends no wholesale keys writes no extras', async () => {
    const c2 = recordingClient();
    await sync.applyBundleInTx(c2, 900, {
      customer_payments: [{ id: 52, customer_id: 11, payment_date: '2026-10-18', amount: 10, ...meta }],
      medicines: [{ id: 23, name: 'Old Client Med', stock_qty: 1, ...meta }],
    }, newSyncHint(900));
    eq(statements(c2.log, /extra_fields/).length, 0, 'statements naming extra_fields');
  });

  console.log('\nPull hands them back as plain fields');
  await check('pullCollection customers / payments, pullDoc sales, fetchDocsByLocalIds purchases', async () => {
    pullRows = [
      [/FROM customers WHERE/, [{ id: 11, name: 'TEST PARTY MEDICAL', extra_fields: { party_type: 'medical', credit_days: 30 } }]],
      [/FROM customer_payments WHERE/, [{ id: 51, amount: 100, extra_fields: { receipt_no: 'R-17' } }]],
      [/FROM sales_items WHERE/, [{ sale_id: 7001, medicine_id: 21, qty: 2, rate: 12.5, extra_fields: { free_qty: 1, rate_tier: 'B' } }]],
      [/FROM sales WHERE/, [{ _pk: 7001, id: 31, bill_no: '1/FY2026-27', fy_start_year: 2026, extra_fields: { buyer_gstin: '27AAAAA0000A1Z5' } }]],
      [/FROM purchase_items WHERE/, [{ purchase_id: 7002, store_pk: 900, medicine_id: 21, qty: 10, unit: '10', tablets_per_stripe: 10, extra_fields: { rate_a: 12.5 } }]],
      [/FROM purchases WHERE/, [{ _pk: 7002, id: 41, purchase_no: '1/FY2026-27', fy_start_year: 2026, extra_fields: null }]],
    ];
    const cust = await sync.pullCollection(900, 'customers', { since: null });
    eq(cust[0].party_type, 'medical', 'customer party_type');
    eq(cust[0].credit_days, 30, 'customer credit_days');
    assert(!('extra_fields' in cust[0]), 'extra_fields left on a pulled customer');
    const pay = await sync.pullCollection(900, 'customer_payments', { since: null });
    eq(pay[0].receipt_no, 'R-17', 'payment receipt_no');
    const sale = await sync.pullDoc(900, 'sales', 31);
    eq(sale.buyer_gstin, '27AAAAA0000A1Z5', 'sale buyer_gstin');
    eq(sale.items[0].free_qty, 1, 'line free_qty');
    eq(sale.items[0].rate_tier, 'B', 'line rate_tier');
    assert(!('extra_fields' in sale) && !('extra_fields' in sale.items[0]), 'extra_fields left on the sale');
    const [pur] = await sync.fetchDocsByLocalIds(900, 'purchases', [41]);
    eq(pur.items[0].rate_a, 12.5, 'purchase line rate_a');
    assert(!('extra_fields' in pur), 'extra_fields left on the purchase');
  });
  await check('every pull SELECT of the five header tables names extra_fields', () => {
    const src = read('src/services/syncService.js');
    for (const t of ['customers', 'medicines', 'sales', 'customer_payments', 'supplier_payments']) {
      const re = new RegExp(`extra_fields\\s*\\r?\\n\\s*FROM ${t} WHERE store_pk=\\$1`, 'g');
      const n = (src.match(re) || []).length;
      const want = ['customer_payments', 'supplier_payments'].includes(t) ? 2 : 3;
      eq(n, want, `${t} pull SELECTs with extra_fields`);
    }
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
  await pool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
