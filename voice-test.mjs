/**
 * voice-test.mjs — the per-store "Voice assistant" switch, checked without a database.
 *
 * Run from the server folder:   node voice-test.mjs
 *
 * Touches NO database and NO network beyond 127.0.0.1. `query()` in
 * src/db/pool.js is a thin wrapper round the exported `pool`, so this file
 * replaces `pool.query` with a tiny in-memory `stores` table before anything
 * runs, then drives the REAL routers (auth + admin) over HTTP on a random local
 * port with real JWTs. The fake understands only the handful of statement
 * shapes the licence path uses and throws on anything else, so a new query on
 * this path shows up as a failure rather than as a silent empty result.
 *
 * Same style as provision-test.mjs / expiry-test.mjs in this folder.
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

// ─── fake stores table ────────────────────────────────────────────────────────
const { pool } = await import('./src/db/pool.js');

/** Column defaults as the migrated schema has them. */
const DEFAULTS = {
  app_mode: 'online', is_active: true, device_role: 'pc', notes: null,
  activation_date: null, expiry_enabled: false, expiry_date: null,
  apply_expiry_check: true, provisioned_trial: false,
  voice_enabled: false, voice_tier: 'auto',
};
const stores = new Map();
let nextId = 9001;
function insertStore(extra = {}) {
  const id = nextId++;
  const row = {
    id, store_id: `store_voice_${id}`, store_key: `Store_Voice_${id}`,
    store_name: `Voice Test ${id}`, android_key: `SC-VOICE${id}`,
    ...DEFAULTS, created_at: new Date(), updated_at: new Date(), ...extra,
  };
  stores.set(id, row);
  return row;
}

/** Split on top-level commas (COALESCE(a, $1) stays whole). */
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
  throw new Error(`fake db: unexpected statement: ${sql.slice(0, 160)}`);
};

// ─── the real routers on a local port ─────────────────────────────────────────
const { default: authRoutes } = await import('./src/routes/auth.js');
const { default: adminRoutes } = await import('./src/routes/admin.js');
const { errorMiddleware } = await import('./src/utils/http.js');
const { signAdminToken, signStoreToken } = await import('./src/middleware/auth.js');
const lic = await import('./src/services/licenseService.js');
const adminSvc = await import('./src/services/adminService.js');

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

const ADMIN = signAdminToken({ id: 1, username: 'voice-test' });
const store = insertStore();
const DEV = signStoreToken(store, 'voice-test-device-1');

