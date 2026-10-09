/**
 * The web login's API (phase 5): /api/web/*. Online-only; every route checks the signed-in
 * user's permission, so a hidden menu is never the only guard.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler, ok, AppError, trustedClientIp } from '../utils/http.js';
import * as users from '../services/webUsers.js';
import * as store from '../services/webStore.js';
import { assertStoreAccess } from '../services/licenseService.js';
import { query } from '../db/pool.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => trustedClientIp(req),
  message: { ok: false, error: 'Too many sign-in attempts. Wait fifteen minutes and try again.' },
});

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

router.post('/auth/login', loginLimiter, asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  const out = await users.login(username, password, { ip: trustedClientIp(req), userAgent: req.headers['user-agent'] });
  ok(res, out);
}));

router.post('/auth/logout', asyncHandler(async (req, res) => {
  await users.logout(bearer(req));
  ok(res, { signed_out: true });
}));

/** Every route below: a live session of an active login of an active, licensed shop. */
router.use(asyncHandler(async (req, _res, next) => {
  const row = await users.sessionUser(bearer(req));
  if (!row) throw new AppError(401, 'Please sign in again.');
  if (row.store_active === false) throw new AppError(403, 'This shop is switched off. Contact Satpuda support.');
  const user = users.shapeUser(row);
  req.web = { user, storePk: Number(row.store_pk), storeName: row.store_name, perms: new Set(user.permissions) };
  const pwRoute = /^\/(me|auth)(\/|$)/.test(req.path);
  if (user.must_change_password && !pwRoute) {
    throw new AppError(403, 'Set your own password first.', { code: 'password_change_required' });
  }
  if (!pwRoute) {
    const { rows } = await query(
      `SELECT id, store_id, is_active, activation_date, expiry_enabled, expiry_date, apply_expiry_check, provisioned_trial
         FROM stores WHERE id=$1`, [req.web.storePk]);
    await assertStoreAccess(rows[0]);
  }
  next();
}));

const need = (...perms) => (req, _res, next) => {
  for (const p of perms) if (!req.web.perms.has(p)) return next(new AppError(403, 'You do not have permission for this. Ask the shop owner.'));
  return next();
};
const needAny = (...perms) => (req, _res, next) => (
  perms.some((p) => req.web.perms.has(p)) ? next() : next(new AppError(403, 'You do not have permission for this. Ask the shop owner.'))
);
const W = (req) => [req.web.storePk, req.web.user];

// ─── Me ──────────────────────────────────────────────────────────────────────

router.get('/me', asyncHandler(async (req, res) => {
  ok(res, {
    user: req.web.user, store_name: req.web.storeName, permissions: [...req.web.perms],
    all_permissions: users.PERMISSIONS, profile: await store.profile(req.web.storePk), today: store.todayIst(),
  });
}));

router.post('/me/password', asyncHandler(async (req, res) => {
  const b = req.body || {};
  ok(res, await users.changeOwnPassword(req.web.user.id, b.current, b.next));
}));

// ─── Lookups used by several screens ─────────────────────────────────────────

router.get('/medicines/sellable', needAny('billing', 'sales_edit'), asyncHandler(async (req, res) => {
  ok(res, await store.searchSellable(req.web.storePk, req.query.q));
}));
router.get('/medicines/any', needAny('purchase_entry', 'purchase_edit', 'inventory_view'), asyncHandler(async (req, res) => {
  ok(res, await store.searchAnyMedicine(req.web.storePk, req.query.q));
}));
router.get('/customers', needAny('parties', 'billing', 'sales_edit'), asyncHandler(async (req, res) => {
  ok(res, await store.customers(req.web.storePk, req.query));
}));
router.get('/suppliers', needAny('parties', 'purchase_entry', 'purchase_edit'), asyncHandler(async (req, res) => {
  ok(res, await store.suppliers(req.web.storePk, req.query));
}));

// ─── Sales ───────────────────────────────────────────────────────────────────

router.post('/sales/preview', needAny('billing', 'sales_edit'), asyncHandler(async (req, res) => {
  ok(res, await store.previewSale(req.web.storePk, req.body || {}));
}));
router.post('/sales', need('billing'), asyncHandler(async (req, res) => {
  ok(res, await store.createSale(...W(req), req.body || {}));
}));
router.get('/sales', need('sales_view'), asyncHandler(async (req, res) => {
  ok(res, await store.salesList(req.web.storePk, req.query));
}));
router.get('/sales/:id', needAny('sales_view', 'billing', 'returns'), asyncHandler(async (req, res) => {
  ok(res, await store.saleDetail(req.web.storePk, req.params.id));
}));
router.put('/sales/:id', need('sales_edit'), asyncHandler(async (req, res) => {
  ok(res, await store.editSale(...W(req), req.params.id, req.body || {}));
}));
router.delete('/sales/:id', need('sales_delete'), asyncHandler(async (req, res) => {
  ok(res, await store.deleteSale(...W(req), req.params.id));
}));

router.get('/sales/:id/returnable', need('returns'), asyncHandler(async (req, res) => {
  ok(res, await store.returnable(req.web.storePk, req.params.id));
}));
router.post('/returns/sales', need('returns'), asyncHandler(async (req, res) => {
  ok(res, await store.createSalesReturn(...W(req), req.body || {}));
}));

