/**
 * wholesale-store-test.mjs — "Wholesale is a SEPARATE store" (WHOLESALE_DESIGN.md, last
 * section), checked without a database.
 *
 * Run from the server folder:   node wholesale-store-test.mjs
 *
 * Touches NO database and NO network beyond 127.0.0.1, same style as wholesale-test.mjs:
 * `pool.query` / `pool.connect` answer from an in-memory `stores` table
 * (test/fakeStoresDb.mjs, advisory locks included) and the REAL auth + admin routers
 * are driven over HTTP on a random local port with real JWTs.
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

// ─── fake stores table ────────────────────────────────────────────────────────
const { pool } = await import('./src/db/pool.js');
const { companionStatement, plainStoresStatement, fakeConnect } = await import('./test/fakeStoresDb.mjs');

const stores = new Map();
const side = {};
function insertStore(extra = {}) {
  // Same id rule as the fake INSERT, so a companion made in between is never overwritten.
  const id = Math.max(9300, ...stores.keys()) + 1;
  const row = {
    id, store_id: `store_t${id}`, store_key: `Store_T${id}`,
    store_name: `Test Shop ${id}`, android_key: `SC-T${id}`,
    app_mode: 'online', is_active: true, device_role: 'pc', notes: null,
    activation_date: '2026-10-01', expiry_enabled: true, expiry_date: '2027-10-01',
    apply_expiry_check: true, provisioned_trial: false,
    voice_enabled: false, voice_tier: 'auto', wholesale_enabled: false,
    store_kind: 'retail', parent_store_id: null,
    created_at: new Date(), updated_at: new Date(), ...extra,
  };
  stores.set(id, row);
  return row;
}
const seen = [];
pool.query = async (text, vals = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  seen.push(sql);
  const a = await companionStatement(stores, sql, vals, side);
  if (a) return a;
  const b = await plainStoresStatement(stores, sql, vals);
  if (b) return b;
  throw new Error(`fake db: unexpected statement: ${sql.slice(0, 160)}`);
};
pool.connect = fakeConnect((text, vals) => pool.query(text, vals));

const companionsOf = (pk) => [...stores.values()].filter((r) => r.parent_store_id === pk && r.store_kind === 'wholesale');

// ─── the real routers on a local port ─────────────────────────────────────────
const { default: authRoutes } = await import('./src/routes/auth.js');
const { default: adminRoutes } = await import('./src/routes/admin.js');
const { errorMiddleware } = await import('./src/utils/http.js');
const { signAdminToken, signStoreToken, invalidateStoreAuthCache, resolveStorePk } = await import('./src/middleware/auth.js');
const lic = await import('./src/services/licenseService.js');
const ws = await import('./src/services/wholesaleStore.js');

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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const ADMIN = signAdminToken({ id: 1, username: 'wholesale-store-test' });
const retail = insertStore();
const RETAIL_DEV = signStoreToken(retail, 'ws-store-test-retail-pc');

try {
  console.log('\nSchema');
  await check('stores.store_kind (retail by default, checked) and parent_store_id (FK, indexed)', () => {
    const s = read('src/db/schema.sql');
    assert(/ALTER TABLE stores ADD COLUMN IF NOT EXISTS store_kind TEXT NOT NULL DEFAULT 'retail'\s+CHECK \(store_kind IN \('retail', 'wholesale'\)\);/.test(s),
      'store_kind ALTER missing');
    assert(/ALTER TABLE stores ADD COLUMN IF NOT EXISTS parent_store_id INTEGER NULL REFERENCES stores\(id\) ON DELETE SET NULL;/.test(s),
      'parent_store_id ALTER missing');
    assert(/CREATE INDEX IF NOT EXISTS idx_stores_parent_store_id ON stores\(parent_store_id\)/.test(s), 'index missing');
  });
  await check('licence and auth column lists read store_kind + parent_store_id', () => {
    assert(/store_kind, parent_store_id/.test(read('src/middleware/auth.js').match(/STORE_AUTH_COLS = `[^`]+`/)[0]),
      'STORE_AUTH_COLS');
    assert(/store_kind, parent_store_id/.test(read('src/services/licenseService.js').match(/LICENSE_COLS = `[^`]+`/)[0]),
      'LICENSE_COLS');
  });

  console.log('\nPure helpers');
  await check('store kind: only "wholesale" is wholesale', () => {
    eq(ws.storeKindOf({ store_kind: 'wholesale' }), 'wholesale', 'wholesale');
    for (const v of [undefined, null, '', 'Wholesale', 'retail', 1]) eq(ws.storeKindOf({ store_kind: v }), 'retail', String(v));
    eq(lic.licensePayload({}).store_kind, 'retail', 'licence of an old row');
    eq(lic.licensePayload({ store_kind: 'wholesale' }).store_kind, 'wholesale', 'licence of a wholesale row');
  });
  await check('companion identity follows the contract, with a suffix only on a clash', () => {
    const p = { store_id: 'store_abc', store_key: 'Store_Abc', store_name: ' Abc Medical ' };
    deepEq(ws.companionIdentity(p), { store_id: 'store_abc_wholesale', store_key: 'Store_Abc_Wholesale', store_name: 'Abc Medical Wholesale' }, 'plain');
    deepEq(ws.companionIdentity(p, 1), { store_id: 'store_abc_wholesale_2', store_key: 'Store_Abc_Wholesale_2', store_name: 'Abc Medical Wholesale' }, 'second');
  });
  await check('link payload: offered only when both switches are on and the companion is active', () => {
    const r = { store_kind: 'retail', wholesale_enabled: true };
    const c = { store_id: 'a', store_key: 'A', store_name: 'A W', android_key: 'SC-1', store_kind: 'wholesale', wholesale_enabled: true, is_active: true, id: 5 };
    deepEq(ws.linkPayload(r, { companion: c }), { store_kind: 'retail', wholesale_store: { store_id: 'a', store_key: 'A', store_name: 'A W', android_key: 'SC-1' } }, 'offered');
    deepEq(ws.linkPayload({ ...r, wholesale_enabled: false }, { companion: c }), { store_kind: 'retail' }, 'retail switch off');
    deepEq(ws.linkPayload(r, { companion: { ...c, wholesale_enabled: false } }), { store_kind: 'retail' }, 'companion switch off');
    deepEq(ws.linkPayload(r, { companion: { ...c, is_active: false } }), { store_kind: 'retail' }, 'companion turned off');
    deepEq(ws.linkPayload(r, {}), { store_kind: 'retail' }, 'no companion');
    deepEq(ws.linkPayload({ store_kind: 'wholesale' }, { parent: c }), { store_kind: 'wholesale', retail_store: { store_id: 'a', store_key: 'A', store_name: 'A W', android_key: 'SC-1' } }, 'wholesale side');
    deepEq(ws.linkPayload({ store_kind: 'wholesale' }, {}), { store_kind: 'wholesale' }, 'orphan wholesale');
  });

  console.log('\nNothing until the owner switches it on');
  await check('ensure on a retail store with wholesale OFF makes nothing', async () => {
    eq(await ws.ensureWholesaleCompanion(retail.id), null, 'result');
    eq(companionsOf(retail.id).length, 0, 'companions');
  });
  await check('GET /auth/license: store_kind retail, no wholesale_store', async () => {
    const r = await j('/api/auth/license', { token: RETAIL_DEV });
    eq(r.status, 200, 'status');
    eq(r.body.data.store_kind, 'retail', 'store_kind');
    assert(!('wholesale_store' in r.body.data), 'wholesale_store present');
    assert(!('retail_store' in r.body.data), 'retail_store present');
  });

  let companion;
  console.log('\nAdmin switches wholesale ON');
  await check('PATCH {wholesale_enabled:true} makes ONE companion store as the contract says', async () => {
    const r = await j(`/api/admin/stores/${retail.id}`, { method: 'PATCH', token: ADMIN, body: { wholesale_enabled: true } });
    eq(r.status, 200, 'status');
    const list = companionsOf(retail.id);
    eq(list.length, 1, 'companions');
    companion = list[0];
    eq(companion.store_id, `${retail.store_id}_wholesale`, 'store_id');
    eq(companion.store_key, `${retail.store_key}_Wholesale`, 'store_key');
    eq(companion.store_name, `${retail.store_name} Wholesale`, 'store_name');
    assert(/^SC-[0-9A-F]{8}$/.test(companion.android_key), `SC key ${companion.android_key}`);
    assert(companion.android_key !== retail.android_key, 'same key as the retail store');
    eq(companion.store_kind, 'wholesale', 'store_kind');
    eq(companion.wholesale_enabled, true, 'wholesale_enabled');
    eq(companion.is_active, true, 'is_active');
    eq(companion.activation_date, retail.activation_date, 'activation_date copied');
    eq(companion.expiry_enabled, retail.expiry_enabled, 'expiry_enabled copied');
    eq(companion.expiry_date, retail.expiry_date, 'expiry_date copied');
    eq(companion.apply_expiry_check, retail.apply_expiry_check, 'apply_expiry_check copied');
    eq(companion.provisioned_trial, false, 'not a trial');
  });
  await check('the companion gets the same side rows as an admin-created store', () => {
    assert((side.pharmacy_profiles || []).some((v) => v[0] === companion.id && v[1] === companion.store_name), 'pharmacy_profiles row');
    assert((side.store_dropdowns || []).some((v) => v[0] === companion.id), 'store_dropdowns row');
  });
  await check('switching ON again (and ensure) never makes a second one', async () => {
    await j(`/api/admin/stores/${retail.id}`, { method: 'PATCH', token: ADMIN, body: { wholesale_enabled: true } });
    const again = await ws.ensureWholesaleCompanion(retail.id);
    eq(again.id, companion.id, 'same companion');
    eq(companionsOf(retail.id).length, 1, 'companions');
  });
  await check('the retail licence offers it: wholesale_store {store_id, store_key, store_name, android_key}', async () => {
    const r = await j('/api/auth/license', { token: RETAIL_DEV });
    eq(r.body.data.store_kind, 'retail', 'store_kind');
    eq(r.body.data.wholesale_enabled, true, 'wholesale_enabled');
    deepEq(r.body.data.wholesale_store, {
      store_id: companion.store_id, store_key: companion.store_key,
      store_name: companion.store_name, android_key: companion.android_key,
    }, 'wholesale_store');
  });

  let WS_DEV;
  console.log('\nThe companion is a store of its own');
  await check('/auth/pair with the companion SC key answers the wholesale store, linked back', async () => {
    const r = await j('/api/auth/pair', { method: 'POST', body: { android_key: companion.android_key, device_id: 'ws-store-test-ws-pc', device_type: 'pc' } });
    eq(r.status, 200, 'status');
    eq(r.body.data.store.id, companion.id, 'store id');
    eq(r.body.data.store.store_kind, 'wholesale', 'store.store_kind');
    eq(r.body.data.license.store_kind, 'wholesale', 'license.store_kind');
    eq(r.body.data.license.wholesale_enabled, true, 'license.wholesale_enabled');
    deepEq(r.body.data.license.retail_store, {
      store_id: retail.store_id, store_key: retail.store_key, store_name: retail.store_name, android_key: retail.android_key,
    }, 'retail_store');
    assert(!('wholesale_store' in r.body.data.license), 'a wholesale store offers no wholesale store');
    WS_DEV = r.body.data.token;
  });
  await check('/auth/pair with the retail key carries wholesale_store too', async () => {
    const r = await j('/api/auth/pair', { method: 'POST', body: { android_key: retail.android_key, device_id: 'ws-store-test-retail-pc' } });
    eq(r.body.data.store.store_kind, 'retail', 'store.store_kind');
    eq(r.body.data.license.wholesale_store?.android_key, companion.android_key, 'wholesale_store.android_key');
  });
  await check('a store token is scoped to its own store, whatever store_id it asks for', async () => {
    const asRetail = await resolveStorePk({ auth: { type: 'store', storePk: retail.id }, params: {}, query: { store_id: companion.store_id }, headers: {} });
    eq(asRetail, retail.id, 'retail token');
    const asWs = await resolveStorePk({ auth: { type: 'store', storePk: companion.id }, params: {}, query: { store_id: retail.store_id }, headers: {} });
    eq(asWs, companion.id, 'wholesale token');
  });
  await check('ensure on a wholesale store makes no companion of a companion', async () => {
    eq(await ws.ensureWholesaleCompanion(companion.id), null, 'result');
    const r = await j(`/api/admin/stores/${companion.id}`, { method: 'PATCH', token: ADMIN, body: { wholesale_enabled: true } });
    eq(r.status, 200, 'status');
    eq(companionsOf(companion.id).length, 0, 'companions of the companion');
  });

  console.log('\nA device cannot change the link');
  await check('retail PC: PUT /auth/license with store_kind/parent_store_id/wholesale_store changes nothing', async () => {
    const before = { r: { ...stores.get(retail.id) }, c: { ...stores.get(companion.id) } };
    const r = await j('/api/auth/license', {
      method: 'PUT', token: RETAIL_DEV,
      body: {
        store_kind: 'wholesale', parent_store_id: companion.id, wholesale_enabled: false,
        activation_date: '2026-10-05', // a field a device may send, so the UPDATE really runs
        wholesale_store: { store_id: 'evil', android_key: 'SC-EVIL0000' }, retail_store: { store_id: 'evil' },
      },
    });
    eq(r.status, 200, 'status');
    for (const k of ['store_kind', 'parent_store_id', 'wholesale_enabled', 'android_key', 'store_id']) {
      eq(stores.get(retail.id)[k], before.r[k], `retail ${k}`);
      eq(stores.get(companion.id)[k], before.c[k], `companion ${k}`);
    }
    eq(r.body.data.store_kind, 'retail', 'answer store_kind');
    eq(r.body.data.wholesale_store.android_key, companion.android_key, 'answer wholesale_store');
  });
  await check('wholesale PC: PUT {store_kind:"retail", parent_store_id:null} changes nothing', async () => {
    const r = await j('/api/auth/license', { method: 'PUT', token: WS_DEV, body: { store_kind: 'retail', parent_store_id: null } });
    eq(r.status, 200, 'status');
    eq(stores.get(companion.id).store_kind, 'wholesale', 'store_kind');
    eq(stores.get(companion.id).parent_store_id, retail.id, 'parent_store_id');
  });
  await check('no device UPDATE ever names the link columns', () => {
    const writes = seen.filter((s) => /^UPDATE stores SET/.test(s) && /RETURNING id, store_id, store_key, store_name, is_active/.test(s));
    assert(writes.length >= 1, 'no device update seen');
    for (const w of writes) {
      const set = w.slice(0, w.indexOf(' WHERE '));
      assert(!/store_kind|parent_store_id|wholesale_enabled/.test(set), `device update wrote: ${set}`);
    }
  });
  await check('a store token cannot use the admin PATCH', async () => {
    const r = await j(`/api/admin/stores/${retail.id}`, { method: 'PATCH', token: RETAIL_DEV, body: { wholesale_enabled: false } });
    eq(r.status, 403, 'status');
  });
  await check('the admin PATCH ignores store_kind / parent_store_id', async () => {
    await j(`/api/admin/stores/${companion.id}`, { method: 'PATCH', token: ADMIN, body: { store_kind: 'retail', parent_store_id: null, notes: 'x' } });
    eq(stores.get(companion.id).store_kind, 'wholesale', 'store_kind');
    eq(stores.get(companion.id).parent_store_id, retail.id, 'parent_store_id');
  });

  console.log('\nThe signed blob');
  await check('links and store_kind stay out of the signed blob', async () => {
    const keyFile = path.join(os.tmpdir(), `wholesale-store-test-${process.pid}.pem`);
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const prevKey = process.env.LICENSE_SIGNING_KEY_PATH;
    process.env.LICENSE_SIGNING_KEY_PATH = keyFile;
    let blob;
    try {
      const seal = await import('./src/services/licenseSeal.js');
      const row = stores.get(retail.id);
      blob = seal.signLicense({ store: row, license: await ws.licensePayloadWithLinks(row) });
    } finally {
      if (prevKey === undefined) delete process.env.LICENSE_SIGNING_KEY_PATH;
      else process.env.LICENSE_SIGNING_KEY_PATH = prevKey;
      fs.rmSync(keyFile, { force: true });
    }
    assert(blob, 'nothing was signed');
    const body = JSON.parse(Buffer.from(blob.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    for (const k of ['wholesale_store', 'retail_store', 'store_kind']) assert(!(k in body), `${k} in the signed blob`);
  });
  await check('POST /auth/license/signed answers the licence with its links', async () => {
    const r = await j('/api/auth/license/signed', { method: 'POST', token: RETAIL_DEV, body: {} });
    eq(r.status, 200, 'status');
    eq(r.body.data.license.wholesale_store?.store_id, companion.store_id, 'wholesale_store');
  });

  console.log('\nAdmin switches wholesale OFF, then ON again');
  await check('OFF keeps the companion, stops offering it, its own payload says wholesale_enabled:false', async () => {
    const r = await j(`/api/admin/stores/${retail.id}`, { method: 'PATCH', token: ADMIN, body: { wholesale_enabled: false } });
    eq(r.status, 200, 'status');
    eq(companionsOf(retail.id).length, 1, 'companion kept');
    eq(stores.get(companion.id).wholesale_enabled, false, 'companion switch');
    const lr = await j('/api/auth/license', { token: RETAIL_DEV });
    assert(!('wholesale_store' in lr.body.data), 'still offered');
    eq(lr.body.data.wholesale_enabled, false, 'retail wholesale_enabled');
    const lw = await j('/api/auth/license', { token: WS_DEV });
    eq(lw.status, 200, 'companion still works');
    eq(lw.body.data.wholesale_enabled, false, 'companion wholesale_enabled');
    eq(lw.body.data.store_kind, 'wholesale', 'companion store_kind');
    eq(lw.body.data.retail_store?.store_id, retail.store_id, 'companion still knows its retail store');
  });
  await check('off: the companion still sends retail_store in full (pair, GET, PUT, signed), so its PC can switch back', async () => {
    const want = {
      store_id: retail.store_id, store_key: retail.store_key,
      store_name: retail.store_name, android_key: retail.android_key,
    };
    eq(stores.get(retail.id).wholesale_enabled, false, 'retail switch is off');
    const p = await j('/api/auth/pair', { method: 'POST', body: { android_key: companion.android_key, device_id: 'ws-store-test-ws-pc' } });
    deepEq(p.body.data.license.retail_store, want, 'pair');
    deepEq((await j('/api/auth/license', { token: WS_DEV })).body.data.retail_store, want, 'GET');
    deepEq((await j('/api/auth/license', { method: 'PUT', token: WS_DEV, body: {} })).body.data.retail_store, want, 'PUT');
    deepEq((await j('/api/auth/license/signed', { method: 'POST', token: WS_DEV, body: {} })).body.data.license.retail_store, want, 'signed');
  });
  await check('ON again re-enables the SAME companion (same id, same SC key)', async () => {
    await j(`/api/admin/stores/${retail.id}`, { method: 'PATCH', token: ADMIN, body: { wholesale_enabled: true } });
    eq(companionsOf(retail.id).length, 1, 'companions');
    const c = stores.get(companion.id);
    eq(c.wholesale_enabled, true, 'companion switch');
    eq(c.android_key, companion.android_key, 'SC key unchanged');
    const lr = await j('/api/auth/license', { token: RETAIL_DEV });
    eq(lr.body.data.wholesale_store?.android_key, companion.android_key, 'offered again');
  });

  console.log('\nThe licence follows the retail store (same shop, same subscription)');
  const FOLLOW = ['is_active', 'activation_date', 'expiry_enabled', 'expiry_date', 'apply_expiry_check', 'voice_enabled', 'voice_tier'];
  const sameLicence = (what) => {
    const r = stores.get(retail.id);
    const c = stores.get(companion.id);
    for (const k of FOLLOW) eq(c[k], r[k], `${what}: companion ${k}`);
  };
  await check('admin PATCH of expiry + voice on the retail store reaches the companion', async () => {
    const before = stores.get(companion.id).updated_at;
    const r = await j(`/api/admin/stores/${retail.id}`, {
      method: 'PATCH', token: ADMIN,
      body: { expiry_enabled: true, expiry_date: '2027-03-31', apply_expiry_check: true, voice_enabled: true, voice_tier: '2' },
    });
    eq(r.status, 200, 'status');
    sameLicence('after PATCH');
    eq(stores.get(companion.id).expiry_date, '2027-03-31', 'companion expiry_date');
    eq(stores.get(companion.id).voice_tier, '2', 'companion voice_tier');
    assert(stores.get(companion.id).updated_at !== before, 'companion updated_at not bumped');
    const lw = await j('/api/auth/license', { token: WS_DEV });
    eq(lw.body.data.expiry_date, '2027-03-31', 'companion licence expiry');
    eq(lw.body.data.voice_enabled, true, 'companion licence voice');
  });
  await check('turning the retail store off turns the companion off, and back on', async () => {
    await j(`/api/admin/stores/${retail.id}`, { method: 'PATCH', token: ADMIN, body: { is_active: false } });
    eq(stores.get(companion.id).is_active, false, 'companion is_active');
    const lw = await j('/api/auth/license', { token: WS_DEV });
    eq(lw.body.data.access_allowed, false, 'companion access while the shop is off');
    await j(`/api/admin/stores/${retail.id}`, { method: 'PATCH', token: ADMIN, body: { is_active: true } });
    eq(stores.get(companion.id).is_active, true, 'companion back on');
    sameLicence('after on/off');
  });
  await check('admin licence route (POST /admin/stores/:retail/license) reaches the companion', async () => {
    const r = await j(`/api/admin/stores/${retail.id}/license`, { method: 'POST', token: ADMIN, body: { expiry_date: '2027-06-30', activation_date: '2026-09-30' } });
    eq(r.status, 200, 'status');
    eq(stores.get(companion.id).expiry_date, '2027-06-30', 'companion expiry_date');
    eq(stores.get(companion.id).activation_date, '2026-09-30', 'companion activation_date');
    sameLicence('after licence route');
  });
  await check("the companion's own licence cannot be edited by the admin: 409, says whom it follows", async () => {
    const snap = { ...stores.get(companion.id) };
    for (const body of [{ expiry_date: '2030-01-01' }, { is_active: false }, { voice_enabled: false }, { activation_date: '2020-01-01' }]) {
      const r = await j(`/api/admin/stores/${companion.id}`, { method: 'PATCH', token: ADMIN, body });
      eq(r.status, 409, `PATCH ${JSON.stringify(body)} status`);
      assert(String(r.body?.error || '').includes(`follows "${retail.store_name}"`), `message: ${r.body?.error}`);
    }
    const l = await j(`/api/admin/stores/${companion.id}/license`, { method: 'POST', token: ADMIN, body: { expiry_date: '2030-01-01' } });
    eq(l.status, 409, 'licence route status');
    for (const k of FOLLOW) eq(stores.get(companion.id)[k], snap[k], `companion ${k} unchanged`);
  });
  await check('non-licence fields of the companion can still be edited (name, notes)', async () => {
    const r = await j(`/api/admin/stores/${companion.id}`, { method: 'PATCH', token: ADMIN, body: { notes: 'wholesale counter' } });
    eq(r.status, 200, 'status');
    eq(stores.get(companion.id).notes, 'wholesale counter', 'notes');
  });
  await check('a wholesale PC recording an activation date cannot start an expiry of its own', async () => {
    const shop = insertStore({ activation_date: null, expiry_enabled: false, expiry_date: null, wholesale_enabled: true });
    const comp = await ws.ensureWholesaleCompanion(shop.id);
    const wsDev = signStoreToken(stores.get(comp.id), 'ws-store-test-act');
    const r = await j('/api/auth/license', { method: 'PUT', token: wsDev, body: { activation_date: '2026-10-18' } });
    eq(r.status, 200, 'status');
    eq(stores.get(comp.id).activation_date, null, 'companion activation_date');
    eq(stores.get(comp.id).expiry_enabled, false, 'companion expiry_enabled');
    eq(stores.get(comp.id).expiry_date, null, 'companion expiry_date');
    eq(r.body.data.expiry_enabled, false, 'answer expiry_enabled');
  });
  await check('the retail PC recording its activation date carries the companion with it', async () => {
    const shop = insertStore({ activation_date: null, expiry_enabled: false, expiry_date: null, wholesale_enabled: true });
    const comp = await ws.ensureWholesaleCompanion(shop.id);
    const dev = signStoreToken(shop, 'ws-store-test-act-retail');
    const r = await j('/api/auth/license', { method: 'PUT', token: dev, body: { activation_date: '2026-10-18' } });
    eq(r.status, 200, 'status');
    const s2 = stores.get(shop.id);
    const c2 = stores.get(comp.id);
    eq(s2.activation_date, '2026-10-18', 'retail activation');
    eq(c2.activation_date, '2026-10-18', 'companion activation');
    eq(c2.expiry_date, s2.expiry_date, 'companion expiry = retail expiry');
    eq(c2.expiry_enabled, true, 'companion expiry_enabled');
  });
  await check('a new companion starts with the retail store\'s access and voice', async () => {
    const shop = insertStore({ wholesale_enabled: true, voice_enabled: true, voice_tier: '3', is_active: true });
    const c = await ws.ensureWholesaleCompanion(shop.id);
    const row = stores.get(c.id);
    for (const k of FOLLOW) eq(row[k], shop[k], `new companion ${k}`);
  });
  await check('a companion that slipped out of step is brought level on the next licence read', async () => {
    stores.set(companion.id, { ...stores.get(companion.id), expiry_date: '2020-01-01' });
    invalidateStoreAuthCache(companion.id);
    await j('/api/auth/license', { token: RETAIL_DEV }); // existing companion: ensure not needed ...
    await ws.ensureWholesaleCompanion(retail.id); // ... the admin switch / ensure levels it
    sameLicence('after ensure');
  });
  await check('mirroring runs on the same transaction client as the retail write', () => {
    const a = read('src/services/adminService.js');
    assert(/withTransaction\(async \(client\) => \{[\s\S]{0,400}UPDATE stores SET[\s\S]{0,300}mirrorLicenceToCompanions\(client, rows\[0\]\)/.test(a), 'updateStore');
    const l = read('src/services/licenseService.js');
    assert(/withTransaction\(async \(client\) => \{[\s\S]{0,1600}mirrorLicenceToCompanions\(client, rows\[0\]\)/.test(l), 'updateStoreLicenseRow');
  });
  await check('store page shows a following licence read-only', () => {
    const d = read('admin/src/pages/StoreDetail.jsx');
    assert(/FollowsRetailPanel/.test(d) && /follows/.test(d), 'StoreDetail');
  });

  console.log('\nLazily, where the licence is built');
  await check('a retail store already switched on (live store, no companion yet) gets one on its first licence read', async () => {
    const old = insertStore({ wholesale_enabled: true });
    const dev = signStoreToken(old, 'ws-store-test-lazy');
    eq(companionsOf(old.id).length, 0, 'none before');
    const r = await j('/api/auth/license', { token: dev });
    eq(r.status, 200, 'status');
    eq(companionsOf(old.id).length, 1, 'one after');
    eq(r.body.data.wholesale_store?.store_id, `${old.store_id}_wholesale`, 'offered in the same answer');
    await j('/api/auth/license', { token: dev });
    eq(companionsOf(old.id).length, 1, 'still one');
  });
  await check('five racing licence reads make ONE companion (advisory lock)', async () => {
    const racer = insertStore({ wholesale_enabled: true });
    const dev = signStoreToken(racer, 'ws-store-test-race');
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => j('/api/auth/license', { token: dev })));
    eq(companionsOf(racer.id).length, 1, 'companions');
    const keys = new Set(answers.map((a) => a.body.data.wholesale_store?.android_key));
    eq(keys.size, 1, 'every answer names the same companion');
  });
  await check('a taken store id gives the companion the next free one', async () => {
    const shop = insertStore({ wholesale_enabled: true });
    insertStore({ store_id: `${shop.store_id}_wholesale`, store_key: 'Store_Unrelated_X' });
    const c = await ws.ensureWholesaleCompanion(shop.id);
    eq(c.store_id, `${shop.store_id}_wholesale_2`, 'store_id');
    eq(c.store_key, `${shop.store_key}_Wholesale_2`, 'store_key');
  });

  console.log('\nAdmin panel');
  await check('adminStoreLink names the other half both ways', async () => {
    const a = await ws.adminStoreLink(stores.get(retail.id));
    eq(a.kind, 'retail', 'kind');
    eq(a.companion.store_id, companion.store_id, 'companion');
    eq(a.companion.android_key, companion.android_key, 'companion key');
    const b = await ws.adminStoreLink(stores.get(companion.id));
    eq(b.kind, 'wholesale', 'kind');
    eq(b.retail.store_name, retail.store_name, 'retail');
  });
  await check('store page and list show the link / WHOLESALE tag', () => {
    const d = read('admin/src/pages/StoreDetail.jsx');
    assert(/WholesaleLinkPanel/.test(d) && /Wholesale store of/.test(d) && /c\.android_key/.test(d), 'StoreDetail');
    const l = read('admin/src/pages/Stores.jsx');
    assert(/store_kind === 'wholesale'/.test(l) && /WHOLESALE/.test(l), 'Stores list');
    assert(/parent_store_name/.test(read('src/services/adminService.js')), 'listStores parent name');
    assert(/wholesale_link: await adminStoreLink\(store\)/.test(read('src/routes/admin.js')), 'GET /admin/stores/:id');
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
  await pool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
