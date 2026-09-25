import { Router } from 'express';
import fs from 'fs';
import { asyncHandler, ok, AppError } from '../utils/http.js';
import { requireAdmin } from '../middleware/auth.js';
import * as admin from '../services/adminService.js';
import * as master from '../services/masterMedicineService.js';
import * as demoUsers from '../services/demoUserService.js';
import * as provisions from '../services/provisionService.js';
import { query } from '../db/pool.js';

const router = Router();
router.use(requireAdmin);

router.get('/overview', asyncHandler(async (_req, res) => {
  ok(res, await admin.platformOverview());
}));

router.get('/stores', asyncHandler(async (_req, res) => {
  ok(res, await admin.listStores());
}));

router.post('/stores', asyncHandler(async (req, res) => {
  ok(res, await admin.createStore(req.body || {}));
}));

router.get('/stores/:id', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  const dash = await admin.storeDashboard(store.id);
  const profile = await query(`SELECT * FROM pharmacy_profiles WHERE store_pk=$1`, [store.id]);
  const devices = await query(
    `SELECT device_id, device_name, device_type, last_seen_at, created_at
     FROM store_devices WHERE store_pk=$1 ORDER BY last_seen_at DESC NULLS LAST`,
    [store.id]
  );
  const { getAdminSyncOverview } = await import('../services/syncRevision.js');
  const sync = await getAdminSyncOverview(store.id);
  ok(res, {
    store,
    profile: profile.rows[0] || null,
    devices: devices.rows,
    dashboard: dash,
    sync,
  });
}));

/** B4.3: revision / device lag / recent sync_changes */
router.get('/stores/:id/sync', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  const { getAdminSyncOverview } = await import('../services/syncRevision.js');
  ok(res, await getAdminSyncOverview(store.id));
}));

router.patch('/stores/:id', asyncHandler(async (req, res) => {
  ok(res, await admin.updateStore(req.params.id, req.body || {}));
}));

router.post('/stores/:id/regenerate-key', asyncHandler(async (req, res) => {
  ok(res, await admin.regenerateAndroidKey(req.params.id));
}));

// ─── Deleting a store ─────────────────────────────────────────────────────────
// The owner cannot remove his dummy test stores from the panel, because nothing
// in this product has ever been able to. See src/services/storeDelete.js for
// what makes this safe to expose; the short version is that the DELETE is
// guarded by a typed store name, refused for a store with recent BUSINESS
// activity unless forced, preceded by a gzipped per-store export, and recorded
// in audit_log.
//
// Both are behind the router-level requireAdmin at the top of this file. That
// matters more here than anywhere else in the file: per memory
// shop-pcs-log-in-as-vendor-admin, the vendor admin credential is bundled into
// the desktop build, so any shop PC holds something that can reach this route.
// The typed name, the guards and the export are what stand between that and a
// lost shop, and they are the reason the credential needs rotating.

/**
 * What a deletion would remove, and what the store last DID. Read-only.
 *
 * `recent_days` widens or narrows the "recent activity" window for LOOKING
 * only, clamped to 1-365. The delete below deliberately does not take it.
 */
/**
 * Store delete is OFF unless the owner has switched it on, from the server itself.
 *
 * requireAdmin alone is not enough for a route that destroys a shop: the vendor
 * administrator's username and password are compiled into the desktop builds
 * already installed in shops (v1.0.1, v1.0.2), and they still match the live
 * `admins` row. Anyone holding one of those installs can sign in as the vendor --
 * and, from the 2026-09-16 admin deploy, would have been able to delete any store.
 *
 * The switch is a file that only someone with a shell on this server can create:
 *     touch /opt/Satpuda-Core-Server/.store-delete-enabled
 * It is honoured for two hours from the moment it was written, then ignored, so a
 * switch left on by mistake closes by itself. No password in any build can open it.
 * Rotating the admin password (after every shop has a build without it) is still
 * the real fix; this keeps the destructive route shut until then.
 */
// The path can only be moved by the server's own environment (tests use a temp file);
// nothing a client sends can change it.
const STORE_DELETE_SWITCH = process.env.STORE_DELETE_SWITCH || '/opt/Satpuda-Core-Server/.store-delete-enabled';
const STORE_DELETE_WINDOW_MS = 2 * 60 * 60 * 1000;

function storeDeleteSwitchedOn() {
  try {
    const st = fs.statSync(STORE_DELETE_SWITCH);
    return Date.now() - st.mtimeMs <= STORE_DELETE_WINDOW_MS;
  } catch {
    return false;
  }
}

function requireStoreDeleteSwitch(_req, _res, next) {
  if (storeDeleteSwitchedOn()) return next();
  return next(new AppError(
    403,
    'Store delete is switched off on this server. Turn it on over SSH for two hours: '
      + 'touch /opt/Satpuda-Core-Server/.store-delete-enabled',
  ));
}