// ─── Purchases ───────────────────────────────────────────────────────────────

router.post('/purchases/preview', needAny('purchase_entry', 'purchase_edit'), asyncHandler(async (req, res) => {
  ok(res, await store.previewPurchase(req.web.storePk, req.body || {}));
}));
router.post('/purchases', need('purchase_entry'), asyncHandler(async (req, res) => {
  ok(res, await store.createPurchase(...W(req), req.body || {}));
}));
router.get('/purchases', need('purchase_view'), asyncHandler(async (req, res) => {
  ok(res, await store.purchasesList(req.web.storePk, req.query));
}));
router.get('/purchases/:id', need('purchase_view'), asyncHandler(async (req, res) => {
  ok(res, await store.purchaseDetail(req.web.storePk, req.params.id));
}));
router.put('/purchases/:id', need('purchase_edit'), asyncHandler(async (req, res) => {
  ok(res, await store.editPurchase(...W(req), req.params.id, req.body || {}));
}));
router.delete('/purchases/:id', need('purchase_delete'), asyncHandler(async (req, res) => {
  ok(res, await store.deletePurchase(...W(req), req.params.id));
}));

// ─── Inventory ───────────────────────────────────────────────────────────────

router.get('/inventory', need('inventory_view'), asyncHandler(async (req, res) => {
  ok(res, await store.inventory(req.web.storePk, req.query));
}));
router.get('/inventory/:id', need('inventory_view'), asyncHandler(async (req, res) => {
  const { fetchDocsByLocalIds } = await import('../services/syncService.js');
  const [doc] = await fetchDocsByLocalIds(req.web.storePk, 'medicines', [Number(req.params.id)]);
  if (!doc) throw new AppError(404, 'Medicine not found.');
  ok(res, doc);
}));
router.put('/inventory/:id', need('inventory_edit'), asyncHandler(async (req, res) => {
  ok(res, await store.editMedicine(...W(req), req.params.id, req.body || {}));
}));

// ─── Parties and payments ────────────────────────────────────────────────────

router.get('/payments/customers', need('parties'), asyncHandler(async (req, res) => {
  ok(res, await store.customerPayments(req.web.storePk, req.query));
}));
router.get('/payments/suppliers', need('parties'), asyncHandler(async (req, res) => {
  ok(res, await store.supplierPayments(req.web.storePk, req.query));
}));
router.post('/payments/customers', need('payments'), asyncHandler(async (req, res) => {
  ok(res, await store.customerPayment(...W(req), req.body || {}));
}));
router.post('/payments/suppliers', need('payments'), asyncHandler(async (req, res) => {
  ok(res, await store.supplierPayment(...W(req), req.body || {}));
}));

// ─── Reports ─────────────────────────────────────────────────────────────────

router.get('/reports', need('reports'), asyncHandler(async (req, res) => {
  ok(res, await store.reports(req.web.storePk, req.query));
}));

// ─── Staff (owner, or a manager given the 'staff' switch) ────────────────────

router.get('/staff', need('staff'), asyncHandler(async (req, res) => {
  ok(res, { users: await users.listUsers(req.web.storePk), permissions: users.PERMISSIONS,
    default_staff: users.DEFAULT_STAFF_PERMISSIONS });
}));
router.post('/staff', need('staff'), asyncHandler(async (req, res) => {
  const out = await users.createUser(req.web.storePk, req.body || {}, { actor: `web:${req.web.user.username}`, byOwner: true });
  await users.audit(null, { storePk: req.web.storePk, user: req.web.user, action: 'staff.add',
    detail: { username: out.user.username, permissions: out.user.permissions } });
  ok(res, out);
}));
router.patch('/staff/:id', need('staff'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const u = await users.updateUser(req.web.storePk, req.params.id,
    { full_name: b.full_name, permissions: b.permissions, is_active: b.is_active, unlock: b.unlock },
    { byOwner: true, selfId: req.web.user.id });
  await users.audit(null, { storePk: req.web.storePk, user: req.web.user, action: 'staff.change',
    detail: { username: u.username, permissions: u.permissions, is_active: u.is_active } });
  ok(res, u);
}));
router.post('/staff/:id/reset-password', need('staff'), asyncHandler(async (req, res) => {
  const out = await users.resetPassword(req.web.storePk, req.params.id, { password: (req.body || {}).password }, { byOwner: true });
  await users.audit(null, { storePk: req.web.storePk, user: req.web.user, action: 'staff.reset_password',
    detail: { username: out.user.username } });
  ok(res, out);
}));
router.delete('/staff/:id', need('staff'), asyncHandler(async (req, res) => {
  const out = await users.deleteUser(req.web.storePk, req.params.id, { byOwner: true, selfId: req.web.user.id });
  await users.audit(null, { storePk: req.web.storePk, user: req.web.user, action: 'staff.delete', detail: { username: out.username } });
  ok(res, out);
}));
router.get('/audit', need('staff'), asyncHandler(async (req, res) => {
  ok(res, await users.listAudit(req.web.storePk, req.query));
}));

export default router;
