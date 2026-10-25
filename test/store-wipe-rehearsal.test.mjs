// "Delete all data" against the REHEARSAL server (never live), on a THROWAWAY store only.
//
//   WIPE_TEST_BASE=http://127.0.0.1:3999 WIPE_TEST_KEY=SC-WIPET025 \
//   WIPE_TEST_ADMIN_TOKEN_FILE=<file holding a rehearsal admin JWT> node --test test/store-wipe-rehearsal.test.mjs
//
// Refuses to run unless the paired store's id starts with "wipetest_".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const BASE = (process.env.WIPE_TEST_BASE || '').replace(/\/+$/, '');
const KEY = process.env.WIPE_TEST_KEY || '';
const ADMIN = process.env.WIPE_TEST_ADMIN_TOKEN_FILE
  ? fs.readFileSync(process.env.WIPE_TEST_ADMIN_TOKEN_FILE, 'utf8').trim() : '';
const skip = !BASE || !KEY || !ADMIN || /:3000\b|satpudacore\.online/.test(BASE);

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('wipe a throwaway store on rehearsal; devices learn of it; stale pushes refused', { skip }, async () => {
  const run = Date.now().toString(36);
  const install = `wipe-rehearsal-${run}`;
  const pair = await call('POST', '/api/auth/pair', { android_key: KEY, device_id: install, device_type: 'pc' });
  assert.equal(pair.status, 200, JSON.stringify(pair.json));
  const token = pair.json.data.token;
  const store = pair.json.data.store;
  assert.match(store.store_id, /^wipetest_/, 'only a throwaway store may be wiped by this test');

  const reg = await call('POST', '/api/sync/v2/register', { install_id: install, device_type: 'pc' }, token);
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  const dev = reg.json.data;
  const gen0 = dev.wipe_generation;
  assert.equal(typeof gen0, 'number');
  const id = (n) => dev.id_base + n;
  let seq = dev.last_seq;
  const ev = (collection, doc) => ({
    seq: ++seq, event_uuid: `${install}:e${seq}`, op: 'upsert', collection, doc, base_version: 0,
  });
  const push1 = await call('POST', '/api/sync/v2/push', {
    install_id: install,
    wipe_generation: gen0,
    events: [
      ev('customers', { id: id(1), name: `Wipe cust ${run}`, phone: '9000000001' }),
      ev('medicines', { id: id(2), name: `Wipe med ${run}`, mrp: 10, stock_qty: 0 }),
    ],
  }, token);
  assert.equal(push1.status, 200, JSON.stringify(push1.json));
  assert.ok(push1.json.data.results.every((r) => r.outcome === 'applied'), JSON.stringify(push1.json.data.results));
  const kv = await call('PUT', '/api/sync/settings/kv', { settings: [
    { name: `regular_meds:${id(1)}`, value: '[1]' }, { name: 'profile_bank_name', value: 'Test Bank' },
  ] }, token);
  assert.equal(kv.status, 200, JSON.stringify(kv.json));

  const pre = await call('GET', '/api/sync/v2/store-wipe/preview', null, token);
  assert.equal(pre.status, 200, JSON.stringify(pre.json));
  assert.ok(pre.json.data.counts.customers >= 1);
  assert.ok(pre.json.data.counts.medicines >= 1);
  assert.ok(pre.json.data.devices.length >= 1);

  // refusals: no administrator, wrong word, another store's id
  assert.equal((await call('POST', '/api/sync/v2/store-wipe', { confirm: 'DELETE ALL TABLES' }, token)).status, 401);
  assert.equal((await call('POST', '/api/sync/v2/store-wipe', { confirm: 'delete', admin_token: ADMIN }, token)).status, 400);
  assert.equal((await call('POST', '/api/sync/v2/store-wipe',
    { confirm: 'DELETE ALL TABLES', admin_token: ADMIN, store_id: 'v2test' }, token)).status, 409);
  // an admin token alone (no store token) cannot pick a store
  assert.equal((await call('POST', '/api/sync/v2/store-wipe', { confirm: 'DELETE ALL TABLES', admin_token: ADMIN }, ADMIN)).status, 403);
  const still = await call('GET', '/api/sync/v2/store-wipe/preview', null, token);
  assert.equal(still.json.data.counts.customers, pre.json.data.counts.customers);

  const requestId = `req-${run}`;
  const wipe = await call('POST', '/api/sync/v2/store-wipe', {
    confirm: 'DELETE ALL TABLES', admin_token: ADMIN, request_id: requestId, store_id: store.store_id,
  }, token);
  assert.equal(wipe.status, 200, JSON.stringify(wipe.json));
  const w = wipe.json.data;
  assert.equal(w.wiped, true);
  assert.equal(w.wipe_generation, gen0 + 1);
  assert.ok(w.export.path.includes('store-wipes'));
  assert.ok(w.counts.customers >= 1);
  console.log('export:', w.export.path, w.export.bytes, 'bytes');

  const again = await call('POST', '/api/sync/v2/store-wipe', {
    confirm: 'DELETE ALL TABLES', admin_token: ADMIN, request_id: requestId,
  }, token);
  assert.equal(again.json.data.repeated, true);
  assert.equal(again.json.data.wipe_generation, w.wipe_generation);

  // every way a device looks at the store says so
  const st = (await call('GET', '/api/sync/status', null, token)).json.data;
  assert.equal(st.wipe_generation, w.wipe_generation);
  assert.equal(st.wipe_revision, w.wipe_revision);
  const page = (await call('GET', '/api/sync/changes/full?after=0&limit=50', null, token)).json.data;
  assert.equal(page.wipe_generation, w.wipe_generation);
  assert.equal(page.changes.length, 0);
  const reg2 = (await call('POST', '/api/sync/v2/register', { install_id: install }, token)).json.data;
  assert.equal(reg2.wipe_generation, w.wipe_generation);
  assert.equal(reg2.last_seq, seq, 'the device keeps its event numbers');
  assert.deepEqual(reg2.open_blocks, []);

  // the store is empty; the profile row stays, the shop-data setting goes
  const after = (await call('GET', '/api/sync/v2/store-wipe/preview', null, token)).json.data;
  assert.equal(after.counts.customers, 0);
  assert.equal(after.counts.medicines, 0);
  assert.equal(after.counts.sync_changes, 0);
  const kvAfter = (await call('GET', '/api/sync/settings/kv', null, token)).json.data;
  const names = (Array.isArray(kvAfter) ? kvAfter : kvAfter.settings || []).map((r) => r.name);
  assert.ok(names.includes('profile_bank_name'));
  assert.ok(!names.includes(`regular_meds:${id(1)}`));

  // an outbox from before the wipe is refused; after catching up the device carries on
  const stale = await call('POST', '/api/sync/v2/push', {
    install_id: install, events: [ev('customers', { id: id(3), name: 'stale' })],
  }, token);
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /^store_wiped/);
  assert.equal(stale.json.details.code, 'store_wiped');
  seq -= 1;
  const fresh = await call('POST', '/api/sync/v2/push', {
    install_id: install, wipe_generation: w.wipe_generation,
    events: [ev('customers', { id: id(4), name: `After wipe ${run}` })],
  }, token);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.json));
  assert.equal(fresh.json.data.results[0].outcome, 'applied');
  const page2 = (await call('GET', `/api/sync/changes/full?after=${w.wipe_revision}&limit=50`, null, token)).json.data;
  assert.deepEqual(page2.changes.map((c) => c.local_id), [id(4)]);

  // bill numbers start again at 1
  const blk = (await call('POST', '/api/sync/v2/number-block',
    { install_id: install, kind: 'sales', fy_start_year: 2026, size: 10 }, token)).json.data;
  assert.equal(blk.from_serial, 1);
});
