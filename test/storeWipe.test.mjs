// "Delete all data" of one store (services/storeWipe.js), against an in-memory database that
// answers the statements the wipe sends. Three stores; only the one asked for loses its rows,
// its export is written first, and the others are untouched.
//
//   node --test test/storeWipe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import {
  WIPE_CONFIRM,
  WIPE_TABLES,
  assertDeviceSawWipe,
  storeWipePreview,
  wipeClassification,
  wipeStoreData,
} from '../src/services/storeWipe.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

function seed() {
  const t = {
    stores: [1, 2, 3].map((id) => ({ id, store_id: `store_${id}`, store_name: `Shop ${id}`, expiry_date: '3026-01-01' })),
    store_sync_state: [1, 2, 3].map((pk) => ({ store_pk: pk, head_revision: 100 * pk, wipe_generation: 0, wipe_revision: 0 })),
    store_devices: [], sync_devices: [], store_api_tokens: [], web_users: [],
    store_settings: [], pharmacy_profiles: [], store_dropdowns: [], shelf_settings: [],
    audit_log: [], sync_check_items: [],
  };
  for (const name of WIPE_TABLES) t[name] = [];
  let id = 1;
  for (const pk of [1, 2, 3]) {
    for (const name of WIPE_TABLES) {
      if (name === 'sync_check_runs') continue;
      t[name].push({ id: id++, store_pk: pk, local_id: id, note: `${name} of ${pk}` });
      t[name].push({ id: id++, store_pk: pk, local_id: id, note: `${name} of ${pk} b` });
    }
    const run = { id: id++, store_pk: pk };
    t.sync_check_runs.push(run);
    t.sync_check_items.push({ id: id++, run_id: run.id, kind: 'stock' });
    t.store_devices.push({ store_pk: pk, device_id: `pc-${pk}`, device_name: 'Counter', device_type: 'pc' });
    t.store_devices.push({ store_pk: pk, device_id: `ph-${pk}`, device_name: 'Phone', device_type: 'android' });
    t.sync_devices.push({ id: id++, store_pk: pk, install_id: `pc-${pk}`, device_no: 1, last_seq: 40 });
    t.store_api_tokens.push({ id: id++, store_pk: pk });
    t.web_users.push({ id: id++, store_pk: pk, username: 'owner' });
    t.pharmacy_profiles.push({ store_pk: pk, name: `Shop ${pk}`, gstin: '27AAAAA0000A1Z5' });
    t.store_dropdowns.push({ store_pk: pk, villages: [] });
    t.shelf_settings.push({ store_pk: pk });
    for (const name of ['regular_meds:5', 'customer_gst:9', 'gst_filed:2026-04', 'doctor_margin_rules',
      'profile_bank_name', 'profile_bill_heading', 'bill_logo_image', 'app_login', 'billing_layout_prefs']) {
      t.store_settings.push({ id: id++, store_pk: pk, name, value: 'x' });
    }
  }
  return t;
}

