/**
 * Store-auth query APIs for Online-mode history / inventory (server-first UI).
 * Always scoped by JWT store_pk — never trust a client-supplied store id.
 */
import { Router } from 'express';
import { asyncHandler, ok } from '../utils/http.js';
import { requireStore, resolveStorePk } from '../middleware/auth.js';
import * as admin from '../services/adminService.js';
import * as summaries from '../services/storeSummaries.js';
import { boolOrNull } from '../services/adminFilters.js';
import { query } from '../db/pool.js';

const router = Router();
router.use(requireStore);

router.get('/summaries/sales', asyncHandler(async (req, res) => {
  ok(res, await summaries.salesSummary(await storePk(req), {
    from: req.query.from,
    to: req.query.to,
    q: req.query.q,
    ids: req.query.ids,
    scoped: req.query.scoped,
  }));
}));

router.get('/summaries/purchases', asyncHandler(async (req, res) => {
  ok(res, await summaries.purchasesSummary(await storePk(req), {
    from: req.query.from,
    to: req.query.to,
    q: req.query.q,
    ids: req.query.ids,
    scoped: req.query.scoped,
  }));
}));

router.get('/summaries/inventory', asyncHandler(async (req, res) => {
  ok(res, await summaries.inventorySummary(await storePk(req)));
}));

router.get('/summaries/home', asyncHandler(async (req, res) => {
  ok(res, await summaries.homeSummary(await storePk(req)));
}));

async function storePk(req) {
  return resolveStorePk(req);
}

/**
 * The shop's list options: the query as sent, with two opt-ins that default OFF here
 * while the admin routes (routes/admin.js, same service functions) keep them ON.
 *
 * - q_phone: since the 2026-09-16 admin deploy the service also matches q against
 *   customer_phone / supplier_phone. No desktop or Android build sends q_phone, so a
 *   digits search in a shop's Sales or Purchase History suddenly returned extra bills
 *   (test store: q=9 went from 1 bill to 3) and disagreed with /summaries/sales.
 * - include_summary: the whole-range summary no shop client reads (see
 *   adminService.wantSummary); off, the answer carries no `summary` key at all.
 *
 * Only an explicit yes (1/true/yes/on) turns either on.
 */
function shopListOptions(req, { phoneSearch = false } = {}) {
  const opts = {
    ...req.query,
    include_summary: boolOrNull(req.query.include_summary) === true ? '1' : '0',
  };
  if (phoneSearch) opts.q_phone = boolOrNull(req.query.q_phone) === true ? '1' : '0';
  return opts;
}

router.get('/sales', asyncHandler(async (req, res) => {
  ok(res, await admin.listSales(await storePk(req), shopListOptions(req, { phoneSearch: true })));
}));

router.get('/sales/:localId', asyncHandler(async (req, res) => {
  ok(res, await admin.getSaleDetail(await storePk(req), Number(req.params.localId)));
}));

router.get('/purchases', asyncHandler(async (req, res) => {
  const pk = await storePk(req);
  const base = await admin.listPurchases(pk, shopListOptions(req, { phoneSearch: true }));
  // Enrich with payment fields used by client history badges
  if (base.rows?.length) {
    const ids = base.rows.map((r) => r.id).filter((n) => Number.isFinite(Number(n)));
    if (ids.length) {
      const { rows: extra } = await query(
        `SELECT local_id AS id, amount_paid_at_entry, cash_paid_at_entry, online_paid_at_entry,
                overall_discount, rounding, total_due, bill_cleared, due, due_amount, final_amount
         FROM purchases
         WHERE store_pk=$1 AND local_id = ANY($2::bigint[])`,
        [pk, ids],
      );
      const byId = new Map(extra.map((r) => [Number(r.id), r]));
      base.rows = base.rows.map((r) => {
        const e = byId.get(Number(r.id));
        return e ? { ...r, ...e } : r;
      });
    }
  }
  ok(res, base);
}));

