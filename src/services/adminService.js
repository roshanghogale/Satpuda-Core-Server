import { query } from '../db/pool.js';
import { AppError } from '../utils/http.js';
import { parseVoiceTier, VOICE_TIERS } from './licenseService.js';
import {
  generateAndroidKey,
  slugifyStoreId,
  storeKeyFromName,
  fyStartYearForDate,
  fyDateBounds,
} from '../utils/fy.js';
import {
  dateOnly,
  intOrNull,
  boolOrNull,
  textOrNull,
  orderBy,
  billStatus,
  paymentModeSql,
  stockValueSql,
  expiryCutoffSql,
  billGstCte,
  SALES_SORTS,
  PURCHASES_SORTS,
  INVENTORY_SORTS,
  CUSTOMER_SORTS,
  PARTY_SORTS,
  DOCTOR_SORTS,
  PAYMENT_SORTS,
  RETURN_SORTS,
} from './adminFilters.js';

/** Default Online history window = current Indian FY (01 Apr – 31 Mar), same as Offline. */
function resolveListDates(from, to) {
  const fd = from ? String(from).trim().slice(0, 10) : '';
  const td = to ? String(to).trim().slice(0, 10) : '';
  if (fd || td) return { from: fd || null, to: td || null, defaultFy: false };
  const [a, b] = fyDateBounds(fyStartYearForDate(new Date()));
  return { from: a, to: b, defaultFy: true };
}

/**
 * Date window for the lists that never had one: payments and returns.
 *
 * Deliberately NOT resolveListDates. Those endpoints answered the whole history
 * (newest 200) before a date filter existed here, and defaulting them to the
 * current FY would quietly hide a shop's older payments from a panel that never
 * asked for a window. from/to are honoured when given and ignored when not.
 */
function resolveOpenDates(from, to) {
  return { from: dateOnly(from), to: dateOnly(to), defaultFy: false };
}

/**
 * The `deleted` predicate for sales / purchases.
 *
 * Default is unchanged (`NOT deleted`). `status=deleted` shows only deleted
 * rows and `include_deleted` shows both, so the owner can finally see a bill
 * that was voided instead of having to take its absence on trust.
 */
function deletedPredicate({ statusDeleted, includeDeleted }) {
  if (includeDeleted === true) return null;
  return statusDeleted ? 'deleted' : 'NOT deleted';
}

/** A free-text ILIKE over a fixed column list; `params` is appended to in place. */
function pushLike(params, where, q, columns) {
  params.push(`%${q}%`);
  const n = params.length;
  const parts = columns.map((c) => `${c} ILIKE $${n}`);
  return `${where} AND (${parts.join(' OR ')})`;
}

function wantExactTotal(includeTotal) {
  return !(includeTotal === false || includeTotal === '0' || includeTotal === 0);
}

/**
 * Whether a list works out its whole-range `summary`.
 *
 * On unless the caller says no (include_summary=0/false/no/off). The admin panel's
 * tiles read it and its routes pass nothing, so they keep it. The shop routes
 * (routes/storeQuery.js) turn it off unless the shop asks: no desktop or Android
 * build reads `summary`, and on a big store the sales one rebuilds printed GST over
 * the whole financial year for every page a client loops through. When it is off
 * the key is left out entirely -- never a zeroed object a client could take for a
 * real total.
 */
