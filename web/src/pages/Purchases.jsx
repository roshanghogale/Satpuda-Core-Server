import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, fmtDate, fmtExpiry, money, monthStartIso, qs, todayIso } from '../api.js';
import { MedicineSearch, PartyPicker, useDebounced } from './common.jsx';

const EMPTY = { name: '', batch_no: '', expiry: '', type: 'Tablet', unit: '10', qty: '', free_qty: '', rate: '', mrp: '', gst_pct: '12', discount_pct: '', hsn_code: '', schedule: '', manufacturer: '' };
const TYPES = ['Tablet', 'Capsule', 'Syrup', 'Injection', 'Ointment', 'Drops', 'Powder', 'Bolus', 'Tablet Pack', 'Other'];

function PurchaseForm({ editId }) {
  const nav = useNavigate();
  const [supplier, setSupplier] = useState({ id: null, name: '' });
  const [billNo, setBillNo] = useState('');
  const [date, setDate] = useState(todayIso());
  const [method, setMethod] = useState('discount_before_gst');
  const [lines, setLines] = useState([{ ...EMPTY }]);
  const [od, setOd] = useState('');
  const [cash, setCash] = useState('');
  const [online, setOnline] = useState('');
  const [calc, setCalc] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [version, setVersion] = useState(null);

  useEffect(() => {
    if (!editId) return;
    api(`/purchases/${editId}`).then((p) => {
      setSupplier({ id: p.supplier_id, name: p.supplier_name }); setBillNo(p.bill_number || ''); setDate(String(p.purchase_date).slice(0, 10));
      setMethod(p.gst_calc_method || 'discount_before_gst'); setOd(String(p.overall_discount || ''));
      setCash(String(p.cash_paid_at_entry || '')); setOnline(String(p.online_paid_at_entry || '')); setVersion(p.version);
      setLines((p.items || []).map((it) => ({ medicine_id: it.medicine_id, name: it.name, batch_no: it.batch_no || '', expiry: fmtExpiry(it.expiry_date),
        type: it.type || '', unit: it.unit || '', qty: String(it.qty), free_qty: String(it.free_qty || ''), rate: String(it.rate), mrp: String(it.mrp),
        gst_pct: String(it.gst_pct), discount_pct: String(it.discount_pct || ''), hsn_code: it.hsn_code || '', schedule: it.schedule || '', manufacturer: it.manufacturer || '' })));
    }).catch((e) => setError(e.message));
  }, [editId]);

  const items = lines.filter((l) => l.name && (Number(l.qty) > 0 || Number(l.free_qty) > 0));
  const body = { supplier_id: supplier.id, supplier_name: supplier.name, bill_number: billNo, purchase_date: date, gst_calc_method: method,
    overall_discount: Number(od) || 0, cash_paid: Number(cash) || 0, online_paid: Number(online) || 0, items };
  const key = useDebounced(JSON.stringify(body), 300);
  useEffect(() => {
    if (!items.length) { setCalc(null); return; }
    let live = true;
    api('/purchases/preview', { method: 'POST', body }).then((c) => { if (live) setCalc(c); }).catch(() => {});
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  function pickExisting(i, m) {
    setLine(i, { medicine_id: m.id, name: m.name, batch_no: m.batch_no || '', expiry: fmtExpiry(m.expiry_date), type: m.type || '', unit: m.unit || '',
      rate: String(m.rate ?? ''), mrp: String(m.mrp ?? ''), gst_pct: String(m.gst_percent ?? ''), hsn_code: m.hsn_code || '', schedule: m.schedule || '', manufacturer: m.manufacturer || '' });
  }
  async function save() {
    setBusy(true); setError('');
    try {
      const out = editId
        ? await api(`/purchases/${editId}`, { method: 'PUT', body: { ...body, version } })
        : await api('/purchases', { method: 'POST', body });
      setDone(`Purchase ${out.purchase_no.split('/FY')[0]} saved: ₹ ${money(out.total_amount)}. Stock added.`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (done) {
    return <div className="card"><div className="okmsg">{done}</div>
      <div className="row"><button className="btn primary" onClick={() => { setDone(''); setLines([{ ...EMPTY }]); setBillNo(''); setSupplier({ id: null, name: '' }); if (editId) nav('/purchases'); }}>New purchase</button>
        <button className="btn" onClick={() => nav('/purchases')}>Purchase history</button></div></div>;
  }
  return (
    <div>
      <div className="card">
        <h2>{editId ? 'Edit purchase' : 'New purchase'}</h2>
        <div className="grid4">
          <label>Supplier<PartyPicker kind="suppliers" value={supplier} onChange={setSupplier} placeholder="Supplier name" /></label>
          <label>Supplier bill no<input value={billNo} onChange={(e) => setBillNo(e.target.value)} /></label>
          <label>Date<input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></label>
          <label>Rates on the bill<select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="discount_before_gst">without GST (GST added)</option>
            <option value="discount_after_gst">with GST included</option>
          </select></label>
        </div>
      </div>
      <div className="card scrollx">
        <table className="grid compact">
          <thead><tr><th>Medicine (pick or type new)</th><th>Batch</th><th>Exp MM/YY</th><th>Type</th><th>Pack</th><th>Qty</th><th>Free</th><th>Rate</th><th>MRP</th><th>GST%</th><th>Disc%</th><th>Schedule</th><th className="r">Amount</th><th /></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i}>
              <td className="wide-cell">
                {l.medicine_id ? <span>{l.name} <button className="btn link small" onClick={() => setLine(i, { medicine_id: null })}>change</button></span>
                  : <><input value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} placeholder="New medicine name" />
                    <MedicineSearch mode="any" placeholder="…or find existing" onPick={(m) => pickExisting(i, m)} /></>}
              </td>
              <td><input value={l.batch_no} onChange={(e) => setLine(i, { batch_no: e.target.value })} /></td>
              <td><input className="num" value={l.expiry} onChange={(e) => setLine(i, { expiry: e.target.value })} placeholder="08/27" /></td>
              <td><select value={l.type} onChange={(e) => setLine(i, { type: e.target.value })}>{[...new Set([l.type, ...TYPES])].filter(Boolean).map((t) => <option key={t}>{t}</option>)}</select></td>
              <td><input className="num" value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} title="Tablets per strip, or pack like 100ML" /></td>
              {['qty', 'free_qty', 'rate', 'mrp', 'gst_pct', 'discount_pct'].map((f) => (
                <td key={f}><input className="num" value={l[f]} onChange={(e) => setLine(i, { [f]: e.target.value })} /></td>
              ))}
              <td><input className="num" value={l.schedule} onChange={(e) => setLine(i, { schedule: e.target.value.toUpperCase() })} placeholder="H/H1" /></td>
              <td className="r">{calc?.items?.[items.indexOf(l)] ? money(calc.items[items.indexOf(l)].item_amount) : ''}</td>
              <td><button className="btn small danger" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button></td>
            </tr>
          ))}</tbody>
        </table>
        <button className="btn small" onClick={() => setLines((ls) => [...ls, { ...EMPTY }])}>+ Add line</button>
        <p className="muted small">Qty and Free are in strips/packs as on the supplier's bill. Strip medicines add qty × pack tablets to stock.</p>
      </div>
      <div className="card totals">
        <div className="grid4">
          <label>Bill discount ₹<input value={od} onChange={(e) => setOd(e.target.value)} /></label>
          <label>Cash paid<input value={cash} onChange={(e) => setCash(e.target.value)} /></label>
          <label>Online paid<input value={online} onChange={(e) => setOnline(e.target.value)} /></label>
          <div className="sum">{calc ? <>
            <div>Taxable {money(calc.subtotal)} · GST {money(calc.total_gst)}{calc.rounding ? ` · round ${money(calc.rounding)}` : ''}</div>
            <div className="big">₹ {money(calc.total_amount)}</div>
            {calc.due > 0 && <div className="warn">Due to supplier after this bill: {money(calc.due)}</div>}
          </> : <span className="muted">Totals appear here</span>}</div>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="row end">
          {editId && <button className="btn" onClick={() => nav('/purchases')}>Cancel</button>}
          <button className="btn primary" disabled={busy || !calc} onClick={save}>{busy ? 'Saving…' : 'Save purchase'}</button>
        </div>
      </div>
    </div>
  );
}

