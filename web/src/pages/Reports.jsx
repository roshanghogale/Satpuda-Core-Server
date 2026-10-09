import { useEffect, useState } from 'react';
import { api, fmtDate, fmtExpiry, money, monthStartIso, qs, shortNo, todayIso } from '../api.js';
import { printNow } from './common.jsx';

export default function Reports({ me }) {
  const [from, setFrom] = useState(monthStartIso());
  const [to, setTo] = useState(todayIso());
  const [r, setR] = useState(null);
  const [error, setError] = useState('');
  const [onlySched, setOnlySched] = useState('');
  useEffect(() => { api(`/reports${qs({ from, to })}`).then(setR).catch((e) => setError(e.message)); }, [from, to]);
  const sched = (r?.schedule_register || []).filter((x) => !onlySched || x.schedule === onlySched);
  const schedules = [...new Set((r?.schedule_register || []).map((x) => x.schedule))];
  return (
    <div>
      <div className="card row wrap no-print">
        <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn" onClick={printNow}>Print</button>
      </div>
      {error && <div className="error">{error}</div>}
      {r && <>
        <div className="card">
          <h2>{me.profile?.name} · {fmtDate(r.from)} to {fmtDate(r.to)}</h2>
          <div className="tiles">
            <div><span>Sales bills</span><b>{r.sales?.bills}</b></div>
            <div><span>Sales</span><b>₹ {money(r.sales?.gross)}</b></div>
            <div><span>Sales GST</span><b>₹ {money(r.sales?.gst)}</b></div>
            <div><span>Returns</span><b>₹ {money(r.sales_returns?.refunds)}</b></div>
            <div><span>Purchases</span><b>₹ {money(r.purchases?.gross ?? r.purchases?.total)}</b></div>
            <div><span>Cash</span><b>₹ {money(r.sales?.cash)}</b></div>
            <div><span>Online</span><b>₹ {money(r.sales?.online)}</b></div>
            <div><span>Due on bills</span><b>₹ {money(r.sales?.due)}</b></div>
          </div>
        </div>
        <div className="split">
          <div className="card"><h3>GST on sales (by rate)</h3>
            <table className="grid compact"><thead><tr><th>GST %</th><th className="r">Value</th><th className="r">Taxable</th><th className="r">GST</th><th className="r">CGST</th><th className="r">SGST</th></tr></thead>
              <tbody>{r.gst_sales.map((g) => <tr key={g.gst_pct}><td>{g.gst_pct}</td><td className="r">{money(g.value)}</td><td className="r">{money(g.taxable)}</td>
                <td className="r">{money(g.gst)}</td><td className="r">{money(g.gst / 2)}</td><td className="r">{money(g.gst / 2)}</td></tr>)}</tbody></table>
          </div>
          <div className="card"><h3>GST on purchases (by rate)</h3>
            <table className="grid compact"><thead><tr><th>GST %</th><th className="r">Taxable</th><th className="r">GST</th><th className="r">Value</th></tr></thead>
              <tbody>{r.gst_purchases.map((g) => <tr key={g.gst_pct}><td>{g.gst_pct}</td><td className="r">{money(g.taxable)}</td><td className="r">{money(g.gst)}</td><td className="r">{money(g.value)}</td></tr>)}</tbody></table>
          </div>
        </div>
        <div className="card">
          <div className="row between"><h3>Schedule register</h3>
            <select className="no-print" value={onlySched} onChange={(e) => setOnlySched(e.target.value)}><option value="">All schedules</option>{schedules.map((s) => <option key={s}>{s}</option>)}</select></div>
          <table className="grid compact">
            <thead><tr><th>Date</th><th>Bill</th><th>Customer</th><th>Doctor</th><th>Medicine</th><th>Sch</th><th>Batch</th><th>Exp</th><th className="r">Qty</th></tr></thead>
            <tbody>{sched.map((x, i) => <tr key={i}><td>{fmtDate(x.bill_date)}</td><td>{shortNo(x.bill_no)}</td><td>{x.customer_name}</td><td>{x.doctor_name}</td>
              <td>{x.name}</td><td>{x.schedule}</td><td>{x.batch_no}</td><td>{fmtExpiry(x.expiry_date)}</td><td className="r">{x.qty}</td></tr>)}</tbody>
          </table>
          {!sched.length && <p className="muted">No scheduled medicine sold in these dates.</p>}
        </div>
      </>}
    </div>
  );
}
