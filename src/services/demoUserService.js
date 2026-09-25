import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { query } from '../db/pool.js';
import { AppError } from '../utils/http.js';

/**
 * Logins for the sales demonstration site.
 *
 * Deliberately its own table and its own token type. A demo account is not a
 * store device and not an administrator: it can open the demonstration copy of
 * the desktop UI and nothing else. The demo site answers every /api/ call
 * inside the browser from a recorded, redacted snapshot, so even a stolen demo
 * login reaches no shop's data -- but the owner still wants to hand each sales
 * person their own id, so that access can be withdrawn one person at a time.
 */

const TOKEN_TYPE = 'demo';

/**
 * How long a signed-in demo may keep FETCHING FILES. It is not what makes the
 * demo ask for the password again -- consumeDemoEntry below does that, and it
 * fires on every page load.
 *
 * This window only has to outlast one demonstration, because the React app
 * lazy-loads chunks (billing, settings) the first time a screen is opened. If
 * this expired mid-demo, clicking Settings after forty minutes would fetch a
 * chunk, get 401, and show a broken screen.
 */
const ASSET_WINDOW_MINUTES = 120;

/**
 * Sessions minted before this instant are refused, whatever their expiry says.
 *
 * Changing the rules above does nothing to the tokens already sitting in
 * people's browsers -- the twelve-hour disk cookies kept working and the demo
 * still did not ask. This retires every one of them at once. Move it forward
 * again if a demo login is ever misused and everyone must sign in afresh.
 */
const SESSION_EPOCH_MS = Date.parse('2026-09-07T16:09:00Z');

export const DEMO_COOKIE = 'satpuda_demo';

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name || '',
    is_active: row.is_active !== false,
    note: row.note || '',
    created_at: row.created_at,
    last_login_at: row.last_login_at,
    login_count: Number(row.login_count || 0),
  };
}

function cleanUsername(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!name) throw new AppError(400, 'Username is required.');
  if (name.length < 3 || name.length > 40) {
    throw new AppError(400, 'Username must be 3-40 characters.');
  }
  if (!/^[a-z0-9._-]+$/.test(name)) {
    throw new AppError(400, 'Username may use letters, numbers, dot, dash and underscore only.');
  }
  return name;
}

function checkPassword(value) {
  const pw = String(value || '');
  // Short enough for someone to type on a phone at a counter, long enough not
  // to fall to the first guess. The demo holds no shop data either way.
  if (pw.length < 6) throw new AppError(400, 'Password must be at least 6 characters.');
  if (pw.length > 200) throw new AppError(400, 'Password is too long.');
  return pw;
}

export async function listDemoUsers() {
  const { rows } = await query(
    `SELECT id, username, name, is_active, note, created_at, last_login_at, login_count
       FROM demo_users ORDER BY username`,
  );
  return { rows: rows.map(shape) };
}

export async function createDemoUser({ username, password, name, note }) {
  const uname = cleanUsername(username);
  const pw = checkPassword(password);
  const hash = await bcrypt.hash(pw, 12);
  try {
    const { rows } = await query(
      `INSERT INTO demo_users (username, password_hash, name, note)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, name, is_active, note, created_at, last_login_at, login_count`,
      [uname, hash, String(name || '').trim() || null, String(note || '').trim() || null],
    );
    return shape(rows[0]);
  } catch (err) {
    if (err && err.code === '23505') {
      throw new AppError(409, `A demo login named "${uname}" already exists.`);
    }
    throw err;
  }
}

export async function updateDemoUser(id, { name, note, is_active, password }) {
  const sets = [];
  const params = [];
  if (name !== undefined) {
    params.push(String(name || '').trim() || null);
    sets.push(`name = $${params.length}`);
  }
  if (note !== undefined) {
    params.push(String(note || '').trim() || null);
    sets.push(`note = $${params.length}`);
  }
  if (is_active !== undefined) {
    params.push(!!is_active);
    sets.push(`is_active = $${params.length}`);
  }
  if (password !== undefined && String(password || '') !== '') {
    params.push(await bcrypt.hash(checkPassword(password), 12));
    sets.push(`password_hash = $${params.length}`);
  }
  if (!sets.length) throw new AppError(400, 'Nothing to change.');
  params.push(Number(id));
  const { rows } = await query(
    `UPDATE demo_users SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING id, username, name, is_active, note, created_at, last_login_at, login_count`,
    params,
  );
  if (!rows.length) throw new AppError(404, 'Demo login not found.');
  return shape(rows[0]);
}

