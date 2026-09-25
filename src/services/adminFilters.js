/**
 * Shared filter / sort / summary SQL for the admin store-detail lists.
 *
 * Everything here is a pure helper: it produces SQL FRAGMENTS and coerced
 * values, and never talks to the database itself. Two rules hold throughout:
 *
 *  1. No caller value is ever interpolated into SQL. Sorts come from a fixed
 *     whitelist keyed by a short name; every other value goes in as $n.
 *  2. An absent, blank or unrecognised parameter means "no filter", so the
 *     answer a caller got before any of these existed is the answer it still
 *     gets. That is the whole backward-compatibility argument for the panel
 *     build sitting on the live box, which sends at most `q`.
 *
 * The stock-value expressions below are transcriptions of
 * utils/saleProfit.js (which is itself a transcription of the desktop's
 * mac2/core/stock_utils). They exist because a summary has to be computed in
 * SQL over the WHOLE filtered range -- summing a page of rows in JS is how a
 * total silently becomes "the total of the first 200 rows" -- and the JS
 * helpers can only see rows already fetched. tests/admin-store-filters.test.mjs
 * checks the SQL against the JS on a table of awkward unit strings, so the two
 * cannot drift apart unnoticed.
 */

/** A YYYY-MM-DD date, or null. Never throws on junk. */
export function dateOnly(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** A positive integer inside [min,max], or null. */
export function intOrNull(v, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < min || i > max) return null;
  return i;
}

/** "1"/"true"/"yes"/"on"/true -> true; "0"/"false"/"no"/"off"/false -> false; else null. */
export function boolOrNull(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return null;
}

