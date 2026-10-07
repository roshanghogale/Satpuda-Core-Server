/**
 * Server-side FIFO bill clearing after standalone payments / returns.
 * Keeps account_cleared / total_due / bill_cleared consistent Online
 * even when clients only push party totals.
 */

function r2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

/** Cash/online at entry wins over a stored 0 in amount_paid_at_entry. */
export const PURCHASE_ENTRY_PAID_SQL = `
  COALESCE(
    NULLIF(COALESCE(cash_paid_at_entry,0) + COALESCE(online_paid_at_entry,0), 0),
    NULLIF(amount_paid_at_entry, 0),
    amount_paid,
    0
  )
`;

function cascadeSalesFifo(billsOldestFirst, standalonePayments, returnRefunds) {
  let pool = r2(standalonePayments + returnRefunds);
  for (const b of billsOldestFirst) {
    pool = r2(pool + Math.max(0, r2(b.amount_paid - b.total_amount)));
  }
  return billsOldestFirst.map((b) => {
    const unpaid = Math.max(0, r2(b.total_amount - b.amount_paid));
    if (unpaid <= 0.01) {
      return { id: b.id, local_id: b.local_id, remainingDue: 0, accountCleared: true };
    }
    if (pool + 0.01 >= unpaid) {
      pool = r2(pool - unpaid);
      return { id: b.id, local_id: b.local_id, remainingDue: 0, accountCleared: true };
    }
    const rem = r2(unpaid - pool);
    pool = 0;
    return { id: b.id, local_id: b.local_id, remainingDue: rem, accountCleared: rem <= 0.01 };
  });
}

function cascadePurchasesFifo(billsOldestFirst, standalonePayments, returnRefunds) {
  let pool = r2(standalonePayments + returnRefunds);
  return billsOldestFirst.map((b) => {
    const unpaid = Math.max(0, r2(b.total_amount - b.amount_paid));
    if (unpaid <= 0.01) {
      return { id: b.id, local_id: b.local_id, remainingDue: 0, accountCleared: true };
    }
    if (pool + 0.01 >= unpaid) {
      pool = r2(pool - unpaid);
      return { id: b.id, local_id: b.local_id, remainingDue: 0, accountCleared: true };
    }
    const rem = r2(unpaid - pool);
    pool = 0;
    return { id: b.id, local_id: b.local_id, remainingDue: rem, accountCleared: rem <= 0.01 };
  });
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
    `SELECT id, local_id,
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

  const fifo = cascadeSalesFifo(sales, paySum, retSum);
  const byId = new Map(sales.map((s) => [Number(s.id), s]));
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
    const cleared = !!f.accountCleared;
    const rem = r2(f.remainingDue);
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
    `SELECT id, local_id,
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

  const fifo = cascadePurchasesFifo(purchases, paySum, retSum);
  const byId = new Map(purchases.map((s) => [Number(s.id), s]));
  const dirtyIds = [];
  const dirtyRem = [];
  const dirtyCleared = [];
  const dirtyLocalIds = [];
  let updated = 0;
  for (const f of fifo) {
    const row = byId.get(Number(f.id));
    if (!row) continue;
    const cleared = !!f.accountCleared;
    const rem = r2(f.remainingDue);
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
