import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtDate, money, qs, todayIso } from '../api.js';

/**
 * Doctor Margin Report BY MARGIN RULES (owner, 22-23 Oct 2026) -- the PC's "By margin rules"
 * mode, the same figures (the server's doctorMarginRules.js is the PC's calculation).
 *
 * Per doctor, two parts (rules version 2, 23 Oct 2026):
 *   On profit       the owner's Excel: product / batch / quantity / MRP / rate / margin per unit /
 *                   total value and a TOTAL -- only the products picked into a group; or
 *                   customer-wise product-batch-wise with sub-totals.
 *   On total sales  the other software's "Customer-Wise Product-Batch Wise Sales": a heading per
 *                   product (name + pack), one row per bill line (customer, bill no, date, batch,
 *                   qty, rate, disc., value, doctor, type), a Sub Total, the total sale value and
 *                   the commission (X% of it).
 *   Doctor's margin = the on-profit TOTAL + the commission.
 * A bill keeps the rules it was saved with; "Recalculate period" works a period out again with
 * today's rules. The CSV and the print (A4 portrait, the shop's name, Printed on, Page n of N)
 * are the PC's files: core/doctor_margin_rules_report.py blocks() / _csv / report_html.
 *
 * The rules: "All doctors" and, where a doctor is different, that doctor's own. Per medicine
 * type: No margin / On profit (groups) / On total sales (%). A group is products of that type
 * picked from the list (tick boxes, Select all, search; a product can be limited to some
 * batches) or "All products" of the type, with its own margin (MRP - rate, % of MRP, Rs per
 * unit). One % of total sales per rule set (a doctor's empty box = the All doctors %).
 */