/** A pool: connect() hands out a client whose BEGIN snapshots the tables and ROLLBACK puts them back. */
function fakeDb(tables, { failOn = null } = {}) {
  const db = { tables, statements: [] };
  const rowsOf = (n) => (db.tables[n] ||= []);
  async function run(sql, vals = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    db.statements.push(s);
    if (failOn && failOn.test(s)) throw new Error(`injected failure: ${s.slice(0, 40)}`);
    let m;
    if (/^ALTER TABLE store_sync_state/.test(s)) return { rows: [] };
    if (/^SELECT pg_advisory_xact_lock/.test(s)) return { rows: [] };
    if (/^SELECT current_database\(\)/.test(s)) return { rows: [{ db: 'fake' }] };
    if (/^SELECT c\.relname AS name FROM pg_class/.test(s)) {
      return { rows: vals[0].filter((n) => n in db.tables).map((name) => ({ name })) };
    }
    if (/^SELECT DISTINCT conrelid/.test(s)) {
      return { rows: Object.keys(db.tables).filter((n) => !['stores', 'audit_log', 'sync_check_items'].includes(n))
        .map((table_name) => ({ table_name })) };
    }
    if ((m = s.match(/^SELECT \* FROM stores WHERE id = \$1( FOR UPDATE)?$/))) {
      return { rows: clone(rowsOf('stores').filter((r) => r.id === Number(vals[0]))) };
    }
    if (/^INSERT INTO store_sync_state/.test(s)) {
      if (!rowsOf('store_sync_state').some((r) => r.store_pk === Number(vals[0]))) {
        rowsOf('store_sync_state').push({ store_pk: Number(vals[0]), head_revision: 0, wipe_generation: 0, wipe_revision: 0 });
      }
      return { rows: [] };
    }
    if (/^UPDATE store_sync_state SET head_revision = head_revision \+ 1/.test(s)) {
      const r = rowsOf('store_sync_state').find((x) => x.store_pk === Number(vals[0]));
      r.head_revision += 1;
      r.wipe_generation = (r.wipe_generation || 0) + 1;
      r.wipe_revision = r.head_revision;
      r.wiped_at = new Date().toISOString();
      r.wipe_request_id = vals[1];
      r.wipe_also_profile = Boolean(vals[2]);
      return { rows: [clone(r)] };
    }
    if (/^INSERT INTO audit_log/.test(s)) {
      const row = { id: rowsOf('audit_log').length + 1, actor_id: vals[0], store_pk: vals[1], action: 'store.wipe_data', meta: JSON.parse(vals[2]) };
      rowsOf('audit_log').push(row);
      return { rows: [{ id: row.id }] };
    }
    if (/^SELECT i\.\* FROM sync_check_items i JOIN sync_check_runs r/.test(s)) {
      const runs = new Set(rowsOf('sync_check_runs').filter((r) => r.store_pk === Number(vals[0])).map((r) => r.id));
      return { rows: clone(rowsOf('sync_check_items').filter((i) => runs.has(i.run_id))) };
    }
    if ((m = s.match(/^SELECT COUNT\(\*\)::int AS n FROM (\w+) WHERE store_pk = \$1$/))) {
      return { rows: [{ n: rowsOf(m[1]).filter((r) => r.store_pk === Number(vals[0])).length }] };
    }
    if ((m = s.match(/^SELECT (\*|name) FROM (\w+) WHERE store_pk = \$1( FOR UPDATE)?$/))) {
      return { rows: clone(rowsOf(m[2]).filter((r) => r.store_pk === Number(vals[0]))) };
    }
    if (/^SELECT device_id, device_name, device_type, last_seen_at FROM store_devices/.test(s)) {
      return { rows: clone(rowsOf('store_devices').filter((r) => r.store_pk === Number(vals[0]))) };
    }
    if ((m = s.match(/^DELETE FROM (\w+) WHERE store_pk = \$1( AND name = ANY\(\$2::text\[\]\))?$/))) {
      const pk = Number(vals[0]);
      const names = m[2] ? new Set(vals[1]) : null;
      const before = rowsOf(m[1]).length;
      db.tables[m[1]] = rowsOf(m[1]).filter((r) => !(r.store_pk === pk && (!names || names.has(r.name))));
      if (m[1] === 'sync_check_runs') {          // ON DELETE CASCADE
        const left = new Set(db.tables.sync_check_runs.map((r) => r.id));
        db.tables.sync_check_items = rowsOf('sync_check_items').filter((i) => left.has(i.run_id));
      }
      return { rows: [], rowCount: before - db.tables[m[1]].length };
    }
    throw new Error(`fake db: unexpected statement ${s}`);
  }
  db.query = run;
  db.connect = async () => {
    let snapshot = null;
    return {
      async query(sql, vals) {
        const s = sql.trim();
        if (s === 'BEGIN') { snapshot = clone(db.tables); return { rows: [] }; }
        if (s === 'COMMIT') { snapshot = null; return { rows: [] }; }
        if (s === 'ROLLBACK') { if (snapshot) db.tables = snapshot; snapshot = null; return { rows: [] }; }
        return run(sql, vals);
      },
      release() {},
    };
  };
  return db;
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'store-wipe-'));
const of = (db, table, pk) => (db.tables[table] || []).filter((r) => r.store_pk === pk);
const settingNames = (db, pk) => of(db, 'store_settings', pk).map((r) => r.name).sort();

