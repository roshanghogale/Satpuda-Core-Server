// The web's wholesale bill against the PC engine (mac2 core/wholesale_sale.py and
// bill_templates/wholesale_invoice.py). Vectors: fixtures/wholesale_vectors.json, recorded by
// scripts/make-wholesale-vectors.py from synthetic bills. Run: node --test test/wholesaleSale.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  amountInWords, calcInvoice, cityOf, cleanParty, cleanState, creditWarning, gstinProblem, isIntraState,
  lineFromRow, packText, placeOfSupply, returnsUsedInCalc, stateFromGstin, stateName, tierRate, unitsPerPack,
  dueDateFor, lineRates, splitTax, returnsInPacks,
} from '../src/services/wholesaleSale.js';
import { renderWholesaleInvoicesHtml } from '../src/services/wholesaleInvoice.js';

const V = JSON.parse(fs.readFileSync(new URL('./fixtures/wholesale_vectors.json', import.meta.url), 'utf8'));

/** Same figures to the paisa (and every other key equal). */
function same(got, want, path = '') {
  if (typeof want === 'number' && typeof got === 'number') {
    assert.ok(Math.abs(got - want) < 1e-9, `${path}: got ${got} want ${want}`);
    return;
  }
  if (Array.isArray(want)) {
    assert.ok(Array.isArray(got), `${path}: not a list`);
    assert.equal(got.length, want.length, `${path}: length`);
    want.forEach((w, i) => same(got[i], w, `${path}[${i}]`));
    return;
  }
  if (want && typeof want === 'object') {
    for (const k of Object.keys(want)) same(got?.[k], want[k], `${path}.${k}`);
    return;
  }
  assert.equal(got, want, path);
}

test(`calc_invoice: ${V.invoices.length} invoices to the paisa`, () => {
  for (const [n, c] of V.invoices.entries()) {
    same(calcInvoice(c.lines, { shopState: c.shop_state, pos: c.pos }), c.expect, `invoice ${n}`);
  }
});

test(`line_from_row: ${V.from_row.length} saved lines read back as packs, rate, disc %`, () => {
  for (const [n, c] of V.from_row.entries()) same(lineFromRow(c.row, c.ups), c.expect, `row ${n}`);
});

test(`amount in words: ${V.words.length}`, () => {
  for (const c of V.words) assert.equal(amountInWords(c.amount), c.expect, String(c.amount));
});

test('credit warning and returns used', () => {
  for (const c of V.credit) {
    assert.equal(creditWarning(c.party, c.bill, c.paid, { thisBillDue: c.this_due }), c.expect, JSON.stringify(c));
  }
  for (const c of V.returns_used) same(returnsUsedInCalc(c.grand, c.paid, c.body), c.expect, JSON.stringify(c));
});

test('place of supply, states, intra/inter', () => {
  for (const c of V.states) {
    assert.equal(placeOfSupply(c.gstin, c.state, c.shop), c.pos, JSON.stringify(c));
    assert.equal(cleanState(c.state), c.clean);
    assert.equal(stateName(c.state), c.name);
    assert.equal(stateFromGstin(c.gstin), c.from_gstin);
    assert.equal(isIntraState(c.pos, cleanState(c.shop)), c.intra);
  }
});

test('GSTIN check and the party form', () => {
  for (const c of V.gstin) assert.equal(gstinProblem(c.gstin) === '', c.ok, c.gstin);
  for (const c of V.party) {
    let got;
    try { got = { ok: true, out: cleanParty({ ...c.data }) }; } catch { got = { ok: false }; }
    assert.deepEqual(got, c.expect, JSON.stringify(c.data));
  }
});

test('tier rate, pack text, city', () => {
  for (const c of V.tier) assert.deepEqual(tierRate(c.med, c.tier), [c.rate, c.used], JSON.stringify(c));
  for (const c of V.pack) assert.equal(packText(c.unit, c.ups), c.expect, JSON.stringify(c));
  for (const c of V.city) assert.equal(cityOf(c.address), c.expect, c.address);
});

test(`the GST invoice HTML is the PC's, byte for byte (${V.html.length} renders)`, () => {
  for (const [n, c] of V.html.entries()) {
    const html = renderWholesaleInvoicesHtml(c.invs || [c.inv], { paper: c.paper, copyLabel: c.copy_label });
    if (html !== c.expect) {
      let i = 0;
      while (i < html.length && html[i] === c.expect[i]) i += 1;
      assert.fail(`render ${n} differs at ${i}:\n got  ${JSON.stringify(html.slice(i - 80, i + 80))}\n want ${JSON.stringify(c.expect.slice(i - 80, i + 80))}`);
    }
  }
});

test('stock units, due date, purchase rates, CGST/SGST split, returns in packs', () => {
  assert.equal(unitsPerPack('Tablet', '10'), 10);
  assert.equal(unitsPerPack('Capsule', '1x15'), 15);
  assert.equal(unitsPerPack('Syrup', '100ML'), 1);
  assert.equal(unitsPerPack('Tablet Pack', '10'), 1);
  assert.equal(dueDateFor('2026-10-19', 30), '2026-11-18');
  assert.equal(dueDateFor('2026-12-31', 0), '2026-12-31');
  assert.equal(dueDateFor('2027-02-20', 10), '2027-03-02');
  assert.deepEqual(lineRates({ rate_a: '12.345', rateB: 0, rate_c: 9 }), { rate_a: 12.35, rate_c: 9 });
  assert.deepEqual(splitTax(10.01), [5.01, 5]);
  assert.deepEqual(splitTax(0.03), [0.02, 0.01]);
  const r = returnsInPacks([{ return_id: 1, items: [{ qty: 20, rate: 1.5, amount: 30 }] }], () => 10);
  assert.deepEqual(r[0].items[0], { qty: 2, rate: 15, amount: 30, units: 20, units_per_pack: 10 });
});
