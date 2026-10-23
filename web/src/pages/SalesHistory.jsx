import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDate, money, monthStartIso, qs, shortNo, todayIso } from '../api.js';
import { BillPrint, PayDue, printNow, useDebounced } from './common.jsx';
import DoctorMargin from './DoctorMargin.jsx';
import { WholesaleInvoice } from './wholesale.jsx';

function ReturnForm({ sale, onDone }) {
  const [data, setData] = useState(null);
  const [qty, setQty] = useState({});
  const [settle, setSettle] = useState('ledger');
  const [error, setError] = useState('');
  useEffect(() => { api(`/sales/${sale.id}/returnable`).then(setData).catch((e) => setError(e.message)); }, [sale.id]);
  // A wholesale bill is returned in strips (as the PC's Returns page counts it); the return is
  // saved in stock units: strips x units per strip.
  const upsOf = (mid) => (data?.wholesale ? Number(data.lines.find((l) => Number(l.medicine_id) === Number(mid))?.units_per_pack || 1) : 1);
  const show = (units, mid) => Math.round((Number(units) / upsOf(mid)) * 100) / 100;
  async function save() {
    setError('');
    try {
      const items = Object.entries(qty).filter(([, q]) => Number(q) > 0).map(([mid, q]) => ({ medicine_id: Number(mid), qty: Number(q) * upsOf(mid) }));
      const out = await api('/returns/sales', { method: 'POST', body: { sale_id: sale.id, items, settle_mode: settle } });
      onDone(`Return ${out.return_no} saved: refund ₹ ${money(out.refund_amount)}`);
    } catch (e) { setError(e.message); }
  }
  if (!data) return <div className="muted">{error || 'Loading…'}</div>;
  return (
    <div className="stack">
      <table className="grid">
        <thead><tr><th>Medicine</th><th className="r">Sold</th><th className="r">Returned</th><th className="r">Return now{data.wholesale ? ' (strips)' : ''}</th></tr></thead>
        <tbody>{data.lines.map((l) => (
          <tr key={l.medicine_id}><td>{l.name}</td><td className="r">{show(l.sold, l.medicine_id)}</td><td className="r">{show(l.already_returned, l.medicine_id)}</td>
            <td className="r">{l.can_return > 0 ? <input className="num" value={qty[l.medicine_id] || ''} onChange={(e) => setQty({ ...qty, [l.medicine_id]: e.target.value })} /> : '—'}</td></tr>
        ))}</tbody>
      </table>
      <label>Refund<select value={settle} onChange={(e) => setSettle(e.target.value)}>
        <option value="ledger">Reduce customer's due / keep as credit</option>
        <option value="cash">Give cash back</option>
        <option value="online">Give back online</option>
      </select></label>
      {error && <div className="error">{error}</div>}
      <button className="btn primary" onClick={save}>Save return</button>
    </div>
  );
}

