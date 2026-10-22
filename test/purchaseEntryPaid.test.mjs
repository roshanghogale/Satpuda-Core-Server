// What a saved purchase's edit starts from (owner, 22 Oct 2026): the paid-at-entry rule the
// supplier's due uses (PURCHASE_ENTRY_PAID_SQL). The web's edit form (web/src/api.js) and the
// server's web edit (webStore.editPurchase, when the edit sends no Cash / Online) read it alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purchaseEntryPaid as webForm } from '../web/src/api.js';
import { purchaseEntryPaid as server } from '../src/services/webStore.js';

const cases = [
  ['the cash / online split is kept', { cash_paid_at_entry: 30, online_paid_at_entry: 20, amount_paid_at_entry: 50, amount_paid: 50 }, { cash: 30, online: 20 }],
  ['online only', { cash_paid_at_entry: 0, online_paid_at_entry: 75, amount_paid_at_entry: 75 }, { cash: 0, online: 75 }],
  // 346 live purchases (stores 126, 127, 132) carry only this: they opened with Cash 0.
  ['paid at entry without a split is cash', { cash_paid_at_entry: 0, online_paid_at_entry: 0, amount_paid_at_entry: 3952, amount_paid: 0 }, { cash: 3952, online: 0 }],
  ['then amount_paid', { cash_paid_at_entry: null, online_paid_at_entry: null, amount_paid_at_entry: 0, amount_paid: '40.5' }, { cash: 40.5, online: 0 }],
  ['an unpaid purchase stays unpaid', { cash_paid_at_entry: 0, online_paid_at_entry: 0, amount_paid_at_entry: 0, amount_paid: 0 }, { cash: 0, online: 0 }],
  ['a missing row', null, { cash: 0, online: 0 }],
];

for (const [name, row, want] of cases) {
  test(`purchase edit starts from what was paid: ${name}`, () => {
    assert.deepEqual(webForm(row), want, 'web form');
    assert.deepEqual(server(row), want, 'server');
  });
}
