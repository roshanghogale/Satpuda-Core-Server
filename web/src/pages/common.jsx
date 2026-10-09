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
