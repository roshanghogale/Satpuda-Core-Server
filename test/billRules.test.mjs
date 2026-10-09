// The web's bill arithmetic must equal the PC engine's to the paisa.
// Vectors: billRules.vectors.json, recorded from mac2/core (synthetic bills, no shop data).
// Run: node test/billRules.test.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildSaleLine, salesCalc, purchaseCalc } from '../src/services/billRules.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(fs.readFileSync(path.join(here, 'billRules.vectors.json'), 'utf8'));
let fails = 0;
let checks = 0;
function eq(label, got, want) {
  checks += 1;
  const a = Number(got ?? 0);
  const b = Number(want ?? 0);
  if (Math.abs(a - b) > 1e-9) {
    fails += 1;
    if (fails <= 25) console.log(`FAIL ${label}: got ${got} want ${want}`);
  }
}

V.sales.forEach((bill, n) => {
  const items = bill.lines.map((l, i) => {
    const line = buildSaleLine(l.med, l.qty, l.disc_pct);
    for (const k of Object.keys(l.expect)) eq(`sale ${n} line ${i} ${k}`, line[k], l.expect[k]);
    return { amount: line.amount };
  });
  const out = salesCalc({
    items, discount_pct: bill.discount_pct, discount_rs: bill.discount_rs,
    cash_paid: bill.cash_paid, online_paid: bill.online_paid,
    previous_due: bill.previous_due, previous_credit: bill.previous_credit,
  });
  for (const k of Object.keys(bill.expect.summary)) eq(`sale ${n} ${k}`, out.summary[k], bill.expect.summary[k]);
  eq(`sale ${n} rounding`, out.rounding, bill.expect.rounding);
  for (const k of Object.keys(bill.expect.payment)) eq(`sale ${n} ${k}`, out.payment[k], bill.expect.payment[k]);
});

V.purchases.forEach((p, n) => {
  const out = purchaseCalc({ ...p, items: p.items.map((i) => ({ ...i })) });
  const map = { gross_subtotal: 'gross_total' };
  for (const k of Object.keys(p.expect)) eq(`purchase ${n} ${k}`, out[map[k] || k], p.expect[k]);
  p.expect_items.forEach((e, i) => {
    for (const k of Object.keys(e)) eq(`purchase ${n} item ${i} ${k}`, out.items[i][k], e[k]);
  });
});

console.log(`${checks - fails}/${checks} figures match the PC engine`);
process.exit(fails ? 1 : 0);
