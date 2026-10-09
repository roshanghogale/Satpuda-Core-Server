import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Web logins of one store (phase 5). The admin creates the store OWNER login and staff logins;
 * a generated password is shown ONCE here to hand over (only its hash is kept), and the person
 * sets their own at first sign-in on /web. The owner then manages staff from the web.
 */
export default function WebLogins({ store }) {
  const sid = store.id;
  const [users, setUsers] = useState([]);
  const [perms, setPerms] = useState([]);
  const [defaults, setDefaults] = useState([]);
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(null);
  const [once, setOnce] = useState(null);
  const [audit, setAudit] = useState([]);
  const [error, setError] = useState('');

  async function load() {
    try {
      const [u, p, a] = await Promise.all([
        api(`/admin/stores/${sid}/web-users`),
        api('/admin/web-permissions'),
        api(`/admin/stores/${sid}/web-audit?limit=50`),
      ]);
      setUsers(u); setPerms(p.permissions); setDefaults(p.default_staff); setAudit(a);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, [sid]);

  async function run(fn) {
    setError('');
    try { await fn(); await load(); } catch (e) { setError(e.message); }
  }

  const groups = [...new Set(perms.map((p) => p.group))];
  const switches = (value, onChange) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10, margin: '10px 0' }}>
      {groups.map((g) => (
        <div key={g} style={{ display: 'grid', gap: 4 }}>
          <b style={{ fontSize: '0.8rem' }}>{g}</b>
          {perms.filter((p) => p.group === g).map((p) => (
            <label key={p.key} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.85rem' }}>
              <input type="checkbox" checked={value.includes(p.key)}
                onChange={(e) => onChange(e.target.checked ? [...value, p.key] : value.filter((k) => k !== p.key))} />
              {p.label}
            </label>
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="panel" style={{ padding: 16 }}>
        <div className="panel-h" style={{ padding: '0 0 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Web logins (browser, online only) — shop opens at /web</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm primary" onClick={() => setForm({ role: 'owner', username: '', full_name: '', permissions: [] })}>Add owner login</button>
            <button className="btn sm" onClick={() => setForm({ role: 'staff', username: '', full_name: '', permissions: defaults })}>Add staff login</button>
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        <table>
          <thead><tr><th>Login ID</th><th>Name</th><th>Role</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="mono">{u.username}</td>
                <td>{u.full_name || '—'}</td>
                <td><span className="badge">{u.role}</span></td>
                <td>
                  <span className={`badge ${u.is_active ? 'ok' : 'off'}`}>{u.is_active ? 'on' : 'off'}</span>
                  {u.must_change_password && <span className="badge warn">must set password</span>}
                  {u.locked && <span className="badge warn">locked</span>}
                </td>
                <td>{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'never'}</td>
                <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {u.role === 'staff' && <button className="btn sm" onClick={() => setEditing({ ...u })}>Permissions</button>}
                  <button className="btn sm" onClick={() => run(async () => {
                    const out = await api(`/admin/stores/${sid}/web-users/${u.id}/reset-password`, { method: 'POST', body: {} });
                    setOnce({ who: u.username, password: out.password });
                  })}>Reset password</button>
                  <button className="btn sm" onClick={() => run(() => api(`/admin/stores/${sid}/web-users/${u.id}`, { method: 'PATCH', body: { is_active: !u.is_active } }))}>
                    {u.is_active ? 'Disable' : 'Enable'}
                  </button>
                  {u.locked && <button className="btn sm" onClick={() => run(() => api(`/admin/stores/${sid}/web-users/${u.id}`, { method: 'PATCH', body: { unlock: true } }))}>Unlock</button>}
                  <button className="btn sm danger" onClick={() => window.confirm(`Delete web login ${u.username}?`) &&
                    run(() => api(`/admin/stores/${sid}/web-users/${u.id}`, { method: 'DELETE' }))}>Delete</button>
                </td>
              </tr>
            ))}
            {!users.length && <tr><td colSpan={6} className="empty">No web logins yet. Add the owner login first.</td></tr>}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="panel" style={{ padding: 16 }}>
          <h3>New {form.role} login</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            <div className="field"><label>Login ID (unique across all shops)</label>
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="e.g. roshanmedical.owner" /></div>
            <div className="field"><label>Name</label>
              <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></div>
          </div>
          {form.role === 'staff' ? switches(form.permissions, (p) => setForm({ ...form, permissions: p }))
            : <p className="muted">The owner has every permission and manages staff from the web.</p>}
          <p className="muted">A password is generated and shown once. The person sets their own at first sign-in.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn primary" disabled={!form.username} onClick={() => run(async () => {
              const out = await api(`/admin/stores/${sid}/web-users`, { method: 'POST', body: form });
              setForm(null);
              setOnce({ who: out.user.username, password: out.password });
            })}>Create login</button>
          </div>
        </div>
      )}

      {editing && (
        <div className="panel" style={{ padding: 16 }}>
          <h3>Permissions of {editing.username}</h3>
          {switches(editing.permissions, (p) => setEditing({ ...editing, permissions: p }))}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" onClick={() => run(async () => {
              await api(`/admin/stores/${sid}/web-users/${editing.id}`, { method: 'PATCH', body: { permissions: editing.permissions } });
              setEditing(null);
            })}>Save</button>
          </div>
        </div>
      )}

      {once && (
        <div className="panel" style={{ padding: 16, borderColor: 'var(--warn)' }}>
          <h3>Password for {once.who} — shown only now</h3>
          <div className="mono" style={{ fontSize: '1.4rem', padding: '10px 0', userSelect: 'all' }}>{once.password}</div>
          <p className="muted">Hand it over privately. It is not stored anywhere readable; reset it if it is lost.</p>
          <button className="btn" onClick={() => setOnce(null)}>I have noted it</button>
        </div>
      )}

      <div className="panel">
        <div className="panel-h"><h3>Recent web activity</h3></div>
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Ref</th></tr></thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.id}>
                <td>{new Date(a.created_at).toLocaleString()}</td>
                <td>{a.username || a.detail?.by || '—'}</td>
                <td>{a.action}</td>
                <td className="mono">{a.ref_no || a.detail?.username || ''}</td>
              </tr>
            ))}
            {!audit.length && <tr><td colSpan={4} className="empty">Nothing yet</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
