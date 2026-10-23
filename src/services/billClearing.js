/**
 * Which bills a party's payments and returns clear (owner, 17 Oct 2026: "when collecting or
 * paying, choose which bills the payment clears, and show it in a payment report").
 *
 * One rule, written the same way on the server (this file), the PC (core/bill_clearing.py)
 * and the phone (BillClearing.kt); test/fixtures/bill_clearing_vectors.json holds the cases
 * all three must agree on.
 *
 *  1. A bill's own unpaid part is total - paid at the counter (never below 0).
 *  2. Credits (payments, later returns) are taken in date order. Each one first pays the
 *     bills it was given (`allocations`), never more than that bill still owes and never
 *     more than the credit itself. A bill that is gone (deleted, another party's) is
 *     skipped and that money stays with the credit.
 *  3. What every credit has left, plus (sales only) whatever was overpaid at the counter
 *     on a bill, clears the remaining bills oldest first -- exactly the rule there was
 *     before allocations, so a party with no allocations gets the same figures as before.
 *     A refund paid out (negative payment) only lowers that pool.
 *
 * clearBills() returns every bill's remaining due and, for the payment report, what each
 * credit paid on which bill ("chosen" = the bill was picked, "oldest" = rule 3).
 */

export function r2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

/** Allocations as stored: [{bill_id, bill_no, amount}], bad entries dropped. */
export function cleanAllocations(raw) {
  let list = raw;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, 500)) {
    if (!a || typeof a !== 'object') continue;
    const billId = Number(a.bill_id);
    const amount = r2(a.amount);
    if (!Number.isFinite(billId) || billId <= 0 || !(amount > 0)) continue;
    out.push({ bill_id: billId, bill_no: a.bill_no == null ? null : String(a.bill_no).slice(0, 60), amount });
  }
  return out;
}

/**
 * bills:   [{id, date, total, paid}] -- any order; cleared oldest (date, id) first.
 * credits: [{kind, id, date, amount, allocations}] -- payments and returns.
 * overpayJoins: a counter / entry overpayment on one bill pays the party's other bills.
 *               True for sales and, since 23 Oct 2026, for purchases too (the supplier's
 *               due always counted that money; false is kept for the shared vectors).
 */
export function clearBills(bills, credits, { overpayJoins = true } = {}) {
  const ordered = [...bills].sort(byDateThenId);
  const unpaid = new Map();
  for (const b of ordered) unpaid.set(Number(b.id), Math.max(0, r2(Number(b.total) - Number(b.paid))));

  const applied = [];
  const sources = [];
  const sortedCredits = [...credits].sort(byDateThenKindThenId);
  for (const c of sortedCredits) {
    const amount = r2(c.amount);
    if (amount <= 0) {
      if (amount < 0) sources.push({ kind: c.kind, id: c.id, date: c.date, left: amount });
      continue;
    }
    let avail = amount;
    for (const a of cleanAllocations(c.allocations)) {
      if (avail <= 0.009) break;
      const id = Number(a.bill_id);
      if (!unpaid.has(id)) continue;
      const take = r2(Math.min(a.amount, unpaid.get(id), avail));
      if (take <= 0.009) continue;
      unpaid.set(id, r2(unpaid.get(id) - take));
      avail = r2(avail - take);
      applied.push({ credit_kind: c.kind, credit_id: c.id, bill_id: id, amount: take, how: 'chosen' });
    }
    if (avail > 0.009) sources.push({ kind: c.kind, id: c.id, date: c.date, left: avail });
  }
  if (overpayJoins) {
    for (const b of ordered) {
      const over = r2(Number(b.paid) - Number(b.total));
      if (over > 0.009) sources.push({ kind: 'overpaid_bill', id: Number(b.id), date: b.date, left: over });
    }
  }

  // Rule 3, exactly as the old pooled loop (the per-bill figures come from the pool total).
  let pool = r2(sources.reduce((s, x) => s + x.left, 0));
  const result = ordered.map((b) => {
    const id = Number(b.id);
    const owed = unpaid.get(id);
    if (owed <= 0.01) return { id, remaining: 0, cleared: true };
    if (pool + 0.01 >= owed) {
      pool = r2(pool - owed);
      return { id, remaining: 0, cleared: true };
    }
    const rem = r2(owed - pool);
    pool = 0;
    return { id, remaining: rem, cleared: rem <= 0.01 };
  });

  // Who paid what under rule 3, for the report only: sources in date order, a refund taken
  // off the credit it was paid out of (latest positive one before it, else the next one).
  const queue = attributeQueue(sources);
  let qi = 0;
  for (const b of ordered) {
    const id = Number(b.id);
    let owed = unpaid.get(id);
    while (owed > 0.01 && qi < queue.length) {
      const s = queue[qi];
      const take = r2(Math.min(owed, s.left));
      if (take > 0.009) {
        applied.push({ credit_kind: s.kind, credit_id: s.id, bill_id: id, amount: take, how: 'oldest' });
        owed = r2(owed - take);
        s.left = r2(s.left - take);
      }
      if (s.left <= 0.009) qi += 1;
    }
  }
  return { bills: result, applied };
}

function attributeQueue(sources) {
  const list = [...sources].sort(byDateThenKindThenId).map((s) => ({ ...s }));
  const pos = list.filter((s) => s.left > 0);
  for (const neg of list.filter((s) => s.left < 0)) {
    let owe = -neg.left;
    const before = pos.filter((p) => cmpDate(p.date, neg.date) <= 0).reverse();
    const after = pos.filter((p) => cmpDate(p.date, neg.date) > 0);
    for (const p of [...before, ...after]) {
      if (owe <= 0.009) break;
      const take = Math.min(owe, p.left);
      p.left = r2(p.left - take);
      owe = r2(owe - take);
    }
  }
  return pos.filter((p) => p.left > 0.009);
}

function dateKey(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d || '').slice(0, 10);
}
function cmpDate(a, b) {
  const x = dateKey(a);
  const y = dateKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
function byDateThenId(a, b) {
  return cmpDate(a.date, b.date) || Number(a.id) - Number(b.id);
}
const KIND_ORDER = { payment: 0, return: 1, overpaid_bill: 2 };
function byDateThenKindThenId(a, b) {
  return cmpDate(a.date, b.date)
    || (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
    || Number(a.id) - Number(b.id);
}
