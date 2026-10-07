import { Router } from 'express';
import { asyncHandler, ok } from '../utils/http.js';
import { requireStore, resolveStorePk } from '../middleware/auth.js';
import {
  deviceStatus,
  listDevices,
  listFlags,
  pushEvents,
  registerDevice,
  reserveNumberBlock,
  resolveFlag,
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
  }));
}));

router.post('/push', asyncHandler(async (req, res) => {
  const b = req.body || {};
  ok(res, await pushEvents(await resolveStorePk(req), { installId: b.install_id, events: b.events }));
}));

router.get('/status', asyncHandler(async (req, res) => {
  ok(res, await deviceStatus(await resolveStorePk(req), req.query.install_id));
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

export default router;
