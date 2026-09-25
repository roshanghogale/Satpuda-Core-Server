import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, inr } from '../api.js';

export default function Stores() {
  const [stores, setStores] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [trialsOnly, setTrialsOnly] = useState(false);
  const [busy, setBusy] = useState(0);

  async function load() {
    try {
      setStores(await api('/admin/stores'));
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { load(); }, []);

  /** One click. The kill switch the owner asked for, on the row itself. */
  async function setActive(store, active) {
    setBusy(store.id);
    setError('');
    try {
      await api(`/admin/stores/${store.store_id}`, { method: 'PATCH', body: { is_active: active } });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(0);
    }
  }

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

  const shown = trialsOnly ? stores.filter((s) => s.provisioned_trial) : stores;

  return (
    <>
      <div className="page-title">
        <div>
          <h2>Stores</h2>
          <p>Create stores and share pairing keys with Mac2 / Android</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.85rem' }}>
            <input
              type="checkbox"
              checked={trialsOnly}
              onChange={(e) => setTrialsOnly(e.target.checked)}
            />
            Trials only
          </label>
          <button className="btn primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : 'New store'}
          </button>
        </div>
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
                <th>Licence</th>
                <th className="right">Today</th>
                <th className="right">Devices</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.store_name}</strong>
                    {s.provisioned_trial && (
                      <span className="badge" style={{ marginLeft: 8 }}>TRIAL</span>
                    )}
                    <div className="muted mono">{s.store_id}</div>
                    {s.provisioned_trial && s.trial_device_id && (
                      <div className="muted mono" style={{ fontSize: '0.7rem' }}>
                        installer · {s.trial_ip || 'no address'}
                      </div>
                    )}
                  </td>
                  <td className="mono">{s.android_key}</td>
                  <td>
                    <span className={`badge ${s.is_active ? 'ok' : 'off'}`}>
                      {s.is_active ? s.app_mode : 'OFF'}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: '0.78rem' }}>
                    {s.expiry_enabled && s.expiry_date
                      ? (Number(s.days_left) > 0
                          ? `${s.days_left}d left`
                          : 'expired')
                      : 'no expiry'}
                  </td>
                  <td className="right mono">{inr(s.today_sales)}</td>
                  <td className="right">{s.device_count}</td>
                  <td className="right" style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="btn sm"
                      disabled={busy === s.id}
                      onClick={() => setActive(s, !s.is_active)}
                    >
                      {busy === s.id ? '…' : (s.is_active ? 'Turn off' : 'Turn on')}
                    </button>
                    {' '}
                    <Link className="btn sm" to={`/stores/${s.store_id}`}>Details</Link>
                  </td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={7} className="empty">No stores</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
