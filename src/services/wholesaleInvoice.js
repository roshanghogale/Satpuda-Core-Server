/**
 * The wholesale GST INVOICE as HTML: a port of the PC's bill_templates/wholesale_invoice.py
 * (owner, 18 Oct 2026), line for line, so the web prints the same paper the PC prints.
 * Always A5 landscape, one bordered box; on A4 portrait two invoices share a sheet (top and
 * bottom halves with a dashed cut line between). A bill with more rows than one box holds
 * goes on over more boxes, the totals on the last.
 *
 * Input is the invoice context (webWholesale.invoiceContext), a plain object, so it renders
 * without a database; test/wholesaleSale.test.mjs compares it with the Python output.
 */
import { pyRound } from './billRules.js';

/** Item-table rows one box holds (lines and Return rows alike, one text line each). */
export const ROWS_PER_PAGE = 18;

const HEAD_MM = 27.0;
const THEAD_MM = 4.6;
const FOOT_MM = 39.0;
const ROW_MM = 3.45;
const STANDARD_RATES = [0.0, 5.0, 12.0, 18.0, 28.0];

/** html.escape(str(v)) */
function e(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}
function f(v) {
  const x = Number(v || 0);
  return Number.isFinite(x) ? x : 0;
}
/** f"{x:.2f}" (Python rounds a half on the double's exact value to even) */
function fx(x, dp = 2) {
  const r = pyRound(x, dp);
  return (Object.is(r, -0) || r === 0 ? 0 : r).toFixed(dp);
}
const m = (v) => fx(f(v));
/** Money, blank when zero. */
function mb(v) {
  const x = f(v);
  return Math.abs(x) >= 0.005 ? fx(x) : '';
}
/** f"{x:g}" for the few quantities that are not whole. */
function g(x) {
  const s = Number(x.toPrecision(6));
  return String(s);
}
function qty(v) {
  const x = f(v);
  if (!x) return '';
  return Number.isInteger(x) ? String(x) : g(x);
}
function exp(raw) {
  const s = String(raw ?? '');
  if (s.length >= 7 && s[4] === '-') return `${s.slice(5, 7)}/${s.slice(2, 4)}`;
  return s;
}
function dateDmy(raw) {
  const s = String(raw ?? '').slice(0, 10);
  if (s.length === 10 && s[4] === '-' && s[7] === '-') return `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}`;
  return s;
}
function words(inv) {
  let text = String(inv.party_total_words || inv.amount_in_words || '').trim();
  const minus = text.startsWith('Minus ');
  if (minus) text = text.slice('Minus '.length);
  if (text.startsWith('Rupees ')) text = text.slice('Rupees '.length);
  if (text.endsWith(' Only')) text = text.slice(0, -' Only'.length);
  return text ? `Rs. ${minus ? 'Minus ' : ''}${text} only` : '';
}
function shopNamePt(name) {
  const n = Math.max(1, String(name || '').length);
  return Math.max(10.0, Math.min(18.0, 215.0 / (n * 0.68)));
}

function columns(intra) {
  const cols = [
    ['sr', 'S.', 'c', '3.2%'], ['name', 'PRODUCT NAME', 'l', ''],
    ['mfg', 'MFG.', 'l', '7.8%'], ['pack', 'PACK', 'l', '5.6%'],
    ['hsn', 'HSN', 'c', '6.4%'], ['batch', 'BATCH', 'l', '8.6%'],
    ['exp', 'EXP.', 'c', '5%'], ['mrp', 'MRP', 'r', '6.2%'],
    ['qty', 'QTY', 'r', '4.4%'], ['free', 'FREE', 'r', '4.2%'],
    ['rate', 'RATE', 'r', '6.6%'],
  ];
  if (intra) cols.push(['sgst', 'SGST%', 'r', '5%'], ['cgst', 'CGST%', 'r', '5%']);
  else cols.push(['igst', 'IGST%', 'r', '6%']);
  cols.push(['gross', 'GROSS AMT.', 'r', '8.8%']);
  return cols;
}
function cls(key, align) {
  return { l: key === 'name' ? 't' : 'l', c: 'c', r: 'n' }[align];
}

