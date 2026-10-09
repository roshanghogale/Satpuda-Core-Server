/**
 * Web logins for a shop (phase 5, owner's decisions 9 Oct 2026).
 *
 * The web is ONLINE-ONLY for good: the browser keeps no copy of the shop, every screen reads
 * and writes through this server. Each person has their own ID and password and their own
 * permissions:
 *   - the vendor admin panel creates the store OWNER login and staff logins;
 *   - the owner, signed into the web, adds staff and switches their permissions on and off.
 *
 * Passwords are stored only as scrypt hashes, the scheme Satpuda Health v3 uses on the same
 * VPS. A generated password is returned ONCE to whoever created it (admin or owner) to hand
 * over, and the login must set its own password at first sign-in. Sessions are rows here, so
 * disabling a login, resetting its password or deleting it signs it out at once.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { query, withTransaction } from '../db/pool.js';
import { AppError } from '../utils/http.js';

// ─── Permissions ──────────────────────────────────────────────────────────────

/** Every switch a staff login can have, in the order the screens show them. */
export const PERMISSIONS = [
  { key: 'billing', label: 'Billing: new sale and print', group: 'Sales' },
  { key: 'sales_view', label: 'Sales history: view and reprint', group: 'Sales' },
  { key: 'sales_edit', label: 'Sales history: edit a bill', group: 'Sales' },
  { key: 'sales_delete', label: 'Sales history: delete a bill', group: 'Sales' },
  { key: 'returns', label: 'Sales and purchase returns', group: 'Sales' },
  { key: 'purchase_view', label: 'Purchase history: view', group: 'Purchases' },
  { key: 'purchase_entry', label: 'Purchases: new entry', group: 'Purchases' },
  { key: 'purchase_edit', label: 'Purchases: edit', group: 'Purchases' },
  { key: 'purchase_delete', label: 'Purchases: delete', group: 'Purchases' },
  { key: 'inventory_view', label: 'Inventory: view', group: 'Stock' },
  { key: 'inventory_edit', label: 'Inventory: edit medicines and stock', group: 'Stock' },
  { key: 'parties', label: 'Customers and suppliers: view dues', group: 'Accounts' },
  { key: 'payments', label: 'Customers and suppliers: take / make payments', group: 'Accounts' },
  { key: 'reports', label: 'Reports (incl. GST)', group: 'Accounts' },
  { key: 'settings', label: 'Shop settings', group: 'Owner' },
  { key: 'staff', label: 'Staff logins (add, permissions, reset)', group: 'Owner' },
];
export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

/** A new staff login starts with the counter work only; the owner switches on the rest. */
export const DEFAULT_STAFF_PERMISSIONS = ['billing', 'sales_view', 'inventory_view', 'parties'];

/** Some switches need another one to be of any use; saving fills those in. */
const IMPLIES = {
  sales_edit: ['sales_view'],
  sales_delete: ['sales_view'],
  purchase_entry: ['purchase_view'],
  purchase_edit: ['purchase_view'],
  purchase_delete: ['purchase_view'],
  inventory_edit: ['inventory_view'],
  payments: ['parties'],
};

export function cleanPermissions(list) {
  const set = new Set();
  for (const k of Array.isArray(list) ? list : []) {
    const key = String(k || '').trim();
    if (!PERMISSION_KEYS.includes(key)) continue;
    set.add(key);
    for (const dep of IMPLIES[key] || []) set.add(dep);
  }
  return PERMISSION_KEYS.filter((k) => set.has(k));
}

export function effectivePermissions(user) {
  if (!user) return [];
  if (user.role === 'owner') return PERMISSION_KEYS.slice();
  return cleanPermissions(user.permissions);
}

// ─── Passwords (scrypt, as Satpuda Health v3) ─────────────────────────────────

