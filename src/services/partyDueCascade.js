/**
 * Server-side FIFO bill clearing after standalone payments / returns.
 * Keeps account_cleared / total_due / bill_cleared consistent Online
 * even when clients only push party totals.
 */

import { clearBills, r2 } from './billClearing.js';

/** Cash/online at entry wins over a stored 0 in amount_paid_at_entry. */
export const PURCHASE_ENTRY_PAID_SQL = `
  COALESCE(
    NULLIF(COALESCE(cash_paid_at_entry,0) + COALESCE(online_paid_at_entry,0), 0),
    NULLIF(amount_paid_at_entry, 0),
    amount_paid,
    0
  )
`;

/** Payments (with the bills they were given) and returns of one party, as credits. */
async function partyCredits(client, storePk, kind, partyId) {
  const pay = kind === 'customer'
    ? `SELECT local_id, payment_date AS date, amount, allocations FROM customer_payments
       WHERE store_pk=$1 AND customer_id=$2 AND NOT deleted`
    : `SELECT local_id, payment_date AS date, amount, allocations FROM supplier_payments
       WHERE store_pk=$1 AND supplier_id=$2 AND NOT deleted`;
  const ret = kind === 'customer'
    ? `SELECT local_id, return_date AS date, refund_amount AS amount, allocations FROM sales_returns
       WHERE store_pk=$1 AND customer_id=$2 AND NOT deleted`
    : `SELECT local_id, return_date AS date, refund_amount AS amount, allocations FROM purchase_returns
       WHERE store_pk=$1 AND supplier_id=$2 AND NOT deleted`;
  const [{ rows: pays }, { rows: rets }] = [
    await client.query(pay, [storePk, partyId]),
    await client.query(ret, [storePk, partyId]),
  ];
  return [
    ...pays.map((p) => ({
      kind: 'payment', id: Number(p.local_id), date: p.date, amount: Number(p.amount) || 0,
      allocations: p.allocations || [],
    })),
    ...rets.map((x) => ({
      kind: 'return', id: Number(x.local_id), date: x.date, amount: Number(x.amount) || 0,
      allocations: x.allocations || [],
    })),
  ];
}

function asBills(rows, dateCol) {
  return rows.map((b) => ({
    id: Number(b.local_id), date: b[dateCol], total: Number(b.total_amount), paid: Number(b.amount_paid),
  }));
}

/**
 * Bills, credits, each bill's remaining due and what each credit cleared (payment report).
 * kind: 'customer' | 'supplier'.
 */
export async function partyBillClearing(client, storePk, kind, partyLocalId) {
  const pid = Number(partyLocalId);
  const bills = kind === 'customer'
    ? (await client.query(
      `SELECT local_id, bill_no, bill_date,
              COALESCE(total_amount,0)::float AS total_amount, COALESCE(amount_paid,0)::float AS amount_paid
       FROM sales WHERE store_pk=$1 AND customer_id=$2 AND NOT deleted AND NOT is_autosave`,
      [storePk, pid],
    )).rows
    : (await client.query(
      `SELECT local_id, purchase_no AS bill_no, bill_number, purchase_date AS bill_date,
              COALESCE(final_amount, total_amount, 0)::float AS total_amount,
              (${PURCHASE_ENTRY_PAID_SQL})::float AS amount_paid
       FROM purchases WHERE store_pk=$1 AND supplier_id=$2 AND NOT deleted
         AND NOT COALESCE(is_autosave, false)`,
      [storePk, pid],
    )).rows;
  const credits = await partyCredits(client, storePk, kind, pid);
  const res = clearBills(asBills(bills, 'bill_date'), credits, { overpayJoins: kind === 'customer' });
  // rows: the bills as read; remaining: the rule's answer per bill; applied: who paid what.
  return { rows: bills, credits, remaining: res.bills, applied: res.applied };
}

/**
 * Recalculate customer balance + FIFO-clear sales after payment/return.
 *
 * onlyIfChanged: rewrite the customer row (version + 1, updated_at NOW()) only when its
 * stored due/credit differ from the ledger. Used after a pushed customer document, so a
 * device that sent the right figure is not made to re-pull it.
 */
