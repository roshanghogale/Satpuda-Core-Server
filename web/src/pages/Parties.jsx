import { useEffect, useMemo, useState } from 'react';
import { api, fmtDate, money, qs, shortNo } from '../api.js';
import { PartyPicker, printNow, useDebounced } from './common.jsx';
import { PartyForm } from './wholesale.jsx';

const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

/**
 * Take a payment. "Choose bills" gives it to the ticked bills (owner, 17 Oct 2026); what is
 * paid over them, or the whole amount with "Oldest bills first", clears the oldest bills.
 */
function PayForm({ kind, party, onDone, onClose }) {
  const [amount, setAmount] = useState('');
  const [typed, setTyped] = useState(false);
  const [mode, setMode] = useState('cash');
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState('');
  const [how, setHow] = useState('oldest');
  const [bills, setBills] = useState(null);
  const [pick, setPick] = useState({});
  const [error, setError] = useState('');
  useEffect(() => {
    if (how !== 'choose' || bills) return;
    api(`/${kind}/${party.id}/open-bills`).then(setBills).catch((e) => setError(e.message));
  }, [how, bills, kind, party.id]);
  const ticked = useMemo(() => (bills || []).filter((b) => pick[b.bill_id] !== undefined)
    .map((b) => ({ bill_id: b.bill_id, bill_no: b.bill_no, amount: r2(Math.min(Number(pick[b.bill_id]) || 0, b.owes)) }))
    .filter((a) => a.amount > 0), [bills, pick]);
  const tickedSum = r2(ticked.reduce((s, a) => s + a.amount, 0));
  const shown = how === 'choose' && !typed ? (tickedSum > 0 ? String(tickedSum) : '') : amount;
  const amt = r2(shown);
  const short = how === 'choose' && tickedSum > amt + 0.009;
  function tick(b, on) {
    setPick((p) => { const n = { ...p }; if (on) n[b.bill_id] = String(b.owes); else delete n[b.bill_id]; return n; });
  }
  async function save() {
    setError('');
    try {
      const allocations = how === 'choose' ? ticked : [];
      const body = kind === 'customers'
        ? { customer_id: party.id, amount: amt, mode, note, allocations, receipt_no: receipt }
        : { supplier_id: party.id, amount: amt, mode, reference: note, allocations, receipt_no: receipt };
      await api(`/payments/${kind}`, { method: 'POST', body });
      onDone(`${kind === 'customers' ? 'Received' : 'Paid'} ₹ ${money(amt)} ${kind === 'customers' ? 'from' : 'to'} ${party.name}.`);
    } catch (e) { setError(e.message); }
  }
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <h3>{kind === 'customers' ? 'Take payment from' : 'Pay'} {party.name}</h3>
        <p>Due now: ₹ {money(party.total_due)}</p>
        <label>Which bills does this pay?<select value={how} onChange={(e) => setHow(e.target.value)}>
          <option value="oldest">Oldest bills first</option><option value="choose">Choose bills</option>
        </select></label>
        {how === 'choose' && (bills === null ? <div className="muted small">Reading the bills…</div>
          : bills.length === 0 ? <div className="muted small">No bill owes anything.</div> : (
            <table className="grid compact">
              <thead><tr><th /><th>Bill</th><th>Date</th><th className="r">Total</th><th className="r">Owes</th><th className="r">Pay</th></tr></thead>
              <tbody>{bills.map((b) => {
                const on = pick[b.bill_id] !== undefined;
                return (
                  <tr key={b.bill_id}>
                    <td><input type="checkbox" checked={on} onChange={(e) => tick(b, e.target.checked)} /></td>
                    <td>{b.bill_no}{b.supplier_bill_no ? <span className="muted small"> ({b.supplier_bill_no})</span> : null}</td>
                    <td>{fmtDate(b.bill_date)}</td><td className="r">{money(b.total)}</td><td className="r">{money(b.owes)}</td>
                    <td className="r">{on && <input className="num" type="number" min="0" step="0.01" max={b.owes} value={pick[b.bill_id]}
                      onChange={(e) => setPick((p) => ({ ...p, [b.bill_id]: e.target.value }))} />}</td>
                  </tr>);
              })}</tbody>
            </table>))}
        <label>Amount<input value={shown} onChange={(e) => { setTyped(true); setAmount(e.target.value); }} autoFocus={how === 'oldest'} /></label>
        {how === 'choose' && tickedSum > 0 && amt > tickedSum + 0.009 && (
          <div className="muted small">₹ {money(amt - tickedSum)} more goes to the oldest bills.</div>)}
        {short && <div className="error">The bills you ticked need ₹ {money(tickedSum)}; the amount is ₹ {money(amt)}.</div>}
        <label>Mode<select value={mode} onChange={(e) => setMode(e.target.value)}><option value="cash">Cash</option><option value="online">Online</option></select></label>
        <label>{kind === 'customers' ? 'Note' : 'Reference'}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <label>Receipt no.<input value={receipt} onChange={(e) => setReceipt(e.target.value)} placeholder="the paper receipt's number (optional)" /></label>
        {error && <div className="error">{error}</div>}
        <div className="row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!(amt > 0) || short} onClick={save}>Save</button></div>
      </div>
    </div>
  );
}

