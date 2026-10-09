import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, money, shortNo } from '../api.js';
import { BillPrint, MedicineSearch, PartyPicker, printNow, useDebounced } from './common.jsx';

/** New bill, or (with :id) edit of an old one. Totals come from the server's rules. */
export default function Billing({ me }) {
  const { id } = useParams();
  const nav = useNavigate();
  const [customer, setCustomer] = useState({ id: null, name: '' });
  const [phone, setPhone] = useState('');
  const [doctor, setDoctor] = useState('');
  const [lines, setLines] = useState([]);
  const [discPct, setDiscPct] = useState('');
  const [cash, setCash] = useState('');
  const [online, setOnline] = useState('');
  const [calc, setCalc] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [version, setVersion] = useState(null);
  const [paidTouched, setPaidTouched] = useState(false);

  useEffect(() => {
    if (!id) return;
    api(`/sales/${id}`).then((s) => {
      setCustomer({ id: s.customer_id, name: s.customer_name });
      setDoctor(s.doctor_name || '');
      setLines((s.items || []).map((it) => ({
        medicine_id: it.medicine_id, name: it.name, batch_no: it.batch_no, expiry_date: it.expiry_date,
        qty: it.qty, disc_pct: it.qty * it.rate > 0 ? Math.round((Number(it.item_discount || 0) / (it.qty * it.rate)) * 10000) / 100 : 0,
        gst_percent: it.gst_percent, schedule: it.schedule,
      })));
      setDiscPct(s.discount_pct ? String(s.discount_pct) : '');
      setCash(String(s.cash_paid || '')); setOnline(String(s.online_paid || ''));
      setPaidTouched(true);
      setVersion(s.version);
    }).catch((e) => setError(e.message));
  }, [id]);

  const body = {
    sale_id: id ? Number(id) : undefined,
    customer_id: customer.id, customer_name: customer.name, customer_phone: phone, doctor_name: doctor,
    items: lines.map((l) => ({ medicine_id: l.medicine_id, qty: Number(l.qty) || 0, disc_pct: Number(l.disc_pct) || 0, gst_percent: l.gst_percent })),
    discount_pct: Number(discPct) || 0, cash_paid: Number(cash) || 0, online_paid: Number(online) || 0,
  };
  const key = useDebounced(JSON.stringify({ ...body, cash_paid: 0, online_paid: 0, a: cash, b: online }), 250);

  useEffect(() => {
    if (!lines.length || lines.some((l) => !(Number(l.qty) > 0))) { setCalc(null); return; }
    let live = true;
    api('/sales/preview', { method: 'POST', body }).then((c) => { if (live) { setCalc(c); setError(''); } })
      .catch((e) => { if (live) { setCalc(null); setError(e.message); } });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function addLine(m) {
    setLines((ls) => {
      const at = ls.findIndex((l) => l.medicine_id === m.id);
      if (at >= 0) return ls.map((l, i) => (i === at ? { ...l, qty: Number(l.qty || 0) + 1 } : l));
      return [...ls, { medicine_id: m.id, name: m.name, batch_no: m.batch_no, expiry_date: m.expiry_date, qty: 1, disc_pct: 0,
        stock: m.stock_qty, schedule: m.schedule, strip: m.strip, tps: m.tablets_per_strip }];
    });
  }
  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function save(andPrint) {
    setBusy(true);
    setError('');
    try {
      const paid = paidTouched ? body : { ...body, cash_paid: calc?.summary?.total_amount || 0 };
      const out = id
        ? await api(`/sales/${id}`, { method: 'PUT', body: { ...paid, version } })
        : await api('/sales', { method: 'POST', body: paid });
      setSaved(out.sale);
      if (andPrint) printNow();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function fresh() {
    setSaved(null); setLines([]); setCustomer({ id: null, name: '' }); setPhone(''); setDoctor('');
    setDiscPct(''); setCash(''); setOnline(''); setCalc(null); setPaidTouched(false);
    if (id) nav('/billing');
  }

  if (saved) {
    return (
      <div>
        <div className="card no-print row between">
          <div><strong>Bill {shortNo(saved.bill_no)} saved.</strong> Total ₹ {money(saved.total_amount)}</div>
          <div className="row">
            <button className="btn" onClick={printNow}>Print</button>
            <button className="btn primary" onClick={fresh} autoFocus>New bill</button>
          </div>
        </div>
        <BillPrint sale={saved} profile={me.profile} />
      </div>
    );
  }

  const s = calc?.summary;
  const due = calc?.payment;
  return (
    <div className="billing">
      <div className="card">
        <h2>{id ? 'Edit bill' : 'New bill'} <span className="muted small">{me.today}</span></h2>
        <div className="grid3">
          <label>Customer<PartyPicker kind="customers" value={customer} onChange={setCustomer} placeholder="Customer name" /></label>
          <label>Phone<input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={customer.id ? 'saved' : 'new customer only'} /></label>
          <label>Doctor<input value={doctor} onChange={(e) => setDoctor(e.target.value)} placeholder="needed for scheduled medicine" /></label>
        </div>
        {calc && Number(calc.previous_due) > 0 && <p className="warn small">Old due of this customer: ₹ {money(calc.previous_due)}</p>}
      </div>
      <div className="card">
        <MedicineSearch onPick={addLine} autoFocus />
        <table className="grid">
          <thead><tr><th>Medicine</th><th>Batch</th><th>Exp</th><th className="r">Qty</th><th className="r">Disc %</th><th className="r">Rate</th><th className="r">Amount</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const c = calc?.lines?.[i];
              return (
                <tr key={`${l.medicine_id}-${i}`}>
                  <td>{l.name} {l.schedule ? <span className="tag">{l.schedule}</span> : null}{l.strip ? <span className="muted small"> · qty in tablets ({l.tps}/strip)</span> : null}</td>
                  <td>{l.batch_no}</td>
                  <td>{String(l.expiry_date || '').slice(5, 7)}/{String(l.expiry_date || '').slice(2, 4)}</td>
                  <td className="r"><input className="num" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value.replace(/[^0-9]/g, '') })} /></td>
                  <td className="r"><input className="num" value={l.disc_pct} onChange={(e) => setLine(i, { disc_pct: e.target.value })} /></td>
                  <td className="r">{c ? money(c.rate) : ''}</td>
                  <td className="r">{c ? money(c.amount) : ''}</td>
                  <td><button className="btn small danger" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button></td>
                </tr>
              );
            })}
            {!lines.length && <tr><td colSpan={8} className="muted center">Search a medicine above and press Enter to add it.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card totals">
        <div className="grid4">
          <label>Bill discount %<input value={discPct} onChange={(e) => setDiscPct(e.target.value)} /></label>
          <label>Cash paid<input value={cash} onChange={(e) => { setCash(e.target.value); setPaidTouched(true); }} placeholder={s ? money(s.total_amount) : ''} /></label>
          <label>Online paid<input value={online} onChange={(e) => { setOnline(e.target.value); setPaidTouched(true); }} /></label>
          <div className="sum">
            {s ? (
              <>
                <div>Subtotal {money(s.subtotal)}{s.discount_amount ? ` − ${money(s.discount_amount)}` : ''}{calc.rounding ? ` · round ${money(calc.rounding)}` : ''}</div>
                <div className="big">₹ {money(s.total_amount)}</div>
                {paidTouched && due && due.due_amount > 0 && <div className="warn">Due on this bill: {money(due.due_amount)}</div>}
                {paidTouched && due && due.credit_amount > 0 && <div className="okmsg">Extra paid (credit): {money(due.credit_amount)}</div>}
              </>
            ) : <div className="muted">Totals appear here</div>}
          </div>
        </div>
        {!paidTouched && s && <p className="muted small">Leave Cash paid empty for a fully paid cash bill.</p>}
        {error && <div className="error">{error}</div>}
        <div className="row end">
          {id && <button className="btn" onClick={() => nav('/sales')}>Cancel</button>}
          <button className="btn" disabled={busy || !calc} onClick={() => save(false)}>Save</button>
          <button className="btn primary" disabled={busy || !calc} onClick={() => save(true)}>{busy ? 'Saving…' : 'Save & print'}</button>
        </div>
      </div>
    </div>
  );
}