function lineCells(it, sr) {
  const pct = f(it.gst_percent);
  let gross = it.gross;
  if (gross === null || gross === undefined) gross = f(it.qty) * f(it.rate);
  return {
    sr: String(sr),
    name: e(String(it.name || '').toUpperCase()),
    mfg: e(String(it.mfg || '').toUpperCase()),
    pack: e(it.pack),
    hsn: e(it.hsn_code),
    batch: e(it.batch),
    exp: e(exp(it.expiry)),
    mrp: mb(it.mrp),
    qty: qty(it.qty),
    free: qty(it.free),
    rate: m(it.rate),
    sgst: fx(pct / 2),
    cgst: fx(pct / 2),
    igst: fx(pct),
    gross: m(gross),
  };
}

function rowEntries(inv) {
  const out = [];
  (inv.lines || []).forEach((it, i) => out.push(['item', [it, i + 1]]));
  for (const r of inv.returns || []) out.push(['return', r]);
  return out;
}

function returnDate(raw) {
  const text = String(raw ?? '').trim().slice(0, 10);
  const parts = text.split('-');
  if (parts.length === 3 && parts[0].length === 4) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  return text;
}
function returnTotalLabel(row) {
  let text = 'Return total';
  if (f(row.refund) > f(row.amount) + 0.009) text += ` (₹${fx(f(row.amount))} of ₹${fx(f(row.refund))} used in this bill)`;
  return text;
}

/** A return settled in this bill: "Return SR.. date", the medicines that came back as minus
 *  lines, then the return's total (core/bill_output.bill_return_rows rows). */
function returnRow(row, cols) {
  const amount = `-${fx(f(row.amount))}`;
  if (row.kind === 'return') {
    const label = `Return ${row.return_no} ${returnDate(row.return_date)}`.trim();
    return `<tr class='r ret-head'><td class='c' colspan='${cols.length}'><b>${e(label)}</b></td></tr>`;
  }
  if (row.kind === 'total') {
    return `<tr class='r ret-total'><td class='rt' colspan='${cols.length - 1}'><b>${e(returnTotalLabel(row))}</b></td>`
      + `<td class='n'><b>${amount}</b></td></tr>`;
  }
  const cells = {
    sr: String(row.sr || ''),
    name: e(String(row.name || '').toUpperCase()),
    batch: e(row.batch),
    exp: row.expiry ? e(exp(row.expiry)) : '',
    mrp: mb(row.mrp),
    qty: qty(row.qty),
    gross: amount,
  };
  return `<tr class='r ret-line'>${cols.map(([k, , a]) => `<td class='${cls(k, a)}'>${cells[k] ?? ''}</td>`).join('')}</tr>`;
}

/** Returns settled in a bill (webStore.returnsInBill, qty in packs) as printed rows. */
export function billReturnRows(returns) {
  const rows = [];
  for (const r of returns || []) {
    const rno = String(r.return_no || '');
    const used = f(r.amount);
    const refund = f(r.refund);
    rows.push({ kind: 'return', return_no: rno, return_date: String(r.return_date || ''), amount: used, refund });
    (r.items || []).forEach((it, i) => rows.push({
      kind: 'medicine', return_no: rno, sr: i + 1, name: String(it.name || ''), qty: f(it.qty),
      amount: f(it.amount), batch: String(it.batch_no || ''), expiry: String(it.expiry || ''), mrp: f(it.mrp),
    }));
    rows.push({ kind: 'total', return_no: rno, amount: used, refund });
  }
  return rows;
}

function itemsTable(inv, entries) {
  const cols = columns(inv.intra_state !== false);
  const colgroup = cols.map(([, , , w]) => (w ? `<col style='width:${w}'>` : '<col>')).join('');
  const head = cols.map(([, h]) => `<th>${e(h)}</th>`).join('');
  const body = entries.map(([kind, data]) => {
    if (kind === 'item') {
      const [it, sr] = data;
      const cells = lineCells(it, sr);
      return `<tr class='r'>${cols.map(([k, , a]) => `<td class='${cls(k, a)}'>${cells[k] ?? ''}</td>`).join('')}</tr>`;
    }
    return returnRow(data, cols);
  });
  const filler = `<tr class='filler'>${cols.map(() => '<td></td>').join('')}</tr>`;
  return `<table class='items'><colgroup>${colgroup}</colgroup><thead><tr>${head}</tr></thead>`
    + `<tbody>${body.join('')}${filler}</tbody></table>`;
}

