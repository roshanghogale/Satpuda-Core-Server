import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, inr } from '../api.js';

export default function Overview() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/admin/overview').then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!data) return <p className="muted">Loading overview…</p>;

  return (
    <>
      <div className="page-title">
        <div>
          <h2>Overview</h2>
          <p>All stores on this Satpuda Core server</p>
        </div>
      </div>

      <div className="grid stats">
        <div className="stat">
          <div className="label">Active stores</div>
          <div className="value">{data.active_stores}</div>
        </div>
        <div className="stat">
          <div className="label">Today's bills</div>
          <div className="value">{data.today_bills}</div>
        </div>
        <div className="stat">
          <div className="label">Today's revenue</div>
          <div className="value">{inr(data.today_revenue)}</div>
        </div>
        <div className="stat">
          <div className="label">Medicines</div>
          <div className="value">{data.total_medicines}</div>
        </div>
        <div className="stat">
          <div className="label">Devices</div>
          <div className="value">{data.devices}</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h"><h3>Stores</h3><Link to="/stores" className="btn sm">Manage</Link></div>
        <div className="panel-b">
          <table>
            <thead>
              <tr>
                <th>Store</th>
                <th>Mode</th>
                <th className="right">Today</th>
                <th className="right">Month</th>
                <th className="right">Sales</th>
                <th className="right">Stock SKUs</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(data.stores || []).map((s) => (
                <tr key={s.id}>
                  <td>
                    <div>{s.store_name}</div>
                    <div className="muted mono">{s.store_id}</div>
                  </td>
                  <td>
                    <span className={`badge ${s.is_active ? 'ok' : 'off'}`}>
                      {s.is_active ? s.app_mode : 'inactive'}
                    </span>
                  </td>
                  <td className="right mono">{inr(s.today_sales)}</td>
                  <td className="right mono">{inr(s.month_sales)}</td>
                  <td className="right">{s.sales_count}</td>
                  <td className="right">{s.medicine_count}</td>
                  <td className="right"><Link className="btn sm" to={`/stores/${s.store_id}`}>Open</Link></td>
                </tr>
              ))}
              {!data.stores?.length && (
                <tr><td colSpan={7} className="empty">No stores yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