test('wipes every business row of the store asked for, exports it first, leaves the others alone', async () => {
  const db = fakeDb(seed());
  const before = clone(db.tables);
  const dir = tmpDir();
  const res = await wipeStoreData(2, { confirm: WIPE_CONFIRM, requestId: 'r-1', actorId: 'admin', exportDir: dir }, { db });

  for (const t of WIPE_TABLES) {
    assert.equal(of(db, t, 2).length, 0, `${t} of store 2 must be empty`);
    for (const pk of [1, 3]) assert.deepEqual(of(db, t, pk), of({ tables: before }, t, pk), `${t} of store ${pk} untouched`);
  }
  assert.equal(db.tables.sync_check_items.filter((i) => i.run_id === before.sync_check_runs.find((r) => r.store_pk === 2).id).length, 0);
  // kept: the store, its pairings, logins, registrations, the profile and the non-data settings
  for (const t of ['stores', 'store_devices', 'sync_devices', 'store_api_tokens', 'web_users', 'pharmacy_profiles', 'store_dropdowns', 'shelf_settings']) {
    assert.deepEqual(db.tables[t], before[t], `${t} untouched`);
  }
  assert.deepEqual(settingNames(db, 2), ['app_login', 'bill_logo_image', 'billing_layout_prefs', 'profile_bank_name', 'profile_bill_heading']);
  assert.equal(settingNames(db, 1).length, 9);
  assert.equal(settingNames(db, 3).length, 9);

  // every device learns of it
  const st = db.tables.store_sync_state.find((r) => r.store_pk === 2);
  assert.equal(st.wipe_generation, 1);
  assert.equal(st.head_revision, 201);
  assert.equal(st.wipe_revision, 201);
  assert.equal(res.wipe_generation, 1);
  assert.equal(res.wipe_revision, 201);
  assert.equal(db.tables.store_sync_state.find((r) => r.store_pk === 1).wipe_generation, 0);

  // the export is on disk, readable, and holds exactly what went
  assert.ok(fs.existsSync(res.export.path));
  assert.equal(path.dirname(res.export.path), dir);
  const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(res.export.path)).toString('utf8'));
  assert.equal(payload.format, 'satpuda-store-wipe-export');
  assert.equal(payload.store.id, 2);
  assert.equal(payload.tables.sales.length, 2);
  assert.ok(payload.tables.sales.every((r) => r.store_pk === 2));
  assert.equal(payload.tables.store_settings.length, 4);
  assert.equal(payload.tables.sync_check_items.length, 1);
  assert.equal(payload.total_rows, res.total_rows);
  // the export was written before the first DELETE
  const firstDelete = db.statements.findIndex((s) => s.startsWith('DELETE FROM'));
  const lastSelect = db.statements.findLastIndex((s) => /^SELECT \* FROM pharmacy|^SELECT \* FROM store_settings/.test(s));
  assert.ok(lastSelect < firstDelete);

  const audit = db.tables.audit_log.at(-1);
  assert.equal(audit.action, 'store.wipe_data');
  assert.equal(audit.store_pk, 2);
  assert.equal(audit.meta.export_path, res.export.path);
});

test('the same request twice is one wipe', async () => {
  const db = fakeDb(seed());
  const dir = tmpDir();
  await wipeStoreData(2, { confirm: WIPE_CONFIRM, requestId: 'same', exportDir: dir }, { db });
  const again = await wipeStoreData(2, { confirm: WIPE_CONFIRM, requestId: 'same', exportDir: dir }, { db });
  assert.equal(again.repeated, true);
  assert.equal(again.wipe_generation, 1);
  assert.equal(fs.readdirSync(dir).length, 1);
  const next = await wipeStoreData(2, { confirm: WIPE_CONFIRM, requestId: 'other', exportDir: dir }, { db });
  assert.equal(next.wipe_generation, 2);
});

