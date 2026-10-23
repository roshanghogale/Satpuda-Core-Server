// Supplier due vs open purchases (live check of 22 Oct 2026): a purchase paid past its own
// total at entry (bill + previous due) left the older purchases open, so the open bills
// summed more than the supplier's due. The cascade now lets that overpayment pay the older
// purchases, as a sale's does, and a paisa of net is no due.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cascadeSupplierAfterLedgerChange, partyBalance } from '../src/services/partyDueCascade.js';

function fakeClient({ purchases, payments = [], returns = [] }) {
  const writes = { supplier: null, purchases: null };
  const paidOf = (p) => (p.cash + p.online) || p.entry || p.paid || 0;
  return {
    writes,
    async query(sql, params) {
      if (/SUM\(COALESCE\(final_amount/.test(sql)) {
        return { rows: [{
          purchased: purchases.reduce((a, p) => a + p.total, 0),
          paid: purchases.reduce((a, p) => a + paidOf(p), 0),
          payments: payments.reduce((a, p) => a + p.amount, 0),
          returns: returns.reduce((a, p) => a + p.amount, 0),
        }] };
      }
      if (/UPDATE suppliers/.test(sql)) { writes.supplier = { due: params[2], credit: params[3] }; return { rowCount: 1 }; }
      if (/FROM purchases/.test(sql)) {
        return { rows: purchases.map((p) => ({
          id: 1000 + p.id, local_id: p.id, purchase_date: p.date, total_amount: p.total,
          amount_paid: paidOf(p), due_amount: p.due ?? 0, due: p.due ?? 0, total_due: p.due ?? 0,
          bill_cleared: !!p.cleared, account_cleared: !!p.cleared,
        })) };
      }
      if (/FROM supplier_payments/.test(sql)) {
        return { rows: payments.map((p) => ({ local_id: p.id, date: p.date, amount: p.amount, allocations: [] })) };
      }
      if (/FROM purchase_returns/.test(sql)) {
        return { rows: returns.map((p) => ({ local_id: p.id, date: p.date, amount: p.amount, allocations: [] })) };
      }
      if (/UPDATE purchases/.test(sql)) {
        writes.purchases = params[0].map((id, i) => ({ id: id - 1000, rem: params[1][i], cleared: params[2][i] }));
        return { rowCount: params[0].length };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

test('an entry overpayment on a purchase pays the older purchases (store 127 shape)', async () => {
  // Older purchase 1000 open; purchase 2 of 285 paid 2185 = 285 + 1900 of the previous due.
  const c = fakeClient({ purchases: [
    { id: 1, date: '2026-01-12', total: 3000, cash: 0, online: 0, due: 3000 },
    { id: 2, date: '2026-06-20', total: 285, cash: 2185, online: 0, due: 0, cleared: true },
  ] });
  const res = await cascadeSupplierAfterLedgerChange(c, 127, 7);
  assert.equal(res.totalDue, 1100);
  assert.deepEqual(c.writes.supplier, { due: 1100, credit: 0 });
  assert.deepEqual(c.writes.purchases, [{ id: 1, rem: 1100, cleared: false }]);
});

test('an overpayment larger than every older purchase leaves a credit and no open bill', async () => {
  const c = fakeClient({ purchases: [
    { id: 1, date: '2026-06-01', total: 126, cash: 0, online: 0, due: 126 },
    { id: 2, date: '2026-06-17', total: 269, cash: 867, online: 0, due: 0, cleared: true },
  ] });
  const res = await cascadeSupplierAfterLedgerChange(c, 127, 3);
  assert.deepEqual(c.writes.supplier, { due: 0, credit: 472 });
  assert.deepEqual(c.writes.purchases, [{ id: 1, rem: 0, cleared: true }]);
  assert.equal(res.totalCredit, 472);
});

test('a paisa of net is no due (store 4: 441.01 paid 441)', async () => {
  const c = fakeClient({ purchases: [
    { id: 1, date: '2026-10-12', total: 441.01, cash: 441, online: 0, due: 0, cleared: true },
  ] });
  await cascadeSupplierAfterLedgerChange(c, 4, 280);
  assert.deepEqual(c.writes.supplier, { due: 0, credit: 0 });
  assert.equal(c.writes.purchases, null);
});

test('partyBalance', () => {
  assert.deepEqual(partyBalance(0.01), { totalDue: 0, totalCredit: 0 });
  assert.deepEqual(partyBalance(-0.01), { totalDue: 0, totalCredit: 0 });
  assert.deepEqual(partyBalance(0.02), { totalDue: 0.02, totalCredit: 0 });
  assert.deepEqual(partyBalance(-12.3449), { totalDue: 0, totalCredit: 12.34 });
  assert.deepEqual(partyBalance(1e-13), { totalDue: 0, totalCredit: 0 });
});
