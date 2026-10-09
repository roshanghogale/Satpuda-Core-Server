/**
 * What the web login reads and saves (phase 5). The web is online-only: the server is the one
 * truth, and every save goes through the same path as a PC or phone save (syncV2
 * applyServerSideSave): bundle rules, stock only through stock operations, the dues cascade,
 * and a sync revision so PCs and phones pull the change. Bill and purchase numbers come from
 * the store's own series (allocateFySerialInTx), after every block a device holds, so a web
 * bill never clashes with a PC or phone bill.
 *
 * The arithmetic is the PC engine's, ported in billRules.js and checked against it.
 */
import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';
import { AppError } from '../utils/http.js';
import * as admin from './adminService.js';
import { applyServerSideSave } from './syncV2.js';
import { allocateFySerialInTx, fetchDocsByLocalIds } from './syncService.js';
import { billGstCte, expiryCutoffSql } from './adminFilters.js';
import { buildSaleLine, saleCostPrice, salesCalc, purchaseCalc, purchaseStockUnits, money, pyRound } from './billRules.js';
import { isStripCountType, parseTabletsPerStripe } from '../utils/saleProfit.js';
import { audit } from './webUsers.js';

const r2 = (x) => pyRound(x, 2);

/** Today in the shop's time zone (India). The web makes bills for today only. */
export function todayIst() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function installIdFor(storePk) {
  return `web-store-${storePk}`;
}

function cleanText(v, max = 120) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s ? s.slice(0, max) : '';
}

/** "08/27" or "2027-08" or "2027-08-31" -> "2027-08-01" (month expiry, the shop's way). */
export function parseExpiry(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\s*[/\-.]\s*(\d{2}|\d{4})$/);
  if (m) {
    const mm = Number(m[1]);
    let yy = Number(m[2]);
    if (yy < 100) yy += 2000;
    if (mm >= 1 && mm <= 12) return `${yy}-${String(mm).padStart(2, '0')}-01`;
  }
  m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (m) return `${m[1]}-${m[2]}-${m[3] || '01'}`;
  throw new AppError(400, `Expiry "${s}" is not a date. Write it as MM/YY, e.g. 08/27.`);
}

