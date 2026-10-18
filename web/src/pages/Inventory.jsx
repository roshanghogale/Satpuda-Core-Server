import { useEffect, useState } from 'react';
import { api, fmtExpiry, money, qs } from '../api.js';
import { useDebounced } from './common.jsx';

/** Owner's ask (9 Oct 2026): see hidden, out-of-stock and expired medicines when needed. */
/** Strips of a strip medicine (tablets ÷ per strip), else the units themselves. */
function stripsOf(m) {
  const legacy = ['tablet', 'capsule', 'bolus'].includes(String(m.type || '').trim().toLowerCase());
  const per = legacy ? Math.max(1, parseInt(String(m.unit || '1').replace(/^1\s*[x×*]\s*/i, ''), 10) || 1) : 1;
  return Math.round((Number(m.stock_qty || 0) / per) * 100) / 100;
}

const VIEWS = [
  { key: 'active', label: 'Active' },
  { key: 'hidden', label: 'Hidden' },
  { key: 'out_of_stock', label: 'Out of stock' },
  { key: 'expired', label: 'Expired' },
  { key: 'all', label: 'All' },
];

function EditDialog({ med, ws, onClose, onSaved }) {
  const [f, setF] = useState({
    ...(ws ? { rate_a: String(med.rate_a ?? ''), rate_b: String(med.rate_b ?? ''), rate_c: String(med.rate_c ?? '') } : {}),
    name: med.name || '', type: med.type || '', unit: med.unit || '', batch_no: med.batch_no || '', expiry_date: fmtExpiry(med.expiry_date),
    mrp: String(med.mrp ?? ''), rate: String(med.rate ?? ''), gst_percent: String(med.gst_percent ?? ''), hsn_code: med.hsn_code || '',
    schedule: med.schedule || '', manufacturer: med.manufacturer || '', content_drug: med.content_drug || '', location: med.location || '',
    is_hidden: !!med.is_hidden, stock_qty: String(med.stock_qty ?? ''),
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function save() {
    setBusy(true); setError('');
    try {
      const body = { ...f, version: med.version };
      if (String(f.stock_qty) === String(med.stock_qty ?? '')) delete body.stock_qty;
      const out = await api(`/inventory/${med.id}`, { method: 'PUT', body });
      onSaved(out.unchanged ? 'Nothing changed.' : ['Saved.', out.note, out.stock_adjust ? `Stock corrected by ${out.stock_adjust}.` : ''].filter(Boolean).join(' '));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const field = (k, label, props = {}) => <label>{label}<input value={f[k]} onChange={set(k)} {...props} /></label>;
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Edit {med.name}</h3>
        <div className="grid3">
          {field('name', 'Name')}{field('type', 'Type')}{field('unit', 'Pack (tablets/strip)')}
          {field('batch_no', 'Batch')}{field('expiry_date', 'Expiry MM/YY')}{field('stock_qty', 'Stock (correct the count)')}
          {!ws && field('mrp', 'MRP')}{field('rate', ws ? 'Purchase rate /strip' : 'Purchase rate')}{field('gst_percent', 'GST %')}
          {ws && <>{field('rate_a', 'Rate A /strip')}{field('rate_b', 'Rate B /strip')}{field('rate_c', 'Rate C /strip')}</>}
          {field('schedule', 'Schedule (H, H1, X…)')}{field('hsn_code', 'HSN')}{field('manufacturer', 'Company')}
          {field('content_drug', 'Content / drug')}{field('location', 'Rack / location')}
          <label className="check"><input type="checkbox" checked={f.is_hidden} onChange={set('is_hidden')} /> Hidden</label>
        </div>
        <p className="muted small">Name, type, HSN, schedule, company, GST %, batch and expiry also change on this medicine's old bills (a new schedule shows in the schedule register; a new GST % changes old sales' GST split). Rates, MRP and amounts on old bills never change.</p>
        {error && <div className="error">{error}</div>}
        <div className="row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></div>
      </div>
    </div>
  );
}

export default function Inventory({ can, me }) {
  const ws = me?.store_kind === 'wholesale';
  const [rates, setRates] = useState({});
  const [view, setView] = useState('active');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const load = () => api(`/inventory${qs({ view, q: dq })}`).then(async (d) => {
    setData(d); setError('');
    // Wholesale: each batch's Rate A / B / C (the inventory list has no such columns).
    if (ws && d.rows.length && dq.trim().length >= 2) {
      const found = await api(`/medicines/any${qs({ q: dq })}`).catch(() => []);
      setRates(Object.fromEntries(found.map((m) => [m.id, m])));
    }
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, dq]);
  const counts = data?.counts || {};
  // The full medicine (its Rate A / B / C live with it) before editing a wholesale batch.
  async function openEdit(m) {
    if (!ws) { setEdit(m); return; }
    try { setEdit({ ...m, ...(await api(`/inventory/${m.id}`)) }); } catch (e) { setError(e.message); }
  }
  return (
    <div>
      <div className="card">
        <div className="chips">
          {VIEWS.map((v) => (
            <button key={v.key} className={`chip ${view === v.key ? 'on' : ''}`} onClick={() => setView(v.key)}>
              {v.label} <span className="count">{counts[v.key] ?? ''}</span>
            </button>
          ))}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, batch, company" />
        {msg && <div className="okmsg">{msg}</div>}
        {error && <div className="error">{error}</div>}
      </div>
      <div className="card list">
        <table className="grid">
          <thead><tr><th>Medicine</th><th>Batch</th><th>Exp</th><th className="r">Stock</th>
            {ws ? <><th className="r">Strips</th><th className="r">Rate A</th><th className="r">B</th><th className="r">C</th></> : <th className="r">MRP</th>}<th>Sch</th><th>Company</th><th /></tr></thead>
          <tbody>{(data?.rows || []).map((m) => (
            <tr key={m.id} className={m.is_hidden ? 'dim' : ''}>
              <td>{m.name}{m.is_hidden ? <span className="tag">hidden</span> : null}</td><td>{m.batch_no}</td><td>{fmtExpiry(m.expiry_date)}</td>
              <td className={`r ${Number(m.stock_qty) <= 0 ? 'neg' : ''}`}>{m.stock_qty}</td>
              {ws ? <>
                <td className="r">{stripsOf(m)}</td>
                <td className="r">{rates[m.id]?.rate_a ? money(rates[m.id].rate_a) : ''}</td>
                <td className="r">{rates[m.id]?.rate_b ? money(rates[m.id].rate_b) : ''}</td>
                <td className="r">{rates[m.id]?.rate_c ? money(rates[m.id].rate_c) : ''}</td>
              </> : <td className="r">{money(m.mrp)}</td>}
              <td>{m.schedule}</td><td className="small">{m.manufacturer}</td>
              <td>{can('inventory_edit') && <button className="btn small" onClick={() => openEdit(m)}>Edit</button>}</td>
            </tr>))}</tbody>
        </table>
        {data && <p className="muted small">{data.rows.length} shown{data.total != null ? ` of ${data.total}` : ''}.</p>}
      </div>
      {ws && <p className="muted small">Search a name to see each batch's Rate A / B / C. Stock is in units (tablets of a strip type); Strips = stock ÷ tablets per strip.</p>}
      {edit && <EditDialog med={edit} ws={ws} onClose={() => setEdit(null)} onSaved={(m) => { setEdit(null); setMsg(m); load(); }} />}
    </div>
  );
}