const scrypt = promisify(crypto.scrypt);
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password).normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(String(password).normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

let _dummyHash = null;
/** Spend the same time as a real check for an unknown ID: timing must not tell which IDs exist. */
async function fakePasswordCheck(password) {
  _dummyHash ??= await hashPassword(crypto.randomBytes(12).toString('hex'));
  await verifyPassword(password || 'x', _dummyHash);
}

/** Ten characters a person can read out and type on a phone: no 0/O, 1/l/I. */
const PW_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generatePassword(len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += PW_ALPHABET[bytes[i] % PW_ALPHABET.length];
  // at least one digit, so it never looks like a word
  if (!/[2-9]/.test(out)) out = out.slice(0, -1) + PW_ALPHABET[48 + (bytes[0] % 8)];
  return out;
}

function checkNewPassword(pw) {
  const s = String(pw ?? '');
  if (s.length < 8) throw new AppError(400, 'Password must be at least 8 characters.');
  if (s.length > 200) throw new AppError(400, 'Password is too long.');
  if (!/[0-9]/.test(s) || !/[A-Za-z]/.test(s)) {
    throw new AppError(400, 'Password needs at least one letter and one number.');
  }
  return s;
}

function cleanUsername(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!name) throw new AppError(400, 'Login ID is required.');
  if (name.length < 3 || name.length > 40) throw new AppError(400, 'Login ID must be 3-40 characters.');
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new AppError(400, 'Login ID may use letters, numbers, dot, dash and underscore only.');
  }
  return name;
}

function cleanName(v) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s ? s.slice(0, 80) : null;
}

export function shapeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    store_pk: row.store_pk,
    username: row.username,
    full_name: row.full_name || '',
    role: row.role,
    permissions: effectivePermissions(row),
    is_active: row.is_active !== false,
    must_change_password: !!row.must_change_password,
    locked: !!(row.locked_until && new Date(row.locked_until).getTime() > Date.now()),
    created_by: row.created_by || '',
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  };
}

const USER_COLS = `id, store_pk, username, full_name, role, permissions, is_active, must_change_password,
  locked_until, created_by, created_at, updated_at, last_login_at`;

// ─── Managing logins (admin panel and the owner's Staff section) ──────────────

export async function listUsers(storePk) {
  const { rows } = await query(
    `SELECT ${USER_COLS} FROM web_users WHERE store_pk=$1 ORDER BY (role='owner') DESC, username`,
    [storePk],
  );
  return rows.map(shapeUser);
}

async function userInStore(storePk, id) {
  const { rows } = await query(`SELECT * FROM web_users WHERE id=$1 AND store_pk=$2`, [Number(id), storePk]);
  if (!rows[0]) throw new AppError(404, 'Login not found.');
  return rows[0];
}

/**
 * Create a login. `password` empty = generate one. The plain password is in the answer
 * once (`password`) and nowhere else: not stored, not logged.
 * `byOwner`: the web Staff section, which can only add staff (never another owner).
 */
export async function createUser(storePk, { username, full_name, role, permissions, password }, { actor, byOwner = false } = {}) {
  const uname = cleanUsername(username);
  const r = byOwner ? 'staff' : (role === 'owner' ? 'owner' : 'staff');
  const generated = !String(password ?? '');
  const plain = generated ? generatePassword() : checkNewPassword(password);
  // A staff login may carry the 'staff' switch (a manager); it still never touches an owner
  // login (updateUser / resetPassword / deleteUser refuse that from the web).
  const perms = r === 'owner' ? [] : cleanPermissions(permissions ?? DEFAULT_STAFF_PERMISSIONS);
  const hash = await hashPassword(plain);
  try {
    const { rows } = await query(
      `INSERT INTO web_users (store_pk, username, full_name, role, permissions, password_hash,
                              must_change_password, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,TRUE,$7) RETURNING ${USER_COLS}`,
      [storePk, uname, cleanName(full_name), r, JSON.stringify(perms), hash, String(actor || '').slice(0, 80) || null],
    );
    return { user: shapeUser(rows[0]), password: plain };
  } catch (err) {
    if (err && err.code === '23505') throw new AppError(409, `The login ID "${uname}" is already taken. Choose another.`);
    throw err;
  }
}

/**
 * Change a login's name, permissions, on/off switch. `byOwner` (web Staff section): an owner
 * login cannot be changed from there, and a user cannot switch themselves off.
 */
