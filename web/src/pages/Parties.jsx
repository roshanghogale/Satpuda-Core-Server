import { useEffect, useState } from 'react';
import { api, fmtDate, money, qs } from '../api.js';
import { useDebounced } from './common.jsx';

function PayForm({ kind, party, onDone, onClose }) {
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('cash');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  async function save() {
    setError('');
    try {
      const body = kind === 'customers'
        ? { customer_id: party.id, amount: Number(amount), mode, note }
        : { supplier_id: party.id, amount: Number(amount), mode, reference: note };
      await api(`/payments/${kind}`, { method: 'POST', body });
      onDone(`${kind === 'customers' ? 'Received' : 'Paid'} ₹ ${money(amount)} ${kind === 'customers' ? 'from' : 'to'} ${party.name}.`);
    } catch (e) { setError(e.message); }
  }
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <h3>{kind === 'customers' ? 'Take payment from' : 'Pay'} {party.name}</h3>
        <p>Due now: ₹ {money(party.total_due)}</p>
        <label>Amount<input value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></label>
        <label>Mode<select value={mode} onChange={(e) => setMode(e.target.value)}><option value="cash">Cash</option><option value="online">Online</option></select></label>
        <label>{kind === 'customers' ? 'Note' : 'Reference'}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {error && <div className="error">{error}</div>}
        <div className="row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!(Number(amount) > 0)} onClick={save}>Save</button></div>
      </div>
    </div>
  );
}

export default function Parties({ can }) {
  const [kind, setKind] = useState('customers');
  const [q, setQ] = useState('');
  const [dueOnly, setDueOnly] = useState(true);
  const dq = useDebounced(q, 300);
  const [data, setData] = useState(null);
  const [pays, setPays] = useState([]);
  const [pay, setPay] = useState(null);
  const [msg, setMsg] = useState('');
  const load = () => {
    api(`/${kind}${qs({ q: dq, has_due: dueOnly ? '1' : '', limit: 500 })}`).then(setData).catch(() => {});
    api(`/payments/${kind}${qs({ limit: 30 })}`).then((d) => setPays(d.rows || [])).catch(() => setPays([]));
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
                <td>{can('payments') && <button className="btn small" onClick={() => setPay(p)}>{kind === 'customers' ? 'Take payment' : 'Pay'}</button>}</td></tr>))}</tbody>
          </table>
        </div>
        <div className="card detail">
          <h3>Recent {kind === 'customers' ? 'receipts' : 'payments'}</h3>
          <table className="grid compact">
            <tbody>{pays.map((p) => <tr key={p.id}><td>{fmtDate(p.payment_date)}</td><td>{p.customer_name || p.supplier_name}</td>
              <td className="r">{money(p.amount)}</td><td className="small muted">{p.payment_mode || p.mode}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
      {pay && <PayForm kind={kind} party={pay} onClose={() => setPay(null)} onDone={(m) => { setPay(null); setMsg(m); load(); }} />}
    </div>
  );
}
