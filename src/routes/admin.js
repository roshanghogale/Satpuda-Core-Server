import { Router } from 'express';
import { asyncHandler, ok } from '../utils/http.js';
import { requireAdmin } from '../middleware/auth.js';
import * as admin from '../services/adminService.js';
import * as master from '../services/masterMedicineService.js';
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

router.get('/stores/:id/doctors', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  const q = req.query.q ? `%${req.query.q}%` : null;
  const { rows } = await query(
    q
      ? `SELECT local_id AS id, name, phone, registration_number, created_at
         FROM doctors WHERE store_pk=$1 AND NOT deleted AND name ILIKE $2
         ORDER BY name LIMIT 500`
      : `SELECT local_id AS id, name, phone, registration_number, created_at
         FROM doctors WHERE store_pk=$1 AND NOT deleted ORDER BY name LIMIT 500`,
    q ? [store.id, q] : [store.id]
  );
  ok(res, { rows });
}));

router.get('/stores/:id/returns/sales', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  const { rows } = await query(
    `SELECT local_id AS id, return_no, bill_no, customer_name, return_date, refund_amount, item_count
     FROM sales_returns WHERE store_pk=$1 AND NOT deleted
     ORDER BY return_date DESC, local_id DESC LIMIT 200`,
    [store.id]
  );
  ok(res, { rows });
}));

router.get('/stores/:id/returns/purchases', asyncHandler(async (req, res) => {
  const store = await admin.getStore(req.params.id);
  const { rows } = await query(
    `SELECT local_id AS id, return_no, purchase_no, supplier_name, return_date, refund_amount, item_count
     FROM purchase_returns WHERE store_pk=$1 AND NOT deleted
     ORDER BY return_date DESC, local_id DESC LIMIT 200`,
    [store.id]
  );
  ok(res, { rows });
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