export async function deleteDemoUser(id) {
  const { rowCount } = await query('DELETE FROM demo_users WHERE id = $1', [Number(id)]);
  if (!rowCount) throw new AppError(404, 'Demo login not found.');
  return { deleted: true };
}

/** Verify a login and return a signed demo session token. */
export async function demoLogin(username, password) {
  const uname = String(username || '').trim().toLowerCase();
  const pw = String(password || '');
  // One message for every failure: a different answer for "no such user" tells
  // an outsider which names exist.
  const denied = new AppError(401, 'Wrong id or password.');
  if (!uname || !pw) throw denied;
  const { rows } = await query('SELECT * FROM demo_users WHERE username = $1', [uname]);
  const user = rows[0];
  if (!user) {
    // Spend the time anyway: answering an unknown name faster than a wrong
    // password is itself an answer.
    await bcrypt.compare(pw, '$2a$12$0000000000000000000000000000000000000000000000000000');
    throw denied;
  }
  const match = await bcrypt.compare(pw, user.password_hash);
  if (!match) throw denied;
  if (user.is_active === false) {
    throw new AppError(403, 'This demo login has been switched off. Ask the office to turn it back on.');
  }
  await query(
    `UPDATE demo_users SET last_login_at = NOW(), login_count = COALESCE(login_count, 0) + 1
      WHERE id = $1`,
    [user.id],
  );
  const token = jwt.sign(
    { typ: TOKEN_TYPE, sub: String(user.id), username: user.username, jti: randomUUID() },
    config.jwtSecret,
    { expiresIn: `${ASSET_WINDOW_MINUTES}m` },
  );
  return { token, user: shape(user), assetWindowMinutes: ASSET_WINDOW_MINUTES };
}

/**
 * Entry tokens already spent. A demo sign-in opens the page ONCE.
 *
 * The owner's rule is that the demo asks for the id and the password every
 * time, and no cookie lifetime can deliver that: a session cookie survives a
 * reload, and Chrome restores session cookies when the browser reopens. So the
 * server spends the ticket instead. The first page load consumes it; the next
 * one -- a reload, a second tab, F5 -- finds it spent and gets the sign-in form.
 *
 * Only NAVIGATIONS consume (see isDemoPageLoad in index.js). The app's own
 * asset and lazy-chunk requests do not, or the page would break as it loaded.
 *
 * In memory on purpose: one process, and a restart simply means everyone signs
 * in again, which is the direction this whole change points.
 */
const spentEntries = new Map();

/**
 * There are TWO products to demonstrate now -- the shop software and the
 * hospital software -- and the sales person picks between them after signing
 * in. One sign-in therefore carries one ticket PER PRODUCT: opening the shop
 * demo does not spend the hospital one, and a reload of either still asks for
 * the password again, which is the rule the owner set.
 */
export function consumeDemoEntry(payload, product = 'medical') {
  const id = payload && payload.jti;
  // A token minted before jti existed cannot be tracked, so it is not allowed
  // to open a page at all -- it would otherwise be an unlimited pass.
  if (!id) return false;
  const key = `${id}:${String(product || 'medical')}`;
  const now = Date.now();
  if (spentEntries.size > 1000) {
    for (const [k, exp] of spentEntries) if (exp <= now) spentEntries.delete(k);
  }
  if (spentEntries.has(key)) return false;
  spentEntries.set(key, (payload.exp ? payload.exp * 1000 : now + ASSET_WINDOW_MINUTES * 60000));
  return true;
}

/** Read the demo cookie off a request. Returns the payload, or null. */
export function readDemoSession(req) {
  const raw = String(req.headers.cookie || '');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== DEMO_COOKIE) continue;
    try {
      const payload = jwt.verify(decodeURIComponent(part.slice(eq + 1).trim()), config.jwtSecret);
      if (!payload || payload.typ !== TOKEN_TYPE) return null;
      // Retire everything minted under the old twelve-hour rules.
      if (!payload.iat || payload.iat * 1000 < SESSION_EPOCH_MS) return null;
      return payload;
    } catch {
      return null;
    }
  }
  return null;
}
