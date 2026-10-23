// "Paid" on a purchase is what it was paid at entry (owner rule, PURCHASE_ENTRY_PAID_SQL), never
// amount_paid alone: 295 live purchases (stores 1, 126, 131, 132; 22 Oct 2026) carry
// amount_paid 0 with cash / online at entry filled, and showed "Paid 0" on the web.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PURCHASES_SORTS } from '../src/services/adminFilters.js';
import { purchaseEntryPaid } from '../web/src/api.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('a purchase stored with amount_paid 0 and cash at entry shows what was paid', () => {
  const p = { amount_paid: 0, amount_paid_at_entry: 3952, cash_paid_at_entry: 3000, online_paid_at_entry: 952 };
  const x = purchaseEntryPaid(p);
  assert.equal(x.cash + x.online, 3952);
});

test('the web purchase view, the admin summary, the paid sort and the dashboard read paid at entry', () => {
  const web = read('../web/src/pages/Purchases.jsx');
  assert.match(web, /Paid \{money\(paidAtEntry\(open\)\)\}/);
  assert.doesNotMatch(web, /money\(open\.amount_paid\)/);
  const admin = read('../src/services/adminService.js');
  const summary = admin.slice(admin.indexOf('async function purchasesRangeSummary'));
  assert.match(summary.slice(0, 900), /\(\$\{PURCHASE_ENTRY_PAID_SQL\}\) AS amount_paid/);
  assert.match(PURCHASES_SORTS.paid_desc, /^COALESCE\(NULLIF\(COALESCE\(cash_paid_at_entry,0\)\+COALESCE\(online_paid_at_entry,0\),0\)/);
  assert.match(read('../src/services/storeSummaries.js'), /SUM\(\$\{PURCHASE_ENTRY_PAID_SQL\}\),0\)::float AS entry_paid/);
});