function gstTable(inv) {
  const intra = inv.intra_state !== false;
  const keys = ['taxable', 'cgst', 'sgst', 'igst'];
  const rates = new Map(STANDARD_RATES.map((r) => [r, { taxable: 0, cgst: 0, sgst: 0, igst: 0 }]));
  for (const it of inv.lines || []) {
    const pct = pyRound(f(it.gst_percent), 2);
    if (!rates.has(pct)) rates.set(pct, { taxable: 0, cgst: 0, sgst: 0, igst: 0 });
    const b = rates.get(pct);
    for (const k of keys) b[k] = pyRound(b[k] + f(it[k]), 2);
  }
  const head = `<th>GST%</th><th>TAXABLE</th>${intra ? '<th>SGST</th><th>CGST</th>' : '<th>IGST</th>'}<th>TOTAL</th>`;
  const body = [...rates.keys()].sort((a, b) => a - b).map((pct) => {
    const b = rates.get(pct);
    const tax = intra ? b.sgst + b.cgst : b.igst;
    const taxes = intra ? `<td class='n'>${mb(b.sgst)}</td><td class='n'>${mb(b.cgst)}</td>` : `<td class='n'>${mb(b.igst)}</td>`;
    return `<tr><td>${fx(pct)}</td><td class='n'>${mb(b.taxable)}</td>${taxes}<td class='n'>${mb(b.taxable + tax)}</td></tr>`;
  });
  return `<table class='gst'><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table>`;
}

function bankLines(shop) {
  let name = '';
  let branch = '';
  const rest = [];
  for (const [label, value] of shop.bank || []) {
    const low = String(label || '').trim().toLowerCase();
    if (low.startsWith('bank') && !name) name = String(value);
    else if (low.startsWith('branch') && !branch) branch = String(value);
    else rest.push([String(label || ''), String(value)]);
  }
  const out = [];
  if (name || branch) out.push(e(name.toUpperCase()) + (branch ? ` (${e(branch.toUpperCase())})` : ''));
  for (let [label, value] of rest) {
    const key = label.trim().toLowerCase().replace(/\./g, '').replace(/ /g, '');
    if (['a/cno', 'acno', 'accountno', 'account', 'a/c', 'ac'].includes(key)) label = 'A/C NO.';
    else if (key.startsWith('ifsc')) label = 'IFSC CODE';
    out.push(label ? `${e(label.toUpperCase())} : ${e(value)}` : e(value));
  }
  return out;
}

function totals(inv) {
  const intra = inv.intra_state !== false;
  const ret = f(inv.returns_total);
  const rows = [['SUB TOTAL', m(inv.sub_total)], ['Discount', mb(inv.line_discount)], ['Bill Disc', mb(inv.bill_discount)]];
  if (intra) rows.push(['SGST Value', mb(inv.sgst_total)], ['CGST Value', mb(inv.cgst_total)]);
  else rows.push(['IGST Value', mb(inv.igst_total)]);
  rows.push(['CR/DR', mb(inv.round_off)], ['CR/DR NOTE', ret ? fx(-ret) : '0.00']);
  let body = rows.map(([k, v]) => `<tr><td>${e(k)}</td><td class='n'>${v}</td></tr>`).join('');
  body += `<tr class='party'><td>PARTY TOTAL</td><td class='n'>${m(inv.party_total ?? inv.grand_total)}</td></tr>`;
  const paid = [];
  if (f(inv.amount_paid) > 0.004) paid.push(`Paid Rs ${m(inv.amount_paid)}`);
  for (const r of inv.receipts || []) paid.push(`Paid Rs ${m(r.amount)} (Rcpt ${e(r.receipt_no)})`);
  body += paid.slice(0, 2).map((p) => `<tr class='paid'><td colspan='2'>${p}</td></tr>`).join('');
  return `<table class='tot'>${body}</table>`;
}

function ledger(inv) {
  const bal = f(inv.ledger_balance);
  return fx(Math.abs(bal)) + (bal < -0.004 ? ' Cr' : '');
}

function signature(inv) {
  const src = String(inv.signature_src || '');
  if (!src.startsWith('data:image/')) return '';
  let look = inv.signature_look;
  if (typeof look !== 'string') look = naturalStyle();
  return `<img class='sign-img' src='${src}' alt='' style='${e(look)}'>`;
}