export default function SalesHistory({ me, can }) {
  const nav = useNavigate();
  const ws = me.store_kind === 'wholesale';
  const [from, setFrom] = useState(monthStartIso());
  const [to, setTo] = useState(todayIso());
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [mode, setMode] = useState('view');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [doctorReport, setDoctorReport] = useState(false);

  const load = () => api(`/sales${qs({ from, to, q: dq })}`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, dq]);

  async function show(id, nextMode = 'view') {
    setMode(nextMode); setMsg(''); setError('');
    try { setOpen(await api(`/sales/${id}`)); } catch (e) { setError(e.message); }
  }
  async function del() {
    if (!window.confirm(`Delete bill ${shortNo(open.bill_no)}? Its medicines go back to stock.`)) return;
    try {
      await api(`/sales/${open.id}`, { method: 'DELETE' });
      setOpen(null); setMsg('Bill deleted.'); load();
    } catch (e) { setError(e.message); }
  }

  const sum = data?.summary;
  return (
    <div>
      <div className="card no-print">
        <div className="row wrap">
          <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="grow">Search<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Bill no, customer, doctor" /></label>
          {!ws && <button className="btn" onClick={() => setDoctorReport(true)}>Export: Doctor margin report</button>}
        </div>
        {sum && <div className="tiles">
          <div><span>Bills</span><b>{sum.bills}</b></div>
          <div><span>Sales</span><b>₹ {money(sum.gross)}</b></div>
          <div><span>Cash</span><b>₹ {money(sum.cash)}</b></div>
          <div><span>Online</span><b>₹ {money(sum.online)}</b></div>
          <div><span>Due</span><b>₹ {money(sum.due)}</b></div>
        </div>}
        {msg && <div className="okmsg">{msg}</div>}
        {error && <div className="error">{error}</div>}
      </div>
      <div className="split">
        <div className="card no-print list">
          <table className="grid click">
            <thead><tr><th>Bill</th><th>Date</th><th>Customer</th><th className="r">Total</th><th className="r">Due</th><th>Status</th><th>By</th></tr></thead>
            <tbody>{(data?.rows || []).map((r) => (
              <tr key={r.id} onClick={() => show(r.id)} className={open?.id === r.id ? 'sel' : ''}>
                <td>{shortNo(r.bill_no)}</td><td>{fmtDate(r.bill_date)}</td><td>{r.customer_name}</td>
                <td className="r">{money(r.total_amount)}</td><td className="r">{Number(r.due_amount) > 0 ? money(r.due_amount) : ''}</td>
                <td>{Number(r.due_amount) > 0.009
                  ? (can('payments')
                    ? <button className="btn small" title="Take a payment for this bill" onClick={(e) => { e.stopPropagation(); show(r.id, 'pay'); }}>
                        {Number(r.amount_paid) > 0 ? 'Partial' : 'Due'} · Pay</button>
                    : <span className="muted small">{Number(r.amount_paid) > 0 ? 'Partial' : 'Due'}</span>)
                  : <span className="muted small">Paid</span>}</td>
                <td className="small muted">{r.made_by || 'PC/phone'}</td>
              </tr>
            ))}</tbody>
          </table>
          {data && !data.rows.length && <p className="muted center">No bills in these dates.</p>}
        </div>
        {open && (
          <div className="detail">
            <div className="card no-print row wrap">
              {!ws && <button className="btn" onClick={printNow}>Print</button>}
              {can('sales_edit') && <button className="btn" onClick={() => nav(`/billing/edit/${open.id}`)}>Edit</button>}
              {can('returns') && <button className="btn" onClick={() => setMode(mode === 'return' ? 'view' : 'return')}>Return</button>}
              {can('payments') && Number(open.due_amount ?? open.total_due) > 0.009 && <button className="btn" onClick={() => setMode(mode === 'pay' ? 'view' : 'pay')}>Receive payment</button>}
              {can('sales_delete') && <button className="btn danger" onClick={del}>Delete</button>}
              <span className="muted small">Made by {open.made_by || 'PC / phone'}</span>
            </div>
            {mode === 'return'
              ? <div className="card"><h3>Return from bill {shortNo(open.bill_no)}</h3><ReturnForm sale={open} onDone={(m) => { setMsg(m); setMode('view'); load(); }} /></div>
              : mode === 'pay'
                ? <div className="card"><h3>Receive payment · {shortNo(open.bill_no)} · {open.customer_name}</h3>
                    <PayDue kind="sale" billId={open.id} onCancel={() => setMode('view')}
                      onDone={(m) => { setMsg(m); setMode('view'); load(); show(open.id); setMsg(m); }} /></div>
                : ws ? <div className="card"><WholesaleInvoice key={open.id} saleId={open.id} /></div>
                  : <BillPrint sale={open} profile={me.profile} />}
          </div>
        )}
      </div>
      {doctorReport && <DoctorMargin from={from} to={to} canEdit={can('reports')} onClose={() => setDoctorReport(false)} />}
    </div>
  );
}