function isExpiredOn(expiry, onDate) {
  if (!expiry) return false;
  const d = new Date(`${String(expiry).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  let cutoff = d;
  if (d.getUTCDate() === 1) cutoff = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return cutoff.toISOString().slice(0, 10) < onDate;
}

async function save(storePk, user, build, auditEntry) {
  const out = await applyServerSideSave(storePk, {
    installId: installIdFor(storePk),
    deviceType: 'web',
    deviceName: 'Web login',
    build,
  });
  if (auditEntry) {
    const entry = typeof auditEntry === 'function' ? auditEntry(out) : auditEntry;
    await audit(null, { storePk, user, ...entry });
  }
  return out;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function profile(storePk) {
  const { rows } = await query(
    `SELECT name, address, phone, email, gstin, dl_number, gst_enabled, fssai_number, show_fssai_on_bill
       FROM pharmacy_profiles WHERE store_pk=$1`, [storePk],
  );
  return rows[0] || {};
}

/** Medicines a bill can sell today: live, not hidden, in stock, not expired. */
export async function searchSellable(storePk, q, { limit = 30 } = {}) {
  const term = cleanText(q, 60);
  if (term.length < 1) return [];
  const { rows } = await query(
    `SELECT local_id AS id, name, type, unit, batch_no, expiry_date, stock_qty, mrp, rate, gst_percent,
            schedule, hsn_code, manufacturer, location
       FROM medicines
      WHERE store_pk=$1 AND NOT deleted AND NOT is_hidden AND COALESCE(stock_qty,0) > 0
        AND (expiry_date IS NULL OR ${expiryCutoffSql('expiry_date')} >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
        AND name ILIKE $2
      ORDER BY (name ILIKE $3) DESC, name, expiry_date NULLS LAST, local_id
      LIMIT $4`,
    [storePk, `%${term}%`, `${term}%`, Math.min(100, Number(limit) || 30)],
  );
  return rows.map((m) => ({
    ...m,
    sale_rate: pyRound(buildSaleLine(m, 1).rate, 4),
    strip: isStripCountType(m.type, m.unit),
    tablets_per_strip: isStripCountType(m.type, m.unit) ? parseTabletsPerStripe(m.unit) : 1,
  }));
}

/** Any medicine by name, hidden and out of stock too: a purchase line picks its batch here. */
export async function searchAnyMedicine(storePk, q) {
  const term = cleanText(q, 60);
  if (!term) return [];
  const { rows } = await query(
    `SELECT local_id AS id, name, type, unit, batch_no, expiry_date, stock_qty, mrp, rate, gst_percent,
            schedule, hsn_code, manufacturer, content_drug, is_hidden
       FROM medicines WHERE store_pk=$1 AND NOT deleted AND name ILIKE $2
      ORDER BY (name ILIKE $3) DESC, name, expiry_date DESC NULLS LAST LIMIT 40`,
    [storePk, `%${term}%`, `${term}%`],
  );
  return rows;
}

/**
 * The Inventory views (owner, 9 Oct 2026): Active (today's default), Hidden, Out of stock,
 * Expired, All. Same rules as the PC and phone: hidden = is_hidden; out of stock = stock <= 0;
 * expired = past the month-end of its expiry month.
 */
export const INVENTORY_VIEWS = {
  active: { hidden: '0' },
  hidden: { hidden: '1' },
  out_of_stock: { hidden: '0', stock: 'out' },
  expired: { hidden: '0', expiry: 'expired' },
  all: { hidden: 'all' },
};

export async function inventory(storePk, opts = {}) {
  const view = INVENTORY_VIEWS[opts.view] ? opts.view : 'active';
  const base = INVENTORY_VIEWS[view];
  const list = await admin.listInventory(storePk, {
    q: opts.q, type: opts.type, schedule: opts.schedule, sort: opts.sort,
    limit: Math.min(Number(opts.limit) || 300, 2000), offset: opts.offset,
    include_total: '1', ...base,
    // "Hidden" and "All" can still be narrowed to out-of-stock / expired.
    ...(opts.stock && view !== 'out_of_stock' ? { stock: opts.stock } : {}),
    ...(opts.expiry && view !== 'expired' ? { expiry: opts.expiry } : {}),
  });
  return { view, ...list, counts: await inventoryCounts(storePk) };
}

export async function inventoryCounts(storePk) {
  const cut = expiryCutoffSql('expiry_date');
  const { rows } = await query(
    `SELECT COUNT(*) FILTER (WHERE NOT is_hidden)::int AS active,
            COUNT(*) FILTER (WHERE is_hidden)::int AS hidden,
            COUNT(*) FILTER (WHERE NOT is_hidden AND COALESCE(stock_qty,0) <= 0)::int AS out_of_stock,
            COUNT(*) FILTER (WHERE NOT is_hidden AND expiry_date IS NOT NULL AND ${cut} < CURRENT_DATE)::int AS expired,
            COUNT(*)::int AS all
       FROM medicines WHERE store_pk=$1 AND NOT deleted`,
    [storePk],
  );
  return rows[0];
}

export async function customers(storePk, opts) {
  return admin.listCustomers(storePk, { ...opts, limit: Math.min(Number(opts?.limit) || 300, 2000) });
}

export async function suppliers(storePk, opts) {
  return admin.listSuppliers(storePk, { ...opts, limit: Math.min(Number(opts?.limit) || 300, 2000) });
}

/** Who made each bill on the web (web_audit); a PC or phone bill shows its device. */
async function madeBy(storePk, collection, ids) {
  if (!ids.length) return new Map();
  const { rows } = await query(
    `SELECT DISTINCT ON (local_id) local_id, username FROM web_audit
      WHERE store_pk=$1 AND collection=$2 AND local_id = ANY($3::bigint[]) AND action LIKE '%.create'
      ORDER BY local_id, created_at`,
    [storePk, collection, ids],
  );
  return new Map(rows.map((r) => [Number(r.local_id), r.username]));
}

export async function salesList(storePk, opts) {
  const out = await admin.listSales(storePk, { ...opts, include_summary: '1', limit: Math.min(Number(opts?.limit) || 300, 2000) });
  const by = await madeBy(storePk, 'sales', out.rows.map((r) => Number(r.id)));
  out.rows = out.rows.map((r) => ({ ...r, made_by: by.get(Number(r.id)) || null }));
  return out;
}

export async function saleDetail(storePk, id) {
  const sale = await admin.getSaleDetail(storePk, Number(id));
  const by = await madeBy(storePk, 'sales', [Number(id)]);
  const hist = await query(
    `SELECT username, action, created_at FROM web_audit WHERE store_pk=$1 AND collection='sales' AND local_id=$2
      ORDER BY created_at`, [storePk, Number(id)],
  );
  return { ...sale, made_by: by.get(Number(id)) || null, web_history: hist.rows };
}

export async function purchasesList(storePk, opts) {
  const out = await admin.listPurchases(storePk, { ...opts, include_summary: '1', limit: Math.min(Number(opts?.limit) || 300, 2000) });
  const by = await madeBy(storePk, 'purchases', out.rows.map((r) => Number(r.id)));
  out.rows = out.rows.map((r) => ({ ...r, made_by: by.get(Number(r.id)) || null }));
  return out;
}

export async function purchaseDetail(storePk, id) {
  return admin.getPurchaseDetail(storePk, Number(id));
}

export async function customerPayments(storePk, opts) {
  return admin.listCustomerPayments(storePk, opts || {});
}

export async function supplierPayments(storePk, opts) {
  return admin.listSupplierPayments(storePk, opts || {});
}

/** Sales, purchases, GST by rate and the schedule register for a date range. */
export async function reports(storePk, { from, to } = {}) {
  const f = String(from || todayIst()).slice(0, 10);
  const t = String(to || todayIst()).slice(0, 10);
  const [sales, purchases, gstSales, gstPurch, schedule, returns] = await Promise.all([
    admin.listSales(storePk, { from: f, to: t, include_summary: '1', limit: 1 }),
    admin.listPurchases(storePk, { from: f, to: t, include_summary: '1', limit: 1 }),
    query(
      // The GST the bills PRINTED (adminFilters.billGstCte, the desktop's printed_bill_gst):
      // each bill's discount shared down its lines, MRP includes GST. Same figure as the tile.
      `WITH f AS (
         SELECT id FROM sales
          WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave AND bill_date BETWEEN $2 AND $3
       ),
       ${billGstCte('f')}
       SELECT rate::float AS gst_pct, ROUND(SUM(net), 2)::float AS value,
              ROUND(SUM(CASE WHEN rate > 0 THEN ROUND(net * 100 / (100 + rate), 2) ELSE net END), 2)::float AS taxable
         FROM _gst_net GROUP BY rate ORDER BY rate`,
      [storePk, f, t],
    ),
    query(
      `SELECT pi.gst_pct::float AS gst_pct, ROUND(SUM(pi.taxable)::numeric,2)::float AS taxable,
              ROUND(SUM(pi.gst_amt)::numeric,2)::float AS gst, ROUND(SUM(pi.item_amount)::numeric,2)::float AS value
         FROM purchases p JOIN purchase_items pi ON pi.purchase_id=p.id
        WHERE p.store_pk=$1 AND NOT p.deleted AND NOT p.is_autosave AND p.purchase_date BETWEEN $2 AND $3
        GROUP BY pi.gst_pct ORDER BY pi.gst_pct`,
      [storePk, f, t],
    ),
    query(
      `SELECT s.local_id AS sale_id, s.bill_no, s.bill_date, s.customer_name, s.customer_address, s.doctor_name,
              si.name, si.batch_no, si.expiry_date, si.qty,
              COALESCE(NULLIF(BTRIM(si.schedule),''), NULLIF(BTRIM(m.schedule),'')) AS schedule,
              m.content_drug, COALESCE(NULLIF(si.manufacturer,''), m.manufacturer) AS manufacturer
         FROM sales s JOIN sales_items si ON si.sale_id=s.id
         LEFT JOIN medicines m ON m.store_pk=si.store_pk AND m.local_id=si.medicine_id
        WHERE s.store_pk=$1 AND NOT s.deleted AND NOT s.is_autosave AND s.bill_date BETWEEN $2 AND $3
          AND COALESCE(NULLIF(BTRIM(si.schedule),''), NULLIF(BTRIM(m.schedule),'')) IS NOT NULL
        ORDER BY s.bill_date, s.fy_serial NULLS LAST, s.local_id
        LIMIT 5000`,
      [storePk, f, t],
    ),
    query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(refund_amount),0)::float AS refunds
         FROM sales_returns WHERE store_pk=$1 AND NOT deleted AND return_date BETWEEN $2 AND $3`,
      [storePk, f, t],
    ),
  ]);
  const gs = gstSales.rows.map((r) => ({ ...r, gst: r2(r.value - r.taxable) }));
  return {
    from: f, to: t,
    sales: sales.summary, purchases: purchases.summary,
    sales_returns: returns.rows[0],
    gst_sales: gs, gst_purchases: gstPurch.rows,
    schedule_register: schedule.rows,
  };
}

// ─── Parties ──────────────────────────────────────────────────────────────────