test('also_profile takes the profile and every settings row too', async () => {
  const db = fakeDb(seed());
  const res = await wipeStoreData(2, { confirm: WIPE_CONFIRM, alsoProfile: true, exportDir: tmpDir() }, { db });
  assert.equal(res.also_profile, true);
  assert.equal(db.tables.store_sync_state.find((r) => r.store_pk === 2).wipe_also_profile, true);
  assert.equal(of(db, 'pharmacy_profiles', 2).length, 0);
  assert.equal(of(db, 'store_dropdowns', 2).length, 0);
  assert.equal(settingNames(db, 2).length, 0);
  assert.equal(of(db, 'pharmacy_profiles', 1).length, 1);
  assert.equal(of(db, 'store_devices', 2).length, 2);
});

test('refusals change nothing and leave no file', async () => {
  for (const [opts, status] of [
    [{ confirm: 'delete all tables' }, 400],
    [{ confirm: WIPE_CONFIRM, expectStoreId: 'store_1' }, 409],
  ]) {
    const db = fakeDb(seed());
    const before = clone(db.tables);
    const dir = tmpDir();
    await assert.rejects(wipeStoreData(2, { ...opts, exportDir: dir }, { db }), (e) => e.status === status);
    assert.deepEqual(db.tables, before);
    assert.equal(fs.readdirSync(dir).length, 0);
  }
});

test('a failure in the middle rolls back and takes the export back off the disk', async () => {
  const db = fakeDb(seed(), { failOn: /^DELETE FROM sales WHERE/ });
  const before = clone(db.tables);
  const dir = tmpDir();
  await assert.rejects(wipeStoreData(2, { confirm: WIPE_CONFIRM, exportDir: dir }, { db }), /injected failure/);
  assert.deepEqual(db.tables, before);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('a push from a device that has not seen the wipe is refused', async () => {
  const db = fakeDb(seed());
  const client = await db.connect();
  assert.equal((await assertDeviceSawWipe(client, 2, undefined)).wipe_generation, 0);   // never wiped
  await wipeStoreData(2, { confirm: WIPE_CONFIRM, exportDir: tmpDir() }, { db });
  for (const seen of [undefined, null, 0, '0']) {
    await assert.rejects(assertDeviceSawWipe(client, 2, seen), (e) => e.status === 409
      && e.details.code === 'store_wiped' && e.details.wipe_generation === 1 && e.details.wipe_revision === 201
      && /^store_wiped/.test(e.message));
  }
  assert.equal((await assertDeviceSawWipe(client, 2, 1)).wipe_generation, 1);
  assert.equal((await assertDeviceSawWipe(client, 1, undefined)).wipe_generation, 0);   // another store
});

test('preview counts what would go and names the devices', async () => {
  const db = fakeDb(seed());
  const p = await storeWipePreview(2, {}, { db });
  assert.equal(p.counts.sales, 2);
  assert.equal(p.counts.store_settings, 4);
  assert.equal(p.profile_kept, true);
  assert.equal(p.devices.length, 2);
  assert.equal(p.confirm_word, WIPE_CONFIRM);
  assert.equal(db.statements.some((s) => /^DELETE|^UPDATE|^INSERT/.test(s)), false);
});

test('a store table nobody classified is named (and never deleted)', async () => {
  const tables = seed();
  tables.brand_new_feature = [{ store_pk: 2 }];
  const db = fakeDb(tables);
  const c = await wipeClassification(db);
  assert.equal(c.ok, false);
  assert.deepEqual(c.unclassified, ['brand_new_feature']);
  await wipeStoreData(2, { confirm: WIPE_CONFIRM, exportDir: tmpDir() }, { db });
  assert.equal(db.tables.brand_new_feature.length, 1);
  delete tables.brand_new_feature;
  assert.equal((await wipeClassification(fakeDb(seed()))).ok, true);
});