try {
  console.log('\nSchema');
  await check('stores.voice_enabled is added OFF by default', () => {
    const s = read('src/db/schema.sql');
    assert(/ALTER TABLE stores ADD COLUMN IF NOT EXISTS voice_enabled BOOLEAN NOT NULL DEFAULT FALSE;/.test(s),
      'missing ALTER ... voice_enabled BOOLEAN NOT NULL DEFAULT FALSE');
  });
  await check("stores.voice_tier is added as 'auto' by default", () => {
    const s = read('src/db/schema.sql');
    assert(/ALTER TABLE stores ADD COLUMN IF NOT EXISTS voice_tier TEXT NOT NULL DEFAULT 'auto';/.test(s),
      "missing ALTER ... voice_tier TEXT NOT NULL DEFAULT 'auto'");
  });

  console.log('\nThe licence payload');
  await check('a row from before the column existed reads as OFF / auto', () => {
    const p = lic.licensePayload({ is_active: true, expiry_enabled: false, apply_expiry_check: true });
    eq(p.voice_enabled, false, 'voice_enabled');
    eq(p.voice_tier, 'auto', 'voice_tier');
  });
  await check('NULL / junk values read as OFF / auto', () => {
    const p = lic.licensePayload({ voice_enabled: null, voice_tier: 'max' });
    eq(p.voice_enabled, false, 'voice_enabled');
    eq(p.voice_tier, 'auto', 'voice_tier');
  });
  await check('a switched-on row carries through', () => {
    const p = lic.licensePayload({ voice_enabled: true, voice_tier: '3' });
    eq(p.voice_enabled, true, 'voice_enabled');
    eq(p.voice_tier, '3', 'voice_tier');
  });

  console.log('\nDefault is OFF on the wire');
  await check('GET /auth/license on a new store says voice_enabled:false, tier auto', async () => {
    const r = await j('/api/auth/license', { token: DEV });
    eq(r.status, 200, 'status');
    eq(r.body?.data?.voice_enabled, false, 'voice_enabled');
    eq(r.body?.data?.voice_tier, 'auto', 'voice_tier');
  });
  await check('admin store detail (getStore) includes both columns', async () => {
    const s = await adminSvc.getStore(String(store.id));
    eq(s.voice_enabled, false, 'voice_enabled');
    eq(s.voice_tier, 'auto', 'voice_tier');
  });
  await check('admin store list selects s.* (so both columns are listed)', () => {
    const src = read('src/services/adminService.js');
    assert(/export async function listStores\(\)[\s\S]*?SELECT s\.\*/.test(src), 'listStores no longer selects s.*');
  });

  console.log('\nPATCH /admin/stores/:id toggles it');
  await check('turn ON with level 2', async () => {
    const r = await j(`/api/admin/stores/${store.id}`, {
      method: 'PATCH', token: ADMIN, body: { voice_enabled: true, voice_tier: '2' },
    });
    eq(r.status, 200, 'status');
    eq(r.body?.data?.voice_enabled, true, 'voice_enabled');
    eq(r.body?.data?.voice_tier, '2', 'voice_tier');
  });
  await check('GET /auth/license now carries voice_enabled:true, tier 2', async () => {
    const r = await j('/api/auth/license', { token: DEV });
    eq(r.body?.data?.voice_enabled, true, 'voice_enabled');
    eq(r.body?.data?.voice_tier, '2', 'voice_tier');
  });
  await check('the cached auth row (STORE_AUTH_COLS) sees it immediately too', async () => {
    const r = await j('/api/auth/me', { token: DEV });
    eq(r.status, 200, 'status');
    eq(r.body?.data?.auth?.license?.voice_enabled, true, 'auth.license.voice_enabled');
    eq(r.body?.data?.auth?.license?.voice_tier, '2', 'auth.license.voice_tier');
  });
  await check('a numeric tier (3) is accepted and stored as "3"', async () => {
    const r = await j(`/api/admin/stores/${store.id}`, { method: 'PATCH', token: ADMIN, body: { voice_tier: 3 } });
    eq(r.status, 200, 'status');
    eq(r.body?.data?.voice_tier, '3', 'voice_tier');
  });
  await check('voice_enabled:"false" (a string) is refused, not read as true', async () => {
    const r = await j(`/api/admin/stores/${store.id}`, { method: 'PATCH', token: ADMIN, body: { voice_enabled: 'false' } });
    eq(r.status, 400, 'status');
    eq(stores.get(store.id).voice_enabled, true, 'stored value unchanged');
  });
  await check('voice_tier "4" is refused', async () => {
    const r = await j(`/api/admin/stores/${store.id}`, { method: 'PATCH', token: ADMIN, body: { voice_tier: '4' } });
    eq(r.status, 400, 'status');
    eq(stores.get(store.id).voice_tier, '3', 'stored value unchanged');
  });
  await check('turn OFF again', async () => {
    const r = await j(`/api/admin/stores/${store.id}`, { method: 'PATCH', token: ADMIN, body: { voice_enabled: false } });
    eq(r.status, 200, 'status');
    eq(r.body?.data?.voice_enabled, false, 'voice_enabled');
    const l = await j('/api/auth/license', { token: DEV });
    eq(l.body?.data?.voice_enabled, false, 'licence voice_enabled');
  });
  await check('a store token cannot use the admin PATCH', async () => {
    const r = await j(`/api/admin/stores/${store.id}`, { method: 'PATCH', token: DEV, body: { voice_enabled: true } });
    eq(r.status, 403, 'status');
    eq(stores.get(store.id).voice_enabled, false, 'stored value unchanged');
  });

  console.log('\nA device cannot set it through PUT /auth/license');
  await check('PUT {voice_enabled:true, voice_tier:"3"} leaves it OFF', async () => {
    const r = await j('/api/auth/license', {
      method: 'PUT', token: DEV, body: { voice_enabled: true, voice_tier: '3', activation_date: '2026-09-20' },
    });
    eq(r.status, 200, 'status');
    eq(r.body?.data?.voice_enabled, false, 'response voice_enabled');
    eq(stores.get(store.id).voice_enabled, false, 'stored voice_enabled');
    eq(stores.get(store.id).voice_tier, '3', 'stored voice_tier (the admin value, not the device)');
    eq(stores.get(store.id).activation_date, '2026-09-20', 'the legitimate field still went through');
  });
  await check('PUT {voice_enabled:false} cannot switch OFF what the admin switched ON', async () => {
    await j(`/api/admin/stores/${store.id}`, { method: 'PATCH', token: ADMIN, body: { voice_enabled: true, voice_tier: '1' } });
    const r = await j('/api/auth/license', { method: 'PUT', token: DEV, body: { voice_enabled: false, voice_tier: 'auto' } });
    eq(r.status, 200, 'status');
    eq(r.body?.data?.voice_enabled, true, 'response voice_enabled');
    eq(r.body?.data?.voice_tier, '1', 'response voice_tier');
    eq(stores.get(store.id).voice_enabled, true, 'stored');
  });
  await check('the device-facing UPDATE never names the voice columns', () => {
    const writes = seen.filter((s) => /^UPDATE stores SET/.test(s) && /RETURNING id, store_id/.test(s));
    assert(writes.length > 0, 'no device update was seen');
    for (const w of writes) {
      const set = w.slice(0, w.indexOf(' WHERE '));
      assert(!/voice_/.test(set), `device update wrote voice: ${set}`);
    }
  });

  console.log('\nThe signed blob');
  await check('signLicense does not sign voice fields (old blobs stay valid)', async () => {
    // A throwaway key, so this signs for real without going near the server's key.
    const keyFile = path.join(os.tmpdir(), `voice-test-${process.pid}.pem`);
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
    assert(!('voice_enabled' in body) && !('voice_tier' in body), 'voice leaked into the signed payload');
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
  await pool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
