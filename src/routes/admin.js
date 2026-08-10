import { Router } from 'express';
import { asyncHandler, ok } from '../utils/http.js';
import { requireAdmin } from '../middleware/auth.js';
import * as admin from '../services/adminService.js';
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
  ok(res, { store, profile: profile.rows[0] || null, devices: devices.rows, dashboard: dash });
}));

router.patch('/stores/:id', asyncHandler(async (req, res) => {
  ok(res, await admin.updateStore(req.params.id, req.body || {}));
}));

router.post('/stores/:id/regenerate-key', asyncHandler(async (req, res) => {
  ok(res, await admin.regenerateAndroidKey(req.params.id));
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
  const { rows } = await query(
    `SELECT local_id AS id, customer_id, customer_name, payment_date, amount, payment_mode, cash_amount, online_amount
     FROM customer_payments WHERE store_pk=$1 AND NOT deleted
     ORDER BY payment_date DESC, local_id DESC LIMIT 200`,
    [store.id]
  );
  ok(res, { rows });
}));

router.get('/stores/:id/payments/suppliers', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  const { rows } = await query(
    `SELECT local_id AS id, payment_no, supplier_id, supplier_name, payment_date, amount, mode
     FROM supplier_payments WHERE store_pk=$1 AND NOT deleted
     ORDER BY payment_date DESC, local_id DESC LIMIT 200`,
    [store.id]
  );
  ok(res, { rows });
}));

export default router;