export async function updateUser(storePk, id, patch, { byOwner = false, selfId = null } = {}) {
  const row = await userInStore(storePk, id);
  if (byOwner && row.role === 'owner') throw new AppError(403, 'The owner login is managed by Satpuda support.');
  const sets = [];
  const params = [];
  if (patch.full_name !== undefined) { params.push(cleanName(patch.full_name)); sets.push(`full_name=$${params.length}`); }
  if (patch.permissions !== undefined && row.role === 'staff') {
    params.push(JSON.stringify(cleanPermissions(patch.permissions)));
    sets.push(`permissions=$${params.length}::jsonb`);
  }
  if (patch.role !== undefined && !byOwner) {
    const role = patch.role === 'owner' ? 'owner' : 'staff';
    params.push(role); sets.push(`role=$${params.length}`);
  }
  if (patch.is_active !== undefined) {
    if (selfId != null && Number(selfId) === Number(row.id) && !patch.is_active) {
      throw new AppError(400, 'You cannot switch off your own login.');
    }
    params.push(!!patch.is_active); sets.push(`is_active=$${params.length}`);
  }
  if (patch.unlock) sets.push('locked_until=NULL, failed_logins=0');
  if (!sets.length) throw new AppError(400, 'Nothing to change.');
  params.push(row.id);
  const { rows } = await query(
    `UPDATE web_users SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${params.length} RETURNING ${USER_COLS}`,
    params,
  );
  if (patch.is_active === false || patch.role !== undefined) await revokeSessions(row.id);
  return shapeUser(rows[0]);
}

/** New password for a login (generated unless given). Signs it out everywhere. */
export async function resetPassword(storePk, id, { password } = {}, { byOwner = false } = {}) {
  const row = await userInStore(storePk, id);
  if (byOwner && row.role === 'owner') throw new AppError(403, 'The owner login is managed by Satpuda support.');
  const plain = String(password ?? '') ? checkNewPassword(password) : generatePassword();
  await query(
    `UPDATE web_users SET password_hash=$2, must_change_password=TRUE, failed_logins=0, locked_until=NULL,
            updated_at=NOW() WHERE id=$1`,
    [row.id, await hashPassword(plain)],
  );
  await revokeSessions(row.id);
  return { user: shapeUser({ ...row, must_change_password: true, locked_until: null }), password: plain };
}

export async function deleteUser(storePk, id, { byOwner = false, selfId = null } = {}) {
  const row = await userInStore(storePk, id);
  if (byOwner && row.role === 'owner') throw new AppError(403, 'The owner login is managed by Satpuda support.');
  if (selfId != null && Number(selfId) === Number(row.id)) throw new AppError(400, 'You cannot delete your own login.');
  // The audit keeps the username, so who made which bill stays readable after a delete.
  await query(`DELETE FROM web_users WHERE id=$1`, [row.id]);
  return { deleted: true, username: row.username };
}

async function revokeSessions(userId) {
  await query(`UPDATE web_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
}

// ─── Signing in ───────────────────────────────────────────────────────────────

/** A session lives 12 hours from its last use, and never more than 7 days in all. */
const IDLE_MS = 12 * 3600 * 1000;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const LOCK_AFTER = 8;
const LOCK_MINUTES = 15;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

export async function login(username, password, { ip, userAgent } = {}) {
  const uname = String(username || '').trim().toLowerCase();
  const pw = String(password || '');
  const denied = new AppError(401, 'Wrong login ID or password.');
  if (!uname || !pw) throw denied;
  const { rows } = await query(
    `SELECT u.*, s.store_name, s.is_active AS store_active
       FROM web_users u JOIN stores s ON s.id=u.store_pk
      WHERE LOWER(u.username)=$1`,
    [uname],
  );
  const user = rows[0];
  if (!user) { await fakePasswordCheck(pw); throw denied; }
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    await fakePasswordCheck(pw);
    throw new AppError(429, `Too many wrong passwords. Try again after ${LOCK_MINUTES} minutes, or ask the owner to reset it.`);
  }
  if (!(await verifyPassword(pw, user.password_hash))) {
    await query(
      `UPDATE web_users SET failed_logins=failed_logins+1,
              locked_until=CASE WHEN failed_logins+1 >= $2 THEN NOW() + ($3 || ' minutes')::interval ELSE locked_until END
        WHERE id=$1`,
      [user.id, LOCK_AFTER, String(LOCK_MINUTES)],
    );
    throw denied;
  }
  if (!user.is_active) throw new AppError(403, 'This login is switched off. Ask the shop owner.');
  if (user.store_active === false) throw new AppError(403, 'This shop is switched off. Contact Satpuda support.');
  const token = crypto.randomBytes(32).toString('base64url');
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO web_sessions (user_id, token_hash, expires_at, ip, user_agent)
       VALUES ($1,$2,NOW() + ($3 || ' milliseconds')::interval,$4,$5)`,
      [user.id, sha256(token), String(MAX_AGE_MS), String(ip || '').slice(0, 64), String(userAgent || '').slice(0, 200)],
    );
    await c.query(
      `UPDATE web_users SET failed_logins=0, locked_until=NULL, last_login_at=NOW() WHERE id=$1`, [user.id],
    );
  });
  return { token, user: shapeUser(user), store_name: user.store_name };
}

