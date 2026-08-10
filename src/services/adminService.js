import { query } from '../db/pool.js';
import { AppError } from '../utils/http.js';
import { generateAndroidKey, slugifyStoreId, storeKeyFromName } from '../utils/fy.js';

export async function listStores() {
  const { rows } = await query(
    `SELECT s.*,
       (SELECT COUNT(*) FROM sales x WHERE x.store_pk=s.id AND NOT x.deleted AND NOT x.is_autosave) AS sales_count,
       (SELECT COUNT(*) FROM medicines x WHERE x.store_pk=s.id AND NOT x.deleted AND NOT x.is_hidden) AS medicine_count,
       (SELECT COALESCE(SUM(total_amount),0) FROM sales x
          WHERE x.store_pk=s.id AND NOT x.deleted AND NOT x.is_autosave
            AND bill_date = CURRENT_DATE) AS today_sales,
       (SELECT COALESCE(SUM(total_amount),0) FROM sales x
          WHERE x.store_pk=s.id AND NOT x.deleted AND NOT x.is_autosave
            AND bill_date >= date_trunc('month', CURRENT_DATE)::date) AS month_sales,
       (SELECT COUNT(*) FROM store_devices d WHERE d.store_pk=s.id) AS device_count
     FROM stores s
     ORDER BY s.store_name`
  );
  return rows;
}

export async function getStore(idOrSlug) {
  const { rows } = await query(
    `SELECT * FROM stores WHERE id::text = $1 OR store_id = $1`,
    [String(idOrSlug)]
  );
  if (!rows[0]) throw new AppError(404, 'Store not found');
  return rows[0];
}

export async function createStore({ store_name, store_id, store_key, notes, app_mode }) {
  if (!store_name?.trim()) throw new AppError(400, 'store_name required');
  const sid = store_id || slugifyStoreId(store_name);
  const skey = store_key || storeKeyFromName(store_name);
  const akey = generateAndroidKey();
  const { rows } = await query(
    `INSERT INTO stores (store_id, store_key, store_name, android_key, notes, app_mode)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [sid, skey, store_name.trim(), akey, notes || null, app_mode || 'online']
  );
  const store = rows[0];
  await query(
    `INSERT INTO pharmacy_profiles (store_pk, name, gst_enabled) VALUES ($1,$2,TRUE)`,
    [store.id, store.store_name]
  );
  await query(
    `INSERT INTO store_dropdowns (store_pk) VALUES ($1)`,
    [store.id]
  );
  return store;
}

export async function updateStore(idOrSlug, patch) {
  const store = await getStore(idOrSlug);
  const fields = [];
  const vals = [];
  let i = 1;
  for (const key of ['store_name', 'app_mode', 'is_active', 'notes', 'device_role']) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = $${i++}`);
      vals.push(patch[key]);
    }
  }
  if (!fields.length) return store;
  fields.push('updated_at = NOW()');
  vals.push(store.id);
  const { rows } = await query(
    `UPDATE stores SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    vals
  );
  return rows[0];
}

export async function regenerateAndroidKey(idOrSlug) {
  const store = await getStore(idOrSlug);
  const akey = generateAndroidKey();
  const { rows } = await query(
    `UPDATE stores SET android_key = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [akey, store.id]
  );
  return rows[0];
}

