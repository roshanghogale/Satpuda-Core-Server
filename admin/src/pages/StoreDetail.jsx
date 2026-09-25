import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, inr } from '../api.js';

const TABS = ['Dashboard', 'Sales', 'Purchases', 'Inventory', 'Customers', 'Suppliers', 'Doctors', 'Payments', 'Returns', 'Settings', 'Devices', 'Sync'];

function parseMaybeJson(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  const raw = String(value).trim();
  if (!raw.startsWith('{') && !raw.startsWith('[')) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function FieldGrid({ rows }) {
  return (
    <div className="settings-fields">
      {rows.map(([label, val]) => (
        <div key={label} className="settings-field">
          <div className="muted settings-field-label">{label}</div>
          <div className="settings-field-value">{val == null || val === '' ? '—' : String(val)}</div>
        </div>
      ))}
    </div>
  );
}

function ChipList({ items }) {
  const list = Array.isArray(items) ? items.filter((x) => x != null && String(x).trim() !== '') : [];
  if (!list.length) return <span className="muted">—</span>;
  return (
    <div className="chip-row">
      {list.map((item) => (
        <span key={String(item)} className="chip">{String(item)}</span>
      ))}
    </div>
  );
}

const VOICE_TIER_OPTIONS = [
  ['auto', 'Auto'],
  ['1', '1 Basic'],
  ['2', '2 Advanced'],
  ['3', '3 Full'],
];

function normVoiceTier(value) {
  const t = String(value ?? '').trim().toLowerCase();
  return VOICE_TIER_OPTIONS.some(([v]) => v === t) ? t : 'auto';
}

function AccessControlPanel({ store, onSave }) {
  const [isActive, setIsActive] = useState(Boolean(store.is_active));
  const [applyExpiry, setApplyExpiry] = useState(store.apply_expiry_check !== false);
  const [expiryEnabled, setExpiryEnabled] = useState(Boolean(store.expiry_enabled));
  const [expiryDate, setExpiryDate] = useState(
    store.expiry_date ? String(store.expiry_date).slice(0, 10) : '',
  );
  const [activationDate, setActivationDate] = useState(
    store.activation_date ? String(store.activation_date).slice(0, 10) : '',
  );
  const [voiceEnabled, setVoiceEnabled] = useState(store.voice_enabled === true);
  const [voiceTier, setVoiceTier] = useState(normVoiceTier(store.voice_tier));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setVoiceEnabled(store.voice_enabled === true);
    setVoiceTier(normVoiceTier(store.voice_tier));
    setIsActive(Boolean(store.is_active));
    setApplyExpiry(store.apply_expiry_check !== false);
    setExpiryEnabled(Boolean(store.expiry_enabled));
    setExpiryDate(store.expiry_date ? String(store.expiry_date).slice(0, 10) : '');
    setActivationDate(store.activation_date ? String(store.activation_date).slice(0, 10) : '');
  }, [store]);

  async function save() {
    setSaving(true);
    setMsg('');
    try {
      await onSave({
        is_active: isActive,
        apply_expiry_check: applyExpiry,
        expiry_enabled: expiryEnabled,
        expiry_date: expiryDate || null,
        activation_date: activationDate || null,
        voice_enabled: voiceEnabled,
        voice_tier: voiceTier,
      });
      setMsg('Access settings saved. Online devices use this immediately.');
    } catch (e) {
      setMsg(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
      <div className="panel-h" style={{ padding: '0 0 12px' }}>
        <h3 style={{ margin: 0 }}>Access &amp; license</h3>
        <span className={`badge ${store.is_active ? 'ok' : 'off'}`}>
          {store.is_active ? 'Access ON' : 'Access OFF'}
        </span>
      </div>
      <div className="settings-fields" style={{ marginBottom: 12 }}>
        <div className="settings-field">
          <div className="muted settings-field-label">Activation date</div>
          <input
            type="date"
            value={activationDate}
            onChange={(e) => setActivationDate(e.target.value)}
            style={{
              background: 'var(--bg2)',
              border: '1px solid var(--line)',
              color: 'var(--text)',
              padding: '8px 10px',
              borderRadius: 8,
              width: '100%',
            }}
          />
          <div className="muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>
            Separate from expiry — set for old stores if missing
          </div>
        </div>
        <div className="settings-field">
          <div className="muted settings-field-label">Turn off access</div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            Store active (uncheck to block Online PC / Android)
          </label>
        </div>
        <div className="settings-field">
          <div className="muted settings-field-label">Apply expiry check</div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={applyExpiry}
              onChange={(e) => setApplyExpiry(e.target.checked)}
            />
            Enforce expiry date from server
          </label>
        </div>
        <div className="settings-field">
          <div className="muted settings-field-label">Expiry enabled</div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={expiryEnabled}
              onChange={(e) => setExpiryEnabled(e.target.checked)}
            />
            Expiry date is active
          </label>
        </div>
        <div className="settings-field">
          <div className="muted settings-field-label">Expiry date</div>
          <input
            type="date"
            className="settings-input"
            value={expiryDate}
            onChange={(e) => setExpiryDate(e.target.value)}
            style={{
              background: 'var(--bg2)',
              border: '1px solid var(--line)',
              color: 'var(--text)',
              padding: '8px 10px',
              borderRadius: 8,
              width: '100%',
            }}
          />
        </div>
        <div className="settings-field">
          <div className="muted settings-field-label">Voice assistant</div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={voiceEnabled}
              onChange={(e) => setVoiceEnabled(e.target.checked)}
            />
            Voice assistant on
          </label>
        </div>
        <div className="settings-field">
          <div className="muted settings-field-label">Voice level</div>
          <select
            value={voiceTier}
            onChange={(e) => setVoiceTier(e.target.value)}
            disabled={!voiceEnabled}
            style={{
              background: 'var(--bg2)',
              border: '1px solid var(--line)',
              color: 'var(--text)',
              padding: '8px 10px',
              borderRadius: 8,
              width: '100%',
            }}
          >
            {VOICE_TIER_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="muted" style={{ fontSize: '0.78rem', margin: '-4px 0 12px' }}>
        Off = the shop's app shows no voice button. Level caps what the shop PC runs
        (1 = wake word + your-voice check, 2 = + small local AI, 3 = + large AI and better hearing).
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn sm" disabled={saving} onClick={save}>
          {saving ? 'Saving…' : 'Save access settings'}
        </button>
        {msg && <span className="muted" style={{ fontSize: '0.85rem' }}>{msg}</span>}
      </div>
    </div>
  );
}

function SettingsView({ list }) {
  const profile = list.profile || null;
  const dropdowns = list.dropdowns || null;
  const shelf = list.shelf_settings || null;
  const settings = list.settings || [];

  const billingPref = useMemo(() => {
    const row = settings.find((s) => s.name === 'billing_layout_prefs');
    if (!row) return null;
    return parseMaybeJson(row.value);
  }, [settings]);

  const otherKv = settings.filter((s) => s.name !== 'billing_layout_prefs');

  return (
    <div style={{ padding: 16, display: 'grid', gap: 16 }}>
      <section>
        <div className="panel-h" style={{ padding: '0 0 10px' }}>
          <h3 style={{ margin: 0 }}>Pharmacy profile</h3>
          {profile && (
            <span className="muted mono" style={{ fontSize: '0.78rem' }}>
              v{profile.version ?? 1}
              {profile.updated_at ? ` · ${new Date(profile.updated_at).toLocaleString()}` : ''}
            </span>
          )}
        </div>
        {profile ? (
          <FieldGrid
            rows={[
              ['Name', profile.name],
              ['Address', profile.address],
              ['Phone', profile.phone],
              ['Email', profile.email],
              ['GSTIN', profile.gstin],
              ['DL number', profile.dl_number],
              ['GST enabled', profile.gst_enabled == null ? '—' : (profile.gst_enabled ? 'Yes' : 'No')],
              ['Device', profile.device_id],
            ]}
          />
        ) : (
          <div className="empty">No pharmacy profile synced</div>
        )}
      </section>

      <section>
        <div className="panel-h" style={{ padding: '0 0 10px' }}>
          <h3 style={{ margin: 0 }}>Dropdowns / lists</h3>
          {dropdowns?.updated_at && (
            <span className="muted mono" style={{ fontSize: '0.78rem' }}>
              {new Date(dropdowns.updated_at).toLocaleString()}
            </span>
          )}
        </div>
        {dropdowns ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <div className="muted settings-field-label">Villages</div>
              <ChipList items={dropdowns.villages} />
              <div className="muted" style={{ marginTop: 6, fontSize: '0.8rem' }}>
                Default: {dropdowns.default_village || '—'}
              </div>
            </div>
            <div>
              <div className="muted settings-field-label">Medicine types</div>
              <ChipList items={dropdowns.med_types} />
            </div>
            <div>
              <div className="muted settings-field-label">Schedules</div>
              <ChipList items={dropdowns.schedules} />
            </div>
          </div>
        ) : (
          <div className="empty">No dropdowns synced</div>
        )}
      </section>

      <section>
        <div className="panel-h" style={{ padding: '0 0 10px' }}>
          <h3 style={{ margin: 0 }}>Shelf settings</h3>
          {shelf && (
            <span className="muted mono" style={{ fontSize: '0.78rem' }}>
              v{shelf.version ?? 1}
              {shelf.updated_at ? ` · ${new Date(shelf.updated_at).toLocaleString()}` : ''}
            </span>
          )}
        </div>
        {shelf ? (
          <FieldGrid
            rows={[
              ['Show location on sales', shelf.show_location ? 'Yes' : 'No'],
              ['Device', shelf.device_id],
            ]}
          />
        ) : (
          <div className="empty">No shelf settings</div>
        )}
      </section>

      <section>
        <div className="panel-h" style={{ padding: '0 0 10px' }}>
          <h3 style={{ margin: 0 }}>Billing layout &amp; FY (Mac2)</h3>
          {billingPref?.updated_at && (
            <span className="muted mono" style={{ fontSize: '0.78rem' }}>
              v{billingPref.version ?? 1} · {new Date(billingPref.updated_at).toLocaleString()}
            </span>
          )}
        </div>
        {billingPref ? (
          <FieldGrid
            rows={[
              ['History scope', billingPref.history_scope],
              ['Payment mode enabled', billingPref.payment_mode_enabled ? 'Yes' : 'No'],
              ['Payment position', billingPref.payment_mode_position],
              ['Item discount mode', billingPref.item_discount_mode],
              ['Show margin column', billingPref.billing_show_margin_column ? 'Yes' : 'No'],
              ['Show total margin', billingPref.billing_show_total_margin ? 'Yes' : 'No'],
              ['Margin loss warning', billingPref.billing_margin_loss_warning ? 'Yes' : 'No'],
            ]}
          />
        ) : (
          <div className="empty">Not synced yet (saved from Mac2 Online)</div>
        )}
      </section>

      <section>
        <div className="panel-h" style={{ padding: '0 0 10px' }}>
          <h3 style={{ margin: 0 }}>Other settings (KV)</h3>
        </div>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {otherKv.map((s) => {
              const parsed = parseMaybeJson(s.value);
              return (
                <tr key={s.name}>
                  <td className="mono">{s.name}</td>
                  <td>
                    {parsed ? (
                      <details>
                        <summary className="muted">JSON object</summary>
                        <pre className="mono settings-json">{JSON.stringify(parsed, null, 2)}</pre>
                      </details>
                    ) : (
                      <span className="mono" style={{ wordBreak: 'break-word' }}>{s.value || '—'}</span>
                    )}
                  </td>
                  <td className="muted">{s.updated_at ? new Date(s.updated_at).toLocaleString() : '—'}</td>
                </tr>
              );
            })}
            {!otherKv.length && (
              <tr><td colSpan={3} className="empty">No other KV settings</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

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
    if (!data || tab === 'Dashboard' || tab === 'Devices' || tab === 'Sync') return;
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
        else if (tab === 'Doctors') path = `/admin/stores/${id}/doctors?${params}`;
        else if (tab === 'Payments') path = `/admin/stores/${id}/payments/customers`;
        else if (tab === 'Returns') path = `/admin/stores/${id}/returns/sales`;
        else if (tab === 'Settings') path = `/admin/stores/${id}/settings`;
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

  async function saveAccess(patch) {
    setError('');
    const store = await api(`/admin/stores/${id}`, { method: 'PATCH', body: patch });
    setData((d) => ({ ...d, store }));
    return store;
  }

  async function openSale(localId) {
    setDetail(await api(`/admin/stores/${id}/sales/${localId}`));
  }

  async function openPurchase(localId) {
    setDetail(await api(`/admin/stores/${id}/purchases/${localId}`));
  }

  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return <p className="muted">Loading store…</p>;

  const { store, profile, devices, dashboard: dash, sync } = data;

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

      <AccessControlPanel store={store} onSave={saveAccess} />

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

      {['Sales', 'Purchases', 'Inventory', 'Customers', 'Suppliers', 'Doctors', 'Payments', 'Returns', 'Settings'].includes(tab) && (
        <>
          {['Sales', 'Purchases', 'Inventory', 'Customers', 'Suppliers', 'Doctors'].includes(tab) && (
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
              {tab === 'Doctors' && (
                <table>
                  <thead><tr><th>Name</th><th>Phone</th><th>Reg. No</th></tr></thead>
                  <tbody>
                    {(list?.rows || []).map((d) => (
                      <tr key={d.id}>
                        <td>{d.name}</td>
                        <td className="mono">{d.phone || '—'}</td>
                        <td className="mono">{d.registration_number || '—'}</td>
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
              {tab === 'Returns' && (
                <table>
                  <thead><tr><th>Return No</th><th>Bill</th><th>Customer</th><th>Date</th><th className="right">Refund</th></tr></thead>
                  <tbody>
                    {(list?.rows || []).map((r) => (
                      <tr key={r.id}>
                        <td className="mono">{r.return_no}</td>
                        <td className="mono">{r.bill_no || '—'}</td>
                        <td>{r.customer_name || '—'}</td>
                        <td>{fmtDate(r.return_date)}</td>
                        <td className="right mono">{inr(r.refund_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {tab === 'Settings' && list && (
                <SettingsView list={list} />
              )}
              {tab !== 'Settings' && !list?.rows?.length && <div className="empty">No records</div>}
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

      {tab === 'Sync' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="panel" style={{ padding: 16 }}>
            <div className="panel-h" style={{ padding: '0 0 12px' }}>
              <h3 style={{ margin: 0 }}>Revision sync</h3>
              <button className="btn sm" onClick={loadStore}>Refresh</button>
            </div>
            <FieldGrid
              rows={[
                ['Head revision', sync?.head_revision ?? '—'],
                ['Head updated', sync?.head_updated_at ? new Date(sync.head_updated_at).toLocaleString() : '—'],
                ['Devices tracked', (sync?.devices || []).length],
              ]}
            />
          </div>

          <div className="panel">
            <div className="panel-h"><h3 style={{ margin: 0 }}>Device lag</h3></div>
            <table>
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Type</th>
                  <th>Last ack</th>
                  <th>Lag (rev)</th>
                  <th>Last seen</th>
                  <th>Lag (sec)</th>
                </tr>
              </thead>
              <tbody>
                {(sync?.devices || []).map((d) => (
                  <tr key={d.device_id}>
                    <td>
                      <div>{d.device_name || '—'}</div>
                      <div className="mono muted" style={{ fontSize: '0.75rem' }}>{d.device_id}</div>
                    </td>
                    <td><span className="badge">{d.device_type || '—'}</span></td>
                    <td className="mono">{d.last_ack_revision}</td>
                    <td className="mono">{d.lag_revisions}</td>
                    <td>{d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : '—'}</td>
                    <td className="mono">{d.lag_seconds == null ? '—' : d.lag_seconds}</td>
                  </tr>
                ))}
                {!(sync?.devices || []).length && (
                  <tr><td colSpan={6} className="empty">No devices paired yet</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <div className="panel-h"><h3 style={{ margin: 0 }}>Last 50 sync_changes</h3></div>
            <table>
              <thead>
                <tr>
                  <th>Rev</th>
                  <th>Collection</th>
                  <th>Local ID</th>
                  <th>Op</th>
                  <th>Device</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {(sync?.recent_changes || []).map((c) => (
                  <tr key={c.revision}>
                    <td className="mono">{c.revision}</td>
                    <td>{c.collection}</td>
                    <td className="mono">{c.local_id}</td>
                    <td><span className="badge">{c.operation}</span></td>
                    <td className="mono" style={{ fontSize: '0.75rem' }}>{c.device_id || '—'}</td>
                    <td>{c.created_at ? new Date(c.created_at).toLocaleString() : '—'}</td>
                  </tr>
                ))}
                {!(sync?.recent_changes || []).length && (
                  <tr><td colSpan={6} className="empty">No sync changes yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