function wantSummary(includeSummary) {
  return boolOrNull(includeSummary) !== false;
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
  //
  // One exception, and it used to be a lie: an EMPTY page past the end of the
  // result set is short too, and `offset + 0` then reported the offset as the
  // total -- offset=500 over six rows answered "total 500". A page that
  // returned nothing at a non-zero offset knows nothing about the total, so it
  // asks, and only a caller that opted out of the count gets the old guess.
  if (pageLen === 0 && offset > 0 && wantExactTotal(includeTotal)) {
    const countRes = await query(
      `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`,
      countParams,
    );
    return Number(countRes.rows[0].n) || 0;
  }
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
       -- A self-service trial is a store a STRANGER may have created, so the
       -- list has to say so, and has to carry enough to judge it without
       -- opening the store: who asked, from where, and how many days are left.
       p.device_id AS trial_device_id,
       p.ip        AS trial_ip,
       p.created_at AS trial_created_at,
       CASE WHEN s.expiry_enabled AND s.expiry_date IS NOT NULL
            THEN (s.expiry_date - (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
       END AS days_left,
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
     LEFT JOIN LATERAL (
       SELECT device_id, ip, created_at FROM store_provisions sp
        WHERE sp.store_pk = s.id ORDER BY sp.created_at DESC LIMIT 1
     ) p ON TRUE
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
  // Voice assistant switch. Strict on purpose: Boolean('false') is true, so a
  // string here would silently turn voice ON for a shop.
  if (patch.voice_enabled !== undefined) {
    if (typeof patch.voice_enabled !== 'boolean') {
      throw new AppError(400, 'voice_enabled must be true or false');
    }
    fields.push(`voice_enabled = $${i++}`);
    vals.push(patch.voice_enabled);
  }
  if (patch.voice_tier !== undefined) {
    const tier = parseVoiceTier(patch.voice_tier);
    if (!tier) throw new AppError(400, `voice_tier must be one of ${VOICE_TIERS.join(', ')}`);
    fields.push(`voice_tier = $${i++}`);
    vals.push(tier);
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

export async function listSales(storePk, {
  from, to, q, schedule, medicine, batch,
  status, customer_id, party_id, sort, q_phone, include_deleted,
  limit = 500, offset = 0, include_total, include_summary,
} = {}) {
  const dates = resolveListDates(from, to);
  const st = billStatus(status);
  const params = [storePk];
  const del = deletedPredicate({
    statusDeleted: st.deleted,
    includeDeleted: boolOrNull(include_deleted) === true,
  });
  let where = `store_pk=$1${del ? ` AND ${del}` : ''} AND NOT is_autosave`;
  if (dates.from) { params.push(dates.from); where += ` AND bill_date >= $${params.length}`; }
  if (dates.to) { params.push(dates.to); where += ` AND bill_date <= $${params.length}`; }
  if (q) {
    // customer_phone is new here. It only ever ADDS rows -- a bill that matched
    // before still matches -- and `q_phone=0` reproduces the pre-2026-09-16
    // column list exactly, for a caller that wants the old result set byte for
    // byte. Searching a shop's history by the number on the customer's phone is
    // the whole point of the owner's "all filters" ask.
    const cols = ['bill_no', 'customer_name', "COALESCE(doctor_name,'')"];
    if (boolOrNull(q_phone) !== false) cols.push("COALESCE(customer_phone,'')");
    where = pushLike(params, where, q, cols);
  }
  if (st.sql) where += ` AND ${st.sql}`;
  const partyId = intOrNull(customer_id ?? party_id, { min: 0 });
  if (partyId !== null) { params.push(partyId); where += ` AND customer_id = $${params.length}`; }
  if (schedule && String(schedule).trim() && String(schedule).trim().toLowerCase() !== 'all') {
    const sch = String(schedule).trim();
    if (sch.toLowerCase() === 'non-scheduled') {
      // COALESCE onto the medicines master, the same rule listPurchases uses.
      // A sale line written by the Online desktop carries no schedule of its
      // own -- save_new_sale_online never sent one -- so judging the line
      // alone called every one of those bills "not scheduled", and answered
      // every NAMED schedule with nothing at all. Resolving through the master
      // fixes the bills already written, which the shop cannot re-enter.
      where += ` AND EXISTS (
        SELECT 1 FROM sales_items si
          LEFT JOIN medicines m ON m.store_pk = si.store_pk AND m.local_id = si.medicine_id
         WHERE si.sale_id = sales.id
           AND COALESCE(NULLIF(BTRIM(si.schedule), ''), NULLIF(BTRIM(m.schedule), '')) IS NULL
      ) AND NOT EXISTS (
        SELECT 1 FROM sales_items si2
          LEFT JOIN medicines m2 ON m2.store_pk = si2.store_pk AND m2.local_id = si2.medicine_id
         WHERE si2.sale_id = sales.id
           AND COALESCE(NULLIF(BTRIM(si2.schedule), ''), NULLIF(BTRIM(m2.schedule), '')) IS NOT NULL
      )`;
    } else {
      params.push(sch);
      where += ` AND EXISTS (
        SELECT 1 FROM sales_items si
          LEFT JOIN medicines m ON m.store_pk = si.store_pk AND m.local_id = si.medicine_id
         WHERE si.sale_id = sales.id
           AND COALESCE(NULLIF(BTRIM(si.schedule), ''), BTRIM(m.schedule)) = $${params.length}
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
            fy_start_year, fy_serial, created_at, deleted
     FROM sales WHERE ${where}
     ORDER BY ${orderBy(SALES_SORTS, sort, 'date_desc')}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const pks = rows.map((r) => r._pk).filter((n) => Number.isFinite(Number(n)));
  const schedByPk = new Map();
  if (pks.length) {
    const { rows: sched } = await query(
      // Resolved the same way the filter above resolves, or the row's Schedule
      // chip would read blank on a bill the H1 filter had just matched.
      `SELECT si.sale_id,
              string_agg(DISTINCT COALESCE(NULLIF(BTRIM(si.schedule), ''), NULLIF(BTRIM(m.schedule), '')), ','
                         ORDER BY COALESCE(NULLIF(BTRIM(si.schedule), ''), NULLIF(BTRIM(m.schedule), ''))) AS schedules
       FROM sales_items si
       LEFT JOIN medicines m ON m.store_pk = si.store_pk AND m.local_id = si.medicine_id
       WHERE si.sale_id = ANY($1::bigint[])
       GROUP BY si.sale_id`,
      [pks],
    );
    for (const r of sched) schedByPk.set(Number(r.sale_id), r.schedules);
  }
  const mapped = rows.map(({ _pk, ...r }) => ({
    ...r,
    schedules: schedByPk.get(Number(_pk)) || null,
  }));
  const filterParams = params.slice(0, -2);
  const withSummary = wantSummary(include_summary);
  const [total, summary] = await Promise.all([
    resolveListTotal({
      table: 'sales',
      where,
      countParams: filterParams,
      offset: off,
      limit: lim,
      pageLen: mapped.length,
      includeTotal: include_total,
    }),
    withSummary ? salesRangeSummary(where, filterParams) : null,
  ]);
  return {
    rows: mapped,
    total,
    ...(withSummary ? { summary } : {}),
    filter_from: dates.from,
    filter_to: dates.to,
    default_fy_applied: dates.defaultFy,
  };
}

/**
 * Sales totals over the WHOLE filtered range, in one round trip.
 *
 * `where` is the same predicate the page was fetched with, so the tiles and the
 * rows can never describe different sets of bills. Nothing here looks at the
 * page: adding up 200 rows and calling it the year's turnover is the bug this
 * function exists to make impossible.
 *
 * GST is the figure the bills PRINTED -- see billGstCte -- because that is the
 * number the shop's returns are filed from; sales carry no GST column of their
 * own, and Online bills written before 2026-09-13 carry no line rate either, so
 * the rate falls back to the medicine's current one exactly as a reprint does.
 */
async function salesRangeSummary(where, filterParams) {
  const { rows } = await query(
    `WITH f AS (
       SELECT id, local_id, total_amount, discount, amount_paid, due_amount,
              cash_paid, online_paid, total_due
         FROM sales WHERE ${where}
     ),
     ${billGstCte('f')},
     _items AS (
       SELECT COALESCE(SUM(si.item_discount),0)::numeric AS item_discount
         FROM sales_items si JOIN f ON f.id = si.sale_id
     ),
     _ret AS (
       SELECT COALESCE(SUM(sr.refund_amount),0)::numeric AS refunds
         FROM sales_returns sr JOIN f ON f.local_id = sr.sale_id
        WHERE sr.store_pk = $1 AND NOT sr.deleted
     )
     SELECT (SELECT COUNT(*)::int FROM f)                                  AS rows,
            (SELECT COUNT(*)::int FROM f)                                  AS bills,
            (SELECT COALESCE(SUM(total_amount),0)::float FROM f)           AS gross,
            (SELECT COALESCE(SUM(discount),0)::numeric FROM f)
              + (SELECT item_discount FROM _items)                         AS discount,
            (SELECT COALESCE(SUM(discount),0)::float FROM f)               AS bill_discount,
            (SELECT item_discount::float FROM _items)                      AS item_discount,
            (SELECT tax::float FROM _gst_total)                            AS gst,
            (SELECT taxable::float FROM _gst_total)                        AS taxable,
            (SELECT COALESCE(SUM(amount_paid),0)::float FROM f)            AS paid,
            (SELECT COALESCE(SUM(due_amount),0)::float FROM f)             AS due,
            (SELECT COALESCE(SUM(cash_paid),0)::float FROM f)              AS cash,
            (SELECT COALESCE(SUM(online_paid),0)::float FROM f)            AS online,
            (SELECT refunds::float FROM _ret)                              AS returns`,
    filterParams,
  );
  const r = rows[0] || {};
  return {
    rows: Number(r.rows || 0),
    bills: Number(r.bills || 0),
    gross: round2(r.gross),
    discount: round2(r.discount),
    bill_discount: round2(r.bill_discount),
    item_discount: round2(r.item_discount),
    gst: round2(r.gst),
    taxable: round2(r.taxable),
    paid: round2(r.paid),
    due: round2(r.due),
    cash: round2(r.cash),
    online: round2(r.online),
    returns: round2(r.returns),
  };
}

/** Money out of SQL is a float; two places is what every one of these figures is. */
function round2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
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

export async function listPurchases(storePk, {
  from, to, q, schedule, medicine, batch,
  status, supplier_id, party_id, sort, q_phone, include_deleted,
  limit = 500, offset = 0, include_total, include_summary,
} = {}) {
  const dates = resolveListDates(from, to);
  const st = billStatus(status);
  const params = [storePk];
  const del = deletedPredicate({
    statusDeleted: st.deleted,
    includeDeleted: boolOrNull(include_deleted) === true,
  });
  let where = `store_pk=$1${del ? ` AND ${del}` : ''} AND NOT is_autosave`;
  if (dates.from) { params.push(dates.from); where += ` AND purchase_date >= $${params.length}`; }
  if (dates.to) { params.push(dates.to); where += ` AND purchase_date <= $${params.length}`; }
  if (q) {
    // supplier_phone added for the same reason customer_phone was added to
    // listSales, with the same `q_phone=0` way back to the old column list.
    const cols = ['purchase_no', 'supplier_name', 'bill_number'];
    if (boolOrNull(q_phone) !== false) cols.push("COALESCE(supplier_phone,'')");
    where = pushLike(params, where, q, cols);
  }
  if (st.sql) where += ` AND ${st.sql}`;
  const partyId = intOrNull(supplier_id ?? party_id, { min: 0 });
  if (partyId !== null) { params.push(partyId); where += ` AND supplier_id = $${params.length}`; }
  if (schedule && String(schedule).trim() && String(schedule).trim().toLowerCase() !== 'all') {
    const sch = String(schedule).trim();
    if (sch.toLowerCase() === 'non-scheduled') {
      // COALESCE onto the medicines master: a line pushed before the desktop
      // started sending pi.schedule has none of its own, and treating that as
      // "not scheduled" is what made this filter answer with the whole history.
      where += ` AND EXISTS (
        SELECT 1 FROM purchase_items pi
          LEFT JOIN medicines m ON m.store_pk = pi.store_pk AND m.local_id = pi.medicine_id
         WHERE pi.purchase_id = purchases.id
           AND COALESCE(NULLIF(BTRIM(pi.schedule), ''), NULLIF(BTRIM(m.schedule), '')) IS NULL
      ) AND NOT EXISTS (
        SELECT 1 FROM purchase_items pi2
          LEFT JOIN medicines m2 ON m2.store_pk = pi2.store_pk AND m2.local_id = pi2.medicine_id
         WHERE pi2.purchase_id = purchases.id
           AND COALESCE(NULLIF(BTRIM(pi2.schedule), ''), NULLIF(BTRIM(m2.schedule), '')) IS NOT NULL
      )`;
    } else {
      params.push(sch);
      where += ` AND EXISTS (
        SELECT 1 FROM purchase_items pi
          LEFT JOIN medicines m ON m.store_pk = pi.store_pk AND m.local_id = pi.medicine_id
         WHERE pi.purchase_id = purchases.id
           AND COALESCE(NULLIF(BTRIM(pi.schedule), ''), BTRIM(m.schedule)) = $${params.length}
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
            fy_start_year, fy_serial, created_at, deleted
     FROM purchases WHERE ${where}
     ORDER BY ${orderBy(PURCHASES_SORTS, sort, 'date_desc')}
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
  const filterParams = params.slice(0, -2);
  const withSummary = wantSummary(include_summary);
  const [total, summary] = await Promise.all([
    resolveListTotal({
      table: 'purchases',
      where,
      countParams: filterParams,
      offset: off,
      limit: lim,
      pageLen: mapped.length,
      includeTotal: include_total,
    }),
    withSummary ? purchasesRangeSummary(where, filterParams) : null,
  ]);
  return {
    rows: mapped,
    total,
    ...(withSummary ? { summary } : {}),
    filter_from: dates.from,
    filter_to: dates.to,
    default_fy_applied: dates.defaultFy,
  };
}

/**
 * Purchase totals over the whole filtered range.
 *
 * Unlike a sale, a purchase carries its own tax columns (the supplier's bill
 * said so), so `gst` here is purchases.total_gst summed -- not re-derived.
 */
async function purchasesRangeSummary(where, filterParams) {
  const { rows } = await query(
    `WITH f AS (
       SELECT id, local_id, final_amount, total_amount, total_gst, overall_discount,
              amount_paid, due_amount, total_due
         FROM purchases WHERE ${where}
     ),
     _ret AS (
       SELECT COALESCE(SUM(pr.refund_amount),0)::numeric AS refunds
         FROM purchase_returns pr JOIN f ON f.local_id = pr.purchase_id
        WHERE pr.store_pk = $1 AND NOT pr.deleted
     )
     SELECT (SELECT COUNT(*)::int FROM f)                             AS rows,
            (SELECT COUNT(*)::int FROM f)                             AS bills,
            (SELECT COALESCE(SUM(final_amount),0)::float FROM f)      AS total,
            (SELECT COALESCE(SUM(total_amount),0)::float FROM f)      AS gross,
            (SELECT COALESCE(SUM(total_gst),0)::float FROM f)         AS gst,
            (SELECT COALESCE(SUM(overall_discount),0)::float FROM f)  AS discount,
            (SELECT COALESCE(SUM(amount_paid),0)::float FROM f)       AS paid,
            (SELECT COALESCE(SUM(due_amount),0)::float FROM f)        AS due,
            (SELECT refunds::float FROM _ret)                         AS returns`,
    filterParams,
  );
  const r = rows[0] || {};
  return {
    rows: Number(r.rows || 0),
    bills: Number(r.bills || 0),
    total: round2(r.total),
    gross: round2(r.gross),
    gst: round2(r.gst),
    discount: round2(r.discount),
    paid: round2(r.paid),
    due: round2(r.due),
    returns: round2(r.returns),
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
  manufacturer, expiring_days, expiry_exact, sort,
  limit = 200, offset = 0, include_total, include_summary,
} = {}) {
  const params = [storePk];
  // How many days "expiring soon" means, for BOTH the filter (expiry=expiring)
  // and the summary tile. 30 is the shop's reorder horizon; expiry=near keeps
  // its old fixed 90 so an existing caller sees no change.
  const expDays = intOrNull(expiring_days, { min: 1, max: 3650 }) ?? 30;
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
  // `out` has always meant "nothing to sell", which lumps a clean zero in with
  // a negative. A negative row is a DATA problem -- stock the shop sold twice,
  // or a purchase that never arrived -- and the owner has to be able to list
  // exactly those, so zero and negative are now separable without changing
  // what `out` answers.
  else if (st === 'zero' || st === 'zero_stock') where += ' AND COALESCE(stock_qty,0) = 0';
  else if (st === 'negative' || st === 'neg') where += ' AND COALESCE(stock_qty,0) < 0';

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

  // Pharmacy expiry is written per month ("09/26") and stored on day 01, but
  // such a batch is good until the 30th. Every tile in this product already
  // reads it that way (storeSummaries.inventorySummary, and the desktop it
  // mirrors); this filter did not, so the "Expired" list and the "Expired" tile
  // disagreed by up to a month of saleable stock on the same screen. They now
  // use one rule, and `expiry_exact=1` compares the stored date with no
  // month-end grace for a caller that wants the old literal comparison.
  const exactExpiry = boolOrNull(expiry_exact) === true;
  const expCol = exactExpiry ? 'expiry_date' : expiryCutoffSql('expiry_date');
  const ex = String(expiry || '').trim().toLowerCase();
  if (ex === 'expired') where += ` AND expiry_date IS NOT NULL AND ${expCol} < CURRENT_DATE`;
  else if (ex === 'near' || ex === 'nearexpiry' || ex === 'near_expiry') {
    where += ` AND expiry_date IS NOT NULL AND ${expCol} >= CURRENT_DATE`
           + ` AND ${expCol} <= CURRENT_DATE + INTERVAL '90 days'`;
  } else if (ex === 'expiring' || ex === 'expiring_soon' || ex === 'expiring_in') {
    // The caller's own horizon, and the one the summary tile counts to.
    params.push(expDays);
    where += ` AND expiry_date IS NOT NULL AND ${expCol} >= CURRENT_DATE`
           + ` AND ${expCol} <= CURRENT_DATE + $${params.length}::int`;
  } else if (ex === 'ok' || ex === 'fresh' || ex === 'not_expiring') {
    params.push(expDays);
    where += ` AND (expiry_date IS NULL OR ${expCol} > CURRENT_DATE + $${params.length}::int)`;
  }

  if (manufacturer && String(manufacturer).trim()) {
    params.push(`%${String(manufacturer).trim()}%`);
    where += ` AND COALESCE(manufacturer,'') ILIKE $${params.length}`;
  }

  if (q) {
    where = pushLike(params, where, q, ['name', 'batch_no', 'manufacturer']);
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
     ORDER BY ${orderBy(INVENTORY_SORTS, sort, 'name')}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const filterParams = params.slice(0, -2);
  const withSummary = wantSummary(include_summary);
  const [total, summary] = await Promise.all([
    resolveListTotal({
      table: 'medicines',
      where,
      countParams: filterParams,
      offset: off,
      limit: lim,
      pageLen: rows.length,
      includeTotal: include_total,
    }),
    withSummary ? inventoryRangeSummary(where, filterParams, expDays, expCol) : null,
  ]);
  return { rows, total, ...(withSummary ? { summary } : {}) };
}

/**
 * Inventory totals over the whole filtered range.
 *
 * Stock value is NOT qty x mrp. A strip medicine's MRP is the price of a strip
 * while its stock is counted in tablets, so both the retail and the cost figure
 * divide by the tablets per strip -- see adminFilters.stockValueSql, which is a
 * transcription of the desktop's own rule. Getting this wrong is not academic:
 * it once put the owner's Stock Value tile Rs 609 above the desktop's on a
 * single row.
 *
 * The expiry counts read a batch dated on the 1st as good to the end of that
 * month, the same way storeSummaries.inventorySummary does, because pharmacy
 * expiry is written per month ("09/26") and stored on day 01.
 */
async function inventoryRangeSummary(where, filterParams, expDays, cutoff) {
  const params = [...filterParams, expDays];
  const n = params.length;
  const { rows } = await query(
    `SELECT COUNT(*)::int AS rows,
            COALESCE(SUM(COALESCE(stock_qty,0)),0)::float AS total_stock,
            ROUND(COALESCE(SUM(${stockValueSql('stock_qty', 'mrp', 'type', "COALESCE(unit,'1')")}),0),2)::float
              AS stock_value_mrp,
            ROUND(COALESCE(SUM(${stockValueSql('stock_qty', 'rate', 'type', "COALESCE(unit,'1')")}),0),2)::float
              AS stock_value_cost,
            COUNT(*) FILTER (WHERE COALESCE(stock_qty,0) = 0)::int AS zero_stock_rows,
            COUNT(*) FILTER (WHERE COALESCE(stock_qty,0) < 0)::int AS negative_stock_rows,
            COUNT(*) FILTER (WHERE COALESCE(stock_qty,0) > 0 AND COALESCE(stock_qty,0) <= 10)::int
              AS low_stock_rows,
            COUNT(*) FILTER (WHERE COALESCE(stock_qty,0) > 0)::int AS in_stock_rows,
            COUNT(*) FILTER (WHERE expiry_date IS NOT NULL AND ${cutoff} < CURRENT_DATE)::int
              AS expired_rows,
            COUNT(*) FILTER (WHERE expiry_date IS NOT NULL
                               AND ${cutoff} >= CURRENT_DATE
                               AND ${cutoff} <= CURRENT_DATE + $${n}::int)::int AS expiring_soon
       FROM medicines WHERE ${where}`,
    params,
  );
  const r = rows[0] || {};
  return {
    rows: Number(r.rows || 0),
    total_stock: round2(r.total_stock),
    stock_value_mrp: round2(r.stock_value_mrp),
    stock_value_cost: round2(r.stock_value_cost),
    in_stock_rows: Number(r.in_stock_rows || 0),
    zero_stock_rows: Number(r.zero_stock_rows || 0),
    negative_stock_rows: Number(r.negative_stock_rows || 0),
    low_stock_rows: Number(r.low_stock_rows || 0),
    expired_rows: Number(r.expired_rows || 0),
    expiring_soon: Number(r.expiring_soon || 0),
    expiring_days: expDays,
  };
}

/**
 * The "has due" / "has credit" pair, shared by customers and suppliers.
 *
 * `dues_only` is the old name and keeps working untouched; `has_due` is the
 * same thing under the name the rest of the new filters use. `has_due=0` is
 * the useful inverse the panel never had: the parties who are square.
 */
function partyBalanceWhere(where, { dues_only, has_due, has_credit }) {
  let out = where;
  if (dues_only) out += ' AND total_due > 0';
  const due = boolOrNull(has_due);
  if (due === true) out += ' AND COALESCE(total_due,0) > 0';
  else if (due === false) out += ' AND COALESCE(total_due,0) <= 0';
  const credit = boolOrNull(has_credit);
  if (credit === true) out += ' AND COALESCE(total_credit,0) > 0';
  else if (credit === false) out += ' AND COALESCE(total_credit,0) <= 0';
  return out;
}

/** Due / credit totals over the whole filtered range of a party table. */
async function partyRangeSummary(table, where, filterParams) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS rows,
            COALESCE(SUM(GREATEST(COALESCE(total_due,0),0)),0)::float AS total_due,
            COALESCE(SUM(GREATEST(COALESCE(total_credit,0),0)),0)::float AS total_credit,
            COUNT(*) FILTER (WHERE COALESCE(total_due,0) > 0)::int AS with_due,
            COUNT(*) FILTER (WHERE COALESCE(total_credit,0) > 0)::int AS with_credit
       FROM ${table} WHERE ${where}`,
    filterParams,
  );
  const r = rows[0] || {};
  return {
    rows: Number(r.rows || 0),
    total_due: round2(r.total_due),
    total_credit: round2(r.total_credit),
    with_due: Number(r.with_due || 0),
    with_credit: Number(r.with_credit || 0),
  };
}

export async function listCustomers(storePk, {
  q, dues_only, has_due, has_credit, sort,
  limit = 200, offset = 0, include_total, include_summary,
} = {}) {
  const params = [storePk];
  let where = partyBalanceWhere('store_pk=$1 AND NOT deleted', { dues_only, has_due, has_credit });
  if (q) {
    where = pushLike(params, where, q, ['name', 'phone', 'address']);
  }
  const lim = Math.min(Number(limit) || 200, 10000);
  const off = Number(offset) || 0;
  params.push(lim);
  params.push(off);
  const { rows } = await query(
    `SELECT local_id AS id, name, phone, address, total_due, total_credit, created_at
     FROM customers WHERE ${where}
     ORDER BY ${orderBy(CUSTOMER_SORTS, sort, 'name')}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const filterParams = params.slice(0, -2);
  const withSummary = wantSummary(include_summary);
  const [total, summary] = await Promise.all([
    resolveListTotal({
      table: 'customers',
      where,
      countParams: filterParams,
      offset: off,
      limit: lim,
      pageLen: rows.length,
      includeTotal: include_total,
    }),
    withSummary ? partyRangeSummary('customers', where, filterParams) : null,
  ]);
  return { rows, total, ...(withSummary ? { summary } : {}) };
}

export async function listSuppliers(storePk, {
  q, dues_only, has_due, has_credit, sort,
  limit = 200, offset = 0, include_total, include_summary,
} = {}) {
  const params = [storePk];
  let where = partyBalanceWhere('store_pk=$1 AND NOT deleted', { dues_only, has_due, has_credit });
  if (q) {
    where = pushLike(params, where, q, ['name', 'phone']);
  }
  const lim = Math.min(Number(limit) || 200, 10000);
  const off = Number(offset) || 0;
  params.push(lim);
  params.push(off);
  const { rows } = await query(
    `SELECT local_id AS id, name, phone, address, gstin, dl_numbers, total_due, total_credit
     FROM suppliers WHERE ${where}
     ORDER BY ${orderBy(PARTY_SORTS, sort, 'name')}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const filterParams = params.slice(0, -2);
  const withSummary = wantSummary(include_summary);
  const [total, summary] = await Promise.all([
    resolveListTotal({
      table: 'suppliers',
      where,
      countParams: filterParams,
      offset: off,
      limit: lim,
      pageLen: rows.length,
      includeTotal: include_total,
    }),
    withSummary ? partyRangeSummary('suppliers', where, filterParams) : null,
  ]);
  return { rows, total, ...(withSummary ? { summary } : {}) };
}

export async function listDoctors(storePk, {
  q, sort, limit = 200, offset = 0, include_total, include_summary,
} = {}) {
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (q) {
    where = pushLike(params, where, q, ['name', 'phone', "COALESCE(registration_number,'')"]);
  }
  const lim = Math.min(Number(limit) || 200, 10000);
  const off = Number(offset) || 0;
  params.push(lim);
  params.push(off);
  const { rows } = await query(
    `SELECT local_id AS id, name, phone, registration_number, created_at
     FROM doctors WHERE ${where}
     ORDER BY ${orderBy(DOCTOR_SORTS, sort, 'name')}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const filterParams = params.slice(0, -2);
  const withSummary = wantSummary(include_summary);
  const [total, counted] = await Promise.all([
    resolveListTotal({
      table: 'doctors',
      where,
      countParams: filterParams,
      offset: off,
      limit: lim,
      pageLen: rows.length,
      includeTotal: include_total,
    }),
    withSummary ? query(`SELECT COUNT(*)::int AS n FROM doctors WHERE ${where}`, filterParams) : null,
  ]);
  return {
    rows,
    total,
    ...(withSummary ? { summary: { rows: Number(counted.rows[0]?.n || 0) } } : {}),
  };
}

// ─── Payments and returns ─────────────────────────────────────────────────────
// These four lists used to be inline SQL in routes/admin.js with a hard
// LIMIT 200 and no filters at all -- the owner could see a shop's newest two
// hundred payments and nothing else, with no way to ask "what did this customer
// pay me in August". Defaults below are exactly that old query (no date window,
// same order, same 200) so the panel on live keeps answering identically.

export async function listCustomerPayments(storePk, {
  from, to, q, customer_id, party_id, mode, sort,
  limit = 200, offset = 0, include_total,
} = {}) {
  const dates = resolveOpenDates(from, to);
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (dates.from) { params.push(dates.from); where += ` AND payment_date >= $${params.length}`; }
  if (dates.to) { params.push(dates.to); where += ` AND payment_date <= $${params.length}`; }
  const partyId = intOrNull(customer_id ?? party_id, { min: 0 });
  if (partyId !== null) { params.push(partyId); where += ` AND customer_id = $${params.length}`; }
  const modeSql = paymentModeSql('payment_mode', mode, {
    splitColumns: { cash: 'cash_amount', online: 'online_amount' },
  });
  if (modeSql) where += ` AND ${modeSql}`;
  if (textOrNull(q)) {
    where = pushLike(params, where, String(q).trim(), [
      "COALESCE(customer_name,'')", "COALESCE(reference_no,'')", "COALESCE(note,'')",
    ]);
  }
  const lim = Math.min(Number(limit) || 200, 5000);
  const off = Number(offset) || 0;
  params.push(lim);
  params.push(off);
  const { rows } = await query(
    `SELECT local_id AS id, customer_id, customer_name, payment_date, amount, payment_mode,
            cash_amount, online_amount, reference_no, note, created_at
     FROM customer_payments WHERE ${where}
     ORDER BY ${orderBy(PAYMENT_SORTS, sort, 'date_desc')}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const filterParams = params.slice(0, -2);
  const [total, summary] = await Promise.all([
    resolveListTotal({
      table: 'customer_payments',
      where,
      countParams: filterParams,
      offset: off,
      limit: lim,
      pageLen: rows.length,
      includeTotal: include_total,
    }),
    paymentRangeSummary('customer_payments', where, filterParams, {
      modeColumn: 'payment_mode',
      cashColumn: 'cash_amount',
      onlineColumn: 'online_amount',
    }),
  ]);
  return { rows, total, summary, filter_from: dates.from, filter_to: dates.to };
}

export async function listSupplierPayments(storePk, {
  from, to, q, supplier_id, party_id, mode, sort,
  limit = 200, offset = 0, include_total,
} = {}) {
  const dates = resolveOpenDates(from, to);
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (dates.from) { params.push(dates.from); where += ` AND payment_date >= $${params.length}`; }
  if (dates.to) { params.push(dates.to); where += ` AND payment_date <= $${params.length}`; }
  const partyId = intOrNull(supplier_id ?? party_id, { min: 0 });
  if (partyId !== null) { params.push(partyId); where += ` AND supplier_id = $${params.length}`; }
  const modeSql = paymentModeSql('mode', mode);
  if (modeSql) where += ` AND ${modeSql}`;
  if (textOrNull(q)) {
    where = pushLike(params, where, String(q).trim(), [
      'payment_no', "COALESCE(supplier_name,'')", "COALESCE(reference,'')",
    ]);
  }
  const lim = Math.min(Number(limit) || 200, 5000);
  const off = Number(offset) || 0;
  params.push(lim);
  params.push(off);
  const { rows } = await query(
    `SELECT local_id AS id, payment_no, supplier_id, supplier_name, payment_date, amount, mode,
            reference, due_before, due_after, created_at
     FROM supplier_payments WHERE ${where}
     ORDER BY ${orderBy(PAYMENT_SORTS, sort, 'date_desc')}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const filterParams = params.slice(0, -2);
  const [total, summary] = await Promise.all([
    resolveListTotal({
      table: 'supplier_payments',
      where,
      countParams: filterParams,
      offset: off,
      limit: lim,
      pageLen: rows.length,
      includeTotal: include_total,
    }),
    paymentRangeSummary('supplier_payments', where, filterParams, { modeColumn: 'mode' }),
  ]);
  return { rows, total, summary, filter_from: dates.from, filter_to: dates.to };
}

/**
 * Payment totals over the whole filtered range, split by mode.
 *
 * customer_payments stores a cash/online split alongside the label, so its cash
 * and online figures are those columns. supplier_payments carries only the
 * label, so there the split is derived from it -- anything not labelled cash is
 * counted as online, which is what the supplier ledger on the desktop does.
 */
async function paymentRangeSummary(table, where, filterParams, { modeColumn, cashColumn, onlineColumn }) {
  const m = `LOWER(BTRIM(COALESCE(${modeColumn},'')))`;
  const cash = cashColumn
    ? `COALESCE(SUM(${cashColumn}),0)::float`
    : `COALESCE(SUM(amount) FILTER (WHERE ${m} = 'cash'),0)::float`;
  const online = onlineColumn
    ? `COALESCE(SUM(${onlineColumn}),0)::float`
    : `COALESCE(SUM(amount) FILTER (WHERE ${m} <> 'cash'),0)::float`;
  const [totals, byMode] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS rows,
              COALESCE(SUM(amount),0)::float AS amount,
              ${cash} AS cash,
              ${online} AS online
         FROM ${table} WHERE ${where}`,
      filterParams,
    ),
    query(
      `SELECT ${m} AS mode, COUNT(*)::int AS count, COALESCE(SUM(amount),0)::float AS amount
         FROM ${table} WHERE ${where}
        GROUP BY 1 ORDER BY 3 DESC, 1`,
      filterParams,
    ),
  ]);
  const r = totals.rows[0] || {};
  return {
    rows: Number(r.rows || 0),
    count: Number(r.rows || 0),
    amount: round2(r.amount),
    cash: round2(r.cash),
    online: round2(r.online),
    by_mode: byMode.rows.map((x) => ({
      mode: x.mode || '',
      count: Number(x.count || 0),
      amount: round2(x.amount),
    })),
  };
}

export async function listSalesReturns(storePk, {
  from, to, q, customer_id, party_id, sort,
  limit = 200, offset = 0, include_total,
} = {}) {
  const dates = resolveOpenDates(from, to);
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (dates.from) { params.push(dates.from); where += ` AND return_date >= $${params.length}`; }
  if (dates.to) { params.push(dates.to); where += ` AND return_date <= $${params.length}`; }
  const partyId = intOrNull(customer_id ?? party_id, { min: 0 });
  if (partyId !== null) { params.push(partyId); where += ` AND customer_id = $${params.length}`; }
  if (textOrNull(q)) {
    where = pushLike(params, where, String(q).trim(), [
      'return_no', "COALESCE(bill_no,'')", "COALESCE(customer_name,'')", "COALESCE(reason,'')",
    ]);
  }
  const lim = Math.min(Number(limit) || 200, 5000);
  const off = Number(offset) || 0;
  params.push(lim);
  params.push(off);
  const { rows } = await query(
    `SELECT local_id AS id, return_no, sale_id, bill_no, customer_id, customer_name,
            return_date, refund_amount, discount, reason, item_count, created_at
     FROM sales_returns WHERE ${where}
     ORDER BY ${orderBy(RETURN_SORTS, sort, 'date_desc')}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const filterParams = params.slice(0, -2);
  const [total, summary] = await Promise.all([
    resolveListTotal({
      table: 'sales_returns',
      where,
      countParams: filterParams,
      offset: off,
      limit: lim,
      pageLen: rows.length,
      includeTotal: include_total,
    }),
    returnRangeSummary('sales_returns', where, filterParams),
  ]);
  return { rows, total, summary, filter_from: dates.from, filter_to: dates.to };
}

export async function listPurchaseReturns(storePk, {
  from, to, q, supplier_id, party_id, sort,
  limit = 200, offset = 0, include_total,
} = {}) {
  const dates = resolveOpenDates(from, to);
  const params = [storePk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (dates.from) { params.push(dates.from); where += ` AND return_date >= $${params.length}`; }
  if (dates.to) { params.push(dates.to); where += ` AND return_date <= $${params.length}`; }
  const partyId = intOrNull(supplier_id ?? party_id, { min: 0 });
  if (partyId !== null) { params.push(partyId); where += ` AND supplier_id = $${params.length}`; }
  if (textOrNull(q)) {
    where = pushLike(params, where, String(q).trim(), [
      'return_no', "COALESCE(purchase_no,'')", "COALESCE(supplier_name,'')", "COALESCE(reason,'')",
    ]);
  }
  const lim = Math.min(Number(limit) || 200, 5000);
  const off = Number(offset) || 0;
  params.push(lim);
  params.push(off);
  const { rows } = await query(
    `SELECT local_id AS id, return_no, purchase_id, purchase_no, supplier_id, supplier_name,
            return_date, refund_amount, discount, reason, item_count, created_at
     FROM purchase_returns WHERE ${where}
     ORDER BY ${orderBy(RETURN_SORTS, sort, 'date_desc')}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const filterParams = params.slice(0, -2);
  const [total, summary] = await Promise.all([
    resolveListTotal({
      table: 'purchase_returns',
      where,
      countParams: filterParams,
      offset: off,
      limit: lim,
      pageLen: rows.length,
      includeTotal: include_total,
    }),
    returnRangeSummary('purchase_returns', where, filterParams),
  ]);
  return { rows, total, summary, filter_from: dates.from, filter_to: dates.to };
}

/** Refund totals over the whole filtered range of a returns table. */
async function returnRangeSummary(table, where, filterParams) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS rows,
            COALESCE(SUM(refund_amount),0)::float AS refund_total,
            COALESCE(SUM(discount),0)::float AS discount_total,
            COALESCE(SUM(item_count),0)::int AS item_count
       FROM ${table} WHERE ${where}`,
    filterParams,
  );
  const r = rows[0] || {};
  return {
    rows: Number(r.rows || 0),
    count: Number(r.rows || 0),
    refund_total: round2(r.refund_total),
    discount_total: round2(r.discount_total),
    item_count: Number(r.item_count || 0),
  };
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