const FLAG_TEXT = { estimated: 'Rate not from a purchase', no_rate: 'No purchase rate', rate_over_mrp: 'Rate above MRP' };
const KIND_TEXT = { mrp_rate: 'MRP − rate', pct_mrp: '% of MRP', fixed: '₹ per unit', none: 'No margin' };
const MODE_TEXT = { none: 'No margin', groups: 'On profit (groups)', sales: 'On total sales (%)' };
const lc = (s) => String(s || '').trim().toLowerCase();
const qtyText = (v) => (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const clone = (x) => JSON.parse(JSON.stringify(x));
/** The PC's pctText / _pct: up to 4 decimals, no trailing zeros. */
const pctText = (p) => `${Number((Number(p) || 0).toFixed(4))}%`;

function marginText(m) {
  if (!m || m.kind === 'none') return 'No margin';
  if (m.kind === 'pct_mrp') return `${m.value}% of MRP`;
  if (m.kind === 'fixed') return `₹${money(m.value)} / unit`;
  return 'MRP − rate';
}
function typeSummary(r, salesPct) {
  if (!r || r.mode === 'none') return 'No margin';
  if (r.mode === 'sales') return `${pctText(salesPct)} of total sales`;
  if (r.groups.length === 1 && r.groups[0].all) return `All products: ${marginText(r.groups[0].margin)}`;
  const picked = r.groups.reduce((n, g) => n + (g.all ? 0 : g.items.length), 0);
  return `${r.groups.length} group(s), ${picked} product(s)${r.groups.some((g) => g.all) ? ' + all products' : ''}`;
}

function Flags({ flags }) {
  if (!flags?.length) return null;
  return flags.map((f) => <span key={f} className={`dmr-flag dmr-flag-${f}`} title={FLAG_TEXT[f]}>{FLAG_TEXT[f] || f}</span>);
}

// ── the files: the PC's blocks (core/doctor_margin_rules_report.py) ───────────────────────

/** A figure the PC writes with 2 decimals (a python float). */
const M = (v) => ({ m: Number(v) || 0 });
/** The PC's _q: a whole quantity as a whole number, else a 2-decimal figure. */
const Q = (v) => (Number.isInteger(Number(v)) ? Number(v) : M(v));
const isM = (v) => v !== null && typeof v === 'object' && 'm' in v;
const dmy = (iso, sep = '-') => {
  const s = String(iso || '').slice(0, 10);
  return s.length === 10 ? `${s.slice(8, 10)}${sep}${s.slice(5, 7)}${sep}${s.slice(0, 4)}` : s;
};
const DOCTOR_COLS = ['Product name', 'Batch', 'Quantity', 'MRP', 'Rate', 'Margin / unit', 'Total value'];
const DETAIL_COLS = ['Product / Customer', 'Bill no', 'Date', 'Batch', 'Qty', 'MRP', 'Rate', 'Margin / unit', 'Value', 'Doctor', 'Type'];
const SALES_COLS = ['Customer Name', 'Bill No.', 'Date', 'Batch No.', 'Qty', 'Rate', 'Disc.', 'Value', 'Doctor Name', 'Type'];
const SUMMARY_COLS = ['Doctor', 'On profit', 'Total sales', 'Commission', "Doctor's margin"];
const SALES_TITLE = 'Customer-Wise Product-Batch Wise Sales';

/** The on-profit detail layout of some lines: per product, its lines by batch / date, a sub-total. */
function profitProducts(rows) {
  const out = new Map();
  const key = (r) => [r.name, r.batch, r.date, r.bill_no];
  const sorted = [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
  for (const r of sorted) {
    let g = out.get(r.name);
    if (!g) {
      g = { name: r.name, type: r.type, lines: [], qty: 0, value: 0 };
      out.set(r.name, g);
    }
    g.lines.push(r);
    g.qty = Math.round((g.qty + r.qty) * 1000) / 1000;
    g.value = Math.round((g.value + r.value) * 100) / 100;
  }
  return [...out.values()];
}

function profitTable(rep, doctor, view) {
  const out = [];
  const mine = rep.rows.filter((r) => r.doctor === doctor);
  const d = rep.doctors.find((x) => x.doctor === doctor);
  if (!mine.length || !d) return [DOCTOR_COLS, out];
  if (view === 'detail') {
    for (const p of profitProducts(mine)) {
      out.push(['head', [p.name, ...Array(DETAIL_COLS.length - 1).fill('')]]);
      for (const r of p.lines) {
        out.push(['line', [r.patient, r.bill_no, dmy(r.date, '/'), r.batch, Q(r.qty), M(r.mrp), M(r.rate), M(r.margin_unit), M(r.value), r.doctor, r.type]]);
      }
      out.push(['sub', ['Sub total', '', '', '', Q(p.qty), '', '', '', M(p.value), '', '']]);
    }
    out.push(['total', ['TOTAL value (on profit)', '', '', '', Q(d.qty), '', '', '', M(d.value), '', '']]);
    return [DETAIL_COLS, out];
  }
  for (const r of rep.summary) {
    if (r.doctor === doctor) out.push(['line', [r.name, r.batch, Q(r.qty), M(r.mrp), M(r.rate), M(r.margin_unit), M(r.value)]]);
  }
  out.push(['total', ['', '', Q(d.qty), '', '', 'TOTAL value', M(d.value)]]);
  return [DOCTOR_COLS, out];
}

function salesTable(rep, doctor) {
  const out = [];
  const d = rep.sales.doctors.find((x) => x.doctor === doctor);
  if (!d) return [SALES_COLS, out];
  const blank = Array(SALES_COLS.length - 1).fill('');
  for (const p of d.products) {
    out.push(['head', [[p.name, p.pack].filter(Boolean).join(' '), ...blank]]);
    for (const r of p.lines) {
      out.push(['line', [r.patient, r.bill_no, dmy(r.date, '/'), r.batch, Q(r.qty), M(r.sale_rate), r.disc ? M(r.disc) : '-', M(r.value),
        r.doctor, String(r.type).toUpperCase()]]);
    }
    out.push(['sub', ['', '', '', 'Sub Total:', Q(p.qty), '', '', M(p.value), '', '']]);
  }
  const types = d.types.map((t) => String(t).toUpperCase()).join(', ');
  out.push(['total', [`Total sales value (${types})`, '', '', '', Q(d.qty), '', '', M(d.value), '', '']]);
  for (const b of d.by_pct) {
    out.push(['total', [`Commission ${pctText(b.pct)} of ${Number(b.value).toFixed(2)}`, '', '', '', '', '', '', M(b.commission), '', '']]);
  }
  return [SALES_COLS, out];
}

/** The report as stacked blocks: ['doctor', name] | ['table', title, cols, rows] | ['margin', label, value]. */
function blocks(rep, view) {
  const f = rep.filters;
  const out = [];
  const period = `From ${dmy(f.from, '/')} To ${dmy(f.to, '/')}`;
  for (const g of rep.grand.doctors) {
    out.push(['doctor', g.doctor]);
    let [cols, rows] = profitTable(rep, g.doctor, view);
    if (rows.length) out.push(['table', 'On profit (products in the groups)', cols, rows]);
    [cols, rows] = salesTable(rep, g.doctor);
    if (rows.length) out.push(['table', `On total sales - ${SALES_TITLE} ${period}`, cols, rows]);
    const parts = [];
    if (rep.doctors.some((d) => d.doctor === g.doctor)) parts.push(`on profit ${Number(g.profit).toFixed(2)}`);
    if (rep.sales.doctors.some((d) => d.doctor === g.doctor)) parts.push(`commission ${Number(g.commission).toFixed(2)}`);
    out.push(['margin', `${g.doctor} - doctor's margin (${parts.join(' + ')})`, g.total]);
  }
  if (rep.grand.doctors.length > 1) {
    const rows = rep.grand.doctors.map((g) => ['line', [g.doctor, M(g.profit), M(g.sales_value), M(g.commission), M(g.total)]]);
    const t = rep.grand.totals;
    rows.push(['total', ['ALL DOCTORS', M(t.profit), M(t.sales_value), M(t.commission), M(t.total)]]);
    out.push(['table', 'All doctors', SUMMARY_COLS, rows]);
  }
  return out;
}

function nowText(withTime) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const day = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day;
}

function headerLines(rep, view) {
  const f = rep.filters;
  return [
    ['Period', `${dmy(f.from)} to ${dmy(f.to)}`],
    ['Doctor', f.doctors.join(', ') || 'All doctors'],
    ['Rate (on profit)', rep.rate_basis_text],
    ['Layout (on profit)', view === 'doctor' ? 'Doctor-wise (product, qty, MRP, rate, total value)' : 'Customer-wise product-batch-wise'],
    ['Generated at', nowText(true)],
  ];
}

function csvCell(v) {
  const s = isM(v) ? v.m.toFixed(2) : String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The PC's _csv: title, the header lines, then the blocks. */
function csvText(title, heads, bl) {
  const lines = [[title], ...heads];
  for (const b of bl) {
    if (b[0] === 'doctor') lines.push([], [b[1]]);
    else if (b[0] === 'margin') lines.push([b[1], Number(b[2]).toFixed(2)]);
    else lines.push([b[1]], b[2], ...b[3].map(([, cells]) => cells));
  }
  return `﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cssStr = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;

/** The PC's report_html: A4 portrait, small type, the shop's name and Printed on / Page n of N
 *  on every page, then per doctor his two parts and his margin. */
function reportHtml(title, heads, bl, shop, period) {
  const cell = (v) => (isM(v) ? `<td class=num>${v.m.toFixed(2)}</td>`
    : typeof v === 'number' || v === '-' ? `<td class=num>${v}</td>` : `<td>${esc(v)}</td>`);
  const numeric = (rows, i) => {
    const vals = rows.filter(([k, c]) => k === 'line' && i < c.length && !['', null, '-'].includes(c[i])).map(([, c]) => c[i]);
    return vals.length > 0 && vals.every((v) => isM(v) || typeof v === 'number');
  };
  const body = [];
  for (const b of bl) {
    if (b[0] === 'doctor') { body.push(`<h3 class=doc>${esc(b[1])}</h3>`); continue; }
    if (b[0] === 'margin') { body.push(`<div class=margin><span>${esc(b[1])}</span><b>${Number(b[2]).toFixed(2)}</b></div>`); continue; }
    const [, sub, cols, rows] = b;
    const trs = rows.map(([kind, cells]) => (kind === 'head'
      ? `<tr class=head><td colspan=${cols.length}>${esc(cells[0])}</td></tr>`
      : `<tr class=${kind}>${cells.map(cell).join('')}</tr>`));
    const hdr = cols.map((h, i) => (numeric(rows, i) ? `<th class=num>${esc(h)}</th>` : `<th>${esc(h)}</th>`)).join('');
    body.push(`<div class=sub>${esc(sub)}</div><table class=grid><thead><tr>${hdr}</tr></thead><tbody>${trs.join('')}</tbody></table>`);
  }
  const meta = heads.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  const printed = nowText(false);
  const css = '@page{size:A4 portrait;margin:14mm 9mm 12mm 9mm;'
    + `@top-left{content:${cssStr(shop.name)};font:600 8pt Arial;color:#333}`
    + `@top-right{content:${cssStr(`Printed on : ${printed}`)};font:8pt Arial;color:#333}`
    + "@bottom-right{content:'Page ' counter(page) ' of ' counter(pages);font:8pt Arial;color:#333}}"
    + '@page :first{@top-left{content:none}@top-right{content:none}}'
    + 'body{font-family:Arial,Segoe UI,sans-serif;font-size:7.5pt;color:#000;margin:0;background:#fff}'
    + '.top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px}'
    + '.shop{font-size:13pt;font-weight:600}.addr{font-size:7.5pt;color:#555;margin-top:1px}'
    + '.printed{font-size:7.5pt;text-align:right}'
    + 'h2{font-size:9.5pt;font-weight:600;margin:6px 0 3px;color:#1f3b57}'
    + 'table{width:100%;border-collapse:collapse}'
    + 'table.meta{width:auto;margin-bottom:4px}table.meta th{text-align:left;padding:0 10px 0 0;font-weight:600}'
    + 'table.meta td{padding:0}'
    + 'h3.doc{font-size:10pt;margin:12px 0 2px;padding:3px 5px;background:#e8eef4;border-left:3px solid #1f4e79;break-after:avoid}'
    + '.sub{font-weight:600;font-size:8pt;margin:6px 0 2px;color:#1f3b57;break-after:avoid}'
    + 'table.grid th{border-top:1px solid #444;border-bottom:1px solid #444;padding:3px;text-align:left;font-weight:600;background:#f2f2f2}'
    + 'table.grid td{padding:2px 3px;border-bottom:.5px solid #e2e2e2}'
    + 'td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}table.grid th.num{text-align:right}'
    + 'thead{display:table-header-group}tr{break-inside:avoid}'
    + 'tr.head td{font-weight:600;font-size:8pt;padding-top:7px;background:#f7f7f7;border-bottom:1px solid #999}'
    + 'tr.sub td{font-weight:600;border-top:1px solid #777;border-bottom:1px solid #777}'
    + 'tr.total td{font-weight:700;border-top:1px solid #333}'
    + '.margin{display:flex;justify-content:space-between;margin:5px 0 4px;padding:4px 6px;'
    + 'border-top:1.5px solid #000;border-bottom:1.5px solid #000;font-size:9pt;font-weight:600}'
    + '*{-webkit-print-color-adjust:exact;print-color-adjust:exact}';
  const top = shop.name ? `<div class=top><div><div class=shop>${esc(shop.name)}</div><div class=addr>${esc(shop.address)}</div></div>`
    + `<div class=printed>Printed on : ${printed}</div></div>` : '';
  return `<!DOCTYPE html><html><head><meta charset=UTF-8><title>${esc(title)}</title><style>${css}</style></head><body>${top}`
    + `<h2>${esc(title)}${period ? ` ${esc(period)}` : ''}</h2><table class=meta>${meta}</table>${body.join('')}</body></html>`;
}

/** Print an HTML page through a hidden frame (no pop-up window to allow). */
function printHtml(html) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60000);
  }, 250);
}