export async function cascadeCustomerAfterLedgerChange(
  client, storePk, customerLocalId, hint = null, { onlyIfChanged = false } = {},
) {
  const cid = Number(customerLocalId);
  if (!cid) return { updated: 0 };

  const { rows: sums } = await client.query(
    `SELECT
       COALESCE((SELECT SUM(total_amount) FROM sales
                 WHERE store_pk=$1 AND customer_id=$2 AND NOT deleted AND NOT is_autosave),0)::float AS billed,
       COALESCE((SELECT SUM(amount_paid) FROM sales
                 WHERE store_pk=$1 AND customer_id=$2 AND NOT deleted AND NOT is_autosave),0)::float AS paid,
       COALESCE((SELECT SUM(amount) FROM customer_payments
                 WHERE store_pk=$1 AND customer_id=$2 AND NOT deleted),0)::float AS payments,
       COALESCE((SELECT SUM(refund_amount) FROM sales_returns
                 WHERE store_pk=$1 AND customer_id=$2 AND NOT deleted),0)::float AS returns`,
    [storePk, cid],
  );

  const totalBilled = Number(sums[0]?.billed || 0);
  const totalPaidAt = Number(sums[0]?.paid || 0);
  const paySum = Number(sums[0]?.payments || 0);
  const retSum = Number(sums[0]?.returns || 0);
  const net = r2(totalBilled - totalPaidAt - paySum - retSum);
  const totalDue = net > 0 ? net : 0;
  const totalCredit = net < 0 ? Math.abs(net) : 0;

  const { rowCount: partyRows } = await client.query(
    `UPDATE customers SET total_due=$3, total_credit=$4, updated_at=NOW(),
            version = COALESCE(version,0) + 1
     WHERE store_pk=$1 AND local_id=$2 AND NOT deleted
       AND (NOT $5::boolean
            OR ABS(COALESCE(total_due,0) - $3) > 0.009
            OR ABS(COALESCE(total_credit,0) - $4) > 0.009)`,
    [storePk, cid, totalDue, totalCredit, Boolean(onlyIfChanged)],
  );

  const { rows: sales } = await client.query(
    `SELECT id, local_id, bill_date,
            COALESCE(total_amount,0)::float AS total_amount,
            COALESCE(amount_paid,0)::float AS amount_paid,
            COALESCE(total_due,0)::float AS total_due,
            COALESCE(due_amount,0)::float AS due_amount,
            account_cleared, bill_cleared
     FROM sales
     WHERE store_pk=$1 AND customer_id=$2 AND NOT deleted AND NOT is_autosave
     ORDER BY bill_date ASC, local_id ASC`,
    [storePk, cid],
  );

  // Payments pay the bills they were given first, the rest clears oldest first.
  const credits = await partyCredits(client, storePk, 'customer', cid);
  const fifo = clearBills(asBills(sales, 'bill_date'), credits, { overpayJoins: true }).bills;
  const byId = new Map(sales.map((s) => [Number(s.local_id), s]));
  const dirtyIds = [];
  const dirtyRem = [];
  const dirtyCleared = [];
  const dirtyBill = [];
  // local_id of every bill touched — callers emit a changelog entry per id, or
  // revision-sync clients never learn the bill was cleared.
  const dirtyLocalIds = [];
  let updated = 0;
  for (const f of fifo) {
    const row = byId.get(Number(f.id));
    if (!row) continue;
    const cleared = !!f.cleared;
    const rem = r2(f.remaining);
    const billCleared = rem <= 0.01;
    // due_amount is written with total_due below, so it is compared too: a bill whose
    // total_due was right but whose due_amount was stale never counted as dirty and
    // kept showing the stale figure (store 127: 42 bills).
    if (
      Math.abs(Number(row.total_due) - rem) > 0.009 ||
      Math.abs(Number(row.due_amount) - rem) > 0.009 ||
      Boolean(row.account_cleared) !== cleared ||
      Boolean(row.bill_cleared) !== billCleared
    ) {
      dirtyIds.push(row.id);
      dirtyRem.push(rem);
      dirtyCleared.push(cleared);
      dirtyBill.push(billCleared);
      dirtyLocalIds.push(Number(row.local_id));
      updated += 1;
    }
  }
  if (dirtyIds.length) {
    await client.query(
      `UPDATE sales AS s SET
         total_due = v.rem, due_amount = v.rem,
         account_cleared = v.cleared, bill_cleared = v.bill_cleared,
         updated_at = NOW(), version = COALESCE(s.version,0) + 1
       FROM unnest($1::bigint[], $2::float[], $3::boolean[], $4::boolean[])
         AS v(id, rem, cleared, bill_cleared)
       WHERE s.id = v.id AND s.store_pk = $5`,
      [dirtyIds, dirtyRem, dirtyCleared, dirtyBill, storePk],
    );
  }
  return { updated, totalDue, totalCredit, dirtyLocalIds, partyUpdated: partyRows > 0 };
}

/**
 * Recalculate supplier balance + FIFO-clear purchases after payment/return.
 * onlyIfChanged: as for customers.
 */
