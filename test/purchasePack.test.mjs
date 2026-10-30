// A purchase line's pack (syncService.purchaseItemPack): a tablets_per_stripe of 1 beside a unit
// naming a strip ("20'", "15'S", "10TAB") is the unit's; a loose line (unit "1") stays 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purchaseItemPack } from '../src/services/syncService.js';

test('a pack of 1 beside a strip unit takes the unit', () => {
  assert.equal(purchaseItemPack({ unit: "20'", tablets_per_stripe: 1 }).tablets_per_stripe, 20);
  assert.equal(purchaseItemPack({ unit: "15'S", tablets_per_stripe: 1 }).tablets_per_stripe, 15);
  assert.equal(purchaseItemPack({ unit: '10TAB', tablets_per_stripe: 1 }).tablets_per_stripe, 10);
});

test('a loose line, a pack of its own and a volume are left as they are', () => {
  assert.equal(purchaseItemPack({ unit: '1', tablets_per_stripe: 1 }).tablets_per_stripe, 1);
  assert.equal(purchaseItemPack({ unit: "15'S", tablets_per_stripe: 10 }).tablets_per_stripe, 10);
  assert.equal(purchaseItemPack({ unit: '100ML', tablets_per_stripe: 1 }).tablets_per_stripe, 1);
  assert.equal(purchaseItemPack({ unit: "20'" }).tablets_per_stripe, 20);
});