async function partyRow(client, table, storePk, id) {
  const { rows } = await client.query(
    `SELECT * FROM ${table} WHERE store_pk=$1 AND local_id=$2 AND NOT deleted`, [storePk, Number(id)],
  );
  return rows[0] || null;
}

/** The customer of a bill: by id, else by exact name, else a new one (an event of its own). */
const COUNTER_SALE = 'COUNTER SALE';
const COUNTER_SALE_NAMES = ['COUNTER SALE', 'COUNTER', 'COUNTER SALES', 'COUNTERSALE', 'COUNTERSALES'];

/** A walk-in bill is paid in full: there is nobody to collect a due from. */
function walkInPaid(cust, payment) {
  if (cust.walk_in && Number(payment.due_amount) > 0) {
    throw new AppError(400, 'A bill without a customer name must be paid in full. Enter the customer name to keep a due.');
  }
}

async function resolveCustomer(client, storePk, { customer_id, customer_name, customer_phone, customer_address }, nextId, events) {
  if (Number(customer_id) > 0) {
    const row = await partyRow(client, 'customers', storePk, customer_id);
    if (!row) throw new AppError(400, 'That customer no longer exists. Pick again.');
    return { ...row, walk_in: COUNTER_SALE_NAMES.includes(String(row.name || '').trim().toUpperCase()) };
  }
  // No name: a walk-in, billed to the shop's COUNTER SALE customer like the PC does
  // (core/customer_service.py COUNTER_SALE and its aliases). Owner, 9 Oct 2026.
  const walkIn = !cleanText(customer_name, 80);
  const name = walkIn ? COUNTER_SALE : cleanText(customer_name, 80).toUpperCase();
  const { rows } = await client.query(
    walkIn
      ? `SELECT * FROM customers WHERE store_pk=$1 AND NOT deleted AND UPPER(BTRIM(name)) = ANY($2::text[])
          ORDER BY (UPPER(BTRIM(name))='COUNTER SALE') DESC, local_id LIMIT 1`
      : `SELECT * FROM customers WHERE store_pk=$1 AND NOT deleted AND UPPER(BTRIM(name))=$2
          ORDER BY local_id LIMIT 1`,
    [storePk, walkIn ? COUNTER_SALE_NAMES : name],
  );
  if (rows[0]) return { ...rows[0], walk_in: walkIn };
  const id = await nextId('customers');
  const doc = {
    id, local_id: id, name, phone: cleanText(customer_phone, 20) || null,
    address: cleanText(customer_address, 120) || null, total_due: 0, total_credit: 0,
    created_at: new Date().toISOString(),
  };
  events.push({ op: 'upsert', collection: 'customers', doc });
  return { local_id: id, name, phone: doc.phone, address: doc.address, total_due: 0, total_credit: 0, walk_in: walkIn };
}

async function resolveSupplier(client, storePk, { supplier_id, supplier_name, supplier_phone, supplier_gstin }, nextId, events) {
  if (Number(supplier_id) > 0) {
    const row = await partyRow(client, 'suppliers', storePk, supplier_id);
    if (!row) throw new AppError(400, 'That supplier no longer exists. Pick again.');
    return row;
  }
  const name = cleanText(supplier_name, 80).toUpperCase();
  if (!name) throw new AppError(400, 'Enter the supplier name.');
  const { rows } = await client.query(
    `SELECT * FROM suppliers WHERE store_pk=$1 AND NOT deleted AND UPPER(BTRIM(name))=$2 ORDER BY local_id LIMIT 1`,
    [storePk, name],
  );
  if (rows[0]) return rows[0];
  const id = await nextId('suppliers');
  const doc = {
    id, local_id: id, name, phone: cleanText(supplier_phone, 20) || null,
    gstin: cleanText(supplier_gstin, 20) || null, total_due: 0, total_credit: 0,
  };
  events.push({ op: 'upsert', collection: 'suppliers', doc });
  return { local_id: id, name, phone: doc.phone, total_due: 0, total_credit: 0 };
}

// ─── Sales ────────────────────────────────────────────────────────────────────

async function medicinesById(client, storePk, ids) {
  const { rows } = await client.query(
    `SELECT * FROM medicines WHERE store_pk=$1 AND local_id = ANY($2::bigint[])`,
    [storePk, [...new Set(ids.map(Number))]],
  );
  return new Map(rows.map((m) => [Number(m.local_id), m]));
}

/**
 * Turn the screen's lines into bill lines with the PC's rules. `oldQty`: what this bill already
 * took of each medicine (an edit gives it back before checking the shelf).
 */
function saleLines(body, meds, billDate, oldQty = new Map()) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new AppError(400, 'Add at least one medicine.');
  if (items.length > 200) throw new AppError(400, 'A bill can have at most 200 lines.');
  const want = new Map();
  const lines = items.map((it, i) => {
    const mid = Number(it.medicine_id);
    const qty = Math.trunc(Number(it.qty));
    const med = meds.get(mid);
    if (!med || med.deleted) throw new AppError(400, `Line ${i + 1}: medicine not found.`);
    if (!(qty > 0)) throw new AppError(400, `Line ${i + 1} (${med.name}): enter a quantity.`);
    if (med.is_hidden && !oldQty.has(mid)) throw new AppError(400, `${med.name} is hidden in Inventory.`);
    if (isExpiredOn(med.expiry_date, billDate) && !oldQty.has(mid)) {
      throw new AppError(400, `${med.name} expired on ${String(med.expiry_date).slice(0, 7)}. It cannot be sold.`);
    }
    want.set(mid, (want.get(mid) || 0) + qty);
    const built = buildSaleLine(med, qty, money(it.disc_pct));
    return {
      medicine_id: mid,
      name: med.name,
      type: med.type || '',
      batch_no: med.batch_no || '',
      expiry_date: med.expiry_date || '',
      hsn_code: med.hsn_code || '',
      schedule: med.schedule || '',
      manufacturer: med.manufacturer || '',
      gst_percent: it.gst_percent != null && oldQty.has(mid) ? money(it.gst_percent) : money(med.gst_percent),
      qty,
      rate: built.rate,
      amount: built.amount,
      item_discount: built.medicine_discount,
      cost_price: saleCostPrice(med),
    };
  });
  for (const [mid, q] of want) {
    const med = meds.get(mid);
    const available = Number(med.stock_qty || 0) + (oldQty.get(mid) || 0);
    if (q > available) {
      throw new AppError(409, `${med.name} (batch ${med.batch_no || '-'}): only ${Math.max(0, available)} in stock.`);
    }
  }
  return { lines, want };
}

function scheduleChecks(lines, customerName, doctorName) {
  const sched = lines.filter((l) => String(l.schedule || '').trim());
  if (!sched.length) return;
  if (!String(customerName || '').trim()) throw new AppError(400, 'A scheduled medicine needs the customer name.');
  if (!String(doctorName || '').trim()) {
    throw new AppError(400, `Enter the doctor for scheduled medicine ${sched[0].name} (${sched[0].schedule}).`);
  }
}

