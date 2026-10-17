import { useEffect, useMemo, useState } from 'react';
import { api, fmtDate, money, qs, todayIso } from '../api.js';
import { printNow } from './common.jsx';

/**
 * Doctor Margin Report (owner, 17 Oct 2026; Sales History -> Export). The figures come from
 * the server's doctorMargin.js, the same rule as the PC and the phone.
 */
const isInj = (t) => String(t || '').toLowerCase().includes('inj');
const PCT_KEY = 'satpuda_doctor_pct';

function readPct() {
  try { const v = localStorage.getItem(PCT_KEY); return v === null ? '10' : v; } catch { return '10'; }
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function DoctorMargin({ from: from0, to: to0, onClose }) {
  const [from, setFrom] = useState(from0 || todayIso());
  const [to, setTo] = useState(to0 || todayIso());
  const [opts, setOpts] = useState(null);
  const [doctor, setDoctor] = useState('');
  const [mode, setMode] = useState('regular');
  const [pct, setPct] = useState(readPct());
  const [style, setStyle] = useState('detailed');
  const [picked, setPicked] = useState(null);
  const [find, setFind] = useState('');
  const [rep, setRep] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/reports/doctor-margin/options').then(setOpts).catch((e) => setError(e.message)); }, []);
  const types = useMemo(() => (opts?.types || []).filter((t) => (mode === 'injection' ? isInj(t) : !isInj(t))), [opts, mode]);
  useEffect(() => { setPicked(null); }, [mode]);
  const chosen = picked ?? types;

  function quick(kind) {
    const now = new Date();
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (kind === 'today') { setFrom(iso(now)); setTo(iso(now)); }
    if (kind === 'week') { const d = new Date(now); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); setFrom(iso(d)); setTo(iso(now)); }
    if (kind === 'month') { setFrom(iso(new Date(now.getFullYear(), now.getMonth(), 1))); setTo(iso(now)); }
  }

  async function run() {
    setError('');
    if (from > to) { setError('From date is after To date.'); return; }
    const p = Number(pct);
    if (mode === 'regular' && !(p >= 0 && p <= 100)) { setError('Doctor commission must be 0 to 100 %.'); return; }
    if (!chosen.length) { setError('Tick at least one medicine type.'); return; }
    try { localStorage.setItem(PCT_KEY, String(pct)); } catch { /* private window */ }
    setBusy(true);
    try {
      setRep(await api(`/reports/doctor-margin${qs({ from, to, doctor, mode, pct: mode === 'regular' ? p : '',
        types: chosen.length === types.length ? '' : chosen.join(',') })}`));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const inj = rep?.mode === 'injection';
  const head = rep ? [
    ['Doctor Margin Report'],
    ['Generated', new Date().toLocaleString('en-IN')],
    ['Dates', `${fmtDate(rep.from)} to ${fmtDate(rep.to)}`],
    ['Doctor', doctor || 'All doctors'],
    ['Medicine types', chosen.length === types.length ? `All ${inj ? 'injection' : 'non-injection'} types` : chosen.join(', ')],
    ['Report', inj ? 'Injection report (100% of positive profit)' : `Regular medicine report, doctor commission ${rep.pct}% of sale`],
    ['Style', style === 'detailed' ? 'Patient-wise detailed' : 'Medicine-wise summary'],
    ['Purchase cost', 'Scheme-adjusted effective purchase rate (free goods counted)'],
  ] : [];
  const detailCols = inj
    ? ['Sale date', 'Patient', 'Doctor', 'Bill no', 'Medicine', 'Type', 'Batch', 'Qty', 'Selling rate', 'Purchase rate', 'Sale amount', 'Purchase cost', 'Injection profit', 'Doctor margin ₹', 'Allocation rule', 'Flags']
    : ['Sale date', 'Patient', 'Doctor', 'Bill no', 'Medicine', 'Type', 'Batch', 'Qty', 'Selling rate', 'Purchase rate', 'Sale amount', 'Purchase cost', 'Profit', 'Commission %', 'Commission ₹', 'Store remaining', 'Flags'];
  const sumCols = inj
    ? ['Doctor', 'Medicine', 'Type', 'Batch', 'Total qty', 'Avg selling rate', 'Purchase rate', 'Total sale', 'Total cost', 'Total injection profit', 'Total doctor margin ₹', 'Allocation rule', 'Flags']
    : ['Doctor', 'Medicine', 'Type', 'Batch', 'Total qty', 'Avg selling rate', 'Purchase rate', 'Total sale', 'Total cost', 'Total profit', 'Commission %', 'Total commission ₹', 'Store remaining', 'Flags'];
  const m = (v) => money(v);
  const detailRow = (r) => (inj
    ? [fmtDate(r.date), r.patient, r.doctor, r.bill_no, r.name, r.type, r.batch, r.qty, m(r.sale_rate), m(r.purchase_rate), m(r.amount), m(r.cost), m(r.profit), m(r.commission), '100% of positive profit', r.flags.join(' ')]
    : [fmtDate(r.date), r.patient, r.doctor, r.bill_no, r.name, r.type, r.batch, r.qty, m(r.sale_rate), m(r.purchase_rate), m(r.amount), m(r.cost), m(r.profit), `${r.pct}%`, m(r.commission), m(r.remaining), r.flags.join(' ')]);
  const sumRow = (g) => (inj
    ? [g.doctor, g.name, g.type, g.batch, g.qty, m(g.avg_sale_rate), m(g.purchase_rate), m(g.amount), m(g.cost), m(g.profit), m(g.commission), '100% of positive profit', g.flags.join(' ')]
    : [g.doctor, g.name, g.type, g.batch, g.qty, m(g.avg_sale_rate), m(g.purchase_rate), m(g.amount), m(g.cost), m(g.profit), `${g.pct}%`, m(g.commission), m(g.remaining), g.flags.join(' ')]);
  const cols = style === 'detailed' ? detailCols : sumCols;
  const body = rep ? (style === 'detailed' ? rep.rows.map(detailRow) : rep.summary.map(sumRow)) : [];

  function csv() {
    const t = rep.totals;
    const lines = [...head, [], cols, ...body, [],
      ['Totals', '', '', '', t.qty, '', '', m(t.amount), m(t.cost), m(t.profit), inj ? m(t.commission) : '', inj ? '' : m(t.commission), inj ? '' : m(t.remaining)],
      ...rep.doctors.map((d) => [`Doctor total: ${d.doctor}`, '', '', '', d.qty, '', '', m(d.amount), m(d.cost), m(d.profit), '', m(d.commission), m(d.remaining)]),
      [], ['Flags: estimated = cost recorded at sale (no purchase line); unavailable = no cost known; loss = sold below cost.']];
    const blob = new Blob([`﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `doctor-margin-${style}-${rep.from}-to-${rep.to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide-modal" onClick={(e) => e.stopPropagation()}>
        <div className="no-print">
          <h3>Doctor Margin Report</h3>
          <div className="row wrap">
            <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <div className="chips">
              <button className="chip" onClick={() => quick('today')}>Today</button>
              <button className="chip" onClick={() => quick('week')}>This week</button>
              <button className="chip" onClick={() => quick('month')}>This month</button>
            </div>
            <label>Doctor<select value={doctor} onChange={(e) => setDoctor(e.target.value)}>
              <option value="">All doctors</option>
              {(opts?.doctors || []).map((d) => <option key={d} value={d}>{d}</option>)}
            </select></label>
            <label>Report<select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="regular">Regular medicine report</option>
              <option value="injection">Injection report</option>
            </select></label>
            {mode === 'regular' && <label>Doctor commission (%)<input className="num" value={pct} onChange={(e) => setPct(e.target.value)} /></label>}
            <label>Style<select value={style} onChange={(e) => setStyle(e.target.value)}>
              <option value="detailed">Patient-wise detailed</option>
              <option value="summary">Medicine-wise summary</option>
            </select></label>
          </div>
          <div className="dm-types">
            <div className="row wrap">
              <b>Medicine types</b>
              <span className="muted small">{chosen.length === types.length ? `All ${types.length}` : `${chosen.length} of ${types.length}`} ticked</span>
              <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a type…" />
              <button className="btn small" onClick={() => setPicked(types)}>Select all</button>
              <button className="btn small" onClick={() => setPicked([])}>Clear all</button>
            </div>
            <div className="dm-type-grid">
              {types.filter((t) => t.toLowerCase().includes(find.trim().toLowerCase())).map((t) => (
                <label key={t} className="check"><input type="checkbox" checked={chosen.includes(t)}
                  onChange={(e) => setPicked(e.target.checked ? [...chosen, t] : chosen.filter((x) => x !== t))} /> {t}</label>
              ))}
            </div>
          </div>
          <p className="muted small">Purchase cost: scheme-adjusted effective purchase rate — what the batch's purchases cost ÷ every unit received, free ones included.</p>
          {error && <div className="error">{error}</div>}
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={run}>{busy ? 'Working…' : 'Show report'}</button>
            <button className="btn" disabled={!rep} onClick={csv}>Excel (CSV)</button>
            <button className="btn" disabled={!rep} onClick={printNow}>Print / PDF</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
        {rep && (
          <div className="dm-report">
            <div className="print-only">{head.map((h) => <div key={h[0]}><b>{h[0]}</b>{h[1] ? `: ${h[1]}` : ''}</div>)}</div>
            <div className="tiles">
              <div><span>Sale</span><b>₹ {m(rep.totals.amount)}</b></div>
              <div><span>Purchase cost</span><b>₹ {m(rep.totals.cost)}</b></div>
              <div><span>Profit</span><b>₹ {m(rep.totals.profit)}</b></div>
              <div><span>{inj ? 'Doctor margin' : `Commission ${rep.pct}%`}</span><b>₹ {m(rep.totals.commission)}</b></div>
              <div><span>Store remaining</span><b>₹ {m(rep.totals.remaining)}</b></div>
            </div>
            {!body.length ? <p className="muted">No eligible sales for these dates and filters.</p> : (
              <div className="dm-scroll">
                <table className="grid compact">
                  <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{body.map((r, i) => <tr key={i} className={r[r.length - 1].includes('loss') ? 'dm-loss' : ''}>
                    {r.map((v, j) => <td key={j} className={typeof v === 'number' || /^[\d,.-]+%?$/.test(String(v)) ? 'r' : ''}>{v}</td>)}</tr>)}</tbody>
                </table>
              </div>)}
            {rep.doctors.length > 1 && (
              <table className="grid compact">
                <thead><tr><th>Doctor</th><th className="r">Qty</th><th className="r">Sale</th><th className="r">Cost</th><th className="r">Profit</th><th className="r">{inj ? 'Margin' : 'Commission'}</th><th className="r">Store remaining</th></tr></thead>
                <tbody>{rep.doctors.map((d) => <tr key={d.doctor}><td>{d.doctor}</td><td className="r">{d.qty}</td><td className="r">{m(d.amount)}</td>
                  <td className="r">{m(d.cost)}</td><td className="r">{m(d.profit)}</td><td className="r">{m(d.commission)}</td><td className="r">{m(d.remaining)}</td></tr>)}</tbody>
              </table>)}
            <p className="muted small">Flags: estimated = cost recorded at the sale (no purchase line for the batch); unavailable = no cost known; loss = sold below cost (no negative commission is paid).</p>
          </div>)}
      </div>
    </div>
  );
}
