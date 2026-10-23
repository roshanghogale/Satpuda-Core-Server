/**
 * The web login's API (phase 5): /api/web/*. Online-only; every route checks the signed-in
 * user's permission, so a hidden menu is never the only guard.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler, ok, AppError, trustedClientIp } from '../utils/http.js';
import * as users from '../services/webUsers.js';
import * as store from '../services/webStore.js';
import * as ws from '../services/webWholesale.js';
import * as dmRules from '../services/doctorMarginRulesStore.js';
import { assertStoreAccess } from '../services/licenseService.js';
import { companionOffered, findCompanion, storeKindOf } from '../services/wholesaleStore.js';
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

const STORE_COLS = `id, store_id, store_name, is_active, activation_date, expiry_enabled, expiry_date, apply_expiry_check,
  provisioned_trial, wholesale_enabled, store_kind, parent_store_id`;

/**
 * Every route below: a live session of an active login of an active, licensed shop.
 *
 * Wholesale is a SEPARATE store (owner, 18 Oct 2026): a login belongs to its retail store, and
 * when that store's wholesale companion is offered (wholesaleStore.companionOffered) the same
 * session may act for the companion instead. The browser asks with the header
 * `X-Satpuda-Store: wholesale` on each request (the Retail | Wholesale switch keeps the choice);
 * the permissions stay the login's own. req.web.storePk is the store the request acts for,
 * req.web.homePk the login's own store (staff logins live there). A wholesale request when the
 * companion is not offered (switched off by the admin) is refused, never quietly done in retail.
 */
router.use(asyncHandler(async (req, _res, next) => {
  const row = await users.sessionUser(bearer(req));
  if (!row) throw new AppError(401, 'Please sign in again.');
  if (row.store_active === false) throw new AppError(403, 'This shop is switched off. Contact Satpuda support.');
  const user = users.shapeUser(row);
  const homePk = Number(row.store_pk);
  req.web = {
    user, storePk: homePk, homePk, storeName: row.store_name, homeName: row.store_name,
    perms: new Set(user.permissions), storeKind: 'retail', companion: null,
  };
  const pwRoute = /^\/(me|auth)(\/|$)/.test(req.path);
  if (user.must_change_password && !pwRoute) {
    throw new AppError(403, 'Set your own password first.', { code: 'password_change_required' });
  }
  const { rows } = await query(`SELECT ${STORE_COLS} FROM stores WHERE id=$1`, [homePk]);
  const home = rows[0];
  let acting = home;
  if (storeKindOf(home) === 'wholesale') {
    // A login made on the wholesale store itself works there only.
    req.web.storeKind = 'wholesale';
  } else if (home?.wholesale_enabled === true) {
    const companion = await findCompanion(homePk);
    if (companionOffered(home, companion)) req.web.companion = { id: Number(companion.id), store_name: companion.store_name };
  }
  const want = String(req.headers['x-satpuda-store'] || '').trim().toLowerCase();
  if (want === 'wholesale' && req.web.storeKind !== 'wholesale') {
    if (!req.web.companion) {
      if (!/^\/me\/?$/.test(req.path)) {
        throw new AppError(409, 'The wholesale store is not available now. Switch back to Retail.', { code: 'wholesale_off' });
      }
    } else {
      const { rows: cr } = await query(`SELECT ${STORE_COLS} FROM stores WHERE id=$1`, [req.web.companion.id]);
      acting = cr[0];
      req.web.storePk = Number(acting.id);
      req.web.storeName = acting.store_name;
      req.web.storeKind = 'wholesale';
    }
  }
  if (!pwRoute) await assertStoreAccess(acting);
  next();
}));