/** Each print its own small tilt, size and place, as on the retail bill (core/bill_signature_look). */
export function naturalStyle(rand = Math.random) {
  const MIN = 1.5; const MAX = 7.0;
  const u = (a, b) => a + (b - a) * rand();
  const tilt = rand() < 0.2 ? u(-MIN, MIN) : (rand() < 0.5 ? -1 : 1) * u(MIN, MAX);
  const size = u(0.80, 1.12);
  const dx = u(-8, 8);
  const dy = u(-14, 8);
  return `transform: translate(${dx.toFixed(1)}%, ${dy.toFixed(1)}%) rotate(${tilt.toFixed(2)}deg) scale(${size.toFixed(3)});`
    + 'transform-origin: 50% 85%;';
}

function box(inv, entries, page, pages, copyLabel) {
  const shop = inv.shop || {};
  const buyer = inv.buyer || {};
  const last = page === pages;
  const intra = inv.intra_state !== false;
  const name = String(shop.name || '');

  const left = [`<div class='shop-name' style='font-size:${shopNamePt(name).toFixed(1)}pt'>${e(name.toUpperCase())}</div>`];
  if (shop.address) left.push(`<div class='addr'>${e(String(shop.address).toUpperCase())}</div>`);
  if (shop.phone) left.push(`<div>Phone : ${e(shop.phone)}</div>`);
  if (shop.dl_numbers) left.push(`<div class='b'>D.L. : ${e(shop.dl_numbers)}</div>`);
  if (shop.gstin) left.push(`<div class='b'>GSTIN : ${e(shop.gstin)}</div>`);

  const meta = [['Invoice No.', e(inv.bill_no)], ['Date', e(dateDmy(inv.bill_date))]];
  if (inv.due_date && String(inv.due_date).slice(0, 10) !== String(inv.bill_date).slice(0, 10)) {
    meta.push(['Due Date', e(dateDmy(inv.due_date))]);
  }
  if (pages > 1) meta.push(['Page', `${page} of ${pages}`]);
  const mid = "<div class='title'>GST INVOICE</div>"
    + `<div class='pay'>(${e(inv.pay_label || 'CREDIT')})</div>`
    + `<table class='meta'>${meta.map(([k, v]) => `<tr><td>${k}</td><td>:</td><td class='b'>${v}</td></tr>`).join('')}</table>`;

  const right = ['<div>Buyer Name</div>', `<div class='party-name'>M/s ${e(String(buyer.name || '').toUpperCase())}</div>`];
  if (buyer.address) right.push(`<div class='addr'>${e(String(buyer.address).toUpperCase())}</div>`);
  right.push(`<div>PHONE NO. : ${e(buyer.phone)}</div>`);
  right.push(`<div class='b'>D.L.No. : ${e(buyer.dl_numbers)}</div>`);
  right.push(`<div class='b'>Party GSTIN : ${e(buyer.gstin)}</div>`);
  if (!intra) {
    const pos = inv.place_of_supply_name || buyer.state_name || '';
    const code = inv.place_of_supply || buyer.state_code || '';
    if (code) right.push(`<div>Place of Supply : ${e(pos)} (${e(code)})</div>`);
  }
  const carry = [['transport', 'Transport'], ['lr_no', 'LR No.'], ['eway_bill_no', 'E-way Bill']]
    .filter(([key]) => String(inv[key] || '').trim())
    .map(([key, label]) => `${label} : ${e(inv[key])}`);
  if (carry.length) right.push(`<div class='carry'>${carry.join('&nbsp;&nbsp;')}</div>`);

  let footLeft; let footMid; let footRight;
  if (last) {
    const bank = bankLines(shop);
    const bankHtml = bank.length ? `<div class='cap'>BANK DETAILS</div>${bank.map((b) => `<div class='line'>${b}</div>`).join('')}` : '';
    footLeft = `${gstTable(inv)}<div class='words'>${e(words(inv))}</div><div class='decl'>${e(inv.declaration || '')}</div>`;
    footMid = `<div class='line'>Total Item / Quantity : ${Math.trunc(f(inv.total_items))} / ${qty(inv.total_qty) || 0}</div>`
      + `${bankHtml}<div class='ledger'>LEDGER BAL. : ${ledger(inv)}</div>`;
    footRight = totals(inv);
  } else {
    footLeft = `<div class='cont'>Page ${page} of ${pages}</div>`;
    footMid = "<div class='cont'>Continued on next page ...</div>";
    footRight = '';
  }
  const label = copyLabel ? `<div class='copy-label'>${e(copyLabel)}</div>` : '';
  const sign = last ? signature(inv) : '';
  return `<div class="inv">
  <div class="head">
    <div class="h-left">${left.join('')}</div>
    <div class="h-mid">${mid}</div>
    <div class="h-right">${right.join('')}</div>
  </div>
  <div class="body">${itemsTable(inv, entries)}</div>
  <div class="foot">
    <div class="f-left">${footLeft}</div>
    <div class="f-mid">${footMid}</div>
    <div class="f-right">${footRight}</div>
    <div class="f-sign">
      <div class="sign-cust">Sign of Customer</div>
      <div class="sign-shop">${sign}<span>For ${e(name.toUpperCase())}</span></div>
    </div>
  </div>
</div>${label}`;
}