/** Totals shown while the bill is typed (no save). */
export async function previewSale(storePk, body) {
  // An edit (sale_id) may keep what the bill already took off the shelf.
  const old = Number(body.sale_id) > 0 ? await currentDoc(storePk, 'sales', body.sale_id) : null;
  const oldQty = old ? qtyByMedicine(old.items) : new Map();
  const meds = await medicinesById({ query: (t, p) => query(t, p) }, storePk,
    [...(body.items || []).map((i) => i.medicine_id), ...oldQty.keys()]);
  const { lines } = saleLines(body, meds, old ? String(old.bill_date).slice(0, 10) : todayIst(), oldQty);
  let prevDue = 0; let prevCredit = 0;
  if (old && Number(body.customer_id) === Number(old.customer_id)) {
    prevDue = Number(old.previous_due || 0); prevCredit = Number(old.previous_credit || 0);
  } else if (Number(body.customer_id) > 0) {
    const { rows } = await query(`SELECT total_due, total_credit FROM customers WHERE store_pk=$1 AND local_id=$2`, [storePk, Number(body.customer_id)]);
    prevDue = Number(rows[0]?.total_due || 0); prevCredit = Number(rows[0]?.total_credit || 0);
  }
  const calc = salesCalc({ items: lines, discount_pct: body.discount_pct, cash_paid: body.cash_paid, online_paid: body.online_paid,
    previous_due: prevDue, previous_credit: prevCredit, payment_mode: body.payment_mode });
  return { lines, ...calc, previous_due: prevDue, previous_credit: prevCredit };
}

export async function createSale(storePk, user, body) {
  const billDate = todayIst();
  let made;
  await save(storePk, user, async (client, device, { nextId }) => {
    const events = [];
    const meds = await medicinesById(client, storePk, (body.items || []).map((i) => i.medicine_id));
    const { lines, want } = saleLines(body, meds, billDate);
    const doctor = cleanText(body.doctor_name, 80).toUpperCase();
    const cust = await resolveCustomer(client, storePk, body, nextId, events);
    scheduleChecks(lines, cust.walk_in ? '' : cust.name, doctor);
    // A walk-in carries no old balance onto its bill.
    const prevDue = cust.walk_in ? 0 : r2(Number(cust.total_due || 0));
    const prevCredit = cust.walk_in ? 0 : r2(Number(cust.total_credit || 0));
    const calc = salesCalc({ items: lines, discount_pct: body.discount_pct, cash_paid: body.cash_paid,
      online_paid: body.online_paid, previous_due: prevDue, previous_credit: prevCredit, payment_mode: body.payment_mode });
    walkInPaid(cust, calc.payment);
    const num = await allocateFySerialInTx(client, storePk, 'sales', billDate);
    const id = await nextId('sales');
    const cu = `web-${randomUUID()}`;
    const p = calc.payment;
    const doc = {
      id, local_id: id, client_uuid: cu, bill_no: num.bill_no, fy_start_year: num.fy_start_year, fy_serial: num.fy_serial,
      customer_id: Number(cust.local_id), customer_name: cust.name, customer_phone: cust.phone || '',
      customer_address: cust.address || '', bill_date: billDate, doctor_name: doctor,
      total_amount: calc.summary.total_amount, discount: calc.summary.discount_amount, discount_pct: calc.summary.discount_pct,
      rounding: calc.rounding, amount_paid: p.amount_paid, cash_paid: calc.cash_paid, online_paid: calc.online_paid,
      previous_due: prevDue, previous_credit: prevCredit, due_amount: p.due_amount, credit_amount: p.credit_amount,
      total_due: p.total_due, bill_cleared: p.due_amount === 0, account_cleared: false,
      item_count: lines.length, items: lines, created_at: new Date().toISOString(), version: 1,
    };
    const stock_ops = [...want].map(([mid, q]) => ({
      op_uuid: `sale:${cu}:med:${mid}:v1`, op: 'sale', qty_delta: -q, medicine_id: mid,
      ref_collection: 'sales', ref_id: id,
    }));
    events.push({ op: 'upsert', collection: 'sales', doc, stock_ops, base_version: 0 });
    made = { id, bill_no: num.bill_no, display_bill_no: num.display_bill_no, total_amount: doc.total_amount };
    return events;
  }, () => ({ action: 'sale.create', collection: 'sales', localId: made.id, refNo: made.bill_no,
    detail: { total: made.total_amount } }));
  return { ...made, sale: await saleDetail(storePk, made.id) };
}

async function currentDoc(storePk, collection, id) {
  const [doc] = await fetchDocsByLocalIds(storePk, collection, [Number(id)]);
  if (!doc || doc.deleted) throw new AppError(404, 'Not found (it may have been deleted on another device).');
  return doc;
}

function qtyByMedicine(items, unitsOf = (it) => Number(it.qty || 0)) {
  const m = new Map();
  for (const it of items || []) {
    const mid = Number(it.medicine_id);
    if (!(mid > 0)) continue;
    m.set(mid, (m.get(mid) || 0) + unitsOf(it));
  }
  return m;
}

