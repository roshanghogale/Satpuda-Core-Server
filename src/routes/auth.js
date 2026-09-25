import { Router } from 'express';
import { asyncHandler, ok } from '../utils/http.js';
import {
  adminLogin,
  pairStore,
  requireAdmin,
  requireAuth,
  requireStoreIdentity,
} from '../middleware/auth.js';
import { healthCheck } from '../db/pool.js';
import { AppError } from '../utils/http.js';
import {
  getStoreLicense,
  getStoreRecord,
  licensePayload,
  updateStoreLicense,
} from '../services/licenseService.js';
import { sealAvailable, signLicense } from '../services/licenseSeal.js';

const router = Router();

router.get('/health', asyncHandler(async (_req, res) => {
  const db = await healthCheck();
  ok(res, { status: 'up', db, time: new Date().toISOString() });
}));

router.get('/meta', (_req, res) => {
  ok(res, {
    name: 'satpuda-core-server',
    version: '1.0.1',
    api_revision: 2,
    collections: [
      'customers', 'suppliers', 'medicines', 'doctors',
      'sales', 'purchases', 'customer_payments', 'supplier_payments',
      'sales_returns', 'purchase_returns',
      'general_products', 'stock_disposals', 'pending_orders',
      'racks', 'sections', 'boxes', 'shelves', 'medicine_shelf',
      'medicine_suppliers',
    ],
    special: ['pharmacy_profile', 'dropdowns', 'shelf_settings', 'settings'],
    global_master: '/api/master-medicines',
  });
});

router.post('/auth/admin/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  const result = await adminLogin(username, password);
  ok(res, {
    token: result.token,
    admin: { id: result.admin.id, username: result.admin.username, name: result.admin.name },
  });
}));

/** Device pairing — replaces Firebase store_keys/{SC-…} */
router.post('/auth/pair', asyncHandler(async (req, res) => {
  const { android_key, store_key, store_name, device_id, device_type, device_name } = req.body || {};
  const key = android_key || store_key;
  const result = await pairStore({
    androidKey: key,
    storeName: store_name,
    deviceId: device_id,
    deviceType: device_type || 'pc',
    deviceName: device_name,
  });
  ok(res, {
    token: result.token,
    store: {
      id: result.store.id,
      store_id: result.store.store_id,
      store_key: result.store.store_key,
      store_name: result.store.store_name,
      app_mode: result.store.app_mode,
      android_key: result.store.android_key,
    },
    license: licensePayload(result.store),
  });
}));

/** Store license / access status (Online devices; readable even if access blocked) */
router.get('/auth/license', requireStoreIdentity, asyncHandler(async (req, res) => {
  if (req.auth.type !== 'store') throw new AppError(403, 'Store token required');
  const storePk = req.auth.storePk || req.auth.store?.id;
  ok(res, await getStoreLicense(storePk));
}));

/** PC Administrator / Online activation updates license on server */
router.put('/auth/license', requireStoreIdentity, asyncHandler(async (req, res) => {
  if (req.auth.type !== 'store') throw new AppError(403, 'Store token required');
  const storePk = req.auth.storePk || req.auth.store?.id;
  // Devices may update expiry settings + record activation_date.
  // is_active is admin-panel only (turn off access from server).
  // A device may report WHEN it was activated. It must not be able to change
  // whether the licence is enforced — passing {apply_expiry_check:false} used to
  // disable expiry permanently, and requireStoreIdentity deliberately skips the
  // access gate, so even an already-expired store could un-expire itself.
  const body = { ...(req.body || {}) };
  // The voice switch is the vendor's to flip from the admin panel, never the
  // shop's (updateStoreLicenseRow ignores it anyway; this keeps it that way if
  // that function ever learns to write it).
  for (const k of ['is_active', 'expiry_enabled', 'apply_expiry_check', 'expiry_date', 'force_activation_date',
    'voice_enabled', 'voice_tier']) {
    delete body[k];
  }
  ok(res, await updateStoreLicense(storePk, body));
}));

/**
 * The SIGNED licence, for the PC that already holds this store's key.
 *
 * POST, not GET, for two reasons. The binding is a body of hashes rather than a
 * lookup key, and a hardware fingerprint has no business in an access log or a
 * proxy's URL history.
 *
 * `requireStoreIdentity`, not `requireStore`: an EXPIRED store must still be
 * able to read its own licence. Gating this behind the access check would mean
 * the one shop that most needs a fresh blob -- the one whose date the vendor has
 * just extended -- is the one that cannot fetch it.
 *
 * Nothing in the body decides what the licence SAYS. It decides only which
 * machine the answer is bound to.
 */
router.post('/auth/license/signed', requireStoreIdentity, asyncHandler(async (req, res) => {
  if (req.auth.type !== 'store') throw new AppError(403, 'Store token required');
  const storePk = req.auth.storePk || req.auth.store?.id;
  const body = req.body || {};
  const store = await getStoreRecord(storePk);
  const license = licensePayload(store);
  const signed = signLicense({
    store,
    license,
    machineId: body.machine_id,
    deviceId: body.device_id || req.auth.deviceId,
    binding: body.hw_parts,
  });
  ok(res, { license, signed, seal_available: sealAvailable() });
}));

router.get('/auth/me', requireAuth(['admin', 'store']), asyncHandler(async (req, res) => {
  ok(res, { auth: req.auth });
}));

router.get('/auth/admin/ping', requireAdmin, asyncHandler(async (req, res) => {
  ok(res, { admin: req.auth });
}));

export default router;