/** One invoice as its boxes (an A5 landscape each). */
export function invoiceBoxes(inv, copyLabel = '') {
  const entries = rowEntries(inv);
  const chunks = [];
  for (let i = 0; i < entries.length; i += ROWS_PER_PAGE) chunks.push(entries.slice(i, i + ROWS_PER_PAGE));
  if (!chunks.length) chunks.push([]);
  return chunks.map((chunk, i) => box(inv, chunk, i + 1, chunks.length, copyLabel));
}

function css(paper) {
  const a4 = paper === 'A4';
  const sheetH = a4 ? '297mm' : '148mm';
  const halfH = a4 ? '148.5mm' : '148mm';
  const page = a4 ? 'size: 210mm 297mm; margin: 0;' : 'size: 210mm 148mm; margin: 0;';
  return `
@page { ${page} }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { font-family: 'Times New Roman', Times, serif; font-size: 7.6pt; line-height: 1.18;
       -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet { width: 210mm; height: ${sheetH}; position: relative; overflow: hidden;
          page-break-after: always; break-after: page; }
.sheet:last-child { page-break-after: auto; break-after: auto; }
.half { width: 210mm; height: ${halfH}; padding: 4mm 5mm 4.2mm; position: relative; }
.cut { position: absolute; left: 0; right: 0; top: 148.5mm; border-top: 0.3mm dashed #000; }
.copy-label { position: absolute; right: 6mm; bottom: 0.6mm; font: 700 6.5pt Arial, sans-serif;
               letter-spacing: 0.5px; }
.inv { height: 100%; border: 0.3mm solid #000; display: flex; flex-direction: column; }
.b { font-weight: 700; }
.head { height: ${HEAD_MM.toFixed(1)}mm; flex: 0 0 auto; display: grid;
         grid-template-columns: 40% 22% 38%; border-bottom: 0.3mm solid #000; overflow: hidden; }
.head > div { padding: 1mm 1.6mm; overflow: hidden; }
.h-mid { border-left: 0.3mm solid #000; border-right: 0.3mm solid #000; }
.shop-name { font-weight: 700; line-height: 1.05; white-space: nowrap; overflow: hidden;
              margin-bottom: 0.6mm; }
.addr { max-height: 3.6em; overflow: hidden; }
.title { text-align: center; font-weight: 700; font-size: 12pt; margin-top: 0.8mm; }
.pay { text-align: center; font-weight: 700; font-size: 9pt; margin-bottom: 1.6mm; }
.meta { border-collapse: collapse; width: 100%; border-top: 0.3mm solid #000; }
.meta td { padding: 0.5mm 0.6mm 0; white-space: nowrap; vertical-align: top; }
.meta td:nth-child(2) { width: 2mm; }
.carry { font-size: 7pt; margin-top: 0.4mm; }
.party-name { font-weight: 700; font-size: 9pt; line-height: 1.1; }
.body { flex: 1 1 auto; min-height: 0; position: relative; }
.items { position: absolute; top: 0; left: 0; width: 100%; height: 100%;
          border-collapse: collapse; table-layout: fixed; }
.items th { height: ${THEAD_MM}mm; font-weight: 400; text-align: left; padding: 0 0.8mm;
             border-bottom: 0.3mm solid #000; border-right: 0.3mm solid #000;
             white-space: nowrap; overflow: hidden; font-size: 7.4pt; }
.items td { border-right: 0.3mm solid #000; padding: 0 0.8mm; white-space: nowrap;
             overflow: hidden; text-overflow: clip; vertical-align: top; }
.items th:last-child, .items td:last-child { border-right: 0; }
.items tr.r td { height: ${ROW_MM}mm; line-height: ${ROW_MM}mm; }
.items tr.filler td { height: 100%; }
.items td.t { text-overflow: ellipsis; }
.items td.n, .items td.rt { text-align: right; }
.items td.c { text-align: center; }
.items tr.ret-line td { font-style: italic; }
.foot { height: ${FOOT_MM.toFixed(1)}mm; flex: 0 0 auto; display: grid; border-top: 0.3mm solid #000;
         grid-template-columns: 37% 30% 33%; grid-template-rows: 1fr 6.4mm; }
.f-left { grid-row: 1 / span 2; overflow: hidden; }
.f-mid { border-left: 0.3mm solid #000; padding: 0.6mm 1.6mm; overflow: hidden; }
.f-right { border-left: 0.3mm solid #000; overflow: hidden; }
.f-sign { grid-column: 2 / span 2; border-left: 0.3mm solid #000; display: flex;
           align-items: flex-end; justify-content: space-between; padding: 0 1.6mm 0.8mm; }
.sign-cust { font-family: Arial, sans-serif; font-size: 7.6pt; }
.sign-shop { position: relative; font-family: Arial, sans-serif; font-weight: 700;
              font-size: 8.4pt; white-space: nowrap; }
.sign-shop span { position: relative; z-index: 1; }
.sign-img { position: absolute; right: 8%; bottom: 1.2mm; height: 13mm; max-width: 46mm;
             object-fit: contain; z-index: 2; transform-origin: 50% 85%; }
.gst { width: 100%; border-collapse: collapse; }
.gst th { font-weight: 400; text-align: left; padding: 0.3mm 0.8mm;
           border-bottom: 0.3mm solid #000; border-right: 0.3mm solid #000; }
.gst th:last-child { border-right: 0; }
.gst td { padding: 0 0.8mm; height: 3.1mm; }
.gst td.n { text-align: right; }
.words { font-weight: 700; padding: 0.6mm 0.8mm 0.4mm; border-top: 0.3mm solid #000; }
.decl { font-size: 6.2pt; line-height: 1.12; padding: 0 0.8mm; }
.cap { font-weight: 700; text-decoration: underline; margin-top: 0.6mm; }
.line { white-space: nowrap; overflow: hidden; }
.ledger { font-weight: 700; margin-top: 0.8mm; white-space: nowrap; }
.tot { width: 100%; border-collapse: collapse; }
.tot td { padding: 0 1.4mm; height: 3.25mm; white-space: nowrap; }
.tot td.n { text-align: right; }
.tot tr.party td { font-weight: 700; font-size: 10.5pt; height: 5.4mm;
                    border-top: 0.3mm solid #000; border-bottom: 0.3mm solid #000; }
.tot tr.paid td { font-size: 6.8pt; height: 3mm; text-align: right; }
.cont { padding: 2mm; font-style: italic; }
`;
}