export async function editSale(storePk, user, id, body) {
  const old = await currentDoc(storePk, 'sales', id);
  if (body.version != null && Number(body.version) !== Number(old.version)) {
    throw new AppError(409, 'This bill was changed on another device since you opened it. Open it again.');
  }
  let made;
  await save(storePk, user, async (client, device, { nextId }) => {
    const events = [];
    const oldQty = qtyByMedicine(old.items);
    const meds = await medicinesById(client, storePk, [...(body.items || []).map((i) => i.medicine_id), ...oldQty.keys()]);
    const { lines, want } = saleLines(body, meds, String(old.bill_date).slice(0, 10), oldQty);
    const doctor = cleanText(body.doctor_name ?? old.doctor_name, 80).toUpperCase();
    const cust = await resolveCustomer(client, storePk, {
      customer_id: body.customer_id ?? old.customer_id, customer_name: body.customer_name,
      customer_phone: body.customer_phone, customer_address: body.customer_address,
    }, nextId, events);
    scheduleChecks(lines, cust.walk_in ? '' : cust.name, doctor);
    const prevDue = Number(cust.local_id) === Number(old.customer_id) ? r2(Number(old.previous_due || 0)) : r2(Number(cust.total_due || 0));
    const prevCredit = Number(cust.local_id) === Number(old.customer_id) ? r2(Number(old.previous_credit || 0)) : r2(Number(cust.total_credit || 0));
    const calc = salesCalc({ items: lines, discount_pct: body.discount_pct, cash_paid: body.cash_paid,
      online_paid: body.online_paid, previous_due: prevDue, previous_credit: prevCredit, payment_mode: body.payment_mode });
    walkInPaid(cust, calc.payment);
    const ver = Number(old.version || 1) + 1;
    const cu = old.client_uuid || `sale-${id}`;
    const p = calc.payment;
    const doc = {
      ...old, id: Number(id), local_id: Number(id), customer_id: Number(cust.local_id), customer_name: cust.name,
      customer_phone: cust.phone || '', customer_address: cust.address || '', doctor_name: doctor,
      total_amount: calc.summary.total_amount, discount: calc.summary.discount_amount, discount_pct: calc.summary.discount_pct,
      rounding: calc.rounding, amount_paid: p.amount_paid, cash_paid: calc.cash_paid, online_paid: calc.online_paid,
      previous_due: prevDue, previous_credit: prevCredit, due_amount: p.due_amount, credit_amount: p.credit_amount,
      total_due: p.total_due, bill_cleared: p.due_amount === 0, item_count: lines.length, items: lines, version: ver,
    };
    delete doc._pk;
    const stock_ops = [];
    for (const mid of new Set([...want.keys(), ...oldQty.keys()])) {
      const delta = (oldQty.get(mid) || 0) - (want.get(mid) || 0);
      if (!delta) continue;
      stock_ops.push({ op_uuid: `sale:${cu}:med:${mid}:edit:v${ver}`, op: 'sale_edit', qty_delta: delta,
        medicine_id: mid, ref_collection: 'sales', ref_id: Number(id) });
    }
    events.push({ op: 'upsert', collection: 'sales', doc, stock_ops, base_version: Number(old.version || 0) });
    made = { id: Number(id), bill_no: old.bill_no, total_amount: doc.total_amount, before: old.total_amount };
    return events;
  }, () => ({ action: 'sale.edit', collection: 'sales', localId: made.id, refNo: made.bill_no,
    detail: { total_before: made.before, total_after: made.total_amount } }));
  return { ...made, sale: await saleDetail(storePk, made.id) };
}

export async function deleteSale(storePk, user, id) {
  const old = await currentDoc(storePk, 'sales', id);
  await save(storePk, user, async () => {
    const cu = old.client_uuid || `sale-${id}`;
    const stock_ops = [...qtyByMedicine(old.items)].filter(([, q]) => q).map(([mid, q]) => ({
      op_uuid: `sale:${cu}:med:${mid}:delete:v1`, op: 'sale_delete', qty_delta: Math.round(q), medicine_id: mid,
      ref_collection: 'sales', ref_id: Number(id),
    }));
    return [{ op: 'delete', collection: 'sales', doc: { id: Number(id) }, stock_ops, base_version: Number(old.version || 0) }];
  }, { action: 'sale.delete', collection: 'sales', localId: Number(id), refNo: old.bill_no, detail: { total: old.total_amount } });
  return { deleted: true, bill_no: old.bill_no };
}

// ─── Sales returns ────────────────────────────────────────────────────────────

/** What can still be returned of a bill: sold minus every earlier return, per medicine. */
export async function returnable(storePk, saleId) {
  const sale = await currentDoc(storePk, 'sales', saleId);
  const { rows } = await query(
    `SELECT sri.medicine_id, SUM(sri.qty)::float AS q
       FROM sales_returns sr JOIN sales_return_items sri ON sri.return_id=sr.id
      WHERE sr.store_pk=$1 AND sr.sale_id=$2 AND NOT sr.deleted GROUP BY sri.medicine_id`,
    [storePk, Number(saleId)],
  );
  const back = new Map(rows.map((r) => [Number(r.medicine_id), Number(r.q)]));
  const lines = (sale.items || []).map((it) => {
    const mid = Number(it.medicine_id);
    const sold = Number(it.qty || 0);
    const already = Math.min(sold, back.get(mid) || 0);
    back.set(mid, (back.get(mid) || 0) - already);
    return { ...it, sold, already_returned: already, can_return: Math.max(0, sold - already) };
  });
  return { sale, lines };
}