/** Wholesale-only routes: the request must act for a wholesale store. */
const wholesaleOnly = (req, _res, next) => (
  req.web.storeKind === 'wholesale' ? next()
    : next(new AppError(409, 'Switch to the wholesale store first.', { code: 'not_wholesale' }))
);
/** Retail bill routes: a wholesale store makes tax invoices, never retail bills. */
const retailOnly = (req, _res, next) => (
  req.web.storeKind !== 'wholesale' ? next()
    : next(new AppError(409, 'This is the wholesale store: make the bill on the Wholesale bill screen.', { code: 'wholesale_store' }))
);

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
  const w = req.web;
  ok(res, {
    user: w.user, store_name: w.storeName, permissions: [...w.perms],
    all_permissions: users.PERMISSIONS, profile: await store.profile(w.storePk), today: store.todayIst(),
    // Retail | Wholesale (owner, 18 Oct 2026): which store this session acts for now, and the
    // other one the switch opens (null when there is none).
    store_kind: w.storeKind,
    home_store_name: w.homeName,
    wholesale_store: w.companion ? { store_name: w.companion.store_name } : null,
    switchable: !!w.companion,
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
// What a new bill starts with: default doctor + phone, doctors, villages (as the PC's Sales).
router.get('/sales/defaults', needAny('billing', 'sales_edit'), asyncHandler(async (req, res) => {
  ok(res, await store.salesDefaults(req.web.storePk));
}));

// ─── Sales ───────────────────────────────────────────────────────────────────

router.post('/sales/preview', needAny('billing', 'sales_edit'), retailOnly, asyncHandler(async (req, res) => {
  ok(res, await store.previewSale(req.web.storePk, req.body || {}));
}));
router.post('/sales', need('billing'), retailOnly, asyncHandler(async (req, res) => {
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
  ok(res, await store.returnable(req.web.storePk, req.params.id, { wholesale: req.web.storeKind === 'wholesale' }));
}));
router.post('/returns/sales', need('returns'), asyncHandler(async (req, res) => {
  ok(res, await store.createSalesReturn(...W(req), req.body || {}));
}));

// ─── Purchases ───────────────────────────────────────────────────────────────

router.post('/purchases/preview', needAny('purchase_entry', 'purchase_edit'), asyncHandler(async (req, res) => {
  ok(res, await store.previewPurchase(req.web.storePk, req.body || {}, { wholesale: req.web.storeKind === 'wholesale' }));
}));
router.post('/purchases', need('purchase_entry'), asyncHandler(async (req, res) => {
  ok(res, await store.createPurchase(...W(req), req.body || {}, { wholesale: req.web.storeKind === 'wholesale' }));
}));
router.get('/purchases', need('purchase_view'), asyncHandler(async (req, res) => {
  ok(res, await store.purchasesList(req.web.storePk, req.query));
}));
router.get('/purchases/:id', need('purchase_view'), asyncHandler(async (req, res) => {
  ok(res, await store.purchaseDetail(req.web.storePk, req.params.id));
}));
router.put('/purchases/:id', need('purchase_edit'), asyncHandler(async (req, res) => {
  ok(res, await store.editPurchase(...W(req), req.params.id, req.body || {}, { wholesale: req.web.storeKind === 'wholesale' }));
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
// Pay a due from Sales / Purchase History: what is open on the bill (the payment itself is the
// ordinary payment below, with the bill number as its reference).
router.get('/sales/:id/due', need('payments'), asyncHandler(async (req, res) => {
  ok(res, await store.billDueInfo(req.web.storePk, 'sale', req.params.id));
}));
router.get('/purchases/:id/due', need('payments'), asyncHandler(async (req, res) => {
  ok(res, await store.billDueInfo(req.web.storePk, 'purchase', req.params.id));
}));
// Which bills still owe, for "Choose bills" in the pay box; and the payment report.
router.get('/customers/:id/open-bills', needAny('parties', 'payments'), asyncHandler(async (req, res) => {
  ok(res, await store.openBills(req.web.storePk, 'customer', req.params.id));
}));
// Returns whose credit is not used yet, offered when billing that party.
router.get('/customers/:id/open-returns', needAny('billing', 'parties'), asyncHandler(async (req, res) => {
  ok(res, await store.openReturns(req.web.storePk, 'customer', req.params.id));
}));
router.get('/suppliers/:id/open-returns', needAny('purchase_entry', 'parties'), asyncHandler(async (req, res) => {
  ok(res, await store.openReturns(req.web.storePk, 'supplier', req.params.id));
}));
router.get('/suppliers/:id/open-bills', needAny('parties', 'payments'), asyncHandler(async (req, res) => {
  ok(res, await store.openBills(req.web.storePk, 'supplier', req.params.id));
}));
// Doctor Margin Report (Sales History -> Export): filters, then the report.
router.get('/reports/doctor-margin/options', needAny('sales_view', 'reports'), asyncHandler(async (req, res) => {
  ok(res, await store.doctorMarginOptions(req.web.storePk));
}));
router.get('/reports/doctor-margin', needAny('sales_view', 'reports'), asyncHandler(async (req, res) => {
  ok(res, await store.doctorMarginReport(req.web.storePk, req.query));
}));
// Doctor margin BY RULES (owner, 22-23 Oct 2026; the PC's "By margin rules" mode): the rules
// (a shop setting every PC and phone shares), the product pick list, the report and the
// owner's Recalculate period. Seeing needs what the report needs; changing needs Reports.
router.get('/reports/doctor-margin/rules', needAny('sales_view', 'reports'), asyncHandler(async (req, res) => {
  ok(res, await dmRules.rulesPayload(req.web.storePk));
}));
router.put('/reports/doctor-margin/rules', need('reports'), asyncHandler(async (req, res) => {
  ok(res, await dmRules.saveRules(...W(req), req.body || {}));
}));
router.get('/reports/doctor-margin/rules/products', needAny('sales_view', 'reports'), asyncHandler(async (req, res) => {
  ok(res, await dmRules.ruleProducts(req.web.storePk, req.query));
}));
router.get('/reports/doctor-margin/by-rules', needAny('sales_view', 'reports'), asyncHandler(async (req, res) => {
  ok(res, await dmRules.report(req.web.storePk, req.query));
}));
router.post('/reports/doctor-margin/recalculate', need('reports'), asyncHandler(async (req, res) => {
  ok(res, await dmRules.recalculate(...W(req), req.body || {}));
}));
router.get('/payments/report', need('parties'), asyncHandler(async (req, res) => {
  ok(res, await store.paymentReport(req.web.storePk, req.query));
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
router.get('/reports/register', need('reports'), asyncHandler(async (req, res) => {
  ok(res, await store.scheduleRegister(req.web.storePk, req.query));
}));

// ─── Wholesale store (owner, 18-19 Oct 2026): tax invoice, parties, print, reports ───

router.get('/wholesale/margins', wholesaleOnly, asyncHandler(async (req, res) => {
  ok(res, await ws.margins(req.web.storePk));
}));
router.get('/wholesale/parties', wholesaleOnly, needAny('parties', 'billing', 'sales_edit'), asyncHandler(async (req, res) => {
  ok(res, await ws.listParties(req.web.storePk, req.query));
}));
router.get('/wholesale/parties/:id', wholesaleOnly, needAny('parties', 'billing', 'sales_edit'), asyncHandler(async (req, res) => {
  const p = await ws.getParty(req.web.storePk, req.params.id);
  if (!p) throw new AppError(404, 'Party not found.');
  ok(res, p);
}));
router.post('/wholesale/parties', wholesaleOnly, needAny('parties', 'billing'), asyncHandler(async (req, res) => {
  ok(res, await ws.saveParty(...W(req), null, req.body || {}));
}));
router.put('/wholesale/parties/:id', wholesaleOnly, needAny('parties', 'billing'), asyncHandler(async (req, res) => {
  ok(res, await ws.saveParty(...W(req), req.params.id, req.body || {}));
}));
router.get('/wholesale/parties/:id/open-returns', wholesaleOnly, needAny('billing', 'parties'), asyncHandler(async (req, res) => {
  ok(res, await ws.openReturnsInPacks(req.web.storePk, req.params.id));
}));
router.get('/wholesale/medicines', wholesaleOnly, needAny('billing', 'sales_edit'), asyncHandler(async (req, res) => {
  ok(res, await ws.searchMedicines(req.web.storePk, req.query.q, req.query.tier));
}));
router.post('/wholesale/line', wholesaleOnly, needAny('billing', 'sales_edit'), asyncHandler(async (req, res) => {
  ok(res, await ws.buildLine(req.web.storePk, req.body || {}));
}));
router.post('/wholesale/sales/calc', wholesaleOnly, needAny('billing', 'sales_edit'), asyncHandler(async (req, res) => {
  ok(res, await ws.calcSale(req.web.storePk, req.body || {}));
}));
router.post('/wholesale/sales', wholesaleOnly, need('billing'), asyncHandler(async (req, res) => {
  ok(res, await ws.createSale(...W(req), req.body || {}));
}));
router.get('/wholesale/sales/:id', wholesaleOnly, needAny('sales_view', 'billing', 'sales_edit'), asyncHandler(async (req, res) => {
  ok(res, await ws.loadSale(req.web.storePk, req.params.id));
}));
router.put('/wholesale/sales/:id', wholesaleOnly, need('sales_edit'), asyncHandler(async (req, res) => {
  ok(res, await ws.editSale(...W(req), req.params.id, req.body || {}));
}));
router.get('/wholesale/sales/:id/invoice', wholesaleOnly, needAny('sales_view', 'billing'), asyncHandler(async (req, res) => {
  ok(res, await ws.invoiceHtml(req.web.storePk, req.params.id, { paper: req.query.paper, copyLabel: req.query.copy_label }));
}));
router.get('/wholesale/reports/parties', wholesaleOnly, need('reports'), asyncHandler(async (req, res) => {
  ok(res, await ws.reportParties(req.web.storePk));
}));
router.get('/wholesale/reports/:name', wholesaleOnly, need('reports'), asyncHandler(async (req, res) => {
  ok(res, await ws.report(req.web.storePk, req.params.name, req.query));
}));

// ─── Staff (owner, or a manager given the 'staff' switch) ────────────────────

router.get('/staff', need('staff'), asyncHandler(async (req, res) => {
  ok(res, { users: await users.listUsers(req.web.homePk), permissions: users.PERMISSIONS,
    default_staff: users.DEFAULT_STAFF_PERMISSIONS });
}));
router.post('/staff', need('staff'), asyncHandler(async (req, res) => {
  const out = await users.createUser(req.web.homePk, req.body || {}, { actor: `web:${req.web.user.username}`, byOwner: true });
  await users.audit(null, { storePk: req.web.homePk, user: req.web.user, action: 'staff.add',
    detail: { username: out.user.username, permissions: out.user.permissions } });
  ok(res, out);
}));
router.patch('/staff/:id', need('staff'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const u = await users.updateUser(req.web.homePk, req.params.id,
    { full_name: b.full_name, permissions: b.permissions, is_active: b.is_active, unlock: b.unlock },
    { byOwner: true, selfId: req.web.user.id });
  await users.audit(null, { storePk: req.web.homePk, user: req.web.user, action: 'staff.change',
    detail: { username: u.username, permissions: u.permissions, is_active: u.is_active } });
  ok(res, u);
}));
router.post('/staff/:id/reset-password', need('staff'), asyncHandler(async (req, res) => {
  const out = await users.resetPassword(req.web.homePk, req.params.id, { password: (req.body || {}).password }, { byOwner: true });
  await users.audit(null, { storePk: req.web.homePk, user: req.web.user, action: 'staff.reset_password',
    detail: { username: out.user.username } });
  ok(res, out);
}));
router.delete('/staff/:id', need('staff'), asyncHandler(async (req, res) => {
  const out = await users.deleteUser(req.web.homePk, req.params.id, { byOwner: true, selfId: req.web.user.id });
  await users.audit(null, { storePk: req.web.homePk, user: req.web.user, action: 'staff.delete', detail: { username: out.username } });
  ok(res, out);
}));
router.get('/audit', need('staff'), asyncHandler(async (req, res) => {
  ok(res, await users.listAudit(req.web.storePk, req.query));
}));

export default router;
