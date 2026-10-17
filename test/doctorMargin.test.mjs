// Doctor Margin Report rule against the vectors the PC and the phone copies share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { doctorMargin, rounded } from '../src/services/doctorMargin.js';

const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/doctor_margin_vectors.json', import.meta.url)));

for (const c of vectors) {
  test(`doctor margin: ${c.name}`, () => {
    assert.deepEqual(rounded(doctorMargin(c.sales, c.purchases, c.opts)), c.expect);
  });
}

test('the two styles reconcile: summary totals = detailed totals', () => {
  for (const c of vectors) {
    const rep = doctorMargin(c.sales, c.purchases, c.opts);
    const sum = (list, k) => list.reduce((s, r) => s + r[k], 0);
    for (const k of ['qty', 'amount', 'cost', 'commission']) {
      assert.ok(Math.abs(sum(rep.rows, k) - sum(rep.summary, k)) < 1e-6, `${c.name} ${k}`);
    }
  }
});