/** Several invoices in one document: an A5 landscape page each ("A5"), or two to an A4
 *  portrait sheet, top and bottom, with a dashed cut line between ("A4"). */
export function renderWholesaleInvoicesHtml(invs, { paper = 'A5', copyLabel = '' } = {}) {
  const p = String(paper || '').toUpperCase() === 'A4' ? 'A4' : 'A5';
  const boxes = [];
  for (const inv of invs) boxes.push(...invoiceBoxes(inv, copyLabel));
  const per = p === 'A4' ? 2 : 1;
  const sheets = [];
  for (let i = 0; i < boxes.length; i += per) {
    const pair = boxes.slice(i, i + per);
    const halves = pair.map((b) => `<div class='half'>${b}</div>`).join('');
    const cut = pair.length > 1 ? "<div class='cut'></div>" : '';
    sheets.push(`<div class='sheet'>${halves}${cut}</div>`);
  }
  const title = invs.slice(0, 3).map((inv) => String(inv.bill_no || '')).join(' ');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>GST INVOICE ${e(title)}</title>
<style>${css(p)}</style></head>
<body class="paper-${p.toLowerCase()}">
${sheets.join('')}
</body></html>
`;
}

export function renderWholesaleInvoiceHtml(inv, { paper = 'A4', copyLabel = '' } = {}) {
  return renderWholesaleInvoicesHtml([inv], { paper, copyLabel });
}