export async function createSalesReturn(storePk, user, body) {
  const { sale, lines } = await returnable(storePk, body.sale_id);
  const want = Array.isArray(body.items) ? body.items : [];
  const items = [];
  for (const w of want) {
    const q = Number(w.qty);
    if (!(q > 0)) continue;
    const line = lines.find((l) => Number(l.medicine_id) === Number(w.medicine_id) && l.can_return > 0);
    if (!line) throw new AppError(400, 'That medicine is not on the bill, or it is already returned.');
    if (q > line.can_return) throw new AppError(400, `${line.name}: at most ${line.can_return} can be returned.`);
    line.can_return -= q;
    // core.calc_engine.calc_return_refund: the rate the customer actually paid (after line discount)
    const eff = line.sold > 0 ? Number(line.amount || 0) / line.sold : Number(line.rate || 0);
    items.push({ medicine_id: Number(line.medicine_id), name: line.name, batch_no: line.batch_no, qty: q, rate: Number(line.rate || 0), amount: r2(q * eff) });
  }
  if (!items.length) throw new AppError(400, 'Enter how many of which medicine come back.');
  const subtotal = r2(items.reduce((a, i) => a + i.amount, 0));
  const discPct = money(body.discount_pct ?? sale.discount_pct ?? 0);
  const refund = r2(subtotal - r2(subtotal * discPct / 100));
  const settle = ['cash', 'online'].includes(String(body.settle_mode)) ? String(body.settle_mode) : 'ledger';
  let made;
  await save(storePk, user, async (client, device, { nextId }) => {
    const id = await nextId('sales_returns');
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(NULLIF(substring(return_no from $2), '')::bigint), 0) AS m
         FROM sales_returns WHERE store_pk=$1 AND return_no LIKE $3`,
      [storePk, `^SR${device.device_no}-([0-9]+)$`, `SR${device.device_no}-%`],
    );
    const returnNo = `SR${device.device_no}-${Number(rows[0].m) + 1}`;
    const cu = `web-${randomUUID()}`;
    const qty = qtyByMedicine(items);
    const events = [{
      op: 'upsert', collection: 'sales_returns', base_version: 0,
      doc: { id, local_id: id, return_no: returnNo, sale_id: Number(sale.local_id ?? sale.id), bill_no: sale.bill_no,
        customer_id: sale.customer_id, customer_name: sale.customer_name, return_date: todayIst(),
        refund_amount: refund, discount: discPct, reason: cleanText(body.reason, 200), item_count: items.length, items,
        created_at: new Date().toISOString() },
      stock_ops: [...qty].map(([mid, q]) => ({ op_uuid: `sales_returns:${cu}:med:${mid}:v1`, op: 'sale_return',
        qty_delta: Math.round(q), medicine_id: mid, ref_collection: 'sales_returns', ref_id: id })),
    }];
    if (settle !== 'ledger' && Number(sale.customer_id) > 0 && refund > 0) {
      // Money handed back: a negative receipt, as the PC records it.
      const pid = await nextId('customer_payments');
      events.push({ op: 'upsert', collection: 'customer_payments', base_version: 0, doc: {
        id: pid, local_id: pid, customer_id: sale.customer_id, customer_name: sale.customer_name, payment_date: todayIst(),
        amount: -refund, payment_mode: settle, cash_amount: settle === 'cash' ? -refund : 0,
        online_amount: settle === 'online' ? -refund : 0, reference_no: returnNo, note: `Refund ${returnNo} ${sale.bill_no}`,
        created_at: new Date().toISOString() } });
    }
    made = { id, return_no: returnNo, refund_amount: refund, settle_mode: settle };
    return events;
  }, () => ({ action: 'sales_return.create', collection: 'sales_returns', localId: made.id, refNo: made.return_no,
    detail: { bill_no: sale.bill_no, refund: made.refund_amount, settle: made.settle_mode } }));
  return made;
}

// ─── Purchases ────────────────────────────────────────────────────────────────

const DESCRIPTIVE = ['type', 'hsn_code', 'schedule', 'manufacturer', 'content_drug'];

/**
 * Each purchase line names a batch: an existing medicine row (medicine_id), the same name +
 * batch already on file, or a new row. The medicine row is written with the bill's price and
 * expiry; stock moves only through the purchase's stock operation.
 */
async function purchaseLines(client, storePk, body, nextId, events) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new AppError(400, 'Add at least one medicine.');
  if (items.length > 300) throw new AppError(400, 'A purchase can have at most 300 lines.');
  const out = [];
  const touched = new Map();
  for (const [i, it] of items.entries()) {
    const qty = money(it.qty);
    const free = money(it.free_qty);
    const rate = money(it.rate);
    if (!(qty > 0) && !(free > 0)) throw new AppError(400, `Line ${i + 1}: enter a quantity.`);
    if (rate < 0 || money(it.mrp) < 0) throw new AppError(400, `Line ${i + 1}: rate and MRP cannot be negative.`);
    let med = null;
    if (Number(it.medicine_id) > 0) {
      const { rows } = await client.query(`SELECT * FROM medicines WHERE store_pk=$1 AND local_id=$2`, [storePk, Number(it.medicine_id)]);
      med = rows[0] || null;
      if (!med) throw new AppError(400, `Line ${i + 1}: medicine not found.`);
    }
    const name = cleanText(it.name || med?.name, 120).toUpperCase();
    if (!name) throw new AppError(400, `Line ${i + 1}: enter the medicine name.`);
    const batch = cleanText(it.batch_no ?? med?.batch_no, 40).toUpperCase();
    if (!med || (batch && String(med.batch_no || '').toUpperCase() !== batch) || name !== String(med.name || '').toUpperCase()) {
      const { rows } = await client.query(
        `SELECT * FROM medicines WHERE store_pk=$1 AND NOT deleted AND UPPER(BTRIM(name))=$2
            AND UPPER(BTRIM(COALESCE(batch_no,'')))=$3 ORDER BY local_id LIMIT 1`,
        [storePk, name, batch],
      );
      med = rows[0] || null;
    }
    const prev = med ? touched.get(Number(med.local_id)) : null;
    const id = med ? Number(med.local_id) : await nextId('medicines');
    const expiry = it.expiry !== undefined || it.expiry_date !== undefined ? parseExpiry(it.expiry ?? it.expiry_date) : (med?.expiry_date || null);
    const doc = {
      ...(prev || (med ? await fullMedicine(storePk, id) : {})),
      id, local_id: id, name, batch_no: batch || null, expiry_date: expiry,
      unit: cleanText(it.unit ?? med?.unit, 20) || med?.unit || '1',
      mrp: money(it.mrp ?? med?.mrp), rate, gst_percent: money(it.gst_pct ?? med?.gst_percent),
      is_hidden: false, deleted: false,
    };
    if (!med && !prev) doc.type = cleanText(it.type, 40) || 'Tablet';
    for (const f of DESCRIPTIVE) {
      const v = cleanText(it[f], 120);
      if (v) doc[f] = f === 'schedule' ? v.toUpperCase() : v;
    }
    delete doc.stock_qty; delete doc._pk;
    touched.set(id, doc);
    const units = purchaseStockUnits({ qty, free_qty: free }, doc);
    out.push({
      medicine_id: id, name, qty, free_qty: free, type: doc.type || '', hsn_code: doc.hsn_code || '',
      gst_pct: money(doc.gst_percent), mrp: money(doc.mrp), rate, manufacturer: doc.manufacturer || '',
      batch_no: batch, expiry_date: expiry || '', schedule: doc.schedule || '', discount_pct: money(it.discount_pct),
      unit: doc.unit, tablets_per_stripe: isStripCountType(doc.type, doc.unit) ? parseTabletsPerStripe(doc.unit) : 1,
      _units: units, _new: !med,
    });
  }
  for (const doc of touched.values()) {
    events.push({ op: 'upsert', collection: 'medicines', doc, base_version: Number(doc.version || 0) });
  }
  return out;
}

async function fullMedicine(storePk, id) {
  const [doc] = await fetchDocsByLocalIds(storePk, 'medicines', [id]);
  return doc || {};
}

function purchaseUnits(line) {
  const tps = Math.max(1, Number(line.tablets_per_stripe || 1));
  const strip = isStripCountType(line.type, line.unit);
  return Math.round((Number(line.qty || 0) + Number(line.free_qty || 0)) * (strip ? tps : 1));
}

function purchaseDoc(base, calc, lines) {
  const items = lines.map((l, i) => {
    const c = calc.items[i] || {};
    const { _units, _new, ...rest } = l;
    return { ...rest, taxable: c.taxable, gst_amt: c.gst_amt, item_amount: c.item_amount };
  });
  return {
    ...base,
    subtotal: calc.subtotal, total_gst: calc.total_gst, cgst: calc.cgst, sgst: calc.sgst, total_amount: calc.total_amount,
    overall_discount: calc.overall_discount, rounding: calc.rounding, need_to_pay: calc.need_to_pay,
    final_amount: calc.final_amount, amount_paid: calc.amount_paid, amount_paid_at_entry: calc.amount_paid,
    cash_paid_at_entry: calc.cash_paid, online_paid_at_entry: calc.online_paid, previous_due: calc.previous_due,
    previous_credit: calc.previous_credit, due: calc.due, current_credit: calc.current_credit, total_due: calc.total_due,
    due_amount: calc.due_amount, credit_amount: calc.credit_amount, bill_cleared: !!calc.bill_cleared,
    account_cleared: !!calc.account_cleared, gst_calc_method: calc.gst_calc_method, expenditure: calc.expenditure,
    item_count: items.length, items,
  };
}

export async function previewPurchase(storePk, body) {
  const lines = (body.items || []).map((it) => ({ qty: money(it.qty), free_qty: money(it.free_qty), rate: money(it.rate),
    gst_pct: money(it.gst_pct), discount_pct: money(it.discount_pct), mrp: money(it.mrp) }));
  let pd = 0; let pc = 0;
  if (Number(body.supplier_id) > 0) {
    const { rows } = await query(`SELECT total_due, total_credit FROM suppliers WHERE store_pk=$1 AND local_id=$2`, [storePk, Number(body.supplier_id)]);
    pd = Number(rows[0]?.total_due || 0); pc = Number(rows[0]?.total_credit || 0);
  }
  return purchaseCalc({ items: lines, overall_discount: body.overall_discount, previous_due: pd, previous_credit: pc,
    cash_paid: body.cash_paid, online_paid: body.online_paid, expenditure: body.expenditure, gst_calc_method: body.gst_calc_method });
}

export async function createPurchase(storePk, user, body) {
  const date = String(body.purchase_date || todayIst()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayIst()) throw new AppError(400, 'Purchase date cannot be in the future.');
  let made;
  await save(storePk, user, async (client, device, { nextId }) => {
    const events = [];
    const sup = await resolveSupplier(client, storePk, body, nextId, events);
    const billNumber = cleanText(body.bill_number, 40);
    if (billNumber) {
      const { rows } = await client.query(
        `SELECT purchase_no FROM purchases WHERE store_pk=$1 AND NOT deleted AND supplier_id=$2
            AND UPPER(BTRIM(COALESCE(bill_number,'')))=UPPER($3) LIMIT 1`,
        [storePk, Number(sup.local_id), billNumber],
      );
      if (rows[0]) throw new AppError(409, `Supplier bill ${billNumber} is already entered (purchase ${rows[0].purchase_no}).`);
    }
    const lines = await purchaseLines(client, storePk, body, nextId, events);
    const calc = purchaseCalc({ items: lines.map((l) => ({ ...l })), overall_discount: body.overall_discount,
      previous_due: Number(sup.total_due || 0), previous_credit: Number(sup.total_credit || 0),
      cash_paid: body.cash_paid, online_paid: body.online_paid, expenditure: body.expenditure, gst_calc_method: body.gst_calc_method });
    const num = await allocateFySerialInTx(client, storePk, 'purchases', date);
    const id = await nextId('purchases');
    const cu = `web-${randomUUID()}`;
    const doc = purchaseDoc({
      id, local_id: id, client_uuid: cu, purchase_no: num.purchase_no, fy_start_year: num.fy_start_year, fy_serial: num.fy_serial,
      supplier_id: Number(sup.local_id), supplier_name: sup.name, supplier_phone: sup.phone || '', purchase_date: date,
      bill_number: billNumber, created_at: new Date().toISOString(), version: 1,
    }, calc, lines);
    const units = qtyByMedicine(lines, (l) => l._units);
    const stock_ops = [...units].filter(([, u]) => u).map(([mid, u]) => ({
      op_uuid: `purchase:${cu}:med:${mid}:v1`, op: 'purchase', qty_delta: u, medicine_id: mid,
      ref_collection: 'purchases', ref_id: id,
    }));
    events.push({ op: 'upsert', collection: 'purchases', doc, stock_ops, base_version: 0 });
    made = { id, purchase_no: num.purchase_no, display_purchase_no: num.display_purchase_no, total_amount: doc.total_amount };
    return events;
  }, () => ({ action: 'purchase.create', collection: 'purchases', localId: made.id, refNo: made.purchase_no,
    detail: { total: made.total_amount } }));
  return { ...made, purchase: await purchaseDetail(storePk, made.id) };
}

export async function editPurchase(storePk, user, id, body) {
  const old = await currentDoc(storePk, 'purchases', id);
  if (body.version != null && Number(body.version) !== Number(old.version)) {
    throw new AppError(409, 'This purchase was changed on another device since you opened it. Open it again.');
  }
  let made;
  await save(storePk, user, async (client, device, { nextId }) => {
    const events = [];
    const sup = await resolveSupplier(client, storePk, { supplier_id: body.supplier_id ?? old.supplier_id, supplier_name: body.supplier_name }, nextId, events);
    const lines = await purchaseLines(client, storePk, body, nextId, events);
    const same = Number(sup.local_id) === Number(old.supplier_id);
    const calc = purchaseCalc({ items: lines.map((l) => ({ ...l })), overall_discount: body.overall_discount,
      previous_due: same ? Number(old.previous_due || 0) : Number(sup.total_due || 0),
      previous_credit: same ? Number(old.previous_credit || 0) : Number(sup.total_credit || 0),
      cash_paid: body.cash_paid, online_paid: body.online_paid, expenditure: body.expenditure,
      gst_calc_method: body.gst_calc_method || old.gst_calc_method });
    const ver = Number(old.version || 1) + 1;
    const cu = old.client_uuid || `purchase-${id}`;
    const doc = purchaseDoc({ ...old, id: Number(id), local_id: Number(id), supplier_id: Number(sup.local_id),
      supplier_name: sup.name, bill_number: cleanText(body.bill_number ?? old.bill_number, 40), version: ver }, calc, lines);
    delete doc._pk;
    const before = qtyByMedicine(old.items, purchaseUnits);
    const after = qtyByMedicine(lines, (l) => l._units);
    const stock_ops = [];
    for (const mid of new Set([...before.keys(), ...after.keys()])) {
      const delta = (after.get(mid) || 0) - (before.get(mid) || 0);
      if (!delta) continue;
      stock_ops.push({ op_uuid: `purchase:${cu}:med:${mid}:edit:v${ver}`, op: 'purchase_edit', qty_delta: delta,
        medicine_id: mid, ref_collection: 'purchases', ref_id: Number(id) });
    }
    events.push({ op: 'upsert', collection: 'purchases', doc, stock_ops, base_version: Number(old.version || 0) });
    made = { id: Number(id), purchase_no: old.purchase_no, total_amount: doc.total_amount, before: old.total_amount };
    return events;
  }, () => ({ action: 'purchase.edit', collection: 'purchases', localId: made.id, refNo: made.purchase_no,
    detail: { total_before: made.before, total_after: made.total_amount } }));
  return { ...made, purchase: await purchaseDetail(storePk, made.id) };
}

export async function deletePurchase(storePk, user, id) {
  const old = await currentDoc(storePk, 'purchases', id);
  await save(storePk, user, async () => {
    const cu = old.client_uuid || `purchase-${id}`;
    const stock_ops = [...qtyByMedicine(old.items, purchaseUnits)].filter(([, u]) => u).map(([mid, u]) => ({
      op_uuid: `purchase:${cu}:med:${mid}:delete:v1`, op: 'purchase_delete', qty_delta: -u, medicine_id: mid,
      ref_collection: 'purchases', ref_id: Number(id),
    }));
    return [{ op: 'delete', collection: 'purchases', doc: { id: Number(id) }, stock_ops, base_version: Number(old.version || 0) }];
  }, { action: 'purchase.delete', collection: 'purchases', localId: Number(id), refNo: old.purchase_no, detail: { total: old.total_amount } });
  return { deleted: true, purchase_no: old.purchase_no };
}

// ─── Payments ─────────────────────────────────────────────────────────────────

function payAmounts(body) {
  const amount = r2(money(body.amount));
  if (!(amount > 0)) throw new AppError(400, 'Enter the amount.');
  const mode = String(body.mode || 'cash').toLowerCase() === 'online' ? 'online' : 'cash';
  return { amount, mode };
}

export async function customerPayment(storePk, user, body) {
  const { amount, mode } = payAmounts(body);
  let made;
  await save(storePk, user, async (client, device, { nextId }) => {
    const cust = await partyRow(client, 'customers', storePk, body.customer_id);
    if (!cust) throw new AppError(400, 'Pick the customer.');
    const id = await nextId('customer_payments');
    made = { id, customer: cust.name, amount };
    return [{ op: 'upsert', collection: 'customer_payments', base_version: 0, doc: {
      id, local_id: id, customer_id: Number(cust.local_id), customer_name: cust.name, payment_date: todayIst(),
      amount, payment_mode: mode, cash_amount: mode === 'cash' ? amount : 0, online_amount: mode === 'online' ? amount : 0,
      reference_no: cleanText(body.reference, 40) || null, note: cleanText(body.note, 200) || null, created_at: new Date().toISOString() } }];
  }, () => ({ action: 'customer_payment.create', collection: 'customer_payments', localId: made.id,
    detail: { customer: made.customer, amount: made.amount, mode } }));
  return made;
}

export async function supplierPayment(storePk, user, body) {
  const { amount, mode } = payAmounts(body);
  let made;
  await save(storePk, user, async (client, device, { nextId }) => {
    const sup = await partyRow(client, 'suppliers', storePk, body.supplier_id);
    if (!sup) throw new AppError(400, 'Pick the supplier.');
    const id = await nextId('supplier_payments');
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(NULLIF(substring(payment_no from $2), '')::bigint), 0) AS m
         FROM supplier_payments WHERE store_pk=$1 AND payment_no LIKE $3`,
      [storePk, `^PAY${device.device_no}-([0-9]+)$`, `PAY${device.device_no}-%`],
    );
    const payNo = `PAY${device.device_no}-${Number(rows[0].m) + 1}`;
    const before = r2(Number(sup.total_due || 0));
    made = { id, payment_no: payNo, supplier: sup.name, amount };
    return [{ op: 'upsert', collection: 'supplier_payments', base_version: 0, doc: {
      id, local_id: id, payment_no: payNo, supplier_id: Number(sup.local_id), supplier_name: sup.name,
      payment_date: todayIst(), amount, mode: mode === 'online' ? 'Online' : 'Cash',
      reference: cleanText(body.reference, 60) || null, due_before: before, due_after: r2(Math.max(0, before - amount)),
      created_at: new Date().toISOString() } }];
  }, () => ({ action: 'supplier_payment.create', collection: 'supplier_payments', localId: made.id, refNo: made.payment_no,
    detail: { supplier: made.supplier, amount: made.amount, mode } }));
  return made;
}