router.get('/stores/:id/delete-preview', requireStoreDeleteSwitch, asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  const { storeDeleteReport } = await import('../services/storeDelete.js');
  const asked = Number(req.query.recent_days);
  const recentDays = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 365) : 30;
  ok(res, await storeDeleteReport(store.id, { recentDays }));
}));

/**
 * Delete the store. POST, not DELETE, so the confirmation body is never at the
 * mercy of a proxy that strips bodies from DELETE requests.
 *
 * Body: { confirm_name, force, clear_trial_throttle }
 *   400  confirm_name missing or not the store's name  (never overridable)
 *   409  the store still looks active and force was not set
 *
 * The activity window is fixed at the service's own 30 days and is NOT a body
 * parameter. Letting a caller send recent_days=1 would be a second way past the
 * guards -- a force that is not recorded as one. `force` is the only way past,
 * and it lands in the audit row.
 */
router.post('/stores/:id/delete', requireStoreDeleteSwitch, asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  const body = req.body || {};
  const { deleteStore } = await import('../services/storeDelete.js');
  ok(res, await deleteStore(store.id, {
    confirmName: body.confirm_name,
    force: body.force === true || body.force === 'true' || body.force === 1 || body.force === '1',
    clearTrialThrottle: body.clear_trial_throttle === true
      || body.clear_trial_throttle === 'true'
      || body.clear_trial_throttle === 1
      || body.clear_trial_throttle === '1',
    actorId: req.auth?.username || (req.auth?.adminId != null ? String(req.auth.adminId) : null),
  }));
}));

/**
 * Set a store's expiry AND hand back the signed blob for one machine — one call.
 *
 * This is what the desktop's own Administrator screen calls. It is on the ADMIN
 * router, behind `requireAdmin`, and that placement is the entire security
 * argument: the vendor types their administrator password at the moment of the
 * edit, and nothing that authorises this is compiled into a build a shopkeeper
 * can open. A store token cannot reach here, which is why `PUT /auth/license`
 * still strips every expiry field from a device's own request and must keep
 * doing so — a shop must never be able to extend itself.
 *
 * ONE CALL, on purpose. The record and the blob are written from the same UPDATE
 * (`updateStoreLicenseRow` returns the row it just wrote and the blob is signed
 * from that row), so the server's record and the file on the shop's PC cannot
 * describe two different licences. If this call does not reach the server, the
 * desktop changes nothing at all — there is no local-only path to an expiry any
 * more.
 */
router.post('/stores/:id/license', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  const body = req.body || {};
  const patch = {};
  for (const k of ['is_active', 'expiry_enabled', 'apply_expiry_check', 'expiry_date']) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (body.activation_date !== undefined) {
    patch.activation_date = body.activation_date;
    // An administrator saying "this shop activated on the 4th" means it, and is
    // the only caller allowed to move a date that is already set.
    patch.force_activation_date = true;
  }
  const { updateStoreLicenseRow, licensePayload } = await import('../services/licenseService.js');
  const { signLicense, sealAvailable } = await import('../services/licenseSeal.js');
  const row = await updateStoreLicenseRow(store.id, patch);
  const license = licensePayload(row);
  ok(res, {
    license,
    signed: signLicense({
      store: row,
      license,
      machineId: body.machine_id,
      deviceId: body.device_id,
      binding: body.hw_parts,
    }),
    seal_available: sealAvailable(),
    store_id: row.store_id,
  });
}));

/**
 * The public half of the licence signing key, so a build can be given one.
 *
 * Admin-only, though the value is not a secret — it is the key that VERIFIES.
 * It is here so that whoever builds the desktop can read the exact key the
 * server is signing with instead of copying it by hand off a terminal and
 * getting one character wrong.
 */
router.get('/license-key', asyncHandler(async (_req, res) => {
  const { publicKeyPem, signingKid, sealAvailable } = await import('../services/licenseSeal.js');
  ok(res, {
    seal_available: sealAvailable(),
    kid: signingKid(),
    public_key_pem: publicKeyPem(),
  });
}));

// ─── Self-service trials ──────────────────────────────────────────────────────
// /api/provision/trial is public, so these are the owner's window onto it: what
// was signed up, from which computer and address, and the switch that turns one
// off. Killing a trial is the PATCH above with {is_active:false} -- the panel's
// Turn off button sends exactly that, and requireAuth's 45-second store cache is
// invalidated by updateStoreLicense, so an Online PC is blocked within a minute.

router.get('/provisions', asyncHandler(async (req, res) => {
  ok(res, await provisions.listProvisions({ limit: req.query.limit }));
}));

/** Open or close the public sign-up itself. Takes effect within ten seconds. */
router.put('/provisions/enabled', asyncHandler(async (req, res) => {
  ok(res, await provisions.setTrialsEnabled(Boolean((req.body || {}).enabled)));
}));

/** Let one computer start a trial again -- a genuine reinstall, a wiped AppData. */
router.delete('/provisions/device/:deviceId', asyncHandler(async (req, res) => {
  ok(res, await provisions.clearDeviceThrottle(req.params.deviceId));
}));

