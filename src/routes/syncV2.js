import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { AppError, asyncHandler, ok } from '../utils/http.js';
import { announceWipe, storeWipePreview, wipeStoreData } from '../services/storeWipe.js';
import { requireStore, resolveStorePk } from '../middleware/auth.js';
import {
  deviceStatus,
  listDevices,
  listFlags,
  numberHead,
  pushEvents,
  registerDevice,
  reserveNumberBlock,
  resolveFlag,
  stockNow,
} from '../services/syncV2.js';

/** Offline-first sync v2 (services/syncV2.js). Mounted before /api/sync, whose
 *  /:collection routes would otherwise read "v2" as a collection name. */
const router = Router();
router.use(requireStore);

router.post('/register', asyncHandler(async (req, res) => {
  const b = req.body || {};
  ok(res, await registerDevice(await resolveStorePk(req), {
    installId: b.install_id,
    deviceType: b.device_type,
    deviceName: b.device_name,
    appVersion: b.app_version,
  }));
}));

router.post('/number-block', asyncHandler(async (req, res) => {
  const b = req.body || {};
  ok(res, await reserveNumberBlock(await resolveStorePk(req), {
    installId: b.install_id,
    kind: b.kind,
    fyStartYear: b.fy_start_year,
    size: b.size,
    pairedId: req.auth?.deviceId,
  }));
}));

/** Are the numbers left in this device's blocks still free on the server? Read-only:
 *  GET /number-head?fy=2026&sales=51-200&purchases=11-50 (services/syncV2.js numberHead). */
router.get('/number-head', asyncHandler(async (req, res) => {
  ok(res, await numberHead(await resolveStorePk(req), {
    fyStartYear: req.query.fy,
    sales: req.query.sales,
    purchases: req.query.purchases,
  }));
}));

router.post('/push', asyncHandler(async (req, res) => {
  const b = req.body || {};
  ok(res, await pushEvents(await resolveStorePk(req), {
    installId: b.install_id,
    events: b.events,
    wipeGeneration: b.wipe_generation,
    pairedId: req.auth?.deviceId,
  }));
}));

router.get('/status', asyncHandler(async (req, res) => {
  ok(res, await deviceStatus(await resolveStorePk(req), req.query.install_id, req.auth?.deviceId));
}));

router.post('/stock', asyncHandler(async (req, res) => {
  const ids = (req.body || {}).ids;
  ok(res, await stockNow(await resolveStorePk(req), Array.isArray(ids) ? ids : null));
}));

router.get('/devices', asyncHandler(async (req, res) => {
  ok(res, await listDevices(await resolveStorePk(req)));
}));

router.get('/flags', asyncHandler(async (req, res) => {
  ok(res, await listFlags(await resolveStorePk(req), {
    open: req.query.all !== '1',
    limit: req.query.limit,
  }));
}));

router.post('/flags/:id/resolve', asyncHandler(async (req, res) => {
  ok(res, await resolveFlag(await resolveStorePk(req), req.params.id, (req.body || {}).note));
}));

/**
 * "Delete all data" (services/storeWipe.js). The store is the one in the caller's STORE token --
 * never a body field, so a device can only ever wipe its own store -- and the caller must also
 * hand over a vendor ADMINISTRATOR token (admin_token): a shop device alone, whose store token
 * sits on every PC and phone of the shop, cannot wipe the server.
 */
function wipeCaller(req) {
  if (req.auth?.type !== 'store') {
    throw new AppError(403, 'Delete all data is sent by a device of the store, with its store token');
  }
  return req.auth.storePk;
}

function adminFromBody(req) {
  const raw = String((req.body || {}).admin_token || '').trim();
  if (!raw) {
    throw new AppError(401, 'The Satpuda administrator sign-in is needed to delete all data', {
      code: 'admin_credential_required',
    });
  }
  let payload;
  try {
    payload = jwt.verify(raw, config.jwtSecret);
  } catch {
    throw new AppError(401, 'The administrator sign-in has expired; sign in again', {
      code: 'admin_credential_required',
    });
  }
  if (payload?.typ !== 'admin') throw new AppError(403, 'An administrator sign-in is needed');
  return payload.username || String(payload.sub || '');
}

/** What would go, and which devices it reaches. Read-only; the store token is enough. */
router.get('/store-wipe/preview', asyncHandler(async (req, res) => {
  const pk = wipeCaller(req);
  const also = req.query.also_profile === '1' || req.query.also_profile === 'true';
  ok(res, await storeWipePreview(pk, { alsoProfile: also }));
}));

router.post('/store-wipe', asyncHandler(async (req, res) => {
  const pk = wipeCaller(req);
  const actor = adminFromBody(req);
  const b = req.body || {};
  const result = await wipeStoreData(pk, {
    confirm: b.confirm,
    alsoProfile: b.also_profile === true || b.also_profile === 'true' || b.also_profile === 1,
    requestId: b.request_id,
    expectStoreId: b.store_id,
    actorId: actor,
    deviceId: req.auth?.deviceId || null,
  });
  await announceWipe(pk, result);
  ok(res, result);
}));

export default router;