/** Trimmed non-empty text, or null. */
export function textOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Normalised filter token: lower-case, spaces and dashes folded to underscore. */
export function token(v) {
  const s = textOrNull(v);
  return s === null ? null : s.toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Pick an ORDER BY from a whitelist.
 *
 * `map` is { token: 'sql fragment' } and `fallback` is the key whose fragment
 * is today's ordering. An unknown sort is the fallback, never an error: a
 * client that guesses a name gets the old list rather than a 400.
 */
export function orderBy(map, sort, fallback) {
  const t = token(sort);
  if (t && Object.prototype.hasOwnProperty.call(map, t)) return map[t];
  return map[fallback];
}

// ─── Sort whitelists ──────────────────────────────────────────────────────────
// The fallback entry of each map is byte-for-byte the ORDER BY that endpoint
// used before this file existed.

export const SALES_SORTS = {
  date_desc: 'bill_date DESC, local_id DESC',
  date_asc: 'bill_date ASC, local_id ASC',
  amount_desc: 'total_amount DESC, local_id DESC',
  amount_asc: 'total_amount ASC, local_id ASC',
  due_desc: 'due_amount DESC, local_id DESC',
  due_asc: 'due_amount ASC, local_id ASC',
  paid_desc: 'amount_paid DESC, local_id DESC',
  number_asc: 'bill_no ASC, local_id ASC',
  number_desc: 'bill_no DESC, local_id DESC',
  party_asc: "COALESCE(customer_name,'') ASC, bill_date DESC, local_id DESC",
  created_desc: 'created_at DESC NULLS LAST, local_id DESC',
  created_asc: 'created_at ASC NULLS LAST, local_id ASC',
};

export const PURCHASES_SORTS = {
  date_desc: 'purchase_date DESC, local_id DESC',
  date_asc: 'purchase_date ASC, local_id ASC',
  amount_desc: 'final_amount DESC, local_id DESC',
  amount_asc: 'final_amount ASC, local_id ASC',
  due_desc: 'due_amount DESC, local_id DESC',
  due_asc: 'due_amount ASC, local_id ASC',
  paid_desc: 'amount_paid DESC, local_id DESC',
  number_asc: 'purchase_no ASC, local_id ASC',
  number_desc: 'purchase_no DESC, local_id DESC',
  party_asc: "COALESCE(supplier_name,'') ASC, purchase_date DESC, local_id DESC",
  created_desc: 'created_at DESC NULLS LAST, local_id DESC',
  created_asc: 'created_at ASC NULLS LAST, local_id ASC',
};

// Every ORDER BY here ends in local_id, and it is not decoration: these lists
// are paged now, and a sort with no unique tiebreaker lets Postgres order the
// ties differently between two pages. A shop with 2,000 customers on one name
// showed customer 1 twice and customer 6 not at all. The sales, purchase,
// payment and return sorts below always had it; these four did not.
export const INVENTORY_SORTS = {
  name: 'name, batch_no, local_id',
  name_desc: 'name DESC, batch_no DESC, local_id DESC',
  stock_asc: 'COALESCE(stock_qty,0) ASC, name, local_id',
  stock_desc: 'COALESCE(stock_qty,0) DESC, name, local_id',
  expiry_asc: 'expiry_date ASC NULLS LAST, name, local_id',
  expiry_desc: 'expiry_date DESC NULLS LAST, name, local_id',
  mrp_asc: 'COALESCE(mrp,0) ASC, name, local_id',
  mrp_desc: 'COALESCE(mrp,0) DESC, name, local_id',
  manufacturer: "COALESCE(manufacturer,'') , name, local_id",
  updated_desc: 'updated_at DESC NULLS LAST, name, local_id',
};

export const PARTY_SORTS = {
  name: 'name, local_id',
  name_desc: 'name DESC, local_id DESC',
  due_desc: 'COALESCE(total_due,0) DESC, name, local_id',
  due_asc: 'COALESCE(total_due,0) ASC, name, local_id',
  credit_desc: 'COALESCE(total_credit,0) DESC, name, local_id',
  credit_asc: 'COALESCE(total_credit,0) ASC, name, local_id',
};

export const CUSTOMER_SORTS = {
  ...PARTY_SORTS,
  created_desc: 'created_at DESC NULLS LAST, name, local_id',
  created_asc: 'created_at ASC NULLS LAST, name, local_id',
};

export const DOCTOR_SORTS = {
  name: 'name, local_id',
  name_desc: 'name DESC, local_id DESC',
  created_desc: 'created_at DESC NULLS LAST, name, local_id',
  created_asc: 'created_at ASC NULLS LAST, name, local_id',
};

export const PAYMENT_SORTS = {
  date_desc: 'payment_date DESC, local_id DESC',
  date_asc: 'payment_date ASC, local_id ASC',
  amount_desc: 'amount DESC, local_id DESC',
  amount_asc: 'amount ASC, local_id ASC',
};

export const RETURN_SORTS = {
  date_desc: 'return_date DESC, local_id DESC',
  date_asc: 'return_date ASC, local_id ASC',
  amount_desc: 'refund_amount DESC, local_id DESC',
  amount_asc: 'refund_amount ASC, local_id ASC',
  number_asc: 'return_no ASC, local_id ASC',
  number_desc: 'return_no DESC, local_id DESC',
};

// ─── Bill / purchase status ───────────────────────────────────────────────────

/**
 * The status filter for sales and purchases.
 *
 * Returns { sql, deleted } where `deleted` says whether the caller asked for
 * deleted rows -- the caller has to know, because "deleted" is the one status
 * that changes the BASE predicate (`NOT deleted`) rather than adding to it.
 * `null` sql means no status filter at all.
 *
 *   paid          nothing is owed on the bill
 *   partly_paid   something was paid and something is still owed
 *   due / unpaid  something is still owed
 *   cleared       the bill is marked cleared
 *   not_cleared   it is not
 *   deleted       the bill was deleted (normally hidden)
 *   all           no filter (explicitly)
 */
export function billStatus(value) {
  const t = token(value);
  if (!t || t === 'all' || t === 'any') return { sql: null, deleted: false };
  switch (t) {
    case 'paid':
      return { sql: 'COALESCE(due_amount,0) <= 0', deleted: false };
    case 'partly_paid':
    case 'partly':
    case 'part_paid':
    case 'partial':
      return { sql: 'COALESCE(due_amount,0) > 0 AND COALESCE(amount_paid,0) > 0', deleted: false };
    case 'due':
    case 'unpaid':
    case 'pending':
      return { sql: 'COALESCE(due_amount,0) > 0', deleted: false };
    case 'cleared':
      return { sql: 'bill_cleared = TRUE', deleted: false };
    case 'not_cleared':
    case 'uncleared':
      return { sql: 'bill_cleared = FALSE', deleted: false };
    case 'account_cleared':
      return { sql: 'account_cleared = TRUE', deleted: false };
    case 'deleted':
      return { sql: null, deleted: true };
    default:
      // Unknown token = no filter, so a typo shows the whole range rather than
      // an empty page the reader would read as "this shop has no bills".
      return { sql: null, deleted: false };
  }
}

// ─── Payment mode ─────────────────────────────────────────────────────────────

/**
 * A payment-mode predicate over a TEXT mode column.
 *
 * Both payment tables store the mode as free text the client chose
 * ('cash', 'Cash', 'Online', 'UPI'…), so the match is case-folded and trimmed.
 * customer_payments additionally carries a cash/online split, and a row whose
 * split says cash counts as cash even when the label does not -- that is what
 * the desktop's own ledger totals do.
 */
export function paymentModeSql(column, value, { splitColumns = null } = {}) {
  const t = token(value);
  if (!t || t === 'all' || t === 'any') return null;
  const m = `LOWER(BTRIM(COALESCE(${column},'')))`;
  const cash = splitColumns ? `COALESCE(${splitColumns.cash},0)` : null;
  const online = splitColumns ? `COALESCE(${splitColumns.online},0)` : null;
  if (t === 'cash') {
    return splitColumns
      ? `((${m} = 'cash') OR (${cash} > 0 AND ${online} <= 0))`
      : `${m} = 'cash'`;
  }
  if (t === 'online' || t === 'upi' || t === 'bank') {
    return splitColumns
      ? `((${m} <> 'cash' AND ${m} <> 'mixed' AND ${m} <> 'both') OR (${online} > 0 AND ${cash} <= 0))`
      : `${m} <> 'cash'`;
  }
  if (t === 'mixed' || t === 'both') {
    return splitColumns ? `(${cash} > 0 AND ${online} > 0)` : `(${m} = 'mixed' OR ${m} = 'both')`;
  }
  return null;
}

// ─── Stock valuation, in SQL ──────────────────────────────────────────────────

const STRIP_UNITS = "('d','tab','tabs','tablet','tablets')";
const STRIP_TYPES = "('tablet','bolus','capsule')";
const PACK_TYPES = "('tablet pack','bolus pack')";
// utils/saleProfit.js VOLUME_PACK_RE, with whitespace already squeezed out.
const VOLUME_PACK_RE = '^[0-9]+(\\.[0-9]+)?(GM|G|MG|ML|MD|KG|L|LI|LTR|LT)$';
const NUMERIC_RE = '^[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]+)?$';

/** saleProfit.isStripCountType(type, unit) as SQL. */
export function isStripCountTypeSql(typeExpr, unitExpr) {
  const t = `LOWER(BTRIM(COALESCE(${typeExpr},'')))`;
  const u = `LOWER(BTRIM(COALESCE(${unitExpr},'')))`;
  return `(CASE
      WHEN ${t} IN ${PACK_TYPES} THEN FALSE
      WHEN ${t} IN ${STRIP_TYPES} THEN TRUE
      ELSE ${u} IN ${STRIP_UNITS}
    END)`;
}

/**
 * saleProfit.parseTabletsPerStripe(unit) as SQL.
 *
 * Step for step the same ladder, including the order of the last two rules --
 * "the whole string is a number" is tried BEFORE "the first run of digits",
 * which is why '1X10' is 10 and '30ML' is 1.
 */
export function tabletsPerStripeSql(unitExpr) {
  const s = `BTRIM(COALESCE(${unitExpr},''))`;
  const squeezed = `REGEXP_REPLACE(${s}, '[[:space:]]+', '', 'g')`;
  const firstDigits = `NULLIF(SUBSTRING(${s} FROM '[0-9]+'), '')`;
  const tailDigits = `NULLIF(SUBSTRING(${s} FROM '[0-9]+$'), '')`;
  const clamp = (e) => `GREATEST(1, LEAST(TRUNC((${e})::numeric), 1000000000))::int`;
  return `(CASE
      WHEN ${s} = '' THEN 1
      WHEN LOWER(${s}) IN ${STRIP_UNITS} THEN 1
      WHEN ${squeezed} <> '' AND ${squeezed} ~* '${VOLUME_PACK_RE}' THEN 1
      WHEN ${s} ~ '^1[[:space:]]*[Xx×*][[:space:]]*[0-9]+$' AND ${tailDigits} IS NOT NULL
        THEN ${clamp(tailDigits)}
      WHEN ${s} ~ '${NUMERIC_RE}' AND (${s})::numeric > 0 THEN ${clamp(`(${s})::numeric`)}
      WHEN ${firstDigits} IS NOT NULL THEN ${clamp(firstDigits)}
      ELSE 1
    END)`;
}

/**
 * saleProfit.stockValueAtMrp(qty, price, type, unit) as SQL, per row.
 *
 * `priceExpr` is mrp for the retail figure and rate for the cost figure: a
 * strip medicine's price column is per STRIP while its stock is counted in
 * tablets, so both have to be divided by the tablets per strip or the tile
 * reads several hundred rupees high (the STECLIN 30ML case in saleProfit.js).
 */
export function stockValueSql(qtyExpr, priceExpr, typeExpr, unitExpr) {
  const qty = `COALESCE(${qtyExpr},0)::numeric`;
  const price = `COALESCE(${priceExpr},0)::numeric`;
  const tps = tabletsPerStripeSql(unitExpr);
  const unitPrice = `(CASE WHEN ${isStripCountTypeSql(typeExpr, unitExpr)}
                            THEN ${price} / GREATEST(1, ${tps})
                            ELSE ${price} END)`;
  return `(CASE WHEN ${qty} <= 0 OR ${price} <= 0 THEN 0::numeric
                ELSE ROUND(${qty} * ${unitPrice}, 2) END)`;
}

/**
 * The expiry cut-off a pharmacy actually works to.
 *
 * A batch written as "09/26" is stored on the 1st but is good until the end of
 * that month, so a date landing on day 1 is read as the last day of the month.
 * storeSummaries.inventorySummary does exactly this in JS; the admin tiles have
 * to agree with it or the same store shows two different "expired" counts.
 */
export function expiryCutoffSql(col = 'expiry_date') {
  return `(CASE WHEN EXTRACT(DAY FROM ${col})::int = 1
                THEN (date_trunc('month', ${col}) + INTERVAL '1 month - 1 day')::date
                ELSE ${col} END)`;
}

// ─── Printed-bill GST, in SQL ─────────────────────────────────────────────────

/**
 * The GST a range of sale bills PRINTED, as one SQL expression set.
 *
 * Sales carry no GST column -- only the lines carry a percentage, and on Online
 * bills written before 2026-09-13 not even that (memory: "Online sale GST was
 * never stored"), so the rate falls back to the medicine's current one exactly
 * as a reprint does. The arithmetic is mac2/core/bill_gst.printed_bill_gst,
 * step for step:
 *
 *   share   = round_half_up(discount * amount / base)   per positive line
 *   leftover (a paisa or two lost to rounding) goes to the biggest line
 *   net     = amount - share
 *   taxable = round_half_up(net * 100 / (100 + rate))   [rate > 0]
 *   tax     = net - taxable
 *
 * Postgres rounds NUMERIC half away from zero, which is the ROUND_HALF_UP the
 * desktop uses -- hence the ::numeric casts; rounding these as double precision
 * would round half-to-even and drift a paisa per line.
 *
 * `saleIdsCte` must be the name of a CTE holding one column `id` = sales.id
 * (the surrogate key, not local_id) for the bills in range.
 */
export function billGstCte(saleIdsCte) {
  return `
    _gst_lines AS (
      SELECT si.sale_id,
             si.id AS item_id,
             ROUND(COALESCE(si.amount,0)::numeric, 2) AS amount,
             GREATEST(0::numeric,
               ROUND(COALESCE(si.gst_percent, m.gst_percent, 0)::numeric, 2)) AS rate
        FROM sales_items si
        JOIN ${saleIdsCte} f ON f.id = si.sale_id
        JOIN sales s ON s.id = si.sale_id
        LEFT JOIN medicines m ON m.store_pk = s.store_pk AND m.local_id = si.medicine_id
    ),
    _gst_base AS (
      SELECT l.sale_id,
             SUM(CASE WHEN l.amount > 0 THEN l.amount ELSE 0 END) AS base
        FROM _gst_lines l GROUP BY l.sale_id
    ),
    _gst_disc AS (
      SELECT b.sale_id, b.base,
             LEAST(GREATEST(ROUND(COALESCE(s.discount,0)::numeric, 2), 0), b.base) AS disc
        FROM _gst_base b JOIN sales s ON s.id = b.sale_id
    ),
    _gst_share AS (
      SELECT l.sale_id, l.item_id, l.amount, l.rate, d.disc,
             CASE WHEN l.amount > 0 AND d.base > 0
                  THEN ROUND(d.disc * l.amount / d.base, 2)
                  ELSE 0::numeric END AS share,
             ROW_NUMBER() OVER (PARTITION BY l.sale_id ORDER BY l.amount DESC, l.item_id) AS big_rank
        FROM _gst_lines l JOIN _gst_disc d ON d.sale_id = l.sale_id
    ),
    _gst_fix AS (
      SELECT sale_id, disc - SUM(share) AS leftover FROM _gst_share GROUP BY sale_id, disc
    ),
    _gst_net AS (
      SELECT sh.sale_id, sh.rate,
             sh.amount - (sh.share + CASE WHEN sh.big_rank = 1 THEN f.leftover ELSE 0::numeric END) AS net
        FROM _gst_share sh JOIN _gst_fix f ON f.sale_id = sh.sale_id
    ),
    _gst_line_tax AS (
      SELECT n.sale_id, n.net,
             CASE WHEN n.rate > 0 THEN ROUND(n.net * 100 / (100 + n.rate), 2) ELSE n.net END AS taxable
        FROM _gst_net n
    ),
    _gst_total AS (
      SELECT COALESCE(SUM(taxable),0)::numeric AS taxable,
             COALESCE(SUM(net - taxable),0)::numeric AS tax
        FROM _gst_line_tax
    )`;
}
