import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtDate, money, qs, todayIso } from '../api.js';
import { printNow } from './common.jsx';

/**
 * Doctor Margin Report BY MARGIN RULES (owner, 22-23 Oct 2026) -- the PC's "By margin rules"
 * mode, the same figures (the server's doctorMarginRules.js is the PC's calculation).
 *
 * The owner's Excel: for a period, per doctor, product / batch / quantity / MRP / rate /
 * margin per unit / total value and a TOTAL; or customer-wise product-batch-wise with
 * sub-totals. Only medicines a margin is given on appear. A bill keeps the rules it was saved
 * with; "Recalculate period" works a period out again with today's rules.
 *
 * The rules: "All doctors" and, where a doctor is different, that doctor's own. Per medicine
 * type: No margin / Whole type / Per group. A group is products of that type picked from the
 * list (tick boxes, Select all, search; a product can be limited to some batches) with its own
 * margin; "Rest of this type" has a margin or none. Margin: MRP - rate, % of MRP, or Rs per unit.
 */

const FLAG_TEXT = { estimated: 'Rate not from a purchase', no_rate: 'No purchase rate', rate_over_mrp: 'Rate above MRP' };
const KIND_TEXT = { mrp_rate: 'MRP − rate', pct_mrp: '% of MRP', fixed: '₹ per unit', none: 'No margin' };
const lc = (s) => String(s || '').trim().toLowerCase();
const qtyText = (v) => (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const clone = (x) => JSON.parse(JSON.stringify(x));

function marginText(m) {
  if (!m || m.kind === 'none') return 'No margin';
  if (m.kind === 'pct_mrp') return `${m.value}% of MRP`;
  if (m.kind === 'fixed') return `₹${money(m.value)} / unit`;
  return 'MRP − rate';
}
function typeSummary(r) {
  if (!r || r.mode === 'none') return 'No margin';
  if (r.mode === 'type') return `Whole type: ${marginText(r.margin)}`;
  return `${r.groups.length} group(s); rest: ${marginText(r.rest)}`;
}
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const q3 = (v) => (Number.isInteger(Number(v)) ? Number(v) : v);

function Flags({ flags }) {
  if (!flags?.length) return null;
  return flags.map((f) => <span key={f} className={`dmr-flag dmr-flag-${f}`} title={FLAG_TEXT[f]}>{FLAG_TEXT[f] || f}</span>);
}

/** The PC's report table (doctor_margin_rules_report.table): the CSV and the print carry it. */
function reportTable(rep) {
  const out = [];
  if (rep.filters.view === 'detail') {
    const cols = ['Product / Customer', 'Bill no', 'Date', 'Batch', 'Qty', 'MRP', 'Rate', 'Margin / unit', 'Value', 'Doctor', 'Type'];
    for (const p of rep.products) {
      out.push(['head', [p.name, ...Array(cols.length - 1).fill('')]]);
      for (const r of p.lines) {
        out.push(['line', [r.patient, r.bill_no, fmtDate(r.date).replace(/-/g, '/'), r.batch, q3(r.qty), r.mrp, r.rate, r.margin_unit, r.value, r.doctor, r.type]]);
      }
      out.push(['sub', ['Sub total', '', '', '', q3(p.qty), '', '', '', p.value, '', '']]);
    }
    out.push(['total', ['TOTAL value', '', '', '', q3(rep.totals.qty), '', '', '', rep.totals.value, '', '']]);
    return { cols, rows: out };
  }
  const cols = ['Product name', 'Batch', 'Quantity', 'MRP', 'Rate', 'Margin / unit', 'Total value'];
  for (const d of rep.doctors) {
    out.push(['head', [d.doctor, ...Array(cols.length - 1).fill('')]]);
    for (const r of rep.summary) if (r.doctor === d.doctor) out.push(['line', [r.name, r.batch, q3(r.qty), r.mrp, r.rate, r.margin_unit, r.value]]);
    out.push(['sub', ['', '', q3(d.qty), '', '', 'TOTAL value', d.value]]);
  }
  if (rep.doctors.length > 1) out.push(['total', ['ALL DOCTORS', '', q3(rep.totals.qty), '', '', 'TOTAL value', rep.totals.value]]);
  return { cols, rows: out };
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
  // The layout is only how the same lines are shown.
  const shown = rep ? { ...rep, filters: { ...rep.filters, view } } : null;

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

  const heads = shown ? [
    ['Period', `${fmtDate(shown.filters.from)} to ${fmtDate(shown.filters.to)}`],
    ['Doctor', shown.filters.doctors.join(', ') || 'All doctors'],
    ['Rate', shown.rate_basis_text],
    ['Layout', view === 'doctor' ? 'Doctor-wise (product, qty, MRP, rate, total value)' : 'Customer-wise product-batch-wise'],
    ['Generated at', new Date().toLocaleString('en-IN')],
  ] : [];
  const title = `Doctor Margin Report${view === 'detail' ? ' - customer-wise product-batch-wise' : ''}`;

  function csv() {
    const { cols, rows } = reportTable(shown);
    const lines = [[title], ...heads, [], cols, ...rows.map(([, cells]) => cells)];
    const blob = new Blob([`﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `doctor_margin_${view}_${shown.filters.from}_${shown.filters.to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const t = shown?.totals;
  const counts = shown?.flag_counts;
  const cannot = Boolean(busy) || Boolean(problem) || !shown || !shown.rows.length;
  const docList = doctors.filter((d) => d.toLowerCase().includes(findDoc.trim().toLowerCase()));

  return (
    <>
      <div className="no-print">
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
          <label>Rate<select value={rateBasis} onChange={(e) => setRateBasis(e.target.value)}>
            <option value="">As saved with each bill (rules)</option>
            <option value="purchase">Purchase rate</option>
            <option value="purchase_free">Purchase rate with free included</option>
          </select></label>
          <label>Layout
            <div className="seg" role="radiogroup" aria-label="Layout">
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
          <button className="btn" disabled={cannot} onClick={printNow}>Print / PDF</button>
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
        <div className="print-only">
          <h3>{title}</h3>
          {heads.map(([k, v]) => <div key={k}><b>{k}</b>: {v}</div>)}
        </div>
        <div className="row between no-print">
          <b>{fmtDate(from)} to {fmtDate(to)}</b>
          <span className="muted small">{loading ? 'Updating…' : shown ? `${shown.rate_basis_text} · only medicines with a doctor margin` : ''}</span>
        </div>
        {shown && t && (
          <>
            {!shown.has_rules && (
              <p className="dmr-hint no-print">No margin rules yet. Press <b>Margin rules…</b> and choose, for each medicine type, which products
                give the doctor a margin.</p>
            )}
            <div className="tiles no-print">
              <div><span>Doctors</span><b>{shown.doctors.length}</b></div>
              <div><span>Bill lines</span><b>{t.lines}</b></div>
              <div><span>Quantity</span><b>{qtyText(t.qty)}</b></div>
              <div className="dmr-total-tile"><span>TOTAL value</span><b>₹ {money(t.value)}</b></div>
            </div>
            {counts && (counts.estimated || counts.no_rate || counts.rate_over_mrp) ? (
              <ul className="dmr-flag-notes no-print">
                {counts.estimated ? <li><span className="dmr-flag dmr-flag-estimated">{FLAG_TEXT.estimated}</span> {counts.estimated} line(s): no purchase bill of that batch; the batch's own purchase rate (or the cost on the bill) is used.</li> : null}
                {counts.no_rate ? <li><span className="dmr-flag dmr-flag-no_rate">{FLAG_TEXT.no_rate}</span> {counts.no_rate} line(s): no rate known, so MRP − rate gives 0.</li> : null}
                {counts.rate_over_mrp ? <li><span className="dmr-flag dmr-flag-rate_over_mrp">{FLAG_TEXT.rate_over_mrp}</span> {counts.rate_over_mrp} line(s): the rate is above MRP, counted as 0.</li> : null}
              </ul>
            ) : null}
            {!shown.rows.length ? (
              <p className="muted">No doctor margin in this period{picked !== null && chosen.length < doctors.length ? ' for these doctors' : ''}.</p>
            ) : view === 'doctor' ? (
              <div className="dmr-doctors">
                {shown.doctors.map((d) => (
                  <section key={d.doctor} className="dmr-doctor">
                    <div className="dmr-doctor-head">
                      <b>{d.doctor}</b>
                      <span className="muted small">{d.lines} bill line(s) · qty {qtyText(d.qty)}</span>
                      <span className="dmr-doctor-total">₹ {money(d.value)}</span>
                    </div>
                    <div className="dm-scroll">
                      <table className="grid compact">
                        <thead><tr><th>Product name</th><th>Batch</th><th className="r">Quantity</th><th className="r">MRP</th><th className="r">Rate</th>
                          <th className="r">Margin / unit</th><th className="r">Total value</th><th className="no-print">Rule</th></tr></thead>
                        <tbody>
                          {shown.summary.filter((r) => r.doctor === d.doctor).map((r, i) => (
                            <tr key={i}>
                              <td>{r.name} <Flags flags={r.flags} /></td><td>{r.batch}</td><td className="r">{qtyText(r.qty)}</td>
                              <td className="r">{money(r.mrp)}</td><td className="r">{money(r.rate)}</td><td className="r">{money(r.margin_unit)}</td>
                              <td className="r">{money(r.value)}</td><td className="muted small no-print" title={KIND_TEXT[r.kind] || r.kind}>{r.rule}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot><tr className="dmr-sum"><td colSpan={2}>TOTAL value</td><td className="r">{qtyText(d.qty)}</td><td colSpan={3} />
                          <td className="r">{money(d.value)}</td><td className="no-print" /></tr></tfoot>
                      </table>
                    </div>
                  </section>
                ))}
                {shown.doctors.length > 1 && (
                  <div className="dmr-grand"><span>All doctors — TOTAL value</span><b>₹ {money(t.value)}</b></div>
                )}
              </div>
            ) : (
              <div className="dm-scroll">
                <table className="grid compact">
                  <thead><tr><th>Customer</th><th>Bill no</th><th>Date</th><th>Batch</th><th className="r">Qty</th><th className="r">MRP</th>
                    <th className="r">Rate</th><th className="r">Margin / unit</th><th className="r">Value</th><th>Doctor</th><th>Type</th></tr></thead>
                  {shown.products.map((p) => (
                    <tbody key={p.name}>
                      <tr className="dmr-product"><td colSpan={11}>{p.name}</td></tr>
                      {p.lines.map((r, i) => (
                        <tr key={i}>
                          <td>{r.patient}</td><td>{r.bill_no}</td><td>{fmtDate(r.date)}</td><td>{r.batch}</td>
                          <td className="r">{qtyText(r.qty)}{r.qty_returned ? <span className="muted small"> (−{qtyText(r.qty_returned)} ret.)</span> : null}</td>
                          <td className="r">{money(r.mrp)}</td><td className="r">{money(r.rate)}</td><td className="r">{money(r.margin_unit)}</td>
                          <td className="r">{money(r.value)}</td><td>{r.doctor}</td><td>{r.type} <Flags flags={r.flags} /></td>
                        </tr>
                      ))}
                      <tr className="dmr-sum"><td colSpan={4}>Sub total</td><td className="r">{qtyText(p.qty)}</td><td colSpan={3} />
                        <td className="r">{money(p.value)}</td><td colSpan={2} /></tr>
                    </tbody>
                  ))}
                  <tfoot><tr className="dmr-sum dmr-grand-row"><td colSpan={4}>TOTAL value</td><td className="r">{qtyText(t.qty)}</td><td colSpan={3} />
                    <td className="r">{money(t.value)}</td><td colSpan={2} /></tr></tfoot>
                </table>
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
      rule = { type: t, mode: 'none', margin: null, groups: [], rest: null };
      s.types.push(rule);
    }
    fn(rule);
  });
  const setMode = (t, mode) => {
    if (mode === 'default') {
      change((r) => { const s = inSet(r); s.types = s.types.filter((x) => lc(x.type) !== lc(t)); });
      return;
    }
    setTypeRule(t, (rule) => {
      rule.mode = mode;
      if (mode === 'type' && !rule.margin) rule.margin = { kind: 'mrp_rate', value: 0 };
    });
    if (mode === 'groups') setTypeKey(t);
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
  const freeDoctors = data.doctors.filter((d) => !rules.sets.some((s) => s.doctor === d));
  const otherGroups = (gi) => {
    const out = {};
    groupsRule?.groups.forEach((g, i) => { if (i !== gi) for (const it of g.items) out[it.product] = g.name; });
    return out;
  };
  const emptyGroups = groupsRule?.groups.filter((g) => !g.items.length).length || 0;

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
                  change((r) => { r.sets.push({ doctor: addDoctor, rate_basis: null, types: [] }); });
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
              {isDefault ? 'Choose for each type: no margin, a margin for the whole type, or groups of products with their own margin.'
                : 'A type set to "Same as all doctors" follows the All doctors rules.'}{' '}
              Rate = the purchase rate of the batch sold. Free included: ₹100 for 10 + 5 free = ₹6.67 a unit.
            </p>
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
                            <option value="none">No margin</option>
                            <option value="type">Whole type</option>
                            <option value="groups">Per group</option>
                          </select>
                        </td>
                        <td onClick={(e) => mode === 'type' && e.stopPropagation()}>
                          {mode === 'type' && own ? (
                            <MarginEdit value={own.margin} disabled={ro} onChange={(m) => setTypeRule(t, (r) => { r.margin = m || { kind: 'mrp_rate', value: 0 }; })} />
                          ) : mode === 'groups' && own ? (
                            <button className="btn small" onClick={() => setTypeKey(t)}>{typeSummary(own)} ›</button>
                          ) : (
                            <span className="muted small">{mode === 'default' ? typeSummary(ruleOf(defaults, t)) : '—'}</span>
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
                  <h3>{groupsRule.type}: groups</h3>
                  {!ro && (
                    <button className="btn primary small" onClick={() => {
                      setTypeRule(groupsRule.type, (r) => r.groups.push({ name: `Group ${r.groups.length + 1}`, margin: { kind: 'mrp_rate', value: 0 }, items: [] }));
                      setPicker({ group: groupsRule.groups.length });
                    }}>+ Group</button>
                  )}
                </div>
                <p className="dmr-hint">A product in a one-product group, or limited to some batches, wins over a bigger group. Products in no group get the rest-of-type margin.</p>
                {emptyGroups ? <div className="error">A group without products is not kept — pick its products.</div> : null}
                {groupsRule.groups.map((g, gi) => (
                  <div key={gi} className="dmr-group">
                    <div className="row wrap">
                      <input className="dmr-group-name" value={g.name} aria-label="Group name" disabled={ro}
                        onChange={(e) => setTypeRule(groupsRule.type, (r) => { r.groups[gi].name = e.target.value; })} />
                      <MarginEdit value={g.margin} allowNone disabled={ro}
                        onChange={(m) => setTypeRule(groupsRule.type, (r) => { r.groups[gi].margin = m || { kind: 'none', value: 0 }; })} />
                      {!ro && <button className="btn small" onClick={() => setPicker({ group: gi })}>Pick products…</button>}
                      {!ro && <button className="btn small danger" title="Delete group" aria-label={`Delete ${g.name}`}
                        onClick={() => setTypeRule(groupsRule.type, (r) => { r.groups.splice(gi, 1); })}>✕</button>}
                    </div>
                    <div className="dmr-items">
                      {g.items.length ? g.items.map((it) => (
                        <span key={it.product} className="dmr-item">
                          {it.product}{it.batches.length ? <em> · batch {it.batches.join(', ')}</em> : null}
                          {!ro && <button aria-label={`Remove ${it.product}`}
                            onClick={() => setTypeRule(groupsRule.type, (r) => { r.groups[gi].items = r.groups[gi].items.filter((x) => x.product !== it.product); })}>×</button>}
                        </span>
                      )) : <span className="muted small">No products yet.</span>}
                    </div>
                  </div>
                ))}
                <div className="row wrap dmr-rest">
                  <b>Rest of {groupsRule.type}</b>
                  <MarginEdit value={groupsRule.rest || { kind: 'none', value: 0 }} allowNone disabled={ro}
                    onChange={(m) => setTypeRule(groupsRule.type, (r) => { r.rest = m && m.kind !== 'none' ? m : null; })} />
                </div>
              </>
            ) : (
              <p className="muted dmr-hint">Set a type to <b>Per group</b> to pick which of its products give a margin — some injections at one
                margin, one injection at another, the rest at a third or none.</p>
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
