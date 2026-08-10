import { Router } from 'express';
import { asyncHandler, ok } from '../utils/http.js';
import { adminLogin, pairStore, requireAdmin, requireAuth } from '../middleware/auth.js';
import { healthCheck } from '../db/pool.js';

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
    vps_ip: '200.234.32.222',
    github: 'https://github.com/roshanghogale/Satpuda-Core-Server.git',
    collections: [
      'customers', 'suppliers', 'medicines', 'doctors',
      'sales', 'purchases', 'customer_payments', 'supplier_payments',
      'sales_returns', 'purchase_returns',
      'general_products', 'stock_disposals', 'pending_orders',
      'racks', 'sections', 'boxes', 'shelves', 'medicine_shelf',
      'medicine_suppliers', 'medicines_master',
    ],
    special: ['pharmacy_profile', 'dropdowns', 'shelf_settings', 'settings'],
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
  });
}));

router.get('/auth/me', requireAuth(['admin', 'store']), asyncHandler(async (req, res) => {
  ok(res, { auth: req.auth });
}));

router.get('/auth/admin/ping', requireAdmin, asyncHandler(async (req, res) => {
  ok(res, { admin: req.auth });
}));

export default router;