function History({ can }) {
  const nav = useNavigate();
  const [from, setFrom] = useState(monthStartIso());
  const [to, setTo] = useState(todayIso());
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState('');
  const load = () => api(`/purchases${qs({ from, to, q: dq })}`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, dq]);
  async function del() {
    if (!window.confirm(`Delete purchase ${String(open.purchase_no).split('/FY')[0]}? Its stock is taken back.`)) return;
    try { await api(`/purchases/${open.id}`, { method: 'DELETE' }); setOpen(null); load(); } catch (e) { setError(e.message); }
  }
  return (
    <div>
      <div className="card row wrap">
        <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="grow">Search<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Purchase no, supplier, bill no" /></label>
        {data?.summary && <div className="tiles"><div><span>Purchases</span><b>{data.summary.bills ?? data.summary.rows}</b></div><div><span>Total</span><b>₹ {money(data.summary.gross ?? data.summary.total)}</b></div></div>}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="split">
        <div className="card list">
          <table className="grid click">
            <thead><tr><th>No</th><th>Date</th><th>Supplier</th><th>Bill no</th><th className="r">Total</th><th>By</th></tr></thead>
            <tbody>{(data?.rows || []).map((r) => (
              <tr key={r.id} onClick={() => api(`/purchases/${r.id}`).then(setOpen)} className={open?.id === r.id ? 'sel' : ''}>
                <td>{String(r.purchase_no).split('/FY')[0]}</td><td>{fmtDate(r.purchase_date)}</td><td>{r.supplier_name}</td><td>{r.bill_number}</td>
                <td className="r">{money(r.final_amount ?? r.total_amount)}</td><td className="small muted">{r.made_by || 'PC/phone'}</td>
              </tr>))}</tbody>
          </table>
        </div>
        {open && <div className="card detail">
          <div className="row wrap">
            <strong>Purchase {String(open.purchase_no).split('/FY')[0]} · {open.supplier_name}</strong>
            {can('purchase_edit') && <button className="btn" onClick={() => nav(`/purchases/edit/${open.id}`)}>Edit</button>}
            {can('purchase_delete') && <button className="btn danger" onClick={del}>Delete</button>}
          </div>
          <table className="grid compact">
            <thead><tr><th>Medicine</th><th>Batch</th><th>Exp</th><th className="r">Qty</th><th className="r">Free</th><th className="r">Rate</th><th className="r">GST%</th><th className="r">Amount</th></tr></thead>
            <tbody>{(open.items || []).map((it, i) => <tr key={i}><td>{it.name}</td><td>{it.batch_no}</td><td>{fmtExpiry(it.expiry_date)}</td>
              <td className="r">{it.qty}</td><td className="r">{it.free_qty || ''}</td><td className="r">{money(it.rate)}</td><td className="r">{it.gst_pct}</td><td className="r">{money(it.item_amount)}</td></tr>)}</tbody>
          </table>
          <p>Taxable {money(open.subtotal)} · GST {money(open.total_gst)} · <b>Total ₹ {money(open.total_amount)}</b> · Paid {money(open.amount_paid)}</p>
        </div>}
      </div>
    </div>
  );
}

function EditRoute() {
  const { id } = useParams();
  return <PurchaseForm editId={id} />;
}

export default function Purchases({ can }) {
  return (
    <div>
      <div className="subnav no-print">
        {can('purchase_entry') && <NavLink to="/purchases/new">New purchase</NavLink>}
        {can('purchase_view') && <NavLink to="/purchases" end>Purchase history</NavLink>}
      </div>
      <Routes>
        <Route index element={can('purchase_view') ? <History can={can} /> : <PurchaseForm />} />
        {can('purchase_entry') && <Route path="new" element={<PurchaseForm />} />}
        {can('purchase_edit') && <Route path="edit/:id" element={<EditRoute />} />}
      </Routes>
    </div>
  );
}