// ─── Inventory edits ──────────────────────────────────────────────────────────

const EDITABLE = ['name', 'type', 'unit', 'mrp', 'rate', 'gst_percent', 'batch_no', 'expiry_date', 'hsn_code',
  'schedule', 'manufacturer', 'content_drug', 'location', 'is_hidden'];

/**
 * Edit a medicine. Its descriptive fields flow into its old bill lines on the server
 * (medicineLines.js); the answer carries the note to show, e.g. "Schedule changed: 37 old
 * sales updated". A stock correction is a stock operation ('adjust'), never a stock figure.
 */
export async function editMedicine(storePk, user, id, body) {
  const cur = await currentDoc(storePk, 'medicines', id);
  if (body.version != null && Number(body.version) !== Number(cur.version)) {
    throw new AppError(409, 'This medicine was changed on another device since you opened it. Open it again.');
  }
  const doc = { ...cur };
  delete doc._pk;
  const changed = {};
  for (const f of EDITABLE) {
    if (body[f] === undefined) continue;
    let v = body[f];
    if (f === 'expiry_date') v = parseExpiry(v);
    else if (['mrp', 'rate', 'gst_percent'].includes(f)) v = money(v);
    else if (f === 'is_hidden') v = !!v;
    else v = cleanText(v, 120);
    if (f === 'name') { v = String(v).toUpperCase(); if (!v) throw new AppError(400, 'Name cannot be empty.'); }
    if (f === 'schedule') v = String(v || '').toUpperCase();
    if (String(doc[f] ?? '') !== String(v ?? '')) changed[f] = { from: doc[f] ?? null, to: v };
    doc[f] = v;
  }
  let adjust = 0;
  if (body.stock_qty !== undefined && body.stock_qty !== null && body.stock_qty !== '') {
    const target = Math.round(Number(body.stock_qty));
    if (!Number.isFinite(target)) throw new AppError(400, 'Stock must be a number.');
    adjust = target - Number(cur.stock_qty || 0);
  }
  if (!Object.keys(changed).length && !adjust) return { unchanged: true };
  let result;
  await save(storePk, user, async () => {
    const stock_ops = adjust ? [{ op_uuid: `adjust:web-${randomUUID()}:med:${id}`, op: 'adjust', qty_delta: adjust,
      medicine_id: Number(id), ref_collection: 'medicines', ref_id: Number(id) }] : [];
    return [{ op: 'upsert', collection: 'medicines', doc: { ...doc, id: Number(id), local_id: Number(id) }, stock_ops,
      base_version: Number(cur.version || 0) }];
  }, (out) => {
    result = out.results[0]?.result || {};
    return { action: 'medicine.edit', collection: 'medicines', localId: Number(id), refNo: doc.name,
      detail: { changed, stock_adjust: adjust || undefined, lines: result.lines_updated || undefined } };
  });
  return { saved: true, lines_updated: result?.lines_updated || null, note: result?.lines_note || '', stock_adjust: adjust };
}
