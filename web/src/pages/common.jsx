import { useEffect, useRef, useState } from 'react';
import { api, fmtDate, fmtExpiry, money, qs, shortNo } from '../api.js';

/** Wait until typing stops before asking the server. */
export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Type a customer or supplier name; pick one from the list or keep the typed (new) name. */
export function PartyPicker({ kind, value, onChange, placeholder }) {
  const [text, setText] = useState(value?.name || '');
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const q = useDebounced(text, 200);
  useEffect(() => { setText(value?.name || ''); }, [value?.id, value?.name]);
  useEffect(() => {
    if (!open || q.trim().length < 1) { setRows([]); return; }
    let live = true;
    api(`/${kind}${qs({ q, limit: 12 })}`).then((d) => { if (live) setRows(d.rows || []); }).catch(() => {});
    return () => { live = false; };
  }, [q, open, kind]);
  return (
    <div className="picker">
      <input
        value={text}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setText(e.target.value); onChange({ id: null, name: e.target.value }); }}
      />
      {open && rows.length > 0 && (
        <div className="dropdown">
          {rows.map((r) => (
            <button type="button" key={r.id} onMouseDown={() => { onChange(r); setText(r.name); setOpen(false); }}>
              <span>{r.name}</span>
              <span className="muted small">{r.phone || ''} {Number(r.total_due) > 0 ? `· due ${money(r.total_due)}` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Search medicines (sellable batches for a bill, any batch for a purchase). */
export function MedicineSearch({ mode = 'sellable', onPick, autoFocus, placeholder = 'Search medicine (name)…' }) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState([]);
  const [hi, setHi] = useState(0);
  const q = useDebounced(text, 200);
  const ref = useRef(null);
  useEffect(() => {
    if (q.trim().length < 2) { setRows([]); return; }
    let live = true;
    api(`/medicines/${mode}${qs({ q })}`).then((d) => { if (live) { setRows(d); setHi(0); } }).catch(() => {});
    return () => { live = false; };
  }, [q, mode]);
  function pick(r) {
    onPick(r);
    setText('');
    setRows([]);
    ref.current?.focus();
  }
  return (
    <div className="picker">
      <input
        ref={ref}
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { setHi((h) => Math.min(rows.length - 1, h + 1)); e.preventDefault(); }
          if (e.key === 'ArrowUp') { setHi((h) => Math.max(0, h - 1)); e.preventDefault(); }
          if (e.key === 'Enter' && rows[hi]) { pick(rows[hi]); e.preventDefault(); }
        }}
      />
      {rows.length > 0 && (
        <div className="dropdown wide">
          {rows.map((r, i) => (
            <button type="button" key={r.id} className={i === hi ? 'hi' : ''} onMouseDown={() => pick(r)}>
              <span><strong>{r.name}</strong> {r.schedule ? <span className="tag">{r.schedule}</span> : null}</span>
              <span className="muted small">
                batch {r.batch_no || '-'} · exp {fmtExpiry(r.expiry_date)} · stock {r.stock_qty}
                {mode === 'sellable' ? ` · ₹${money(r.sale_rate)}${r.strip ? '/tab' : ''}` : ` · MRP ${money(r.mrp)}`}
                {r.is_hidden ? ' · hidden' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The printed bill. Shown on screen, printed with the browser's print (Ctrl+P). */
export function BillPrint({ sale, profile }) {
  if (!sale) return null;
  const items = sale.items || [];
  return (
    <div className="bill-print">
      <div className="bp-head">
        <div className="bp-shop">{profile?.name}</div>
        <div>{profile?.address}</div>
        <div>
          {profile?.phone ? `Ph: ${profile.phone}` : ''}
          {profile?.gstin ? ` · GSTIN: ${profile.gstin}` : ''}
          {profile?.dl_number ? ` · DL: ${profile.dl_number}` : ''}
        </div>
      </div>
      <div className="bp-meta">
        <div>Bill No: <strong>{shortNo(sale.bill_no)}</strong></div>
        <div>Date: {fmtDate(sale.bill_date)}</div>
        <div>Customer: {sale.customer_name}{sale.customer_phone ? ` (${sale.customer_phone})` : ''}</div>
        {sale.doctor_name ? <div>Doctor: {sale.doctor_name}</div> : null}
      </div>
      <table className="bp-lines">
        <thead><tr><th>#</th><th>Medicine</th><th>Batch</th><th>Exp</th><th className="r">Qty</th><th className="r">Rate</th><th className="r">Amount</th></tr></thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>{it.name}{it.schedule ? ` [${it.schedule}]` : ''}</td>
              <td>{it.batch_no}</td>
              <td>{fmtExpiry(it.expiry_date)}</td>
              <td className="r">{it.qty}</td>
              <td className="r">{money(it.rate)}</td>
              <td className="r">{money(it.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="bp-tot">
        {Number(sale.discount) > 0 && <div>Discount: {money(sale.discount)}</div>}
        {Number(sale.rounding) !== 0 && <div>Round off: {money(sale.rounding)}</div>}
        <div className="bp-total">Total: ₹ {money(sale.total_amount)}</div>
        <div>Paid: {money(sale.amount_paid)}{Number(sale.due_amount) > 0 ? ` · Due: ${money(sale.due_amount)}` : ''}</div>
        <div className="muted small">GST included in MRP</div>
      </div>
    </div>
  );
}

export function printNow() {
  setTimeout(() => window.print(), 50);
}

/**
 * Take a payment for one bill from Sales / Purchase History (owner, 12 Oct 2026). Saved as an
 * ordinary customer / supplier payment with the bill number as its reference, so the ledger,
 * the party's due and every bill's status follow. Payments clear the oldest bill first: the
 * box shows the older dues and fills in the amount that clears this bill.
 */
export function PayDue({ kind, billId, onDone, onCancel }) {
  const [info, setInfo] = useState(null);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('cash');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setInfo(null); setError('');
    api(`/${kind === 'sale' ? 'sales' : 'purchases'}/${billId}/due`)
      .then((d) => { if (live) { setInfo(d); setAmount(d.to_clear > 0 ? String(d.to_clear) : ''); } })
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [kind, billId]);
  async function save() {
    setError(''); setBusy(true);
    try {
      const sale = kind === 'sale';
      const body = sale
        ? { customer_id: info.party_id, amount: Number(amount), mode, reference: shortNo(info.bill_no), note: `Paid from Sales History (${shortNo(info.bill_no)})` }
        : { supplier_id: info.party_id, amount: Number(amount), mode, reference: shortNo(info.bill_no) };
      await api(sale ? '/payments/customers' : '/payments/suppliers', { method: 'POST', body });
      onDone(sale
        ? `₹ ${money(amount)} received from ${info.party} against ${shortNo(info.bill_no)}.`
        : `₹ ${money(amount)} paid to ${info.party} against ${shortNo(info.bill_no)}.`);
    } catch (e) { setError(e.message); setBusy(false); }
  }
  if (!info) return <div className="muted">{error || 'Reading the bill…'}</div>;
  return (
    <div className="stack">
      <table className="grid">
        <tbody>
          <tr><td>Due on this bill</td><td className="r">₹ {money(info.bill_due)}</td></tr>
          {info.older_due > 0.009 && <tr><td>Due on older bills</td><td className="r">₹ {money(info.older_due)}</td></tr>}
          <tr><td>{kind === 'sale' ? 'Customer' : 'Supplier'} total due</td><td className="r">₹ {money(info.party_due)}</td></tr>
        </tbody>
      </table>
      {info.older_due > 0.009 && info.bill_due > 0.009 && (
        <p className="muted small">Payments clear the oldest bill first: ₹ {money(info.to_clear)} clears this bill.</p>
      )}
      <div className="row wrap">
        <label>Amount<input className="num" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label>Mode<select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="cash">Cash</option><option value="online">Online</option>
        </select></label>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy || !(Number(amount) > 0)} onClick={save}>{busy ? 'Saving…' : 'Save payment'}</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
