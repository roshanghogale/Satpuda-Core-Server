import { useEffect, useState } from 'react';
import { api, fmtDate } from '../api.js';

export default function MasterMedicines() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [stores, setStores] = useState([]);
  const [storePk, setStorePk] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setMsg('');
    try {
      const data = await api(`/admin/master-medicines?q=${encodeURIComponent(q)}&limit=200`);
      setRows(data.docs || []);
      setTotal(data.total || 0);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    api('/admin/stores')
      .then((list) => setStores(Array.isArray(list) ? list : list?.stores || []))
      .catch(() => {});
  }, []);

  async function mergeStore() {
    if (!storePk) return;
    setBusy(true);
    setMsg('');
    try {
      const r = await api(`/admin/master-medicines/merge-from-store/${storePk}`, {
        method: 'POST',
        body: {},
      });
      setMsg(
        `Merged ${r.source_names || 0} inventory names → upserted ${r.upserted || 0}, ` +
          `skipped ${r.skipped || 0}. Global total ${Number(r.global_count || 0).toLocaleString()}.`,
      );
      await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function migrateScoped() {
    setBusy(true);
    setMsg('');
    try {
      const r = await api('/admin/master-medicines/migrate-store-scoped', {
        method: 'POST',
        body: {},
      });
      setMsg(`Migrated store-scoped rows: upserted ${r.upserted || r.migrated || 0}`);
      await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function exportJson() {
    setBusy(true);
    setMsg('');
    try {
      const data = await api('/admin/master-medicines/export');
      const blob = new Blob([JSON.stringify(data.docs || [], null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `medicines_master_global_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg(`Exported ${(data.count || 0).toLocaleString()} rows`);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Global master medicines</h2>
          <p className="muted">
            One shared catalog for every store/device in Online mode. Business Push/Pull never
            touches this table. Devices search it live (alphabetical prefix) and can download a
            local snapshot for Offline.
          </p>
        </div>
        <div className="muted" style={{ fontSize: 18, fontWeight: 600 }}>
          {total.toLocaleString()} medicines
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
          <div className="field" style={{ minWidth: 220 }}>
            <label>Search catalog</label>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
              placeholder="Medicine name"
            />
          </div>
          <button className="btn" disabled={busy} onClick={load}>
            Search
          </button>
          <button className="btn ghost" disabled={busy} onClick={exportJson}>
            Export JSON
          </button>
          <div className="field" style={{ minWidth: 260 }}>
            <label>Merge store inventory → global</label>
            <select value={storePk} onChange={(e) => setStorePk(e.target.value)}>
              <option value="">Select store…</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.store_name || s.store_key} (#{s.id})
                </option>
              ))}
            </select>
          </div>
          <button className="btn primary" disabled={busy || !storePk} onClick={mergeStore}>
            Merge into global
          </button>
          <button className="btn ghost" disabled={busy} onClick={migrateScoped}>
            Migrate old store-scoped rows
          </button>
        </div>
        {msg && (
          <p className="muted" style={{ marginTop: 12 }}>
            {msg}
          </p>
        )}
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Schedule</th>
              <th>HSN</th>
              <th>GST</th>
              <th>MRP</th>
              <th>Ver</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.med_type || '—'}</td>
                <td>{r.schedule || '—'}</td>
                <td>{r.hsn_code || '—'}</td>
                <td>{r.gst_percent ?? '—'}</td>
                <td>{r.mrp ?? '—'}</td>
                <td>{r.version}</td>
                <td>{fmtDate(r.updated_at)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={8} className="muted">
                  No rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
