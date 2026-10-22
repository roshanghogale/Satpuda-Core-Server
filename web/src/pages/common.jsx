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

/**
 * A text box with suggestions (villages, doctors): typing shows the ones that match; arrows
 * move, Enter takes the marked one, Esc closes the list.
 */
export function SuggestInput({ value, onChange, options, placeholder, inputRef, onPicked, className }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const t = String(value || '').trim().toUpperCase();
  const shown = (options || []).filter((o) => {
    const name = typeof o === 'string' ? o : o.name;
    return !t || (name.toUpperCase().includes(t) && name.toUpperCase() !== t);
  }).slice(0, 12);
  function pick(o) {
    const name = typeof o === 'string' ? o : o.name;
    onChange(name);
    onPicked?.(o);
    setOpen(false); setHi(-1);
  }
  return (
    <div className="picker">
      <input ref={inputRef} className={className} value={value} placeholder={placeholder} autoComplete="off"
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHi(-1); }}
        onKeyDown={(e) => {
          if (!open || !shown.length) return;
          if (e.key === 'ArrowDown') { setHi((h) => Math.min(shown.length - 1, h + 1)); e.preventDefault(); }
          if (e.key === 'ArrowUp') { setHi((h) => Math.max(-1, h - 1)); e.preventDefault(); }
          if (e.key === 'Enter' && hi >= 0 && shown[hi]) { e.preventDefault(); e.stopPropagation(); pick(shown[hi]); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
        }} />
      {open && shown.length > 0 && (
        <div className="dropdown">
          {shown.map((o, i) => {
            const name = typeof o === 'string' ? o : o.name;
            return (
              <button type="button" tabIndex={-1} key={name} className={i === hi ? 'hi' : ''} onMouseDown={() => pick(o)}>
                <span>{name}</span>
                {typeof o !== 'string' && o.phone ? <span className="muted small">{o.phone}</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** What a new bill starts with: default doctor + phone, doctors, villages (the PC's Sales). */
export function useSalesDefaults() {
  const [d, setD] = useState(null);
  useEffect(() => {
    let live = true;
    api('/sales/defaults').then((x) => { if (live) setD(x); })
      .catch(() => { if (live) setD({ default_doctor: '', default_doctor_phone: '', doctors: [], villages: [], default_village: '' }); });
    return () => { live = false; };
  }, []);
  return d;
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

/**
 * Returns settled in a bill (owner, 17-18 Oct 2026): a centred "Return SR1-7 17-10-2026" row
 * (no customer name), the medicines that came back one per row like the items (batch, expiry,
 * qty, MRP, minus amount), then the return's total. `cols` = 7, the bill table's columns.
 */
export function ReturnRows({ returns }) {
  return (returns || []).map((r) => [
    <tr key={`r${r.return_id}`} className="ret-head">
      <td colSpan={7} className="center">Return {r.return_no} {fmtDate(r.return_date)}</td>
    </tr>,
    ...(r.items || []).map((it, i) => (
      <tr key={`r${r.return_id}-${i}`} className="ret-line">
        <td>{i + 1}</td>
        <td>{it.name}</td>
        <td>{it.batch_no}</td>
        <td>{fmtExpiry(it.expiry)}</td>
        <td className="r">{it.qty}</td>
        <td className="r">{Number(it.mrp) ? money(it.mrp) : ''}</td>
        <td className="r">− {money(it.amount)}</td>
      </tr>
    )),
    <tr key={`r${r.return_id}-t`} className="ret-total">
      <td colSpan={6} className="r">Return total
        {Number(r.refund) > r.amount + 0.009 ? ` (₹ ${money(r.amount)} of ₹ ${money(r.refund)} used in this bill)` : ''}</td>
      <td className="r">− {money(r.amount)}</td>
    </tr>,
  ]);
}

/** The printed bill. Shown on screen, printed with the browser's print (Ctrl+P). */
export function BillPrint({ sale, profile }) {
  if (!sale) return null;
  const items = sale.items || [];
  const rets = sale.returns_in_bill || [];
  const retTotal = Math.round(rets.reduce((s, r) => s + Number(r.amount || 0), 0) * 100) / 100;
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
          <ReturnRows returns={rets} />
        </tbody>
      </table>
      <div className="bp-tot">
        {Number(sale.discount) > 0 && <div>Discount: {money(sale.discount)}</div>}
        {Number(sale.rounding) !== 0 && <div>Round off: {money(sale.rounding)}</div>}
        <div className={retTotal > 0 ? '' : 'bp-total'}>Total: ₹ {money(sale.total_amount)}</div>
        {retTotal > 0 && <div>Return total: − ₹ {money(retTotal)}</div>}
        {retTotal > 0 && <div className="bp-total">Net to pay: ₹ {money(Number(sale.total_amount) - retTotal)}</div>}
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
 * the party's due and every bill's status follow. The payment is given to THIS bill
 * (allocations, 17 Oct 2026); whatever is paid over its due clears the oldest bills.
 */
export function PayDue({ kind, billId, onDone, onCancel }) {
  const [info, setInfo] = useState(null);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('cash');
  const [receipt, setReceipt] = useState('');
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
      const amt = Number(amount);
      const allocations = info.bill_due > 0.009
        ? [{ bill_id: info.bill_id, bill_no: shortNo(info.bill_no), amount: Math.min(amt, info.bill_due) }] : [];
      const body = sale
        ? { customer_id: info.party_id, amount: amt, mode, reference: shortNo(info.bill_no), note: `Paid from Sales History (${shortNo(info.bill_no)})`, allocations, receipt_no: receipt }
        : { supplier_id: info.party_id, amount: amt, mode, reference: shortNo(info.bill_no), allocations, receipt_no: receipt };
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
      {info.bill_due > 0.009 && (
        <p className="muted small">Clears this bill; any more clears the oldest bills.</p>
      )}
      <div className="row wrap">
        <label>Amount<input className="num" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label>Mode<select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="cash">Cash</option><option value="online">Online</option>
        </select></label>
        <label>Receipt no.<input value={receipt} onChange={(e) => setReceipt(e.target.value)} placeholder="optional" /></label>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy || !(Number(amount) > 0)} onClick={save}>{busy ? 'Saving…' : 'Save payment'}</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