router.get('/stores/:id/dashboard', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  ok(res, await admin.storeDashboard(store.id));
}));

router.get('/stores/:id/sales', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  ok(res, await admin.listSales(store.id, req.query));
}));

router.get('/stores/:id/sales/:localId', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  ok(res, await admin.getSaleDetail(store.id, Number(req.params.localId)));
}));

router.get('/stores/:id/purchases', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  ok(res, await admin.listPurchases(store.id, req.query));
}));

router.get('/stores/:id/purchases/:localId', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  ok(res, await admin.getPurchaseDetail(store.id, Number(req.params.localId)));
}));

router.get('/stores/:id/inventory', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  ok(res, await admin.listInventory(store.id, req.query));
}));

router.get('/stores/:id/customers', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  ok(res, await admin.listCustomers(store.id, req.query));
}));

router.get('/stores/:id/suppliers', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  ok(res, await admin.listSuppliers(store.id, req.query));
}));

router.get('/stores/:id/trend', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  ok(res, await admin.salesTrend(store.id, Number(req.query.days) || 30));
}));

router.get('/stores/:id/payments/customers', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  ok(res, await admin.listCustomerPayments(store.id, req.query));
}));

router.get('/stores/:id/payments/suppliers', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  ok(res, await admin.listSupplierPayments(store.id, req.query));
}));

/**
 * Doctors. Now served by admin.listDoctors so it gains sort/paging/total, with
 * limit defaulted to the 500 this route always used rather than the service's
 * own 200 -- a store with 300 doctors must keep seeing all of them.
 *
 * `q` is widened from name-only to name / phone / registration number, which is
 * the service's long-standing search and can only match MORE rows.
 */
router.get('/stores/:id/doctors', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  ok(res, await admin.listDoctors(store.id, { limit: 500, ...req.query }));
}));

router.get('/stores/:id/returns/sales', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  ok(res, await admin.listSalesReturns(store.id, req.query));
}));

router.get('/stores/:id/returns/purchases', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  ok(res, await admin.listPurchaseReturns(store.id, req.query));
}));

router.get('/stores/:id/settings', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  const [profile, dropdowns, settings, shelf] = await Promise.all([
    query(`SELECT * FROM pharmacy_profiles WHERE store_pk=$1`, [store.id]),
    query(`SELECT * FROM store_dropdowns WHERE store_pk=$1`, [store.id]),
    query(`SELECT name, value, updated_at FROM store_settings WHERE store_pk=$1 ORDER BY name`, [store.id]),
    query(`SELECT * FROM shelf_settings WHERE store_pk=$1`, [store.id]),
  ]);
  ok(res, {
    profile: profile.rows[0] || null,
    dropdowns: dropdowns.rows[0] || null,
    settings: settings.rows,
    shelf_settings: shelf.rows[0] || null,
  });
}));

// ─── Demo site sign-ins ───────────────────────────────────────────────────────
// One login per sales person for demo.satpudacore.online. The demo holds no
// shop's data -- it runs off a recorded, redacted snapshot inside the browser
// -- but access is still handed out and withdrawn one person at a time.

router.get('/demo-users', asyncHandler(async (_req, res) => {
  ok(res, await demoUsers.listDemoUsers());
}));

router.post('/demo-users', asyncHandler(async (req, res) => {
  ok(res, await demoUsers.createDemoUser(req.body || {}));
}));

router.patch('/demo-users/:id', asyncHandler(async (req, res) => {
  ok(res, await demoUsers.updateDemoUser(req.params.id, req.body || {}));
}));

router.delete('/demo-users/:id', asyncHandler(async (req, res) => {
  ok(res, await demoUsers.deleteDemoUser(req.params.id));
}));

// ─── Global master medicines ──────────────────────────────────────────────────

router.get('/master-medicines', asyncHandler(async (req, res) => {
  const docs = await master.exportGlobalMaster({
    q: req.query.q || '',
    limit: Number(req.query.limit) || 200,
  });
  ok(res, { docs, count: docs.length, total: await master.countGlobalMaster() });
}));

router.get('/master-medicines/export', asyncHandler(async (_req, res) => {
  const docs = await master.exportGlobalMaster({});
  ok(res, { docs, count: docs.length, total: docs.length });
}));

router.post('/master-medicines/upsert', asyncHandler(async (req, res) => {
  const docs = Array.isArray(req.body?.docs) ? req.body.docs : [];
  ok(res, await master.upsertGlobalMasterBatch(docs, { enrich: !!req.body?.enrich }));
}));

router.post('/master-medicines/merge-from-store/:storePk', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.storePk);
  ok(res, await master.mergeFromStoreInventory(store.id));
}));

router.post('/master-medicines/migrate-store-scoped', asyncHandler(async (_req, res) => {
  ok(res, await master.migrateStoreScopedToGlobal());
}));

export default router;