// ── the report ──────────────────────────────────────────────────────────────────────────

export function DoctorMarginByRules({ from, to, setFrom, setTo, canEdit, onClose, modeSwitch }) {
  const [payload, setPayload] = useState(null);
  const [picked, setPicked] = useState(null); // null = every doctor
  const [findDoc, setFindDoc] = useState('');
  const [rateBasis, setRateBasis] = useState('');
  const [view, setView] = useState('doctor');
  const [rep, setRep] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [askRecalc, setAskRecalc] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const seq = useRef(0);

  useEffect(() => { api('/reports/doctor-margin/rules').then(setPayload).catch((e) => setError(e.message)); }, [reload]);
  const doctors = payload?.doctors || [];
  const chosen = picked ?? doctors;
  const problem = !from || !to ? 'Choose the From and To dates.'
    : from > to ? 'From date is after To date.'
      : doctors.length && !chosen.length ? 'Tick at least one doctor.' : '';
  const filters = useMemo(() => ({
    from, to, doctors: picked === null || chosen.length === doctors.length ? '' : chosen.join(','), rate_basis: rateBasis, view,
  }), [from, to, picked, chosen, doctors.length, rateBasis, view]);
  const dataKey = JSON.stringify({ ...filters, view: undefined, reload });

  useEffect(() => {
    if (problem) { seq.current += 1; setRep(null); setLoading(false); return undefined; }
    const mine = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      api(`/reports/doctor-margin/by-rules${qs(filters)}`)
        .then((r) => { if (mine === seq.current) { setRep(r); setError(''); } })
        .catch((e) => { if (mine === seq.current) setError(e.message); })
        .finally(() => { if (mine === seq.current) setLoading(false); });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problem, dataKey]);
  // The layout is only how the same lines are shown. An answer of an older server (no `sales`)
  // reads as on-profit only.
  const shown = rep ? {
    ...rep,
    filters: { ...rep.filters, view },
    sales: rep.sales || { rows: [], doctors: [], totals: { qty: 0, value: 0, lines: 0, commission: 0 } },
    grand: rep.grand || {
      doctors: rep.doctors.map((d) => ({ doctor: d.doctor, profit: d.value, sales_value: 0, commission: 0, total: d.value })),
      totals: { profit: rep.totals.value, sales_value: 0, commission: 0, total: rep.totals.value },
    },
  } : null;

  function quick(which) {
    const t = todayIso();
    const d = new Date(`${t}T00:00:00`);
    if (which === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    if (which === 'last10') d.setDate(d.getDate() - 9);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    setFrom(which === 'today' ? t : which === 'month' ? `${t.slice(0, 8)}01` : iso);
    setTo(t);
  }

  async function recalc() {
    setAskRecalc(false);
    setBusy('recalc');
    setError('');
    setNote('');
    try {
      const r = await api('/reports/doctor-margin/recalculate', { method: 'POST', body: filters });
      seq.current += 1;
      setRep(r);
      setNote(`Recalculated ${r.sync?.bills ?? 0} doctor bill(s) of ${fmtDate(from)} – ${fmtDate(to)} with today's rules.`);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  }

  const fileTitle = 'Doctor Margin Report';
  const period = shown ? `From ${dmy(shown.filters.from, '/')} To ${dmy(shown.filters.to, '/')}` : '';

  function csv() {
    const text = csvText(`${fileTitle} ${period}`, headerLines(shown, view), blocks(shown, view));
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `doctor_margin_${view}_${shown.filters.from}_${shown.filters.to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function print() {
    setBusy('print');
    let shop = { name: '', address: '' };
    try {
      const me = await api('/me');
      shop = { name: String(me.profile?.name || me.store_name || ''), address: String(me.profile?.address || '').split(/\s+/).filter(Boolean).join(' ') };
    } catch { /* printed without the shop's heading */ }
    try {
      printHtml(reportHtml(fileTitle, headerLines(shown, view), blocks(shown, view), shop, period));
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  }

  const g = shown?.grand;
  const counts = shown?.flag_counts;
  const anyLines = Boolean(shown && (shown.rows.length || shown.sales.rows.length));
  const cannot = Boolean(busy) || Boolean(problem) || !shown || !anyLines;
  const docList = doctors.filter((d) => d.toLowerCase().includes(findDoc.trim().toLowerCase()));

  return (
    <>
      <div>
        <h3>Doctor Margin Report</h3>
        {modeSwitch}
        <div className="row wrap">
          <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <div className="chips">
            <button className="chip" onClick={() => quick('today')}>Today</button>
            <button className="chip" onClick={() => quick('last10')}>Last 10 days</button>
            <button className="chip" onClick={() => quick('week')}>This week</button>
            <button className="chip" onClick={() => quick('month')}>This month</button>
          </div>
          <label>Rate (on profit)<select value={rateBasis} onChange={(e) => setRateBasis(e.target.value)}>
            <option value="">As saved with each bill (rules)</option>
            <option value="purchase">Purchase rate</option>
            <option value="purchase_free">Purchase rate with free included</option>
          </select></label>
          <label>On-profit layout
            <div className="seg" role="radiogroup" aria-label="On-profit layout">
              <button role="radio" aria-checked={view === 'doctor'} className={view === 'doctor' ? 'on' : ''} onClick={() => setView('doctor')}>Doctor-wise (Excel)</button>
              <button role="radio" aria-checked={view === 'detail'} className={view === 'detail' ? 'on' : ''} onClick={() => setView('detail')}>Customer-wise product-batch</button>
            </div>
          </label>
        </div>
        <div className="dm-types">
          <div className="row wrap">
            <b>Doctors</b>
            <span className="muted small">{!payload ? 'Loading…' : doctors.length ? `${chosen.length === doctors.length ? `All ${doctors.length}` : `${chosen.length} of ${doctors.length}`} ticked` : 'No doctor on any bill yet.'}</span>
            {doctors.length > 6 && <input className="dmr-find" value={findDoc} onChange={(e) => setFindDoc(e.target.value)} placeholder="Find a doctor…" />}
            <button className="btn small" onClick={() => setPicked(null)}>Select all</button>
            <button className="btn small" onClick={() => setPicked([])}>Clear all</button>
          </div>
          <div className="dm-type-grid">
            {docList.map((d) => (
              <label key={d} className="check"><input type="checkbox" checked={chosen.includes(d)}
                onChange={(e) => setPicked(e.target.checked ? [...chosen, d] : chosen.filter((x) => x !== d))} /> {d}</label>
            ))}
          </div>
        </div>
        <div className="row wrap">
          <button className="btn primary" onClick={() => setRulesOpen(true)}>Margin rules…</button>
          {canEdit && <button className="btn" disabled={Boolean(busy) || Boolean(problem)} onClick={() => setAskRecalc(true)}
            title="Work this period out again with today's rules">{busy === 'recalc' ? 'Recalculating…' : 'Recalculate period'}</button>}
          <span className="grow" />
          <button className="btn" disabled={cannot} onClick={csv}>Excel (CSV)</button>
          <button className="btn" disabled={cannot} onClick={print} title="A4 page as the PC prints it: Print, or Save as PDF">{busy === 'print' ? 'Preparing…' : 'Print / PDF'}</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        {askRecalc && (
          <div className="dmr-confirm" role="alertdialog" aria-label="Recalculate">
            <span>Every doctor bill of {fmtDate(from)} – {fmtDate(to)} will be worked out again with today's rules and today's
              purchase rates. The figures the bills were saved with are replaced, on the PC too when it recalculates.</span>
            <button className="btn primary small" onClick={recalc}>Recalculate</button>
            <button className="btn small" onClick={() => setAskRecalc(false)}>Cancel</button>
          </div>
        )}
        {problem && <div className="error">{problem}</div>}
        {error && !problem && <div className="error">{error}</div>}
        {note && <div className="okmsg">{note}</div>}
      </div>

      <div className="dm-report" aria-busy={loading}>
        <div className="row between">
          <b>{fmtDate(from)} to {fmtDate(to)}</b>
          <span className="muted small">{loading ? 'Updating…' : shown ? `On profit: ${shown.rate_basis_text} · on total sales: % of the sale value` : ''}</span>
        </div>
        {shown && g && (
          <>
            {!shown.has_rules && (
              <p className="dmr-hint">No margin rules yet. Press <b>Margin rules…</b> and choose, for each medicine type, how the doctor
                gets his margin: on profit (the products you put in groups) or on total sales (a %).</p>
            )}
            <div className="tiles">
              <div><span>Doctors</span><b>{g.doctors.length}</b></div>
              <div><span>On profit</span><b>₹ {money(g.totals.profit)}</b></div>
              <div><span>Total sales</span><b>₹ {money(g.totals.sales_value)}</b></div>
              <div><span>Commission on sales</span><b>₹ {money(g.totals.commission)}</b></div>
              <div className="dmr-total-tile"><span>Doctors' margin</span><b>₹ {money(g.totals.total)}</b></div>
            </div>
            {counts && (counts.estimated || counts.no_rate || counts.rate_over_mrp) ? (
              <ul className="dmr-flag-notes">
                {counts.estimated ? <li><span className="dmr-flag dmr-flag-estimated">{FLAG_TEXT.estimated}</span> {counts.estimated} line(s): no purchase bill of that batch; the batch's own purchase rate (or the cost on the bill) is used.</li> : null}
                {counts.no_rate ? <li><span className="dmr-flag dmr-flag-no_rate">{FLAG_TEXT.no_rate}</span> {counts.no_rate} line(s): no rate known, so MRP − rate gives 0.</li> : null}
                {counts.rate_over_mrp ? <li><span className="dmr-flag dmr-flag-rate_over_mrp">{FLAG_TEXT.rate_over_mrp}</span> {counts.rate_over_mrp} line(s): the rate is above MRP, counted as 0.</li> : null}
              </ul>
            ) : null}
            {!anyLines ? (
              <p className="muted">No doctor margin in this period{picked !== null && chosen.length < doctors.length ? ' for these doctors' : ''}.</p>
            ) : (
              <div className="dmr-doctors">
                {g.doctors.map((gd) => {
                  const pd = shown.doctors.find((d) => d.doctor === gd.doctor);
                  const sd = shown.sales.doctors.find((d) => d.doctor === gd.doctor);
                  return (
                    <section key={gd.doctor} className="dmr-doctor">
                      <div className="dmr-doctor-head">
                        <b>{gd.doctor}</b>
                        <span className="muted small">
                          {pd ? `on profit ₹${money(gd.profit)}` : ''}{pd && sd ? ' + ' : ''}{sd ? `commission ₹${money(gd.commission)}` : ''}
                        </span>
                        <span className="dmr-doctor-total">₹ {money(gd.total)}</span>
                      </div>
                      {pd ? <ProfitPart rep={shown} doctor={gd.doctor} d={pd} view={view} /> : null}
                      {sd ? <SalesPart d={sd} from={from} to={to} /> : null}
                      <div className="dmr-doctor-margin">
                        <span>{gd.doctor} — doctor's margin{pd && sd ? ` (on profit ₹${money(gd.profit)} + commission ₹${money(gd.commission)})` : ''}</span>
                        <b>₹ {money(gd.total)}</b>
                      </div>
                    </section>
                  );
                })}
                {g.doctors.length > 1 && (
                  <div className="dm-scroll">
                    <table className="grid compact dmr-all-doctors">
                      <thead><tr><th>All doctors</th><th className="r">On profit</th><th className="r">Total sales</th><th className="r">Commission</th><th className="r">Doctor's margin</th></tr></thead>
                      <tbody>
                        {g.doctors.map((x) => (
                          <tr key={x.doctor}><td>{x.doctor}</td><td className="r">{money(x.profit)}</td><td className="r">{money(x.sales_value)}</td>
                            <td className="r">{money(x.commission)}</td><td className="r">{money(x.total)}</td></tr>
                        ))}
                      </tbody>
                      <tfoot><tr className="dmr-sum dmr-grand-row"><td>ALL DOCTORS</td><td className="r">{money(g.totals.profit)}</td>
                        <td className="r">{money(g.totals.sales_value)}</td><td className="r">{money(g.totals.commission)}</td>
                        <td className="r">{money(g.totals.total)}</td></tr></tfoot>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {rulesOpen && (
        <RulesEditor canEdit={canEdit} onClose={() => setRulesOpen(false)}
          onSaved={() => {
            setNote('Rules saved. New bills use them; bills already saved keep their figures — press Recalculate period to apply the new rules to this period.');
            setReload((n) => n + 1);
          }} />
      )}
    </>
  );
}

/** One doctor's "On profit" part: doctor-wise (the owner's Excel) or customer-wise product-batch. */
function ProfitPart({ rep, doctor, d, view }) {
  return (
    <div className="dmr-part">
      <div className="dmr-part-head"><b>On profit</b><span className="muted small">products in the groups · {d.lines} bill line(s) · qty {qtyText(d.qty)}</span></div>
      <div className="dm-scroll">
        {view === 'doctor' ? (
          <table className="grid compact">
            <thead><tr><th>Product name</th><th>Batch</th><th className="r">Quantity</th><th className="r">MRP</th><th className="r">Rate</th>
              <th className="r">Margin / unit</th><th className="r">Total value</th><th>Rule</th></tr></thead>
            <tbody>
              {rep.summary.filter((r) => r.doctor === doctor).map((r, i) => (
                <tr key={i}>
                  <td>{r.name} <Flags flags={r.flags} /></td><td>{r.batch}</td><td className="r">{qtyText(r.qty)}</td>
                  <td className="r">{money(r.mrp)}</td><td className="r">{money(r.rate)}</td><td className="r">{money(r.margin_unit)}</td>
                  <td className="r">{money(r.value)}</td><td className="muted small" title={KIND_TEXT[r.kind] || r.kind}>{r.rule}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="dmr-sum"><td colSpan={2}>TOTAL value</td><td className="r">{qtyText(d.qty)}</td><td colSpan={3} />
              <td className="r">{money(d.value)}</td><td /></tr></tfoot>
          </table>
        ) : (
          <table className="grid compact">
            <thead><tr><th>Customer</th><th>Bill no</th><th>Date</th><th>Batch</th><th className="r">Qty</th><th className="r">MRP</th>
              <th className="r">Rate</th><th className="r">Margin / unit</th><th className="r">Value</th><th>Type</th></tr></thead>
            {profitProducts(rep.rows.filter((r) => r.doctor === doctor)).map((p) => (
              <tbody key={p.name}>
                <tr className="dmr-product"><td colSpan={10}>{p.name}</td></tr>
                {p.lines.map((r, i) => (
                  <tr key={i}>
                    <td>{r.patient}</td><td>{r.bill_no}</td><td>{fmtDate(r.date)}</td><td>{r.batch}</td>
                    <td className="r">{qtyText(r.qty)}{r.qty_returned ? <span className="muted small"> (−{qtyText(r.qty_returned)} ret.)</span> : null}</td>
                    <td className="r">{money(r.mrp)}</td><td className="r">{money(r.rate)}</td><td className="r">{money(r.margin_unit)}</td>
                    <td className="r">{money(r.value)}</td><td>{r.type} <Flags flags={r.flags} /></td>
                  </tr>
                ))}
                <tr className="dmr-sub"><td colSpan={4}>Sub total</td><td className="r">{qtyText(p.qty)}</td><td colSpan={3} />
                  <td className="r">{money(p.value)}</td><td /></tr>
              </tbody>
            ))}
            <tfoot><tr className="dmr-sum"><td colSpan={4}>TOTAL value</td><td className="r">{qtyText(d.qty)}</td><td colSpan={3} />
              <td className="r">{money(d.value)}</td><td /></tr></tfoot>
          </table>
        )}
      </div>
    </div>
  );
}

/** One doctor's "On total sales" part: the other software's Customer-Wise Product-Batch Wise Sales. */
function SalesPart({ d, from, to }) {
  return (
    <div className="dmr-part">
      <div className="dmr-part-head"><b>On total sales</b>
        <span className="muted small">Customer-wise product-batch-wise sales {fmtDate(from)} – {fmtDate(to)} · {d.types.join(', ')}</span></div>
      <div className="dm-scroll">
        <table className="grid compact dmr-sales">
          <thead><tr><th>Customer name</th><th>Bill no</th><th>Date</th><th>Batch no</th><th className="r">Qty</th><th className="r">Rate</th>
            <th className="r">Disc.</th><th className="r">Value</th><th>Doctor name</th><th>Type</th></tr></thead>
          {d.products.map((p) => (
            <tbody key={`${p.name}|${p.pack}`}>
              <tr className="dmr-product"><td colSpan={10}>{p.name}{p.pack ? <span className="dmr-pack"> {p.pack}</span> : null}</td></tr>
              {p.lines.map((r, i) => (
                <tr key={i}>
                  <td>{r.patient}</td><td>{r.bill_no}</td><td>{fmtDate(r.date)}</td><td>{r.batch}</td>
                  <td className="r">{qtyText(r.qty)}{r.qty_returned ? <span className="muted small"> (−{qtyText(r.qty_returned)} ret.)</span> : null}</td>
                  <td className="r">{money(r.sale_rate)}</td><td className="r">{r.disc ? money(r.disc) : '-'}</td><td className="r">{money(r.value)}</td>
                  <td>{r.doctor}</td><td>{String(r.type).toUpperCase()}</td>
                </tr>
              ))}
              <tr className="dmr-sub"><td colSpan={3} /><td>Sub Total:</td><td className="r">{qtyText(p.qty)}</td><td colSpan={2} />
                <td className="r">{money(p.value)}</td><td colSpan={2} /></tr>
            </tbody>
          ))}
          <tfoot>
            <tr className="dmr-sum"><td colSpan={4}>Total sales value</td><td className="r">{qtyText(d.qty)}</td><td colSpan={2} />
              <td className="r">{money(d.value)}</td><td colSpan={2} /></tr>
            {d.by_pct.map((b) => (
              <tr key={b.pct} className="dmr-sum dmr-commission"><td colSpan={7}>Commission {pctText(b.pct)} of ₹{money(b.value)}</td>
                <td className="r">{money(b.commission)}</td><td colSpan={2} /></tr>
            ))}
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ── the rules ───────────────────────────────────────────────────────────────────────────

function MarginEdit({ value, onChange, allowNone, disabled }) {
  const kind = value?.kind || 'none';
  return (
    <span className="dmr-margin">
      <select value={kind} aria-label="Margin kind" disabled={disabled}
        onChange={(e) => {
          const k = e.target.value;
          onChange(k === 'none' ? (allowNone ? { kind: 'none', value: 0 } : null) : { kind: k, value: k === 'mrp_rate' ? 0 : value?.value || 0 });
        }}>
        <option value="mrp_rate">{KIND_TEXT.mrp_rate}</option>
        <option value="pct_mrp">{KIND_TEXT.pct_mrp}</option>
        <option value="fixed">{KIND_TEXT.fixed}</option>
        {allowNone ? <option value="none">{KIND_TEXT.none}</option> : null}
      </select>
      {kind === 'pct_mrp' || kind === 'fixed' ? (
        <input type="number" className="num" min={0} max={kind === 'pct_mrp' ? 100 : undefined} step={kind === 'pct_mrp' ? 0.5 : 0.01}
          value={value?.value ?? 0} disabled={disabled} aria-label={kind === 'pct_mrp' ? 'Percent of MRP' : 'Rupees per unit'}
          onChange={(e) => onChange({ kind, value: Number(e.target.value) || 0 })} />
      ) : null}
    </span>
  );
}

/** The product list of one type: tick boxes, Select all, search, stock; batches of the focused product. */
function ProductPicker({ type, initial, others, onDone, onClose }) {
  const [products, setProducts] = useState(null);
  const [error, setError] = useState('');
  const [find, setFind] = useState('');
  const [sel, setSel] = useState(() => Object.fromEntries(initial.map((i) => [i.product, i.batches])));
  const [focus, setFocus] = useState('');

  useEffect(() => {
    api(`/reports/doctor-margin/rules/products${qs({ type })}`).then((r) => setProducts(r.products)).catch((e) => setError(e.message));
  }, [type]);
  const shown = useMemo(() => {
    const q = find.trim().toUpperCase();
    return (products || []).filter((p) => !q || p.product.includes(q) || String(p.contents || '').toUpperCase().includes(q));
  }, [products, find]);
  const allTicked = shown.length > 0 && shown.every((p) => p.product in sel);
  const focused = (products || []).find((p) => p.product === focus) || null;
  const count = Object.keys(sel).length;
  const toggle = (name, on) => setSel((s) => {
    const n = { ...s };
    if (on) n[name] = n[name] || [];
    else delete n[name];
    return n;
  });

  return (
    <div className="modal-back dmr-top dmr-top2" onClick={onClose}>
      <div className="modal wide-modal dmr-picker" role="dialog" aria-label={`Product list — ${type}`} onClick={(e) => e.stopPropagation()}>
        <div className="row between"><h3>Product list — {type}</h3><button className="btn small" onClick={onClose}>Close</button></div>
        <div className="dmr-picker-body">
          <div className="dmr-picker-left">
            <input placeholder="Search product or contents…" value={find} autoFocus onChange={(e) => setFind(e.target.value)} />
            {error && <div className="error">{error}</div>}
            <div className="dmr-picker-table">
              <table className="grid compact">
                <thead><tr>
                  <th className="dmr-tick"><label className="check" title="Select all shown"><input type="checkbox" checked={allTicked}
                    onChange={(e) => setSel((s) => {
                      const n = { ...s };
                      for (const p of shown) {
                        if (e.target.checked) n[p.product] = n[p.product] || [];
                        else delete n[p.product];
                      }
                      return n;
                    })} /> All</label></th>
                  <th className="r">Stock</th><th>Product name</th><th>Pack</th><th>Company</th><th>Contents</th>
                </tr></thead>
                <tbody>
                  {products === null ? <tr><td colSpan={6} className="muted">Loading…</td></tr>
                    : !shown.length ? <tr><td colSpan={6} className="muted">No {type} product{find ? ' matches' : ' in the medicine list'}.</td></tr>
                      : shown.map((p) => (
                        <tr key={p.product} className={`${focus === p.product ? 'sel' : ''} ${p.product in sel ? 'dmr-ticked' : ''}`} onClick={() => setFocus(p.product)}>
                          <td className="dmr-tick"><input type="checkbox" checked={p.product in sel} aria-label={`Pick ${p.product}`}
                            onClick={(e) => e.stopPropagation()} onChange={(e) => { toggle(p.product, e.target.checked); setFocus(p.product); }} /></td>
                          <td className="r">{p.stock}</td>
                          <td>{p.product}
                            {others[p.product] ? <span className="tag">in {others[p.product]}</span> : null}
                            {sel[p.product]?.length ? <span className="tag">{sel[p.product].length} batch(es)</span> : null}</td>
                          <td>{p.pack}</td><td>{p.company}</td><td className="small">{p.contents}</td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          </div>
          <aside className="dmr-picker-side">
            {focused ? (
              <>
                <h3>{focused.product}</h3>
                <div className="small"><b>Type</b> {focused.type} · <b>Pack</b> {focused.pack || '—'} · <b>Company</b> {focused.company || '—'} · <b>Stock</b> {focused.stock}</div>
                <h4>Batches</h4>
                {!(focused.product in sel) ? <p className="muted small">Tick the product to give it a margin; then choose its batches here.</p> : (
                  <>
                    <label className="check"><input type="radio" checked={!sel[focused.product].length}
                      onChange={() => setSel((s) => ({ ...s, [focused.product]: [] }))} /> All batches (also batches bought later)</label>
                    <label className="check"><input type="radio" checked={sel[focused.product].length > 0} disabled={!focused.batches.length}
                      onChange={() => setSel((s) => ({ ...s, [focused.product]: focused.batches.slice(0, 1).map((b) => b.batch) }))} /> Only these batches</label>
                    {sel[focused.product].length ? (
                      <div className="dmr-batches">
                        {focused.batches.map((b) => (
                          <label key={b.batch} className="check">
                            <input type="checkbox" checked={sel[focused.product].includes(b.batch)}
                              onChange={(e) => setSel((s) => {
                                const cur = s[focused.product] || [];
                                const next = e.target.checked ? [...cur, b.batch] : cur.filter((x) => x !== b.batch);
                                return { ...s, [focused.product]: next };
                              })} />
                            <b>{b.batch}</b>
                            <span className="muted small">stock {b.stock}{b.expiry ? ` · exp ${b.expiry.slice(0, 7)}` : ''} · MRP {money(b.mrp)}</span>
                          </label>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </>
            ) : <p className="muted small">Click a product to see its batches.</p>}
          </aside>
        </div>
        <div className="row end">
          <span className="muted small">{count} product(s) picked</span>
          <span className="grow" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onDone(Object.entries(sel).map(([product, batches]) => ({ product, batches })))}>OK</button>
        </div>
      </div>
    </div>
  );
}

export function RulesEditor({ canEdit, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [rules, setRules] = useState(null);
  const [setKey, setSetKey] = useState('');
  const [typeKey, setTypeKey] = useState('');
  const [picker, setPicker] = useState(null);
  const [addDoctor, setAddDoctor] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/reports/doctor-margin/rules').then((p) => { setData(p); setRules(p.rules); }).catch((e) => setError(e.message));
  }, []);
  const types = useMemo(() => {
    const out = [];
    const seen = new Set();
    for (const t of [...(data?.types || []), ...(rules?.sets.flatMap((s) => s.types.map((r) => r.type)) || [])]) {
      if (t && !seen.has(lc(t))) { seen.add(lc(t)); out.push(t); }
    }
    return out;
  }, [data, rules]);

  const close = () => {
    if (dirty && !window.confirm('Close without saving the changed rules?')) return;
    onClose();
  };
  if (!rules || !data) {
    return (
      <div className="modal-back dmr-top" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>Doctor margin rules</h3>
          {error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>}
          <div className="row end"><button className="btn" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }

  const ro = !canEdit;
  const set = rules.sets.find((s) => s.doctor === setKey) || rules.sets[0];
  const isDefault = set.doctor === '';
  const defaults = rules.sets[0];
  const ruleOf = (s, t) => s.types.find((r) => lc(r.type) === lc(t));
  const change = (fn) => {
    const next = clone(rules);
    fn(next);
    setRules(next);
    setDirty(true);
  };
  const inSet = (r) => r.sets.find((s) => s.doctor === set.doctor);
  const setTypeRule = (t, fn) => change((r) => {
    const s = inSet(r);
    let rule = ruleOf(s, t);
    if (!rule) {
      rule = { type: t, mode: 'none', groups: [] };
      s.types.push(rule);
    }
    fn(rule);
  });
  const setMode = (t, mode) => {
    if (mode === 'default') {
      change((r) => { const s = inSet(r); s.types = s.types.filter((x) => lc(x.type) !== lc(t)); });
      return;
    }
    setTypeRule(t, (rule) => { rule.mode = mode; });
    setTypeKey(t);
  };
  async function save() {
    setBusy(true);
    setError('');
    try {
      const out = await api('/reports/doctor-margin/rules', { method: 'PUT', body: { rules } });
      setRules(out.rules);
      setDirty(false);
      onSaved();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const selRule = typeKey ? ruleOf(set, typeKey) : undefined;
  const groupsRule = selRule && selRule.mode === 'groups' ? selRule : undefined;
  // The % this set's total-sales types get: its own, or All doctors' when it has none.
  const salesPct = set.sales_pct ?? defaults.sales_pct ?? 0;
  // Types on each way for this set, its own and the ones it follows from All doctors.
  const wayOf = (t) => (ruleOf(set, t) || (isDefault ? undefined : ruleOf(defaults, t)))?.mode;
  const salesTypes = types.filter((t) => wayOf(t) === 'sales');
  const profitTypes = types.filter((t) => wayOf(t) === 'groups');
  const freeDoctors = data.doctors.filter((d) => !rules.sets.some((s) => s.doctor === d));
  const otherGroups = (gi) => {
    const out = {};
    groupsRule?.groups.forEach((g, i) => { if (i !== gi) for (const it of g.items) out[it.product] = g.name; });
    return out;
  };
  const emptyGroups = groupsRule?.groups.filter((g) => !g.all && !g.items.length).length || 0;

  return (
    <div className="modal-back dmr-top" onClick={close}>
      <div className="modal wide-modal dmr-editor" role="dialog" aria-label="Doctor margin rules" onClick={(e) => e.stopPropagation()}>
        <div className="row between"><h3>Doctor margin rules</h3>{ro && <span className="muted small">View only — changing the rules needs the Reports permission.</span>}</div>
        <div className="dmr-editor-body">
          <nav className="dmr-sets" aria-label="Rules for">
            <span className="muted small">Rules for</span>
            {rules.sets.map((s) => (
              <button key={s.doctor || '*'} className={`dmr-set ${s.doctor === set.doctor ? 'on' : ''}`}
                onClick={() => { setSetKey(s.doctor); setTypeKey(''); }}>
                <b>{s.doctor || 'All doctors'}</b>
                <span className="muted small">{s.doctor ? `${s.types.length} type(s) of its own` : 'default for every doctor'}</span>
              </button>
            ))}
            {!ro && (
              <div className="dmr-add-doctor">
                <select value={addDoctor} onChange={(e) => setAddDoctor(e.target.value)}>
                  <option value="">Doctor with different rules…</option>
                  {freeDoctors.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <button className="btn small" disabled={!addDoctor} onClick={() => {
                  change((r) => { r.sets.push({ doctor: addDoctor, rate_basis: null, sales_pct: null, types: [] }); });
                  setSetKey(addDoctor);
                  setTypeKey('');
                  setAddDoctor('');
                }}>Add</button>
              </div>
            )}
          </nav>

          <section className="dmr-types">
            <div className="row wrap">
              <h3 className="grow">{isDefault ? 'All doctors' : set.doctor}</h3>
              <label>Rate used for MRP − rate
                <select value={isDefault ? rules.rate_basis : set.rate_basis || ''} disabled={ro}
                  onChange={(e) => change((r) => {
                    if (isDefault) r.rate_basis = e.target.value;
                    else inSet(r).rate_basis = e.target.value || null;
                  })}>
                  {!isDefault ? <option value="">Same as all doctors</option> : null}
                  <option value="purchase">Purchase rate (as billed)</option>
                  <option value="purchase_free">Purchase rate with free included</option>
                </select>
              </label>
              <label className="dmr-pct">% of total sales
                <span className="row">
                  <input type="number" className="num" min={0} max={100} step={0.5} disabled={ro}
                    value={isDefault ? (set.sales_pct ?? 0) : (set.sales_pct ?? '')}
                    placeholder={isDefault ? '0' : `${defaults.sales_pct ?? 0} (all)`} aria-label="Percent of total sales"
                    onChange={(e) => change((r) => {
                      const v = e.target.value;
                      inSet(r).sales_pct = v === '' ? (isDefault ? 0 : null) : Math.min(100, Math.max(0, Number(v) || 0));
                    })} />
                  <span>%</span>
                </span>
              </label>
            </div>
            {!isDefault && !ro && (
              <div className="row wrap">
                <button className="btn small" title="Start this doctor from the All doctors rules"
                  onClick={() => change((r) => { inSet(r).types = clone(r.sets[0].types); })}>Copy All doctors rules</button>
                <button className="btn small" onClick={() => {
                  change((r) => { r.sets = r.sets.filter((s) => s.doctor !== set.doctor); });
                  setSetKey('');
                  setTypeKey('');
                }}>Remove this doctor's rules</button>
              </div>
            )}
            <p className="dmr-hint">
              {isDefault ? 'Choose for each type one of two ways: On profit — only the products you put in groups, each group with its own margin; or On total sales — a % of the sale value of every product of the type.'
                : 'A type set to "Same as all doctors" follows the All doctors rules. Leave the % box empty to use the All doctors %.'}{' '}
              On profit, rate = the purchase rate of the batch sold (free included: ₹100 for 10 + 5 free = ₹6.67 a unit).
            </p>
            <div className="dmr-ways" aria-label="The two ways">
              <div className={`dmr-way ${profitTypes.length ? 'on' : ''}`}>
                <b>On profit (groups)</b>
                <span>{profitTypes.length ? profitTypes.join(', ') : 'no type'}</span>
              </div>
              <div className={`dmr-way ${salesTypes.length ? 'on' : ''}`}>
                <b>On total sales — {pctText(salesPct)}</b>
                <span>{salesTypes.length
                  ? `${salesTypes.join(', ')}: ${pctText(salesPct)} of their total sale value (MRP rate as billed, less line discount, less returns)`
                  : 'no type'}</span>
              </div>
            </div>
            <div className="dmr-types-table">
              <table className="grid compact">
                <thead><tr><th>Type</th><th>Doctor margin</th><th>Margin</th></tr></thead>
                <tbody>
                  {types.map((t) => {
                    const own = ruleOf(set, t);
                    const mode = own ? own.mode : isDefault ? 'none' : 'default';
                    return (
                      <tr key={t} className={`${lc(typeKey) === lc(t) ? 'sel' : ''} ${mode !== 'none' && mode !== 'default' ? 'dmr-on' : ''}`} onClick={() => setTypeKey(t)}>
                        <td><b>{t}</b></td>
                        <td>
                          <select value={mode} aria-label={`${t} margin`} disabled={ro} onClick={(e) => e.stopPropagation()} onChange={(e) => setMode(t, e.target.value)}>
                            {!isDefault ? <option value="default">Same as all doctors</option> : null}
                            <option value="none">{MODE_TEXT.none}</option>
                            <option value="groups">{MODE_TEXT.groups}</option>
                            <option value="sales">{MODE_TEXT.sales}</option>
                          </select>
                        </td>
                        <td>
                          {mode === 'groups' && own ? (
                            <button className="btn small" onClick={() => setTypeKey(t)}>{typeSummary(own, salesPct)} ›</button>
                          ) : mode === 'sales' && own ? (
                            <span className="dmr-sales-tag">{typeSummary(own, salesPct)}</span>
                          ) : (
                            <span className="muted small">{mode === 'default' ? typeSummary(ruleOf(defaults, t), salesPct) : '—'}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="dmr-groups">
            {groupsRule ? (
              <>
                <div className="row between">
                  <h3>{groupsRule.type}: on profit, by groups</h3>
                  {!ro && (
                    <button className="btn primary small" onClick={() => {
                      setTypeRule(groupsRule.type, (r) => r.groups.push({ name: `Group ${r.groups.length + 1}`, margin: { kind: 'mrp_rate', value: 0 }, all: false, items: [] }));
                      setPicker({ group: groupsRule.groups.length });
                    }}>+ Group</button>
                  )}
                </div>
                <p className="dmr-hint">Only the products in these groups are in the report; any other {groupsRule.type} product is left out.
                  A product in a one-product group, or limited to some batches, wins over a bigger group; "All products" is the weakest.</p>
                {emptyGroups ? <div className="error">A group without products is not kept — pick its products.</div> : null}
                {!groupsRule.groups.length ? <p className="muted small">No group yet: press + Group and pick the products that give the doctor a margin.</p> : null}
                {groupsRule.groups.map((g, gi) => (
                  <div key={gi} className="dmr-group">
                    <div className="row wrap">
                      <input className="dmr-group-name" value={g.name} aria-label="Group name" disabled={ro}
                        onChange={(e) => setTypeRule(groupsRule.type, (r) => { r.groups[gi].name = e.target.value; })} />
                      <MarginEdit value={g.margin} allowNone disabled={ro}
                        onChange={(m) => setTypeRule(groupsRule.type, (r) => { r.groups[gi].margin = m || { kind: 'none', value: 0 }; })} />
                      <label className="check dmr-all" title={`Every ${groupsRule.type} product, also ones bought later`}>
                        <input type="checkbox" checked={Boolean(g.all)} disabled={ro}
                          onChange={(e) => setTypeRule(groupsRule.type, (r) => {
                            r.groups[gi].all = e.target.checked;
                            if (e.target.checked) r.groups[gi].items = [];
                          })} /> All products</label>
                      {!ro && <button className="btn small" disabled={Boolean(g.all)} onClick={() => setPicker({ group: gi })}>Pick products…</button>}
                      {!ro && <button className="btn small danger" title="Delete group" aria-label={`Delete ${g.name}`}
                        onClick={() => setTypeRule(groupsRule.type, (r) => { r.groups.splice(gi, 1); })}>✕</button>}
                    </div>
                    <div className="dmr-items">
                      {g.all ? <span className="muted small">Every {groupsRule.type} product (also ones bought later).</span> : g.items.length ? g.items.map((it) => (
                        <span key={it.product} className="dmr-item">
                          {it.product}{it.batches.length ? <em> · batch {it.batches.join(', ')}</em> : null}
                          {!ro && <button aria-label={`Remove ${it.product}`}
                            onClick={() => setTypeRule(groupsRule.type, (r) => { r.groups[gi].items = r.groups[gi].items.filter((x) => x.product !== it.product); })}>×</button>}
                        </span>
                      )) : <span className="muted small">No products yet.</span>}
                    </div>
                  </div>
                ))}
              </>
            ) : selRule && selRule.mode === 'sales' ? (
              <div className="dmr-sales-panel">
                <h3>{selRule.type}: on total sales</h3>
                <p>The doctor gets <b>{pctText(salesPct)}</b> of the total sale value of every {selRule.type} product he prescribed in the
                  period — the amount on the bill (MRP-based rate × qty, less the line's discount), less returns. No purchase rate is used.</p>
                <p className="muted small">Example: {salesTypes.join(', ') || selRule.type} sold for ₹80,000 in 10 days at {pctText(salesPct)} → ₹
                  {money((80000 * salesPct) / 100)}. Change the % in “% of total sales” above{isDefault ? '' : ' (empty = the All doctors %)'}.</p>
              </div>
            ) : (
              <p className="muted dmr-hint">Set a type to <b>On profit (groups)</b> to pick which of its products give a margin — some injections
                at one margin, one injection at another; products in no group give nothing. Or set it to <b>On total sales</b> to give the
                doctor a % of everything of that type he prescribed.</p>
            )}
          </section>
        </div>
        <div className="row end">
          {error ? <span className="error">{error}</span>
            : <span className="muted small">{dirty ? 'Not saved yet.' : rules.updated ? `Saved ${rules.updated.replace('T', ' ')}` : ''}</span>}
          <span className="grow" />
          <button className="btn" onClick={close}>Close</button>
          {!ro && <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save rules'}</button>}
        </div>
        {picker && groupsRule && groupsRule.groups[picker.group] ? (
          <ProductPicker type={groupsRule.type} initial={groupsRule.groups[picker.group].items} others={otherGroups(picker.group)}
            onClose={() => setPicker(null)}
            onDone={(items) => {
              const gi = picker.group;
              setTypeRule(groupsRule.type, (r) => { r.groups[gi].items = items; });
              setPicker(null);
            }} />
        ) : null}
      </div>
    </div>
  );
}
