import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, inr } from '../api.js';

export default function Stores() {
  const [stores, setStores] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setStores(await api('/admin/stores'));
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function createStore(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api('/admin/stores', { method: 'POST', body: { store_name: name } });
      setName('');
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="page-title">
        <div>
          <h2>Stores</h2>
          <p>Create stores and share pairing keys with Mac2 / Android</p>
        </div>
        <button className="btn primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'New store'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {showForm && (
        <form className="panel" style={{ padding: 16, marginBottom: 16 }} onSubmit={createStore}>
          <div className="field">
            <label>Store display name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Roshan Medical" required />
          </div>
          <button className="btn primary" disabled={saving}>{saving ? 'Creating…' : 'Create store'}</button>
        </form>
      )}

      <div className="panel">
        <div className="panel-b">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Pairing key</th>
                <th>Status</th>
                <th className="right">Today</th>
                <th className="right">Devices</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {stores.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.store_name}</strong>
                    <div className="muted mono">{s.store_id}</div>
                  </td>
                  <td className="mono">{s.android_key}</td>
                  <td>
                    <span className={`badge ${s.is_active ? 'ok' : 'off'}`}>
                      {s.is_active ? s.app_mode : 'inactive'}
                    </span>
                  </td>
                  <td className="right mono">{inr(s.today_sales)}</td>
                  <td className="right">{s.device_count}</td>
                  <td className="right"><Link className="btn sm" to={`/stores/${s.store_id}`}>Details</Link></td>
                </tr>
              ))}
              {!stores.length && <tr><td colSpan={6} className="empty">No stores</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
