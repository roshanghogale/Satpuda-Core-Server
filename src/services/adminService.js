import { query } from '../db/pool.js';
import { AppError } from '../utils/http.js';
import {
  generateAndroidKey,
  slugifyStoreId,
  storeKeyFromName,
  fyStartYearForDate,
  fyDateBounds,
} from '../utils/fy.js';

/** Default Online history window = current Indian FY (01 Apr – 31 Mar), same as Offline. */
function resolveListDates(from, to) {
  const fd = from ? String(from).trim().slice(0, 10) : '';
  const td = to ? String(to).trim().slice(0, 10) : '';
  if (fd || td) return { from: fd || null, to: td || null, defaultFy: false };
  const [a, b] = fyDateBounds(fyStartYearForDate(new Date()));
  return { from: a, to: b, defaultFy: true };
}

function wantExactTotal(includeTotal) {
  return !(includeTotal === false || includeTotal === '0' || includeTotal === 0);
}

async function resolveListTotal({
  table,
  where,
  countParams,
  offset,
  limit,
  pageLen,
  includeTotal,
}) {
  // Same envelope as before: always { rows, total: int }. Skip COUNT only when
  // the page is short (total is then exact) or a new client opted out.
  if (pageLen < limit || !wantExactTotal(includeTotal)) {
    return offset + pageLen;
  }
  const countRes = await query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`,
    countParams,
  );
  return Number(countRes.rows[0].n) || 0;
}

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
  if (patch.expiry_enabled !== undefined) {
    fields.push(`expiry_enabled = $${i++}`);
    vals.push(Boolean(patch.expiry_enabled));
  }
  if (patch.apply_expiry_check !== undefined) {
    fields.push(`apply_expiry_check = $${i++}`);
    vals.push(Boolean(patch.apply_expiry_check));
  }
  if (patch.expiry_date !== undefined) {
    fields.push(`expiry_date = $${i++}`);
    vals.push(patch.expiry_date ? String(patch.expiry_date).slice(0, 10) : null);
  }
  if (patch.activation_date !== undefined) {
    fields.push(`activation_date = $${i++}`);
    vals.push(patch.activation_date ? String(patch.activation_date).slice(0, 10) : null);
  }
  if (!fields.length) return store;
  fields.push('updated_at = NOW()');
  vals.push(store.id);
  const { rows } = await query(
    `UPDATE stores SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    vals
  );
  const updated = rows[0];

  // An admin changing expiry / is_active must take effect NOW, not in up to 45s.
  // requireAuth caches the store row, so without this the PC and Android keep
  // working until the cache lapses — and a live WebSocket never noticed at all.
  await applyLicenceChangeNow(updated);
  return updated;
}

/**
 * Push a licence/access change straight through to every connected device.
 *
 * 1. drop the cached store row so the very next HTTP call re-evaluates access
 * 2. tell live sockets, so a blocked store stops immediately and a re-enabled
 *    one comes back without the user restarting anything
 */
