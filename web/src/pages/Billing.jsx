import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fmtDate, money, shortNo } from '../api.js';
import { BillPrint, MedicineSearch, PartyPicker, printNow, SuggestInput, useDebounced, useSalesDefaults } from './common.jsx';

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
  // Returns of this customer whose credit is not used yet; the ticked ones are settled in
  // this bill as Return rows (owner, 17 Oct 2026).
  const [openRets, setOpenRets] = useState([]);
  const [useRets, setUseRets] = useState([]);
  const [askRets, setAskRets] = useState(false);
  // Contacts > Doctors > Set default on the PC (settings billing_layout_prefs.default_doctor):
  // every new bill starts with that doctor, as on the PC and the phone (owner, 19 Oct 2026).
  const defs = useSalesDefaults();
  const doctorTouched = useRef(false);
  useEffect(() => {
    if (!id && defs?.default_doctor && !doctorTouched.current) setDoctor(defs.default_doctor);
  }, [defs, id]);
  const doctorPhone = (defs?.doctors || []).find((d) => d.name.toUpperCase() === doctor.trim().toUpperCase())?.phone || '';

  useEffect(() => {
    setOpenRets([]); setUseRets([]); setAskRets(false);
    if (id || !customer.id) return;
    let live = true;
    api(`/customers/${customer.id}/open-returns`).then((r) => {
      if (!live || !r.length) return;
      setOpenRets(r); setUseRets(r.map((x) => x.return_id)); setAskRets(true);
    }).catch(() => {});
    return () => { live = false; };
  }, [customer.id, id]);

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
    apply_returns: id ? undefined : useRets,
  };
  const pickedRets = openRets.filter((r) => useRets.includes(r.return_id));
  const billTotal = calc?.summary?.total_amount || 0;
  // The server gives each return what it has left, never more than the bill leaves unpaid.
  const retTotal = Math.round(Math.min(pickedRets.reduce((x, r) => x + r.left, 0), billTotal) * 100) / 100;
  const netTotal = Math.round((billTotal - retTotal) * 100) / 100;
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
      const paid = paidTouched ? body : { ...body, cash_paid: netTotal };
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
    setSaved(null); setLines([]); setCustomer({ id: null, name: '' }); setPhone(''); setDoctor(defs?.default_doctor || '');
    doctorTouched.current = false;
    setDiscPct(''); setCash(''); setOnline(''); setCalc(null); setPaidTouched(false);
    setOpenRets([]); setUseRets([]); setAskRets(false);
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
          <label>Customer<PartyPicker kind="customers" value={customer} onChange={setCustomer} placeholder="Empty = walk-in (paid in full)" /></label>
          <label>Phone<input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={customer.id ? 'saved' : 'new customer only'} /></label>
          <label>Doctor{doctorPhone ? <span className="muted small"> · {doctorPhone}</span> : null}
            <SuggestInput value={doctor} options={defs?.doctors || []} placeholder="needed for scheduled medicine"
              onChange={(v) => { doctorTouched.current = true; setDoctor(v); }} /></label>
        </div>
        {calc && Number(calc.previous_due) > 0 && <p className="warn small">Old due of this customer: ₹ {money(calc.previous_due)}</p>}
        {openRets.length > 0 && !askRets && (
          <p className="okmsg small">Return credit: {pickedRets.length ? `${pickedRets.map((r) => r.return_no).join(', ')} settled in this bill` : 'not used in this bill'}
            {' '}<button className="btn small" onClick={() => setAskRets(true)}>Change</button></p>)}
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
            {pickedRets.map((r) => [
              <tr key={`r${r.return_id}`} className="ret-head">
                <td colSpan={8}>Return {r.return_no} {fmtDate(r.return_date)}</td>
              </tr>,
              ...r.items.map((it, j) => (
                <tr key={`r${r.return_id}-${j}`} className="ret-line">
                  <td colSpan={3}>{j + 1}. {it.name}</td><td className="r">{it.qty}</td><td /><td />
                  <td className="r">− {money(it.amount)}</td><td />
                </tr>)),
              <tr key={`r${r.return_id}-t`} className="ret-total">
                <td colSpan={6} className="r">Return total <span className="muted small">(bill {r.bill_no}
                  {r.left < r.amount - 0.009 ? ` · ₹ ${money(r.amount - r.left)} of ₹ ${money(r.amount)} already went to older dues` : ''})</span></td>
                <td className="r">− {money(r.left)}</td><td />
              </tr>,
            ])}
          </tbody>
        </table>
      </div>
      <div className="card totals">
        <div className="grid4">
          <label>Bill discount %<input value={discPct} onChange={(e) => setDiscPct(e.target.value)} /></label>
          <label>Cash paid<input value={cash} onChange={(e) => { setCash(e.target.value); setPaidTouched(true); }} placeholder={s ? money(netTotal) : ''} /></label>
          <label>Online paid<input value={online} onChange={(e) => { setOnline(e.target.value); setPaidTouched(true); }} /></label>
          <div className="sum">
            {s ? (
              <>
                <div>Subtotal {money(s.subtotal)}{s.discount_amount ? ` − ${money(s.discount_amount)}` : ''}{calc.rounding ? ` · round ${money(calc.rounding)}` : ''}</div>
                <div className={retTotal > 0 ? '' : 'big'}>{retTotal > 0 ? 'Total ' : ''}₹ {money(s.total_amount)}</div>
                {retTotal > 0 && <div>Return total − ₹ {money(retTotal)}</div>}
                {retTotal > 0 && <div className="big">Net to pay ₹ {money(netTotal)}</div>}
                {paidTouched && retTotal > 0 && netTotal - (Number(cash) || 0) - (Number(online) || 0) > 0.009 && (
                  <div className="warn">Due on this bill: {money(netTotal - (Number(cash) || 0) - (Number(online) || 0))}</div>)}
                {paidTouched && !(retTotal > 0) && due && due.due_amount > 0 && <div className="warn">Due on this bill: {money(due.due_amount)}</div>}
                {paidTouched && due && due.credit_amount > 0 && <div className="okmsg">Extra paid (credit): {money(due.credit_amount)}</div>}
              </>
            ) : <div className="muted">Totals appear here</div>}
          </div>
        </div>
        {!paidTouched && s && <p className="muted small">Leave Cash paid empty for a fully paid cash bill.</p>}
        {askRets && (
          <div className="modal-back" onClick={() => setAskRets(false)}>
            <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
              <h3>{customer.name} has return credit</h3>
              <p className="small">Tick the returns to settle in this bill. They show on the bill as Return rows and come off its total.</p>
              <table className="grid compact">
                <tbody>{openRets.map((r) => (
                  <tr key={r.return_id}>
                    <td><input type="checkbox" checked={useRets.includes(r.return_id)}
                      onChange={(e) => setUseRets((u) => (e.target.checked ? [...u, r.return_id] : u.filter((x) => x !== r.return_id)))} /></td>
                    <td>{r.return_no}<div className="muted small">{fmtDate(r.return_date)} · bill {r.bill_no}</div>
                      <div className="muted small">{r.items.map((it) => `${it.name} × ${it.qty}`).join(', ')}</div></td>
                    <td className="r">₹ {money(r.left)}</td>
                  </tr>))}</tbody>
              </table>
              <div className="row end">
                <button className="btn" onClick={() => { setUseRets([]); setAskRets(false); }}>Not in this bill</button>
                <button className="btn primary" autoFocus onClick={() => setAskRets(false)}>Use ticked</button>
              </div>
            </div>
          </div>)}
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
