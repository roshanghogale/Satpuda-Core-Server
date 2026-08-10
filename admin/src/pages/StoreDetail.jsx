import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, inr } from '../api.js';

const TABS = ['Dashboard', 'Sales', 'Purchases', 'Inventory', 'Customers', 'Suppliers', 'Payments', 'Devices'];

export default function StoreDetail() {
  const { id } = useParams();
  const [tab, setTab] = useState('Dashboard');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const [detail, setDetail] = useState(null);
  const [trend, setTrend] = useState([]);

  async function loadStore() {
    setError('');
    try {
      setData(await api(`/admin/stores/${id}`));
      setTrend(await api(`/admin/stores/${id}/trend?days=30`));
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { loadStore(); }, [id]);

  useEffect(() => {
    if (!data || tab === 'Dashboard' || tab === 'Devices') return;
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        let path;
        if (tab === 'Sales') path = `/admin/stores/${id}/sales?${params}`;
        else if (tab === 'Purchases') path = `/admin/stores/${id}/purchases?${params}`;
        else if (tab === 'Inventory') path = `/admin/stores/${id}/inventory?${params}`;
        else if (tab === 'Customers') path = `/admin/stores/${id}/customers?${params}`;
        else if (tab === 'Suppliers') path = `/admin/stores/${id}/suppliers?${params}`;
        else if (tab === 'Payments') path = `/admin/stores/${id}/payments/customers`;
        if (!path) return;
        const res = await api(path);
        if (!cancelled) { setList(res); setDetail(null); }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [tab, id, q, data]);

  const maxTrend = useMemo(() => Math.max(1, ...trend.map((t) => t.amount || 0)), [trend]);

  async function regenKey() {
    if (!confirm('Regenerate pairing key? Existing devices must re-pair.')) return;
    try {
      const store = await api(`/admin/stores/${id}/regenerate-key`, { method: 'POST' });
      setData((d) => ({ ...d, store }));
    } catch (e) {
      setError(e.message);
    }
  }

  async function openSale(localId) {
    setDetail(await api(`/admin/stores/${id}/sales/${localId}`));
  }

  async function openPurchase(localId) {
    setDetail(await api(`/admin/stores/${id}/purchases/${localId}`));
  }

  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return <p className="muted">Loading store…</p>;

  const { store, profile, devices, dashboard: dash } = data;

  return (
    <>
      <div className="page-title">
        <div>
          <p style={{ margin: 0 }}><Link to="/stores">← Stores</Link></p>
          <h2>{store.store_name}</h2>
          <p className="mono">{store.store_id} · {store.store_key}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className={`badge ${store.is_active ? 'ok' : 'off'}`}>{store.app_mode}</span>
          <button className="btn sm" onClick={loadStore}>Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center' }}>
          <div>
            <div className="muted" style={{ fontSize: '0.78rem', marginBottom: 4 }}>Android / Mac2 pairing key</div>
            <div className="key-box">{store.android_key}</div>
          </div>
          <button className="btn sm" onClick={regenKey}>Regenerate key</button>
          {profile && (
            <div className="muted" style={{ fontSize: '0.85rem' }}>
              GSTIN: {profile.gstin || '—'} · Phone: {profile.phone || '—'}
            </div>
          )}
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => { setTab(t); setQ(''); }}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'Dashboard' && dash && (
        <>
          <div className="grid stats">
            <div className="stat">
              <div className="label">Today sales</div>
              <div className="value">{inr(dash.today.amount)}</div>
              <div className="sub">{dash.today.bills} bills · cash {inr(dash.today.cash)}</div>
            </div>
            <div className="stat">
              <div className="label">Month sales</div>
              <div className="value">{inr(dash.month_sales.amount)}</div>
              <div className="sub">{dash.month_sales.bills} bills</div>
            </div>
            <div className="stat">
              <div className="label">Month purchases</div>
              <div className="value">{inr(dash.month_purchases.amount)}</div>
              <div className="sub">{dash.month_purchases.bills} invoices</div>
            </div>
            <div className="stat">
              <div className="label">Inventory</div>
              <div className="value">{dash.inventory.visible}</div>
              <div className="sub">{dash.inventory.out_of_stock} out of stock</div>
            </div>
            <div className="stat">
              <div className="label">Customer dues</div>
              <div className="value">{inr(dash.dues.customer_due)}</div>
            </div>
            <div className="stat">
              <div className="label">Supplier dues</div>
              <div className="value">{inr(dash.dues.supplier_due)}</div>
            </div>
          </div>

          <div className="grid two">
            <div className="panel">
              <div className="panel-h"><h3>30-day sales</h3></div>
              <div className="spark">
                {trend.map((t) => (
                  <span key={t.date} title={`${t.date}: ${inr(t.amount)}`} style={{ height: `${(t.amount / maxTrend) * 100}%` }} />
                ))}
                {!trend.length && <div className="empty">No sales in range</div>}
              </div>
            </div>
            <div className="panel">
              <div className="panel-h"><h3>Recent sales</h3></div>
              <table>
                <thead><tr><th>Bill</th><th>Customer</th><th className="right">Amount</th></tr></thead>
                <tbody>
                  {(dash.recent_sales || []).map((s) => (
                    <tr key={s.id}>
                      <td className="mono">{s.bill_no?.split('/FY')[0]}</td>
                      <td>{s.customer_name || '—'}</td>
                      <td className="right mono">{inr(s.total_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid two" style={{ marginTop: 14 }}>
            <div className="panel">
              <div className="panel-h"><h3>Low stock</h3></div>
              <table>
                <thead><tr><th>Medicine</th><th>Batch</th><th className="right">Qty</th></tr></thead>
                <tbody>
                  {(dash.low_stock || []).map((m) => (
                    <tr key={m.id}><td>{m.name}</td><td className="mono">{m.batch_no || '—'}</td><td className="right">{m.stock_qty}</td></tr>
                  ))}
                  {!dash.low_stock?.length && <tr><td colSpan={3} className="empty">None</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="panel">
              <div className="panel-h"><h3>Expiring (90d)</h3></div>
              <table>
                <thead><tr><th>Medicine</th><th>Batch</th><th>Expiry</th></tr></thead>
                <tbody>
                  {(dash.expiring || []).map((m) => (
                    <tr key={m.id}><td>{m.name}</td><td className="mono">{m.batch_no || '—'}</td><td>{fmtDate(m.expiry_date)}</td></tr>
                  ))}
                  {!dash.expiring?.length && <tr><td colSpan={3} className="empty">None</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {['Sales', 'Purchases', 'Inventory', 'Customers', 'Suppliers', 'Payments'].includes(tab) && (
        <>
          {tab !== 'Payments' && (
            <div className="toolbar">
              <input placeholder={`Search ${tab.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}

          {detail && (
            <div className="panel" style={{ marginBottom: 14 }}>
              <div className="panel-h">
                <h3>
                  {detail.bill_no || detail.purchase_no} — {inr(detail.total_amount ?? detail.final_amount)}
                </h3>
                <button className="btn sm" onClick={() => setDetail(null)}>Close</button>
              </div>
              <table>
                <thead>
                  <tr><th>Item</th><th>Batch</th><th className="right">Qty</th><th className="right">Rate</th><th className="right">Amount</th></tr>
                </thead>
                <tbody>
                  {(detail.items || []).map((it, i) => (
                    <tr key={i}>
                      <td>{it.name || `#${it.medicine_id}`}</td>
                      <td className="mono">{it.batch_no || '—'}</td>
                      <td className="right">{it.qty}</td>
                      <td className="right mono">{Number(it.rate).toFixed(2)}</td>
                      <td className="right mono">{Number(it.amount ?? it.item_amount).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="panel">
            <div className="panel-b">
              {tab === 'Sales' && (
                <table>
                  <thead><tr><th>Bill</th><th>Date</th><th>Customer</th><th className="right">Total</th><th className="right">Paid</th><th className="right">Due</th><th></th></tr></thead>
                  <tbody>
                    {(list?.rows || []).map((s) => (
                      <tr key={s.id}>
                        <td className="mono">{s.bill_no?.split('/FY')[0]}</td>
                        <td>{fmtDate(s.bill_date)}</td>
                        <td>{s.customer_name || '—'}</td>
                        <td className="right mono">{inr(s.total_amount)}</td>
                        <td className="right mono">{inr(s.amount_paid)}</td>
                        <td className="right mono">{inr(s.due_amount)}</td>
                        <td className="right"><button className="btn sm" onClick={() => openSale(s.id)}>View</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {tab === 'Purchases' && (
                <table>
                  <thead><tr><th>No</th><th>Date</th><th>Supplier</th><th>Invoice</th><th className="right">Amount</th><th></th></tr></thead>
                  <tbody>
                    {(list?.rows || []).map((p) => (
                      <tr key={p.id}>
                        <td className="mono">{p.purchase_no?.split('/FY')[0]}</td>
                        <td>{fmtDate(p.purchase_date)}</td>
                        <td>{p.supplier_name || '—'}</td>
                        <td>{p.bill_number || '—'}</td>
                        <td className="right mono">{inr(p.final_amount)}</td>
                        <td className="right"><button className="btn sm" onClick={() => openPurchase(p.id)}>View</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {tab === 'Inventory' && (
                <table>
                  <thead><tr><th>Name</th><th>Type</th><th>Batch</th><th className="right">Stock</th><th className="right">MRP</th><th>Expiry</th></tr></thead>
                  <tbody>
                    {(list?.rows || []).map((m) => (
                      <tr key={m.id}>
                        <td>{m.name}</td>
                        <td>{m.type || '—'}</td>
                        <td className="mono">{m.batch_no || '—'}</td>
                        <td className="right">{m.stock_qty}</td>
                        <td className="right mono">{m.mrp != null ? Number(m.mrp).toFixed(2) : '—'}</td>
                        <td>{fmtDate(m.expiry_date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {tab === 'Customers' && (
                <table>
                  <thead><tr><th>Name</th><th>Phone</th><th>Address</th><th className="right">Due</th><th className="right">Credit</th></tr></thead>
                  <tbody>
                    {(list?.rows || []).map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td className="mono">{c.phone || '—'}</td>
                        <td>{c.address || '—'}</td>
                        <td className="right mono">{inr(c.total_due)}</td>
                        <td className="right mono">{inr(c.total_credit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {tab === 'Suppliers' && (
                <table>
                  <thead><tr><th>Name</th><th>Phone</th><th>GSTIN</th><th className="right">Due</th></tr></thead>
                  <tbody>
                    {(list?.rows || []).map((s) => (
                      <tr key={s.id}>
                        <td>{s.name}</td>
                        <td className="mono">{s.phone || '—'}</td>
                        <td className="mono">{s.gstin || '—'}</td>
                        <td className="right mono">{inr(s.total_due)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {tab === 'Payments' && (
                <table>
                  <thead><tr><th>Date</th><th>Customer</th><th>Mode</th><th className="right">Amount</th></tr></thead>
                  <tbody>
                    {(list?.rows || []).map((p) => (
                      <tr key={p.id}>
                        <td>{fmtDate(p.payment_date)}</td>
                        <td>{p.customer_name || `#${p.customer_id}`}</td>
                        <td>{p.payment_mode}</td>
                        <td className="right mono">{inr(p.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {!list?.rows?.length && <div className="empty">No records</div>}
            </div>
          </div>
        </>
      )}

      {tab === 'Devices' && (
        <div className="panel">
          <table>
            <thead><tr><th>Device ID</th><th>Name</th><th>Type</th><th>Last seen</th></tr></thead>
            <tbody>
              {(devices || []).map((d) => (
                <tr key={d.device_id}>
                  <td className="mono">{d.device_id}</td>
                  <td>{d.device_name || '—'}</td>
                  <td><span className="badge">{d.device_type}</span></td>
                  <td>{d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : '—'}</td>
                </tr>
              ))}
              {!devices?.length && <tr><td colSpan={4} className="empty">No devices paired yet</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
