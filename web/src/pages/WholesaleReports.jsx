import { useEffect, useState } from 'react';
import { api, money, monthStartIso, qs, todayIso } from '../api.js';
import { printNow, useDebounced } from './common.jsx';
import { ReportSections, reportCsv } from './wholesale.jsx';

/**
 * Reports of the wholesale store (owner, 18 Oct 2026; core/wholesale_reports.py): the sales
 * register (invoice, party, GSTIN, taxable, CGST / SGST / IGST, total, due date, paid, balance),
 * party-wise and item-wise sales, outstanding with ageing from the due dates, and the price list
 * (Rate A / B / C). What a bill still owes is the dues rule itself.
 */
const REPORTS = [
  { key: 'register', label: 'Sales register' },
  { key: 'outstanding', label: 'Outstanding & ageing' },
  { key: 'party', label: 'Party-wise sales' },
  { key: 'items', label: 'Item-wise sales' },
  { key: 'price_list', label: 'Price list' },
];

export default function WholesaleReports({ me }) {
  const [report, setReport] = useState('register');
  const [from, setFrom] = useState(monthStartIso());
  const [to, setTo] = useState(todayIso());
  const [asOf, setAsOf] = useState(todayIso());
  const [partyId, setPartyId] = useState('');
  const [tier, setTier] = useState('');
  const [inStock, setInStock] = useState(true);
  const [search, setSearch] = useState('');
  const [parties, setParties] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/wholesale/reports/parties').then(setParties).catch(() => {}); }, []);
  const params = { from, to, as_of: asOf, party_id: partyId, tier, in_stock: inStock ? '1' : '0', search };
  const key = useDebounced(JSON.stringify({ report, ...params }), 400);
  useEffect(() => {
    let live = true;
    setData(null); setError('');
    const p = JSON.parse(key);
    const { report: r, ...q } = p;
    api(`/wholesale/reports/${r}${qs(q)}`).then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [key]);
  const dated = ['register', 'party', 'items'].includes(report);
  const byParty = ['register', 'items', 'outstanding'].includes(report);
  const t = data?.totals || {};
  return (
    <div>
      <div className="card no-print">
        <div className="chips">
          {REPORTS.map((r) => <button key={r.key} className={`chip ${report === r.key ? 'on' : ''}`} onClick={() => setReport(r.key)}>{r.label}</button>)}
        </div>
        <div className="row wrap">
          {dated && <>
            <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </>}
          {report === 'outstanding' && <label>As on<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>}
          {byParty && <label>Party<select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">All parties</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>}
          {report === 'price_list' && <>
            <label>Rates<select value={tier} onChange={(e) => setTier(e.target.value)}>
              <option value="">All (purchase, A, B, C)</option><option value="A">Rate A list</option><option value="B">Rate B list</option><option value="C">Rate C list</option>
            </select></label>
            <label className="grow">Search<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Medicine name" /></label>
            <label className="check"><input type="checkbox" checked={inStock} onChange={(e) => setInStock(e.target.checked)} /> In stock only</label>
          </>}
          <button className="btn" disabled={!data} onClick={printNow}>Print</button>
          <button className="btn" disabled={!data} onClick={() => reportCsv(data)}>CSV</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="muted">Reading…</div>}
      {data && (
        <div className="card">
          <h2>{me.profile?.name || me.store_name} · {data.title} <span className="muted small">{data.subtitle}</span></h2>
          {report === 'register' && <div className="tiles">
            <div><span>Invoices</span><b>{data.count}</b></div>
            <div><span>Taxable</span><b>₹ {money(t.taxable)}</b></div>
            <div><span>CGST</span><b>₹ {money(t.cgst)}</b></div>
            <div><span>SGST</span><b>₹ {money(t.sgst)}</b></div>
            <div><span>IGST</span><b>₹ {money(t.igst)}</b></div>
            <div><span>Total</span><b>₹ {money(t.total)}</b></div>
            <div><span>Balance</span><b>₹ {money(t.balance)}</b></div>
          </div>}
          {report === 'outstanding' && <div className="tiles">
            <div><span>Parties</span><b>{data.count}</b></div>
            <div><span>Balance</span><b>₹ {money(t.balance)}</b></div>
            {['Not Due', 'Due 0-30', 'Due 31-60', 'Due 61-90', 'Due 90+'].map((b) => <div key={b}><span>{b}</span><b>₹ {money(t[b])}</b></div>)}
            <div><span>Limit crossed</span><b>{t.crossed}</b></div>
          </div>}
          {report === 'price_list' && data.without_rate > 0 && <p className="warn small">{data.without_rate} batch(es) have no {data.tier ? `Rate ${data.tier}` : 'Rate A'}.</p>}
          <ReportSections report={data} />
        </div>
      )}
    </div>
  );
}