/** "S2-55 ₹500 ✓ · S2-61 ₹200", ✓ = a bill the payment was given to. */
function Cleared({ p }) {
  const list = p.cleared || [];
  if (!list.length && !(p.left_as_credit > 0.009)) return null;
  return (
    <div className="small muted">
      {list.map((c, i) => <span key={`${c.bill_id}-${i}`}>{i ? ' · ' : ''}{c.bill_no} ₹{money(c.amount)}{c.how === 'chosen' ? ' ✓' : ''}</span>)}
      {p.left_as_credit > 0.009 && <span>{list.length ? ' · ' : ''}₹{money(p.left_as_credit)} left as credit</span>}
    </div>
  );
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Payments in the dates with the bills each one cleared; print or CSV. */
function PaymentReport({ kind, onClose }) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const [party, setParty] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setData(null); setError('');
    api(`/payments/report${qs({ kind, from, to, party_id: party?.id || '' })}`).then(setData).catch((e) => setError(e.message));
  }, [kind, from, to, party?.id]);
  const cust = kind === 'customers';
  function csv() {
    const head = ['Date', cust ? 'Reference' : 'Payment no', 'Receipt no', cust ? 'Customer' : 'Supplier', 'Mode', 'Amount', 'Bill', 'Bill date', 'Cleared', 'How'];
    const lines = [head];
    for (const p of data.rows) {
      const base = [p.payment_date?.slice(0, 10), cust ? shortNo(p.reference_no || '') : p.payment_no, p.receipt_no || '', p.customer_name || p.supplier_name, p.payment_mode || p.mode, r2(p.amount)];
      if (!p.cleared.length) lines.push([...base, '', '', '', '']);
      p.cleared.forEach((c, i) => lines.push([...(i ? ['', '', '', '', '', ''] : base), c.bill_no, c.bill_date, c.amount, c.how]));
      if (p.left_as_credit > 0.009) lines.push(['', '', '', '', '', '', 'Left as credit', '', p.left_as_credit, '']);
    }
    lines.push(['Total', '', '', '', '', data.totals.amount, '', '', data.totals.cleared, '']);
    const blob = new Blob([`﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `payment-report-${kind}-${from}-to-${to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row wrap no-print">
          <h3>Payment report · {cust ? 'receipts from customers' : 'payments to suppliers'}</h3>
          <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label>{cust ? 'Customer' : 'Supplier'}<PartyPicker kind={kind} value={party} placeholder="All"
            onChange={(p) => setParty(p?.id ? p : null)} /></label>
          <button className="btn" disabled={!data} onClick={printNow}>Print</button>
          <button className="btn" disabled={!data} onClick={csv}>CSV</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <h3 className="print-only">Payment report {fmtDate(from)} to {fmtDate(to)}{party ? ` · ${party.name}` : ''}</h3>
        {error && <div className="error">{error}</div>}
        {!data ? <div className="muted">{error ? '' : 'Reading…'}</div> : (
          <table className="grid compact">
            <thead><tr><th>Date</th><th>{cust ? 'Reference' : 'No'}</th><th>Receipt no.</th><th>{cust ? 'Customer' : 'Supplier'}</th><th>Mode</th>
              <th className="r">Amount</th><th>Bills cleared</th></tr></thead>
            <tbody>{data.rows.map((p) => (
              <tr key={p.id}><td>{fmtDate(p.payment_date)}</td><td>{cust ? shortNo(p.reference_no || '') : p.payment_no}</td><td>{p.receipt_no || ''}</td>
                <td>{p.customer_name || p.supplier_name}</td><td className="small">{p.payment_mode || p.mode}</td>
                <td className="r">{money(p.amount)}</td><td><Cleared p={p} /></td></tr>))}</tbody>
            <tfoot><tr><td colSpan={5}><b>{data.totals.count} payments</b></td><td className="r"><b>{money(data.totals.amount)}</b></td>
              <td className="small">Cleared ₹{money(data.totals.cleared)} · credit ₹{money(data.totals.left_as_credit)}</td></tr></tfoot>
          </table>)}
      </div>
    </div>
  );
}

export default function Parties({ can, me }) {
  const ws = me?.store_kind === 'wholesale';
  const [partyForm, setPartyForm] = useState(null);
  const [kind, setKind] = useState('customers');
  const [q, setQ] = useState('');
  const [dueOnly, setDueOnly] = useState(true);
  const dq = useDebounced(q, 300);
  const [data, setData] = useState(null);
  const [pays, setPays] = useState([]);
  const [pay, setPay] = useState(null);
  const [report, setReport] = useState(false);
  const [msg, setMsg] = useState('');
  async function openParty(p) {
    try { setPartyForm(await api(`/wholesale/parties/${p.id}`)); } catch (e) { setMsg(e.message); }
  }
  const load = () => {
    api(`/${kind}${qs({ q: dq, has_due: dueOnly ? '1' : '', limit: 500 })}`).then(setData).catch(() => {});
    api(`/payments/${kind}${qs({ limit: 30, with_cleared: 1 })}`).then((d) => setPays(d.rows || [])).catch(() => setPays([]));
  };
  useEffect(() => { load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, dq, dueOnly]);
  return (
    <div>
      <div className="card">
        <div className="chips">
          <button className={`chip ${kind === 'customers' ? 'on' : ''}`} onClick={() => setKind('customers')}>Customers</button>
          <button className={`chip ${kind === 'suppliers' ? 'on' : ''}`} onClick={() => setKind('suppliers')}>Suppliers</button>
          <label className="check"><input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} /> Only with due</label>
          <button className="btn small" onClick={() => setReport(true)}>Payment report</button>
          {ws && kind === 'customers' && <button className="btn small" onClick={() => setPartyForm({})}>+ New party</button>}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or phone" />
        {msg && <div className="okmsg">{msg}</div>}
      </div>
      <div className="split">
        <div className="card list">
          <table className="grid">
            <thead><tr><th>Name</th><th>Phone</th><th className="r">Due</th><th className="r">Credit</th><th /></tr></thead>
            <tbody>{(data?.rows || []).map((p) => (
              <tr key={p.id}><td>{p.name}</td><td>{p.phone}</td><td className="r">{Number(p.total_due) > 0 ? money(p.total_due) : ''}</td>
                <td className="r">{Number(p.total_credit) > 0 ? money(p.total_credit) : ''}</td>
                <td><div className="row">{can('payments') && <button className="btn small" onClick={() => setPay(p)}>{kind === 'customers' ? 'Take payment' : 'Pay'}</button>}
                  {ws && kind === 'customers' && <button className="btn small" onClick={() => openParty(p)}>Party details</button>}</div></td></tr>))}</tbody>
          </table>
        </div>
        <div className="card detail">
          <h3>Recent {kind === 'customers' ? 'receipts' : 'payments'}</h3>
          <table className="grid compact">
            <tbody>{pays.map((p) => <tr key={p.id}><td>{fmtDate(p.payment_date)}</td>
              <td>{p.customer_name || p.supplier_name}{p.receipt_no ? <span className="tag">Rcpt {p.receipt_no}</span> : null}<Cleared p={p} /></td>
              <td className="r">{money(p.amount)}</td><td className="small muted">{p.payment_mode || p.mode}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
      {pay && <PayForm kind={kind} party={pay} onClose={() => setPay(null)} onDone={(m) => { setPay(null); setMsg(m); load(); }} />}
      {report && <PaymentReport kind={kind} onClose={() => setReport(false)} />}
      {partyForm && <PartyForm party={partyForm.id ? partyForm : null} onClose={() => setPartyForm(null)}
        onSaved={(p) => { setPartyForm(null); setMsg(`Party ${p.name} saved.`); load(); }} />}
    </div>
  );
}
