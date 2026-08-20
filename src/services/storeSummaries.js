/**
 * Store-scoped Online summaries — mirrors Offline Mac2 history/home math.
 * Always filtered by store_pk from JWT.
 */
import { query } from '../db/pool.js';
import { fyStartYearForDate, fyDateBounds } from '../utils/fy.js';
import { saleLineProfit, stockValueAtMrp } from '../utils/saleProfit.js';
import { istToday } from './licenseService.js';

function dateOnly(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function resolveRange(from, to) {
  let f = dateOnly(from);
  let t = dateOnly(to);
  let defaultFy = false;
  if (!f && !t) {
    const [a, b] = fyDateBounds(fyStartYearForDate(new Date()));
    f = a;
    t = b;
    defaultFy = true;
  }
  return { from: f, to: t, defaultFy };
}

/** Comma/space-separated local_ids, or array. */
function parseIds(ids) {
  if (ids == null) return null;
  if (Array.isArray(ids)) {
    return ids.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  }
  const s = String(ids).trim();
  if (!s) return [];
  return s
    .split(/[,\s]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Same as Offline mac2 sale_line_profit / effective_cost_per_unit.
 * Online sales often have cost_price=0; must NOT multiply strip medicines.rate
 * by tablet qty without dividing by tablets-per-strip.
 */
async function profitForSales(storePk, saleLocalIds) {
  if (!saleLocalIds.length) return 0;
  const { rows } = await query(
    `SELECT si.amount, si.qty, si.cost_price,
            COALESCE(NULLIF(TRIM(si.type), ''), m.type, '') AS med_type,
            COALESCE(NULLIF(TRIM(m.unit), ''), '1') AS unit,
            COALESCE(m.rate, 0)::float AS purchase_rate
     FROM sales_items si
     JOIN sales s ON s.id = si.sale_id
     LEFT JOIN medicines m ON m.store_pk = s.store_pk AND m.local_id = si.medicine_id
     WHERE s.store_pk = $1
       AND s.local_id = ANY($2::bigint[])
       AND COALESCE(s.deleted, FALSE) = FALSE
       AND COALESCE(s.is_autosave, FALSE) = FALSE`,
    [storePk, saleLocalIds]
  );
  let profit = 0;
  for (const r of rows || []) {
    profit += saleLineProfit(
      r.amount,
      r.qty,
      r.cost_price,
      r.purchase_rate,
      r.med_type,
      r.unit,
    );
  }
  return Math.round(profit * 100) / 100;
}

/**
 * @param {object} opts
 * @param {string} [opts.from]
 * @param {string} [opts.to]
 * @param {string} [opts.q]
 * @param {string|number[]} [opts.ids] — when scoped=1 / ids set, use these local_ids
 *   (matches Offline: summary follows the filtered history list).
 * @param {string|boolean} [opts.scoped]
 */
export async function salesSummary(storePk, { from, to, q, ids, scoped } = {}) {
  const range = resolveRange(from, to);
  const today = istToday();
  const monthStart = `${today.slice(0, 7)}-01`;
  const explicitIds = parseIds(ids);
  const useScoped = scoped === true || scoped === '1' || scoped === 1 || explicitIds !== null;

  let saleIds;
  if (useScoped) {
    saleIds = explicitIds || [];
  } else {
    const params = [storePk];
    let where = `store_pk=$1 AND NOT deleted AND NOT is_autosave`;
    if (range.from) {
      params.push(range.from);
      where += ` AND bill_date >= $${params.length}`;
    }
    if (range.to) {
      params.push(range.to);
      where += ` AND bill_date <= $${params.length}`;
    }
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (bill_no ILIKE $${params.length} OR customer_name ILIKE $${params.length})`;
    }
    const idsRes = await query(`SELECT local_id AS id FROM sales WHERE ${where}`, params);
    saleIds = (idsRes.rows || []).map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
  }

  const payParams = [storePk];
  let payWhere = 'store_pk=$1 AND NOT deleted';
  if (range.from) {
    payParams.push(range.from);
    payWhere += ` AND payment_date >= $${payParams.length}`;
  }
  if (range.to) {
    payParams.push(range.to);
    payWhere += ` AND payment_date <= $${payParams.length}`;
  }

  const [agg, dues, payments, returns] = await Promise.all([
    saleIds.length
      ? query(
          `SELECT COUNT(*)::int AS bills,
                  COALESCE(SUM(total_amount),0)::float AS total_sales,
                  COALESCE(SUM(discount),0)::float AS bill_discount,
                  COALESCE(SUM(amount_paid),0)::float AS bill_paid,
                  COALESCE(SUM(CASE WHEN bill_date = $2 THEN total_amount ELSE 0 END),0)::float AS today_rev,
                  COALESCE(SUM(CASE WHEN bill_date = $2 THEN cash_paid ELSE 0 END),0)::float AS today_cash,
                  COALESCE(SUM(CASE WHEN bill_date = $2 THEN online_paid ELSE 0 END),0)::float AS today_online,
                  COALESCE(SUM(CASE WHEN bill_date >= $3 AND bill_date <= $2 THEN total_amount ELSE 0 END),0)::float AS month_rev
           FROM sales
           WHERE store_pk=$1
             AND local_id = ANY($4::bigint[])
             AND NOT deleted AND NOT is_autosave`,
          [storePk, today, monthStart, saleIds]
        )
      : Promise.resolve({ rows: [{}] }),
    query(
      `SELECT COALESCE(SUM(total_due),0)::float AS customer_due
       FROM customers WHERE store_pk=$1 AND NOT deleted AND total_due > 0`,
      [storePk]
    ),
    query(
      `SELECT COALESCE(SUM(amount),0)::float AS paid
       FROM customer_payments WHERE ${payWhere}`,
      payParams
    ),
    saleIds.length
      ? query(
          `SELECT COALESCE(SUM(sr.refund_amount),0)::float AS refunds
           FROM sales_returns sr
           JOIN sales s ON s.store_pk = sr.store_pk AND s.local_id = sr.sale_id
           WHERE s.store_pk=$1
             AND s.local_id = ANY($2::bigint[])
             AND NOT s.deleted AND NOT s.is_autosave AND NOT sr.deleted`,
          [storePk, saleIds]
        )
      : Promise.resolve({ rows: [{ refunds: 0 }] }),
  ]);

  const a = agg.rows[0] || {};
  let itemDisc = 0;
  if (saleIds.length) {
    const { rows: idisc } = await query(
      `SELECT COALESCE(SUM(si.item_discount),0)::float AS d
       FROM sales_items si
       JOIN sales s ON s.id = si.sale_id
       WHERE s.store_pk=$1 AND s.local_id = ANY($2::bigint[])`,
      [storePk, saleIds]
    );
    itemDisc = Number(idisc[0]?.d || 0);
  }

  const todayIds = saleIds.length
    ? (
        await query(
          `SELECT local_id AS id FROM sales
           WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave AND bill_date=$2
             AND local_id = ANY($3::bigint[])`,
          [storePk, today, saleIds]
        )
      ).rows.map((r) => Number(r.id))
    : [];
  const monthIds = saleIds.length
    ? (
        await query(
          `SELECT local_id AS id FROM sales
           WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave
             AND bill_date >= $2 AND bill_date <= $3
             AND local_id = ANY($4::bigint[])`,
          [storePk, monthStart, today, saleIds]
        )
      ).rows.map((r) => Number(r.id))
    : [];

  const [totalProfit, todayProfit, monthProfit] = await Promise.all([
    profitForSales(storePk, saleIds),
    profitForSales(storePk, todayIds),
    profitForSales(storePk, monthIds),
  ]);

  const billPaid = Number(a.bill_paid || 0);
  const standalonePaid = Number(payments.rows[0]?.paid || 0);

  return {
    filter_from: range.from,
    filter_to: range.to,
    default_fy_applied: range.defaultFy && !useScoped,
    scoped: useScoped,
    total_bills: Number(a.bills || 0),
    total_sales: Number(a.total_sales || 0),
    total_discount: Number(a.bill_discount || 0) + itemDisc,
    total_paid: billPaid + standalonePaid,
    bill_paid: billPaid,
    standalone_paid: standalonePaid,
    total_due_global: Number(dues.rows[0]?.customer_due || 0),
    total_profit: totalProfit,
    today_revenue: Number(a.today_rev || 0),
    today_profit: todayProfit,
    today_cash: Number(a.today_cash || 0),
    today_online: Number(a.today_online || 0),
    month_revenue: Number(a.month_rev || 0),
    month_profit: monthProfit,
    total_returns: Number(returns.rows[0]?.refunds || 0),
  };
}

export async function purchasesSummary(storePk, { from, to, q, ids, scoped } = {}) {
  const range = resolveRange(from, to);
  const explicitIds = parseIds(ids);
  const useScoped = scoped === true || scoped === '1' || scoped === 1 || explicitIds !== null;

  let purchaseIds;
  if (useScoped) {
    purchaseIds = explicitIds || [];
  } else {
    const params = [storePk];
    let where = `store_pk=$1 AND NOT deleted AND NOT is_autosave`;
    if (range.from) {
      params.push(range.from);
      where += ` AND purchase_date >= $${params.length}`;
    }
    if (range.to) {
      params.push(range.to);
      where += ` AND purchase_date <= $${params.length}`;
    }
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (purchase_no ILIKE $${params.length} OR supplier_name ILIKE $${params.length} OR bill_number ILIKE $${params.length})`;
    }
    const { rows } = await query(`SELECT local_id AS id FROM purchases WHERE ${where}`, params);
    purchaseIds = (rows || []).map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
  }

  const [agg, dues, returns] = await Promise.all([
    purchaseIds.length
      ? query(
          `SELECT COUNT(*)::int AS bills,
                  COALESCE(SUM(COALESCE(final_amount, total_amount, 0)),0)::float AS final_amount,
                  COALESCE(SUM(
                    COALESCE(
                      NULLIF(COALESCE(cash_paid_at_entry,0)+COALESCE(online_paid_at_entry,0),0),
                      NULLIF(amount_paid_at_entry,0),
                      amount_paid,0)
                  ),0)::float AS entry_paid,
                  COALESCE(SUM(item_count),0)::int AS items
           FROM purchases
           WHERE store_pk=$1 AND local_id = ANY($2::bigint[])
             AND NOT deleted AND NOT is_autosave`,
          [storePk, purchaseIds]
        )
      : Promise.resolve({ rows: [{}] }),
    // Offline: SUM(total_due), SUM(total_credit) with no >0 filter
    query(
      `SELECT
         COALESCE(SUM(total_due),0)::float AS supplier_due,
         COALESCE(SUM(total_credit),0)::float AS supplier_credit
       FROM suppliers WHERE store_pk=$1 AND NOT deleted`,
      [storePk]
    ),
    purchaseIds.length
      ? query(
          `SELECT COALESCE(SUM(pr.refund_amount),0)::float AS refunds
           FROM purchase_returns pr
           JOIN purchases p ON p.store_pk = pr.store_pk AND p.local_id = pr.purchase_id
           WHERE p.store_pk=$1
             AND p.local_id = ANY($2::bigint[])
             AND NOT p.deleted AND NOT p.is_autosave AND NOT pr.deleted`,
          [storePk, purchaseIds]
        )
      : Promise.resolve({ rows: [{ refunds: 0 }] }),
  ]);

  const a = agg.rows[0] || {};
  const d = dues.rows[0] || {};
  return {
    filter_from: range.from,
    filter_to: range.to,
    default_fy_applied: range.defaultFy && !useScoped,
    scoped: useScoped,
    total_purchases: Number(a.bills || 0),
    final_amount: Number(a.final_amount || 0),
    entry_paid: Number(a.entry_paid || 0),
    total_items: Number(a.items || 0),
    total_returns: Number(returns.rows[0]?.refunds || 0),
    supplier_due: Number(d.supplier_due || 0),
    supplier_credit: Number(d.supplier_credit || 0),
  };
}

export async function inventorySummary(storePk) {
  const today = istToday();
  const { rows: meds } = await query(
    `SELECT stock_qty, mrp, type, COALESCE(unit, '1') AS unit, name, expiry_date
     FROM medicines
     WHERE store_pk=$1 AND NOT deleted AND NOT is_hidden`,
    [storePk]
  );

  const byName = new Map();
  let totalMedicines = 0;
  let nearExpiry = 0;
  let expired = 0;
  let stockValue = 0;
  const todayD = new Date(`${today}T12:00:00`);

  for (const r of meds || []) {
    totalMedicines += 1;
    const name = String(r.name || '');
    const qty = Number(r.stock_qty) || 0;
    byName.set(name, (byName.get(name) || 0) + qty);
    stockValue += stockValueAtMrp(qty, r.mrp, r.type, r.unit);

    const expRaw = r.expiry_date ? String(r.expiry_date).slice(0, 10) : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(expRaw)) {
      const exp = new Date(`${expRaw}T12:00:00`);
      const days = Math.round((exp - todayD) / 86400000);
      if (days <= 0) expired += 1;
      else if (days <= 90) nearExpiry += 1;
    }
  }

  let lowStock = 0;
  let outOfStock = 0;
  for (const qty of byName.values()) {
    if (qty <= 0) outOfStock += 1;
    else if (qty <= 10) lowStock += 1;
  }

  return {
    total_medicines: totalMedicines,
    low_stock: lowStock,
    out_of_stock: outOfStock,
    near_expiry: nearExpiry,
    expired: expired,
    stock_value: Math.round(stockValue * 100) / 100,
  };
}

export async function homeSummary(storePk) {
  const today = istToday();
  const fy = fyStartYearForDate(today);
  const [fyStart, fyEnd] = fyDateBounds(fy);
  const monthStart = `${today.slice(0, 7)}-01`;

  const [todayR, monthR, yearR, dues, inv] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(total_amount),0)::float AS sales,
              COALESCE(SUM(amount_paid),0)::float AS collected,
              COUNT(*)::int AS bills
       FROM sales
       WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave AND bill_date=$2`,
      [storePk, today]
    ),
    query(
      `SELECT COALESCE(SUM(total_amount),0)::float AS sales,
              COALESCE(SUM(amount_paid),0)::float AS collected,
              COUNT(*)::int AS bills
       FROM sales
       WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave
         AND bill_date >= $2 AND bill_date <= $3`,
      [storePk, monthStart, today]
    ),
    query(
      `SELECT COALESCE(SUM(total_amount),0)::float AS sales,
              COALESCE(SUM(amount_paid),0)::float AS collected,
              COUNT(*)::int AS bills
       FROM sales
       WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave
         AND bill_date >= $2 AND bill_date <= $3`,
      [storePk, fyStart, fyEnd]
    ),
    query(
      `SELECT
         (SELECT COALESCE(SUM(total_due),0)::float FROM customers WHERE store_pk=$1 AND NOT deleted AND total_due>0) AS customer_due,
         (SELECT COALESCE(SUM(total_due),0)::float FROM suppliers WHERE store_pk=$1 AND NOT deleted AND total_due>0) AS supplier_due`,
      [storePk]
    ),
    inventorySummary(storePk),
  ]);

  const t = todayR.rows[0] || {};
  const m = monthR.rows[0] || {};
  const y = yearR.rows[0] || {};
  const d = dues.rows[0] || {};
  return {
    today: today,
    month_start: monthStart,
    fy_start: fyStart,
    fy_end: fyEnd,
    fy_label: `${fy}-${String(fy + 1).slice(2)}`,
    today_sales: Number(t.sales || 0),
    today_collected: Number(t.collected || 0),
    today_bills: Number(t.bills || 0),
    month_sales: Number(m.sales || 0),
    month_collected: Number(m.collected || 0),
    month_bills: Number(m.bills || 0),
    year_sales: Number(y.sales || 0),
    year_collected: Number(y.collected || 0),
    year_bills: Number(y.bills || 0),
    customer_due: Number(d.customer_due || 0),
    supplier_due: Number(d.supplier_due || 0),
    stock_value: Number(inv.stock_value || 0),
    inventory: inv,
  };
}