export async function logout(token) {
  if (!token) return;
  await query(`UPDATE web_sessions SET revoked_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL`, [sha256(token)]);
}

/** The signed-in user behind a bearer token, loaded fresh, or null. */
export async function sessionUser(token) {
  if (!token || token.length < 20 || token.length > 200) return null;
  const { rows } = await query(
    `SELECT s.id AS session_id, s.last_seen_at, s.expires_at, u.*, st.store_name, st.store_id,
            st.is_active AS store_active
       FROM web_sessions s
       JOIN web_users u ON u.id=s.user_id
       JOIN stores st ON st.id=u.store_pk
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > IDLE_MS) {
    await query(`UPDATE web_sessions SET revoked_at=NOW() WHERE id=$1`, [row.session_id]);
    return null;
  }
  if (!row.is_active) return null;
  // Once a minute is enough to keep the idle clock honest without a write per request.
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    query(`UPDATE web_sessions SET last_seen_at=NOW() WHERE id=$1`, [row.session_id]).catch(() => {});
  }
  return row;
}

export async function changeOwnPassword(userId, current, next) {
  const { rows } = await query(`SELECT * FROM web_users WHERE id=$1`, [userId]);
  const user = rows[0];
  if (!user) throw new AppError(404, 'Login not found.');
  if (!(await verifyPassword(String(current || ''), user.password_hash))) {
    throw new AppError(400, 'The current password is not right.');
  }
  const pw = checkNewPassword(next);
  if (pw === String(current)) throw new AppError(400, 'Choose a password different from the old one.');
  await query(
    `UPDATE web_users SET password_hash=$2, must_change_password=FALSE, updated_at=NOW() WHERE id=$1`,
    [userId, await hashPassword(pw)],
  );
  return { changed: true };
}

// ─── Audit ────────────────────────────────────────────────────────────────────

export async function audit(clientOrNull, { storePk, user, action, collection = null, localId = null, refNo = null, detail = null }) {
  const run = clientOrNull ? (t, p) => clientOrNull.query(t, p) : query;
  await run(
    `INSERT INTO web_audit (store_pk, user_id, username, action, collection, local_id, ref_no, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [storePk, user?.id ?? null, user?.username ?? null, action, collection, localId, refNo,
      detail ? JSON.stringify(detail) : null],
  );
}

export async function listAudit(storePk, { limit = 200, username, collection, local_id } = {}) {
  const params = [storePk];
  let where = 'store_pk=$1';
  if (username) { params.push(String(username).toLowerCase()); where += ` AND LOWER(username)=$${params.length}`; }
  if (collection) { params.push(String(collection)); where += ` AND collection=$${params.length}`; }
  if (local_id) { params.push(Number(local_id)); where += ` AND local_id=$${params.length}`; }
  params.push(Math.max(1, Math.min(1000, Number(limit) || 200)));
  const { rows } = await query(
    `SELECT id, user_id, username, action, collection, local_id, ref_no, detail, created_at
       FROM web_audit WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}
