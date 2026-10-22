// Bill of Supply (owner, 22 Oct 2026): the shop's "Bill heading" setting turns the wholesale
// invoice (and the web's retail bill) into a BILL OF SUPPLY -- no GST columns, no tax rows, the
// composition declaration only for a composition dealer, the same totals.
// Run: node --test test/billHeading.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BILL_OF_SUPPLY, COMPOSITION, COMPOSITION_DECLARATION, EXEMPT, TAX_INVOICE, billHeadingInfo,
} from '../src/services/billHeading.js';
import { renderWholesaleInvoiceHtml } from '../src/services/wholesaleInvoice.js';
import { pyRound } from '../src/services/billRules.js';

const V = JSON.parse(fs.readFileSync(new URL('./fixtures/wholesale_vectors.json', import.meta.url), 'utf8'));
const r2 = (x) => pyRound(x, 2);

test('the settings rows read as tax invoice unless they say bill of supply', () => {
  for (const raw of [undefined, null, '', 'tax_invoice', 'nonsense', 'TAX_INVOICE']) {
    assert.deepEqual(billHeadingInfo(raw, undefined),
      { bill_heading: TAX_INVOICE, bill_supply_reason: COMPOSITION, bill_of_supply: false, supply_declaration: '' });
  }
  assert.deepEqual(billHeadingInfo('bill_of_supply', ''),
    { bill_heading: BILL_OF_SUPPLY, bill_supply_reason: COMPOSITION, bill_of_supply: true,
      supply_declaration: COMPOSITION_DECLARATION });
  assert.equal(billHeadingInfo(' "Bill_Of_Supply" ', 'composition').bill_of_supply, true);
  assert.deepEqual(billHeadingInfo('bill_of_supply', 'exempt'),
    { bill_heading: BILL_OF_SUPPLY, bill_supply_reason: EXEMPT, bill_of_supply: true, supply_declaration: '' });
  assert.equal(COMPOSITION_DECLARATION, 'Composition taxable person, not eligible to collect tax on supplies');
});

/** The money cell of a totals row: <td>LABEL</td><td class='n'>VALUE</td>. */
function totalRow(html, label) {
  const m = html.match(new RegExp(`<td>${label}</td><td class='n'>([^<]*)</td>`));
  return m ? m[1] : null;
}

const withItems = V.html.filter((c) => (c.inv || c.invs[0]).lines.length > 0);

test(`a tax invoice prints exactly as before (${V.html.length} renders)`, () => {
  for (const c of V.html) {
    const inv = { ...(c.inv || c.invs[0]), ...billHeadingInfo('tax_invoice', 'composition') };
    if (!c.inv) continue;
    assert.equal(renderWholesaleInvoiceHtml(inv, { paper: c.paper, copyLabel: c.copy_label }), c.expect);
  }
});

test(`bill of supply: heading, no GST columns or rows, same party total (${withItems.length} invoices)`, () => {
  for (const c of withItems) {
    const base = c.inv || c.invs[0];
    const taxHtml = renderWholesaleInvoiceHtml(base, { paper: c.paper });
    const inv = { ...base, ...billHeadingInfo('bill_of_supply', 'composition') };
    const html = renderWholesaleInvoiceHtml(inv, { paper: c.paper });
    assert.match(html, /<div class='title'>BILL OF SUPPLY<\/div>/);
    assert.match(html, /<title>BILL OF SUPPLY /);
    assert.doesNotMatch(html, /GST INVOICE/);
    for (const gone of ['SGST%', 'CGST%', 'IGST%', 'SGST Value', 'CGST Value', 'IGST Value', "class='gst'", 'TAXABLE']) {
      assert.ok(!html.includes(gone), `${gone} still printed`);
    }
    assert.ok(html.includes(`<div class='supply-decl'`) && html.includes(COMPOSITION_DECLARATION));
    // The shop's GSTIN and the HSN column stay.
    if (base.shop?.gstin) assert.ok(html.includes(`GSTIN : ${base.shop.gstin}`));
    assert.ok(html.includes('<th>HSN</th>'));
    // The same money: PARTY TOTAL unchanged, and SUB TOTAL - Discount - Bill Disc + CR/DR
    // still reaches the bill's total (the tax went into the lines, not away).
    const party = (h) => h.match(/<tr class='party'><td>PARTY TOTAL<\/td><td class='n'>([^<]*)</)[1];
    assert.equal(party(html), party(taxHtml));
    const sub = Number(totalRow(html, 'SUB TOTAL'));
    const disc = Number(totalRow(html, 'Discount') || 0);
    const reached = r2(sub - disc - Number(base.bill_discount || 0) + Number(base.round_off || 0));
    assert.equal(reached, r2(base.grand_total));
    // The GROSS AMT column adds up to SUB TOTAL.
    const grossCells = [...html.matchAll(/<tr class='r'>(.*?)<\/tr>/g)]
      .map((row) => [...row[1].matchAll(/<td class='n'>([^<]*)<\/td>/g)].pop()[1]);
    assert.equal(r2(grossCells.reduce((s, v) => s + Number(v || 0), 0)), sub);
  }
});

test('bill of supply for exempt goods: no declaration', () => {
  for (const c of withItems) {
    const inv = { ...(c.inv || c.invs[0]), ...billHeadingInfo('bill_of_supply', 'exempt') };
    const html = renderWholesaleInvoiceHtml(inv, { paper: c.paper });
    assert.match(html, /BILL OF SUPPLY/);
    assert.ok(!html.includes(COMPOSITION_DECLARATION));
    assert.ok(!html.includes('supply-decl'));
  }
});

test('bill of supply lines: rate, gross and discount carry the tax', () => {
  // X: 10 x 100 at 12 %, 100 off -> taxable 900, tax 108, charged 1008.
  // Y: 1 x 50 at 5 %, no discount -> tax 2.50, charged 52.50.
  const inv = {
    bill_no: 'W1', bill_date: '2026-10-22', shop: { name: 'T', gstin: '27AAAAA0000A1Z5' }, buyer: { name: 'B' },
    intra_state: true,
    lines: [
      { name: 'X', qty: 10, rate: 100, gross: 1000, gst_percent: 12, cgst: 54, sgst: 54, igst: 0, line_discount: 100, hsn_code: '3004' },
      { name: 'Y', qty: 1, rate: 50, gross: 50, gst_percent: 5, cgst: 1.25, sgst: 1.25, igst: 0, line_discount: 0 },
    ],
    sub_total: 1050, line_discount: 100, bill_discount: 0, cgst_total: 55.25, sgst_total: 55.25, igst_total: 0,
    round_off: 0, grand_total: 1060.5, party_total: 1060.5, ...billHeadingInfo('bill_of_supply', 'exempt'),
  };
  const html = renderWholesaleInvoiceHtml(inv, { paper: 'A5' });
  assert.ok(html.includes("<td class='n'>112.00</td>"), 'rate with 12% in it');
  assert.ok(html.includes("<td class='n'>1120.00</td>"), 'gross with the tax in it');
  assert.ok(html.includes("<td class='n'>52.50</td>"), 'an undiscounted line: gross + its tax');
  assert.equal(totalRow(html, 'SUB TOTAL'), '1172.50');
  assert.equal(totalRow(html, 'Discount'), '112.00'); // 100 off and the 12 tax it saved
  assert.ok(html.includes("<tr class='party'><td>PARTY TOTAL</td><td class='n'>1060.50</td>"));
});