export async function cascadeSupplierAfterLedgerChange(
  client, storePk, supplierLocalId, hint = null, { onlyIfChanged = false } = {},
) {
  const sid = Number(supplierLocalId);
  if (!sid) return { updated: 0 };

  const { rows: sums } = await client.query(
    `SELECT
       COALESCE((SELECT SUM(COALESCE(final_amount, total_amount)) FROM purchases
                 WHERE store_pk=$1 AND supplier_id=$2 AND NOT deleted AND NOT COALESCE(is_autosave, false)),0)::float AS purchased,
       COALESCE((SELECT SUM(${PURCHASE_ENTRY_PAID_SQL}) FROM purchases
                 WHERE store_pk=$1 AND supplier_id=$2 AND NOT deleted AND NOT COALESCE(is_autosave, false)),0)::float AS paid,
       COALESCE((SELECT SUM(amount) FROM supplier_payments
                 WHERE store_pk=$1 AND supplier_id=$2 AND NOT deleted),0)::float AS payments,
       COALESCE((SELECT SUM(refund_amount) FROM purchase_returns
                 WHERE store_pk=$1 AND supplier_id=$2 AND NOT deleted),0)::float AS returns`,
    [storePk, sid],
  );

  const totalPurch = Number(sums[0]?.purchased || 0);
  const totalPaidAt = Number(sums[0]?.paid || 0);
  const paySum = Number(sums[0]?.payments || 0);
  const retSum = Number(sums[0]?.returns || 0);
  const net = r2(totalPurch - totalPaidAt - paySum - retSum);
  const totalDue = net > 0 ? net : 0;
  const totalCredit = net < 0 ? Math.abs(net) : 0;

  const { rowCount: partyRows } = await client.query(
    `UPDATE suppliers SET total_due=$3, total_credit=$4, updated_at=NOW(),
            version = COALESCE(version,0) + 1
     WHERE store_pk=$1 AND local_id=$2 AND NOT deleted
       AND (NOT $5::boolean
            OR ABS(COALESCE(total_due,0) - $3) > 0.009
            OR ABS(COALESCE(total_credit,0) - $4) > 0.009)`,
    [storePk, sid, totalDue, totalCredit, Boolean(onlyIfChanged)],
  );

  const { rows: purchases } = await client.query(
    `SELECT id, local_id, purchase_date,
            COALESCE(final_amount, total_amount, 0)::float AS total_amount,
            (${PURCHASE_ENTRY_PAID_SQL})::float AS amount_paid,
            COALESCE(due_amount, 0)::float AS due_amount,
            COALESCE(due, 0)::float AS due,
            COALESCE(total_due, 0)::float AS total_due,
            bill_cleared, account_cleared
     FROM purchases
     WHERE store_pk=$1 AND supplier_id=$2 AND NOT deleted
       AND NOT COALESCE(is_autosave, false)
     ORDER BY purchase_date ASC, local_id ASC`,
    [storePk, sid],
  );

  const credits = await partyCredits(client, storePk, 'supplier', sid);
  const fifo = clearBills(asBills(purchases, 'purchase_date'), credits, { overpayJoins: false }).bills;
  const byId = new Map(purchases.map((s) => [Number(s.local_id), s]));
  const dirtyIds = [];
  const dirtyRem = [];
  const dirtyCleared = [];
  const dirtyLocalIds = [];
  let updated = 0;
  for (const f of fifo) {
    const row = byId.get(Number(f.id));
    if (!row) continue;
    const cleared = !!f.cleared;
    const rem = r2(f.remaining);
    if (
      Math.abs(Number(row.due_amount) - rem) > 0.009 ||
      Math.abs(Number(row.due) - rem) > 0.009 ||
      Math.abs(Number(row.total_due) - rem) > 0.009 ||
      Boolean(row.bill_cleared) !== cleared ||
      Boolean(row.account_cleared) !== cleared
    ) {
      dirtyIds.push(row.id);
      dirtyRem.push(rem);
      dirtyCleared.push(cleared);
      dirtyLocalIds.push(Number(row.local_id));
      updated += 1;
    }
  }
  if (dirtyIds.length) {
    await client.query(
      `UPDATE purchases AS p SET
         due_amount = v.rem, due = v.rem, total_due = v.rem,
         bill_cleared = v.cleared, account_cleared = v.cleared,
         updated_at = NOW(), version = COALESCE(p.version,0) + 1
       FROM unnest($1::bigint[], $2::float[], $3::boolean[])
         AS v(id, rem, cleared)
       WHERE p.id = v.id AND p.store_pk = $4`,
      [dirtyIds, dirtyRem, dirtyCleared, storePk],
    );
  }
  return { updated, totalDue, totalCredit, dirtyLocalIds, partyUpdated: partyRows > 0 };
}
