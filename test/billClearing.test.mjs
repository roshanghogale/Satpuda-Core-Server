// The bill-clearing rule against the vectors the PC and the phone copies share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { clearBills, cleanAllocations } from '../src/services/billClearing.js';

const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/bill_clearing_vectors.json', import.meta.url)));

for (const c of vectors) {
  test(`bill clearing: ${c.name}`, () => {
    assert.deepEqual(clearBills(c.bills, c.credits, { overpayJoins: c.overpay_joins }), c.expect);
  });
}

test('allocations kept as stored: junk dropped, text read as numbers', () => {
  assert.deepEqual(cleanAllocations('[{"bill_id":"5","amount":"10.005"},{"bill_id":0,"amount":3}]'),
    [{ bill_id: 5, bill_no: null, amount: 10.01 }]);
  assert.deepEqual(cleanAllocations('not json'), []);
  assert.deepEqual(cleanAllocations(null), []);
});