export async function applyLicenceChangeNow(store) {
  if (!store?.id) return;
  try {
    const { invalidateStoreAuthCache } = await import('../middleware/auth.js');
    invalidateStoreAuthCache(store.id);
  } catch { /* cache is best-effort */ }
  try {
    const { evaluateAccess } = await import('./licenseService.js');
    const { broadcastLicenceChange } = await import('../ws/syncHub.js');
    const access = evaluateAccess(store);
    broadcastLicenceChange(store.id, {
      access_allowed: !access.blocked,
      access_reason: access.reason || null,
      expiry_date: store.expiry_date
        ? String(store.expiry_date).slice(0, 10)
        : null,
      is_active: store.is_active !== false,
    });
  } catch { /* ws is best-effort */ }
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

export async function listSales(storePk, { from, to, q, schedule, medicine, batch, limit = 500, offset = 0, include_total } = {}) {
  const dates = resolveListDates(from, to);
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted AND NOT is_autosave';
  if (dates.from) { params.push(dates.from); where += ` AND bill_date >= $${params.length}`; }
  if (dates.to) { params.push(dates.to); where += ` AND bill_date <= $${params.length}`; }
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (bill_no ILIKE $${params.length} OR customer_name ILIKE $${params.length} OR COALESCE(doctor_name,'') ILIKE $${params.length})`;
  }
  if (schedule && String(schedule).trim() && String(schedule).trim().toLowerCase() !== 'all') {
    const sch = String(schedule).trim();
    if (sch.toLowerCase() === 'non-scheduled') {
      where += ` AND EXISTS (
        SELECT 1 FROM sales_items si WHERE si.sale_id = sales.id
          AND (si.schedule IS NULL OR TRIM(si.schedule) = '')
      ) AND NOT EXISTS (
        SELECT 1 FROM sales_items si2 WHERE si2.sale_id = sales.id
          AND si2.schedule IS NOT NULL AND TRIM(si2.schedule) <> ''
      )`;
    } else {
      params.push(sch);
      where += ` AND EXISTS (
        SELECT 1 FROM sales_items si WHERE si.sale_id = sales.id AND si.schedule = $${params.length}
      )`;
    }
  }
  if (medicine && String(medicine).trim()) {
    params.push(`%${String(medicine).trim()}%`);
    where += ` AND EXISTS (
      SELECT 1 FROM sales_items si WHERE si.sale_id = sales.id AND COALESCE(si.name,'') ILIKE $${params.length}
    )`;
  }
  if (batch && String(batch).trim()) {
    params.push(`%${String(batch).trim()}%`);
    where += ` AND EXISTS (
      SELECT 1 FROM sales_items si WHERE si.sale_id = sales.id AND COALESCE(si.batch_no,'') ILIKE $${params.length}
    )`;
  }
  const lim = Math.min(Number(limit) || 500, 5000);
  const off = Number(offset) || 0;
  params.push(lim);
  params.push(off);
  const { rows } = await query(
    `SELECT id AS _pk, local_id AS id, bill_no, bill_date, customer_id, customer_name, total_amount,
            amount_paid, due_amount, cash_paid, online_paid, previous_due, credit_amount,
            total_due, bill_cleared, account_cleared, discount, item_count, doctor_name,
            fy_start_year, fy_serial, created_at
     FROM sales WHERE ${where}
     ORDER BY bill_date DESC, local_id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const pks = rows.map((r) => r._pk).filter((n) => Number.isFinite(Number(n)));
  const schedByPk = new Map();
  if (pks.length) {
    const { rows: sched } = await query(
      `SELECT sale_id,
              string_agg(DISTINCT NULLIF(TRIM(schedule), ''), ',' ORDER BY NULLIF(TRIM(schedule), '')) AS schedules
       FROM sales_items WHERE sale_id = ANY($1::bigint[])
       GROUP BY sale_id`,
      [pks],
    );
    for (const r of sched) schedByPk.set(Number(r.sale_id), r.schedules);
  }
  const mapped = rows.map(({ _pk, ...r }) => ({
    ...r,
    schedules: schedByPk.get(Number(_pk)) || null,
  }));
  const total = await resolveListTotal({
    table: 'sales',
    where,
    countParams: params.slice(0, -2),
    offset: off,
    limit: lim,
    pageLen: mapped.length,
    includeTotal: include_total,
  });
  return {
    rows: mapped,
    total,
    filter_from: dates.from,
    filter_to: dates.to,
    default_fy_applied: dates.defaultFy,
  };
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

export async function listPurchases(storePk, { from, to, q, schedule, medicine, batch, limit = 500, offset = 0, include_total } = {}) {
  const dates = resolveListDates(from, to);
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted AND NOT is_autosave';
  if (dates.from) { params.push(dates.from); where += ` AND purchase_date >= $${params.length}`; }
  if (dates.to) { params.push(dates.to); where += ` AND purchase_date <= $${params.length}`; }
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (purchase_no ILIKE $${params.length} OR supplier_name ILIKE $${params.length} OR bill_number ILIKE $${params.length})`;
  }
  if (schedule && String(schedule).trim() && String(schedule).trim().toLowerCase() !== 'all') {
    const sch = String(schedule).trim();
    if (sch.toLowerCase() === 'non-scheduled') {
      where += ` AND EXISTS (
        SELECT 1 FROM purchase_items pi WHERE pi.purchase_id = purchases.id
          AND (pi.schedule IS NULL OR TRIM(pi.schedule) = '')
      ) AND NOT EXISTS (
        SELECT 1 FROM purchase_items pi2 WHERE pi2.purchase_id = purchases.id
          AND pi2.schedule IS NOT NULL AND TRIM(pi2.schedule) <> ''
      )`;
    } else {
      params.push(sch);
      where += ` AND EXISTS (
        SELECT 1 FROM purchase_items pi WHERE pi.purchase_id = purchases.id AND pi.schedule = $${params.length}
      )`;
    }
  }
  if (medicine && String(medicine).trim()) {
    params.push(`%${String(medicine).trim()}%`);
    where += ` AND EXISTS (
      SELECT 1 FROM purchase_items pi WHERE pi.purchase_id = purchases.id AND COALESCE(pi.name,'') ILIKE $${params.length}
    )`;
  }
  if (batch && String(batch).trim()) {
    params.push(`%${String(batch).trim()}%`);
    where += ` AND EXISTS (
      SELECT 1 FROM purchase_items pi WHERE pi.purchase_id = purchases.id AND COALESCE(pi.batch_no,'') ILIKE $${params.length}
    )`;
  }
  const lim = Math.min(Number(limit) || 500, 5000);
  const off = Number(offset) || 0;
  params.push(lim);
  params.push(off);
  const { rows } = await query(
    `SELECT id AS _pk, local_id AS id, purchase_no, purchase_date, supplier_id, supplier_name, bill_number,
            final_amount, amount_paid, due_amount, credit_amount, total_due, bill_cleared,
            account_cleared, amount_paid_at_entry, cash_paid_at_entry, online_paid_at_entry,
            previous_due, previous_credit, overall_discount, rounding, item_count,
            fy_start_year, fy_serial, created_at
     FROM purchases WHERE ${where}
     ORDER BY purchase_date DESC, local_id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const pks = rows.map((r) => r._pk).filter((n) => Number.isFinite(Number(n)));
  const localIds = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
  const schedByPk = new Map();
  const retByLocal = new Map();
  if (pks.length) {
    const { rows: sched } = await query(
      `SELECT purchase_id,
              string_agg(DISTINCT NULLIF(TRIM(schedule), ''), ',' ORDER BY NULLIF(TRIM(schedule), '')) AS schedules
       FROM purchase_items WHERE purchase_id = ANY($1::bigint[])
       GROUP BY purchase_id`,
      [pks],
    );
    for (const r of sched) schedByPk.set(Number(r.purchase_id), r.schedules);
  }
  if (localIds.length) {
    const { rows: rets } = await query(
      `SELECT purchase_id, COALESCE(SUM(refund_amount),0)::float AS returns_amount
       FROM purchase_returns
       WHERE store_pk=$1 AND purchase_id = ANY($2::bigint[]) AND NOT deleted
       GROUP BY purchase_id`,
      [storePk, localIds],
    );
    for (const r of rets) retByLocal.set(Number(r.purchase_id), Number(r.returns_amount) || 0);
  }
  const mapped = rows.map(({ _pk, ...r }) => ({
    ...r,
    schedules: schedByPk.get(Number(_pk)) || null,
    returns_amount: Number(retByLocal.get(Number(r.id)) || 0),
  }));
  const total = await resolveListTotal({
    table: 'purchases',
    where,
    countParams: params.slice(0, -2),
    offset: off,
    limit: lim,
    pageLen: mapped.length,
    includeTotal: include_total,
  });
  return {
    rows: mapped,
    total,
    filter_from: dates.from,
    filter_to: dates.to,
    default_fy_applied: dates.defaultFy,
  };
}

export async function getPurchaseDetail(storePk, localId) {
  const { rows } = await query(
    `SELECT * FROM purchases WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (!rows[0]) throw new AppError(404, 'Purchase not found');
  const p = rows[0];
  const items = await query(`SELECT * FROM purchase_items WHERE purchase_id=$1`, [p.id]);
  const mapped = items.rows.map((it) => {
    const unit = it.unit || null;
    const tps = it.tablets_per_stripe ?? null;
    return {
      ...it,
      unit,
      tablets_per_stripe: tps,
      quantity_value: unit,
    };
  });
  return { ...p, id: p.local_id, items: mapped };
}

export async function listInventory(storePk, {
  q, low_stock, hidden, stock, type, schedule, expiry,
  limit = 200, offset = 0, include_total,
} = {}) {
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (hidden === '1' || hidden === 'true') where += ' AND is_hidden = TRUE';
  else if (hidden !== 'all') where += ' AND NOT is_hidden';
  if (low_stock) where += ' AND stock_qty <= 10';

  // ── Filters below used to run CLIENT-side over one fixed page (limit=1000),
  // so on a store with more inventory than that page they silently searched only
  // part of the catalogue. Pushing them into SQL makes them correct at any size,
  // and keeps Online behaviour identical to the Offline SQLite queries.
  const st = String(stock || '').trim().toLowerCase();
  if (st === 'in' || st === 'instock' || st === 'in_stock') where += ' AND COALESCE(stock_qty,0) > 0';
  else if (st === 'out' || st === 'outofstock' || st === 'out_of_stock') where += ' AND COALESCE(stock_qty,0) <= 0';
  else if (st === 'low') where += ' AND COALESCE(stock_qty,0) > 0 AND COALESCE(stock_qty,0) <= 10';

  if (type && String(type).trim() && String(type).trim().toLowerCase() !== 'all') {
    params.push(String(type).trim());
    where += ` AND UPPER(TRIM(COALESCE(type,''))) = UPPER(TRIM($${params.length}))`;
  }

  if (schedule && String(schedule).trim() && String(schedule).trim().toLowerCase() !== 'all') {
    const sch = String(schedule).trim();
    if (sch.toLowerCase() === 'non-scheduled') {
      where += " AND COALESCE(TRIM(schedule),'') = ''";
    } else {
      params.push(sch);
      where += ` AND UPPER(TRIM(COALESCE(schedule,''))) = UPPER(TRIM($${params.length}))`;
    }
  }

  const ex = String(expiry || '').trim().toLowerCase();
  if (ex === 'expired') where += ' AND expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE';
  else if (ex === 'near' || ex === 'nearexpiry' || ex === 'near_expiry') {
    where += " AND expiry_date IS NOT NULL AND expiry_date >= CURRENT_DATE"
           + " AND expiry_date <= CURRENT_DATE + INTERVAL '90 days'";
  }

  if (q) {
    params.push(`%${q}%`);
    where += ` AND (name ILIKE $${params.length} OR batch_no ILIKE $${params.length} OR manufacturer ILIKE $${params.length})`;
  }
  const lim = Math.min(Number(limit) || 200, 10000);
  const off = Number(offset) || 0;
  params.push(lim);
  params.push(off);
  const { rows } = await query(
    `SELECT local_id AS id, name, type, stock_qty, unit, gst_percent, mrp, rate, manufacturer,
            batch_no, expiry_date, hsn_code, schedule, location, is_hidden, updated_at,
            -- version and content_drug are needed by clients that EDIT a medicine.
            -- Without version, a client building an update from this response
            -- stamped version 1 against a server copy several versions ahead, so
            -- every edit was refused as "your copy is out of date" -- permanently,
            -- because refetching returned a version-less row again.
            version, content_drug, client_uuid
     FROM medicines WHERE ${where}
     ORDER BY name, batch_no
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = await resolveListTotal({
    table: 'medicines',
    where,
    countParams: params.slice(0, -2),
    offset: off,
    limit: lim,
    pageLen: rows.length,
    includeTotal: include_total,
  });
  return { rows, total };
}

export async function listCustomers(storePk, { q, dues_only, limit = 200, offset = 0, include_total } = {}) {
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (dues_only) where += ' AND total_due > 0';
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length} OR address ILIKE $${params.length})`;
  }
  const lim = Math.min(Number(limit) || 200, 10000);
  const off = Number(offset) || 0;
  params.push(lim);
  params.push(off);
  const { rows } = await query(
    `SELECT local_id AS id, name, phone, address, total_due, total_credit, created_at
     FROM customers WHERE ${where}
     ORDER BY name
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = await resolveListTotal({
    table: 'customers',
    where,
    countParams: params.slice(0, -2),
    offset: off,
    limit: lim,
    pageLen: rows.length,
    includeTotal: include_total,
  });
  return { rows, total };
}

export async function listSuppliers(storePk, { q, dues_only, limit = 200, offset = 0, include_total } = {}) {
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (dues_only) where += ' AND total_due > 0';
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length})`;
  }
  const lim = Math.min(Number(limit) || 200, 10000);
  const off = Number(offset) || 0;
  params.push(lim);
  params.push(off);
  const { rows } = await query(
    `SELECT local_id AS id, name, phone, address, gstin, dl_numbers, total_due, total_credit
     FROM suppliers WHERE ${where}
     ORDER BY name
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = await resolveListTotal({
    table: 'suppliers',
    where,
    countParams: params.slice(0, -2),
    offset: off,
    limit: lim,
    pageLen: rows.length,
    includeTotal: include_total,
  });
  return { rows, total };
}

export async function listDoctors(storePk, { q, limit = 200, offset = 0, include_total } = {}) {
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length} OR COALESCE(registration_number,'') ILIKE $${params.length})`;
  }
  const lim = Math.min(Number(limit) || 200, 10000);
  const off = Number(offset) || 0;
  params.push(lim);
  params.push(off);
  const { rows } = await query(
    `SELECT local_id AS id, name, phone, registration_number, created_at
     FROM doctors WHERE ${where}
     ORDER BY name
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = await resolveListTotal({
    table: 'doctors',
    where,
    countParams: params.slice(0, -2),
    offset: off,
    limit: lim,
    pageLen: rows.length,
    includeTotal: include_total,
  });
  return { rows, total };
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
