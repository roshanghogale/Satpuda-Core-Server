import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config/index.js';
import { query } from '../db/pool.js';
import { AppError } from '../utils/http.js';
import { hashToken } from '../utils/fy.js';

export function signAdminToken(admin) {
  return jwt.sign(
    { typ: 'admin', sub: String(admin.id), username: admin.username },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

export function signStoreToken(store, deviceId) {
  return jwt.sign(
    {
      typ: 'store',
      sub: String(store.id),
      store_id: store.store_id,
      store_key: store.store_key,
      device_id: deviceId || null,
    },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

export async function adminLogin(username, password) {
  const { rows } = await query('SELECT * FROM admins WHERE username = $1', [username]);
  const admin = rows[0];
  if (!admin) throw new AppError(401, 'Invalid credentials');
  const match = await bcrypt.compare(password, admin.password_hash);
  if (!match) throw new AppError(401, 'Invalid credentials');
  return { admin, token: signAdminToken(admin) };
}

/** Pair device with store via android_key (SC-XXXXXXXX) */
export async function pairStore({ androidKey, storeName, deviceId, deviceType = 'pc', deviceName }) {
  const { rows } = await query(
    `SELECT * FROM stores WHERE android_key = $1`,
    [androidKey]
  );
  const store = rows[0];
  if (!store) throw new AppError(404, 'Invalid store key');
  const { assertStoreAccess } = await import('../services/licenseService.js');
  await assertStoreAccess(store);
  if (storeName) {
    const a = String(storeName).trim().toLowerCase();
    const b = String(store.store_name).trim().toLowerCase();
    if (a && b && a !== b) throw new AppError(403, 'Store name does not match key');
  }
  if (deviceId) {
    await query(
      `INSERT INTO store_devices (store_pk, device_id, device_name, device_type, last_seen_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (store_pk, device_id) DO UPDATE
         SET last_seen_at = NOW(),
             device_name = COALESCE(EXCLUDED.device_name, store_devices.device_name),
             device_type = COALESCE(EXCLUDED.device_type, store_devices.device_type)`,
      [store.id, deviceId, deviceName || null, deviceType]
    );
  }
  const token = signStoreToken(store, deviceId);
  return { store, token };
}

export function requireAuth(roles = ['admin', 'store']) {
  return async (req, _res, next) => {
    try {
      const header = req.headers.authorization || '';
      const raw = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!raw) throw new AppError(401, 'Missing authorization token');

      let payload;
      try {
        payload = jwt.verify(raw, config.jwtSecret);
      } catch {
        throw new AppError(401, 'Invalid or expired token');
      }

      if (!roles.includes(payload.typ)) throw new AppError(403, 'Forbidden');

      if (payload.typ === 'admin') {
        req.auth = { type: 'admin', adminId: Number(payload.sub), username: payload.username };
      } else if (payload.typ === 'store') {
        const { rows } = await query(
          `SELECT * FROM stores WHERE id = $1`,
          [Number(payload.sub)]
        );
        if (!rows[0]) throw new AppError(401, 'Store not found');
        const { assertStoreAccess, licensePayload } = await import('../services/licenseService.js');
        await assertStoreAccess(rows[0]);
        req.auth = {
          type: 'store',
          storePk: rows[0].id,
          storeId: rows[0].store_id,
          storeKey: rows[0].store_key,
          deviceId: payload.device_id,
          store: rows[0],
          license: licensePayload(rows[0]),
        };
        if (payload.device_id) {
          query(
            `UPDATE store_devices SET last_seen_at = NOW()
             WHERE store_pk = $1 AND device_id = $2`,
            [rows[0].id, payload.device_id]
          ).catch(() => {});
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireAdmin(req, _res, next) {
  return requireAuth(['admin'])(req, _res, next);
}

export function requireStore(req, _res, next) {
  return requireAuth(['store', 'admin'])(req, _res, next);
}

/** Store JWT without access/expiry gate — used for license status reads. */
export function requireStoreIdentity(req, _res, next) {
  return (async () => {
    try {
      const header = req.headers.authorization || '';
      const raw = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!raw) throw new AppError(401, 'Missing authorization token');
      let payload;
      try {
        payload = jwt.verify(raw, config.jwtSecret);
      } catch {
        throw new AppError(401, 'Invalid or expired token');
      }
      if (payload.typ === 'admin') {
        req.auth = { type: 'admin', adminId: Number(payload.sub), username: payload.username };
        return next();
      }
      if (payload.typ !== 'store') throw new AppError(403, 'Forbidden');
      const { rows } = await query(`SELECT * FROM stores WHERE id = $1`, [Number(payload.sub)]);
      if (!rows[0]) throw new AppError(401, 'Store not found');
      const { licensePayload } = await import('../services/licenseService.js');
      req.auth = {
        type: 'store',
        storePk: rows[0].id,
        storeId: rows[0].store_id,
        storeKey: rows[0].store_key,
        deviceId: payload.device_id,
        store: rows[0],
        license: licensePayload(rows[0]),
      };
      next();
    } catch (err) {
      next(err);
    }
  })();
}

/** Admin can pass ?store_id= or header; store token is scoped automatically */
export async function resolveStorePk(req) {
  if (req.auth?.type === 'store') return req.auth.storePk;
  const sid = req.params.storeId || req.query.store_id || req.headers['x-store-id'];
  if (!sid) throw new AppError(400, 'store_id required');
  const { rows } = await query(
    `SELECT id FROM stores WHERE store_id = $1 OR id::text = $1`,
    [String(sid)]
  );
  if (!rows[0]) throw new AppError(404, 'Store not found');
  return rows[0].id;
}

export { hashToken };