export async function storeDashboard(storePk) {
  const [
    salesToday,
    salesMonth,
    purchasesMonth,
    inventory,
    dues,
    recentSales,
    lowStock,
    expiring,
  ] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS bills, COALESCE(SUM(total_amount),0)::float AS amount,
              COALESCE(SUM(cash_paid),0)::float AS cash, COALESCE(SUM(online_paid),0)::float AS online
       FROM sales WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave AND bill_date=CURRENT_DATE`,
      [storePk]
    ),
    query(
      `SELECT COUNT(*)::int AS bills, COALESCE(SUM(total_amount),0)::float AS amount
       FROM sales WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave
         AND bill_date >= date_trunc('month', CURRENT_DATE)::date`,
      [storePk]
    ),
    query(
      `SELECT COUNT(*)::int AS bills, COALESCE(SUM(final_amount),0)::float AS amount
       FROM purchases WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave
         AND purchase_date >= date_trunc('month', CURRENT_DATE)::date`,
      [storePk]
    ),
    query(
      `SELECT COUNT(*) FILTER (WHERE NOT is_hidden)::int AS visible,
              COUNT(*) FILTER (WHERE stock_qty <= 0 AND NOT is_hidden)::int AS out_of_stock,
              COUNT(*)::int AS total
       FROM medicines WHERE store_pk=$1 AND NOT deleted`,
      [storePk]
    ),
    query(
      `SELECT
         (SELECT COALESCE(SUM(total_due),0)::float FROM customers WHERE store_pk=$1 AND NOT deleted AND total_due>0) AS customer_due,
         (SELECT COALESCE(SUM(total_due),0)::float FROM suppliers WHERE store_pk=$1 AND NOT deleted AND total_due>0) AS supplier_due`,
      [storePk]
    ),
    query(
      `SELECT local_id AS id, bill_no, bill_date, customer_name, total_amount, amount_paid, due_amount
       FROM sales WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave
       ORDER BY bill_date DESC, local_id DESC LIMIT 15`,
      [storePk]
    ),
    query(
      `SELECT local_id AS id, name, batch_no, stock_qty, mrp, expiry_date
       FROM medicines WHERE store_pk=$1 AND NOT deleted AND NOT is_hidden AND stock_qty > 0 AND stock_qty <= 10
       ORDER BY stock_qty ASC LIMIT 20`,
      [storePk]
    ),
    query(
      `SELECT local_id AS id, name, batch_no, stock_qty, expiry_date
       FROM medicines WHERE store_pk=$1 AND NOT deleted AND NOT is_hidden
         AND expiry_date IS NOT NULL AND expiry_date <= (CURRENT_DATE + INTERVAL '90 days')
       ORDER BY expiry_date ASC LIMIT 20`,
      [storePk]
    ),
  ]);

  return {
    today: salesToday.rows[0],
    month_sales: salesMonth.rows[0],
    month_purchases: purchasesMonth.rows[0],
    inventory: inventory.rows[0],
    dues: dues.rows[0],
    recent_sales: recentSales.rows,
    low_stock: lowStock.rows,
    expiring: expiring.rows,
  };
}

export async function platformOverview() {
  const { rows } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM stores WHERE is_active) AS active_stores,
       (SELECT COUNT(*)::int FROM sales WHERE NOT deleted AND NOT is_autosave AND bill_date=CURRENT_DATE) AS today_bills,
       (SELECT COALESCE(SUM(total_amount),0)::float FROM sales WHERE NOT deleted AND NOT is_autosave AND bill_date=CURRENT_DATE) AS today_revenue,
       (SELECT COUNT(*)::int FROM medicines WHERE NOT deleted AND NOT is_hidden) AS total_medicines,
       (SELECT COUNT(*)::int FROM store_devices) AS devices`
  );
  const stores = await listStores();
  return { ...rows[0], stores };
}

export async function listSales(storePk, { from, to, q, limit = 100, offset = 0 } = {}) {
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted AND NOT is_autosave';
  if (from) { params.push(from); where += ` AND bill_date >= $${params.length}`; }
  if (to) { params.push(to); where += ` AND bill_date <= $${params.length}`; }
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (bill_no ILIKE $${params.length} OR customer_name ILIKE $${params.length})`;
  }
  params.push(Math.min(Number(limit) || 100, 500));
  params.push(Number(offset) || 0);
  const { rows } = await query(
    `SELECT local_id AS id, bill_no, bill_date, customer_id, customer_name, total_amount,
            amount_paid, due_amount, cash_paid, online_paid, item_count, doctor_name, created_at
     FROM sales WHERE ${where}
     ORDER BY bill_date DESC, local_id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const countRes = await query(`SELECT COUNT(*)::int AS n FROM sales WHERE ${where}`, params.slice(0, -2));
  return { rows, total: countRes.rows[0].n };
}

