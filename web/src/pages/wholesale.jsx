import { useEffect, useRef, useState } from 'react';
import { api, money, qs } from '../api.js';
import { useDebounced } from './common.jsx';

/** GST state codes (core/customer_gst.py STATES), for the party form. */
export const STATES = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'],
  ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'],
  ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
  ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'], ['97', 'Other Territory'],
];

const PAPER_KEY = 'satpuda_ws_invoice_paper';
export function invoicePaper() {
  try { return localStorage.getItem(PAPER_KEY) === 'A5' ? 'A5' : 'A4'; } catch { return 'A4'; }
}
function rememberPaper(p) {
  try { localStorage.setItem(PAPER_KEY, p); } catch { /* not kept */ }
}

/**
 * The GST INVOICE of a wholesale bill, exactly as the PC prints it (the server renders the
 * PC's layout): A5 landscape, or two to an A4 portrait sheet. Shown in a frame; Print prints
 * the frame alone. `autoPrint` prints once as soon as it has loaded (Save & print).
 */
export function WholesaleInvoice({ saleId, autoPrint = false, onPrinted }) {
  const [paper, setPaper] = useState(invoicePaper());
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');
  const frame = useRef(null);
  const printed = useRef(false);
  useEffect(() => {
    let live = true;
    setDoc(null); setError('');
    api(`/wholesale/sales/${saleId}/invoice${qs({ paper })}`)
      .then((d) => { if (live) setDoc(d); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [saleId, paper]);
  function print() {
    const w = frame.current?.contentWindow;
    if (!w) return;
    w.focus();
    w.print();
    onPrinted?.();
  }
  function loaded() {
    if (autoPrint && !printed.current) {
      printed.current = true;
      setTimeout(print, 150);
    }
  }
  const a4 = paper === 'A4';
  return (
    <div className="ws-invoice">
      <div className="row wrap no-print">
        <label>Paper<select value={paper} onChange={(e) => { setPaper(e.target.value); rememberPaper(e.target.value); }}>
          <option value="A4">A4 (two invoices a sheet)</option>
          <option value="A5">A5 landscape</option>
        </select></label>
        <button className="btn primary" disabled={!doc} onClick={print}>Print invoice</button>
      </div>
      {error && <div className="error">{error}</div>}
      {!doc && !error && <div className="muted">Making the invoice…</div>}
      {doc && (
        <div className={`ws-invoice-frame ${a4 ? 'a4' : 'a5'}`}>
          <iframe ref={frame} title={`GST invoice ${doc.bill_no}`} srcDoc={doc.html} onLoad={loaded} />
        </div>
      )}
    </div>
  );
}

/** Type a party (medicals first); pick one from the list. */
export function WsPartyPicker({ value, onPick, placeholder = "Type the medical's name", autoFocus }) {
  const [text, setText] = useState(value?.name || '');
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const q = useDebounced(text, 200);
  useEffect(() => { setText(value?.name || ''); }, [value?.id, value?.name]);
  useEffect(() => {
    if (!open) { setRows([]); return; }
    let live = true;
    api(`/wholesale/parties${qs({ q, limit: 15 })}`).then((d) => { if (live) setRows(d || []); }).catch(() => {});
    return () => { live = false; };
  }, [q, open]);
  return (
    <div className="picker">
      <input value={text} placeholder={placeholder} autoFocus={autoFocus}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setText(e.target.value); if (value?.id) onPick(null); }} />
      {open && rows.length > 0 && (
        <div className="dropdown">
          {rows.map((r) => (
            <button type="button" key={r.id} onMouseDown={() => { onPick(r); setText(r.name); setOpen(false); }}>
              <span>{r.name} {r.party_type === 'medical' ? <span className="tag">medical</span> : null}</span>
              <span className="muted small">{[r.gstin, r.phone, Number(r.total_due) > 0 ? `due ${money(r.total_due)}` : ''].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A party's details (wholesale): party type, GSTIN, DL numbers, state, rate tier, credit limit
 * and days, with name, phone and address. A new party when `party` has no id.
 */
export function PartyForm({ party, onSaved, onClose }) {
  const isNew = !party?.id;
  const [f, setF] = useState({
    name: party?.name || '', phone: party?.phone || '', address: party?.address || '',
    party_type: party?.party_type || 'medical', gstin: party?.gstin || '', legal_name: party?.legal_name || '',
    dl_numbers: party?.dl_numbers || '', state_code: party?.state_code || '', rate_tier: party?.rate_tier || 'A',
    credit_limit: party?.credit_limit ? String(party.credit_limit) : '', credit_days: party?.credit_days ? String(party.credit_days) : '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const gstState = /^\d{2}/.test(f.gstin.trim()) ? f.gstin.trim().slice(0, 2) : '';
  async function save() {
    setBusy(true); setError('');
    try {
      const out = isNew
        ? await api('/wholesale/parties', { method: 'POST', body: f })
        : await api(`/wholesale/parties/${party.id}`, { method: 'PUT', body: f });
      onSaved(out);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{isNew ? 'New party' : `Party details · ${party.name}`}</h3>
        <div className="grid3">
          <label>Name<input value={f.name} onChange={set('name')} autoFocus={isNew} /></label>
          <label>Phone<input value={f.phone} onChange={set('phone')} /></label>
          <label>Address<input value={f.address} onChange={set('address')} /></label>
          <label>Party type<select value={f.party_type} onChange={set('party_type')}>
            <option value="medical">Medical (wholesale buyer)</option><option value="retail">Retail</option>
          </select></label>
          <label>GSTIN<input value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} placeholder="Unregistered: leave empty" /></label>
          <label>Legal name (as on GST)<input value={f.legal_name} onChange={set('legal_name')} /></label>
          <label>DL numbers<input value={f.dl_numbers} onChange={set('dl_numbers')} placeholder="20B: …, 21B: …" /></label>
          <label>State{gstState ? <span className="muted small"> (from the GSTIN)</span> : null}
            <select value={gstState || f.state_code} disabled={!!gstState} onChange={set('state_code')}>
              <option value="">—</option>
              {STATES.map(([c, n]) => <option key={c} value={c}>{c} {n}</option>)}
            </select></label>
          <label>Rate tier<select value={f.rate_tier} onChange={set('rate_tier')}>
            <option value="A">Rate A</option><option value="B">Rate B</option><option value="C">Rate C</option>
          </select></label>
          <label>Credit limit ₹<input value={f.credit_limit} onChange={set('credit_limit')} placeholder="0 = no limit" /></label>
          <label>Credit days<input value={f.credit_days} onChange={set('credit_days')} placeholder="due date = bill date + days" /></label>
        </div>
        <p className="muted small">The bill takes this party's rate tier (A / B / C, else Rate A), its GSTIN and DL numbers, and
          its due date from the credit days. Crossing the credit limit only warns.</p>
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !f.name.trim()} onClick={save}>{busy ? 'Saving…' : 'Save party'}</button>
        </div>
      </div>
    </div>
  );
}

/** A report's sections as tables, with its TOTAL rows (core/wholesale_reports shape). */
export function ReportSections({ report }) {
  return (report?.sections || []).map((s) => (
    <div key={s.title} className="ws-report-section">
      <h3>{s.title} <span className="muted small">{s.rows.length} rows</span></h3>
      <div className="scrollx">
        <table className="grid compact">
          <thead><tr>{s.columns.map((c) => <th key={c} className={isNumCol(s, c) ? 'r' : ''}>{c}</th>)}</tr></thead>
          <tbody>{s.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === 'number' ? 'r' : ''}>{cell(v, s.columns[j])}</td>)}</tr>)}</tbody>
          {s.total_row && <tfoot><tr className="ws-total-row">{s.total_row.map((v, j) => <td key={j} className={typeof v === 'number' ? 'r' : ''}><b>{cell(v, s.columns[j])}</b></td>)}</tr></tfoot>}
        </table>
      </div>
      {!s.rows.length && <p className="muted">Nothing in these dates.</p>}
    </div>
  ));
}
function isNumCol(s, c) {
  return s.rows.some((r) => typeof r[s.columns.indexOf(c)] === 'number');
}
function cell(v, col) {
  if (typeof v !== 'number') return v;
  return /^(Bills|Qty|Free Qty|Days Late|Days Late \(oldest\)|Stock \(strips\))$/.test(col || '') ? v : money(v);
}

export function reportCsv(report) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [];
  for (const s of report.sections) {
    if (!s.rows.length) continue;
    lines.push([s.title], s.columns, ...s.rows, ...(s.total_row ? [s.total_row] : []), []);
  }
  const blob = new Blob([`﻿${lines.map((l) => l.map(esc).join(',')).join('\r\n')}\r\n`], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${report.title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