router.get('/purchases/:localId', asyncHandler(async (req, res) => {
  ok(res, await admin.getPurchaseDetail(await storePk(req), Number(req.params.localId)));
}));

router.get('/inventory', asyncHandler(async (req, res) => {
  ok(res, await admin.listInventory(await storePk(req), shopListOptions(req)));
}));

/** Store parties — same rows Offline SQLite uses for Sales/Purchase dropdowns. */
router.get('/customers', asyncHandler(async (req, res) => {
  ok(res, await admin.listCustomers(await storePk(req), shopListOptions(req)));
}));

router.get('/doctors', asyncHandler(async (req, res) => {
  ok(res, await admin.listDoctors(await storePk(req), shopListOptions(req)));
}));

router.get('/suppliers', asyncHandler(async (req, res) => {
  ok(res, await admin.listSuppliers(await storePk(req), shopListOptions(req)));
}));

router.get('/payments/customers', asyncHandler(async (req, res) => {
  const pk = await storePk(req);
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  const params = [pk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (req.query.from) {
    params.push(String(req.query.from).slice(0, 10));
    where += ` AND payment_date >= $${params.length}`;
  }
  if (req.query.to) {
    params.push(String(req.query.to).slice(0, 10));
    where += ` AND payment_date <= $${params.length}`;
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT local_id AS id, customer_id, customer_name, payment_date, amount, payment_mode,
            cash_amount, online_amount, reference_no, note, created_at
     FROM customer_payments WHERE ${where}
     ORDER BY payment_date DESC, local_id DESC LIMIT $${params.length}`,
    params,
  );
  ok(res, { rows, total: rows.length });
}));

router.get('/payments/suppliers', asyncHandler(async (req, res) => {
  const pk = await storePk(req);
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  const params = [pk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (req.query.from) {
    params.push(String(req.query.from).slice(0, 10));
    where += ` AND payment_date >= $${params.length}`;
  }
  if (req.query.to) {
    params.push(String(req.query.to).slice(0, 10));
    where += ` AND payment_date <= $${params.length}`;
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT local_id AS id, payment_no, supplier_id, supplier_name, payment_date, amount, mode,
            reference, due_before, due_after, created_at
     FROM supplier_payments WHERE ${where}
     ORDER BY payment_date DESC, local_id DESC LIMIT $${params.length}`,
    params,
  );
  ok(res, { rows, total: rows.length });
}));

router.get('/returns/sales', asyncHandler(async (req, res) => {
  const pk = await storePk(req);
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  const params = [pk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (req.query.from) {
    params.push(String(req.query.from).slice(0, 10));
    where += ` AND return_date >= $${params.length}`;
  }
  if (req.query.to) {
    params.push(String(req.query.to).slice(0, 10));
    where += ` AND return_date <= $${params.length}`;
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT local_id AS id, return_no, sale_id, bill_no, customer_id, customer_name,
            return_date, refund_amount, discount, reason, item_count, created_at
     FROM sales_returns WHERE ${where}
     ORDER BY return_date DESC, local_id DESC LIMIT $${params.length}`,
    params,
  );
  ok(res, { rows, total: rows.length });
}));

router.get('/returns/purchases', asyncHandler(async (req, res) => {
  const pk = await storePk(req);
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  const params = [pk];
  let where = 'store_pk=$1 AND NOT deleted';
  if (req.query.from) {
    params.push(String(req.query.from).slice(0, 10));
    where += ` AND return_date >= $${params.length}`;
  }
  if (req.query.to) {
    params.push(String(req.query.to).slice(0, 10));
    where += ` AND return_date <= $${params.length}`;
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT local_id AS id, return_no, purchase_id, purchase_no, supplier_id, supplier_name,
            return_date, refund_amount, discount, reason, item_count, created_at
     FROM purchase_returns WHERE ${where}
     ORDER BY return_date DESC, local_id DESC LIMIT $${params.length}`,
    params,
  );
  ok(res, { rows, total: rows.length });
}));

export default router;