export async function getSaleDetail(storePk, localId) {
  const { rows } = await query(
    `SELECT * FROM sales WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (!rows[0]) throw new AppError(404, 'Sale not found');
  const sale = rows[0];
  const items = await query(`SELECT * FROM sales_items WHERE sale_id=$1`, [sale.id]);
  return { ...sale, id: sale.local_id, items: items.rows };
}

export async function listPurchases(storePk, { from, to, q, limit = 100, offset = 0 } = {}) {
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted AND NOT is_autosave';
  if (from) { params.push(from); where += ` AND purchase_date >= $${params.length}`; }
  if (to) { params.push(to); where += ` AND purchase_date <= $${params.length}`; }
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (purchase_no ILIKE $${params.length} OR supplier_name ILIKE $${params.length} OR bill_number ILIKE $${params.length})`;
  }
  params.push(Math.min(Number(limit) || 100, 500));
  params.push(Number(offset) || 0);
  const { rows } = await query(
    `SELECT local_id AS id, purchase_no, purchase_date, supplier_id, supplier_name, bill_number,
            final_amount, amount_paid, due_amount, item_count, created_at
     FROM purchases WHERE ${where}
     ORDER BY purchase_date DESC, local_id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const countRes = await query(`SELECT COUNT(*)::int AS n FROM purchases WHERE ${where}`, params.slice(0, -2));
  return { rows, total: countRes.rows[0].n };
}

export async function getPurchaseDetail(storePk, localId) {
  const { rows } = await query(
    `SELECT * FROM purchases WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (!rows[0]) throw new AppError(404, 'Purchase not found');
  const p = rows[0];
  const items = await query(`SELECT * FROM purchase_items WHERE purchase_id=$1`, [p.id]);
  return { ...p, id: p.local_id, items: items.rows };
}

export async function listInventory(storePk, { q, low_stock, hidden, limit = 200, offset = 0 } = {}) {
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (hidden === '1' || hidden === 'true') where += ' AND is_hidden = TRUE';
  else if (hidden !== 'all') where += ' AND NOT is_hidden';
  if (low_stock) where += ' AND stock_qty <= 10';
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (name ILIKE $${params.length} OR batch_no ILIKE $${params.length} OR manufacturer ILIKE $${params.length})`;
  }
  params.push(Math.min(Number(limit) || 200, 1000));
  params.push(Number(offset) || 0);
  const { rows } = await query(
    `SELECT local_id AS id, name, type, stock_qty, unit, gst_percent, mrp, rate, manufacturer,
            batch_no, expiry_date, hsn_code, schedule, location, is_hidden, updated_at
     FROM medicines WHERE ${where}
     ORDER BY name, batch_no
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const countRes = await query(`SELECT COUNT(*)::int AS n FROM medicines WHERE ${where}`, params.slice(0, -2));
  return { rows, total: countRes.rows[0].n };
}

export async function listCustomers(storePk, { q, dues_only, limit = 200, offset = 0 } = {}) {
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (dues_only) where += ' AND total_due > 0';
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length} OR address ILIKE $${params.length})`;
  }
  params.push(Math.min(Number(limit) || 200, 1000));
  params.push(Number(offset) || 0);
  const { rows } = await query(
    `SELECT local_id AS id, name, phone, address, total_due, total_credit, created_at
     FROM customers WHERE ${where}
     ORDER BY name
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows };
}

export async function listSuppliers(storePk, { q, dues_only, limit = 200 } = {}) {
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (dues_only) where += ' AND total_due > 0';
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length})`;
  }
  params.push(Math.min(Number(limit) || 200, 1000));
  const { rows } = await query(
    `SELECT local_id AS id, name, phone, address, gstin, total_due, total_credit
     FROM suppliers WHERE ${where}
     ORDER BY name LIMIT $${params.length}`,
    params
  );
  return { rows };
}

export async function salesTrend(storePk, days = 30) {
  const { rows } = await query(
    `SELECT bill_date::text AS date,
            COUNT(*)::int AS bills,
            COALESCE(SUM(total_amount),0)::float AS amount
     FROM sales
     WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave
       AND bill_date >= CURRENT_DATE - ($2::int || ' days')::interval
     GROUP BY bill_date
     ORDER BY bill_date`,
    [storePk, days]
  );
  return rows;
}
