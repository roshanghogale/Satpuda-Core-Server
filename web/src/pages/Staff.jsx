import { useEffect, useState } from 'react';
import { api, fmtDate } from '../api.js';

function PermissionSwitches({ all, value, onChange, disabled }) {
  const groups = [...new Set(all.map((p) => p.group))];
  return (
    <div className="perm-grid">
      {groups.map((g) => (
        <div key={g} className="perm-group">
          <b>{g}</b>
          {all.filter((p) => p.group === g).map((p) => (
            <label key={p.key} className="switch">
              <input type="checkbox" disabled={disabled} checked={value.includes(p.key)}
                onChange={(e) => onChange(e.target.checked ? [...value, p.key] : value.filter((k) => k !== p.key))} />
              <span>{p.label}</span>
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Shown once: the password is not kept anywhere readable after this. */
function PasswordOnce({ who, password, onClose }) {
  return (
    <div className="modal-back"><div className="modal narrow">
      <h3>Password for {who}</h3>
      <p>Give this to {who}. It is shown only now; they set their own at first sign-in.</p>
      <div className="pw-once">{password}</div>
      <div className="row end"><button className="btn primary" onClick={onClose}>Done</button></div>
    </div></div>
  );
}

export default function Staff({ me }) {
  const [data, setData] = useState(null);
  const [audit, setAudit] = useState([]);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(null);
  const [once, setOnce] = useState(null);
  const [editing, setEditing] = useState(null);
  const load = () => {
    api('/staff').then(setData).catch((e) => setError(e.message));
    api('/audit?limit=60').then(setAudit).catch(() => {});
  };
  useEffect(load, []);
  const run = async (fn) => { setError(''); try { await fn(); load(); } catch (e) { setError(e.message); } };

  async function add() {
    await run(async () => {
      const out = await api('/staff', { method: 'POST', body: adding });
      setAdding(null);
      setOnce({ who: out.user.username, password: out.password });
    });
  }
  if (!data) return <div className="card">{error || 'Loading…'}</div>;
  return (
    <div>
      <div className="card">
        <div className="row between"><h2>Staff logins</h2>
          <button className="btn primary" onClick={() => setAdding({ username: '', full_name: '', permissions: data.default_staff })}>Add staff</button></div>
        {error && <div className="error">{error}</div>}
        <table className="grid">
          <thead><tr><th>Login ID</th><th>Name</th><th>Role</th><th>Permissions</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>{data.users.map((u) => (
            <tr key={u.id} className={u.is_active ? '' : 'dim'}>
              <td>{u.username}</td><td>{u.full_name}</td><td>{u.role}{u.is_active ? '' : ' (off)'}{u.locked ? ' (locked)' : ''}</td>
              <td className="small">{u.role === 'owner' ? 'everything' : u.permissions.map((k) => data.permissions.find((p) => p.key === k)?.label.split(':')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ')}</td>
              <td className="small">{u.last_login_at ? fmtDate(u.last_login_at) : 'never'}</td>
              <td className="row">{u.role !== 'owner' && <>
                <button className="btn small" onClick={() => setEditing({ ...u })}>Permissions</button>
                <button className="btn small" onClick={() => run(async () => { const out = await api(`/staff/${u.id}/reset-password`, { method: 'POST', body: {} }); setOnce({ who: u.username, password: out.password }); })}>Reset password</button>
                {u.id !== me.user.id && <button className="btn small" onClick={() => run(() => api(`/staff/${u.id}`, { method: 'PATCH', body: { is_active: !u.is_active } }))}>{u.is_active ? 'Switch off' : 'Switch on'}</button>}
                {u.locked && <button className="btn small" onClick={() => run(() => api(`/staff/${u.id}`, { method: 'PATCH', body: { unlock: true } }))}>Unlock</button>}
                {u.id !== me.user.id && <button className="btn small danger" onClick={() => window.confirm(`Delete login ${u.username}? Their old bills keep their name.`) && run(() => api(`/staff/${u.id}`, { method: 'DELETE' }))}>Delete</button>}
              </>}</td>
            </tr>))}</tbody>
        </table>
      </div>
      <div className="card">
        <h3>Who did what (web)</h3>
        <table className="grid compact">
          <tbody>{audit.map((a) => <tr key={a.id}><td className="small">{new Date(a.created_at).toLocaleString('en-IN')}</td><td>{a.username || 'Satpuda support'}</td>
            <td>{a.action}</td><td>{a.ref_no ? String(a.ref_no).split('/FY')[0] : (a.detail?.username || '')}</td></tr>)}</tbody>
        </table>
      </div>
      {adding && (
        <div className="modal-back" onClick={() => setAdding(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>Add staff</h3>
          <div className="grid3">
            <label>Login ID<input value={adding.username} onChange={(e) => setAdding({ ...adding, username: e.target.value })} placeholder="e.g. shopname.ravi" /></label>
            <label>Name<input value={adding.full_name} onChange={(e) => setAdding({ ...adding, full_name: e.target.value })} /></label>
            <label>Password<input value={adding.password || ''} onChange={(e) => setAdding({ ...adding, password: e.target.value })} placeholder="leave empty: make one for me" /></label>
          </div>
          <PermissionSwitches all={data.permissions} value={adding.permissions} onChange={(p) => setAdding({ ...adding, permissions: p })} />
          {error && <div className="error">{error}</div>}
          <div className="row end"><button className="btn" onClick={() => setAdding(null)}>Cancel</button><button className="btn primary" disabled={!adding.username} onClick={add}>Add</button></div>
        </div></div>
      )}
      {editing && (
        <div className="modal-back" onClick={() => setEditing(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>Permissions of {editing.username}</h3>
          <PermissionSwitches all={data.permissions} value={editing.permissions} onChange={(p) => setEditing({ ...editing, permissions: p })} />
          <div className="row end"><button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" onClick={() => run(async () => { await api(`/staff/${editing.id}`, { method: 'PATCH', body: { permissions: editing.permissions } }); setEditing(null); })}>Save</button></div>
        </div></div>
      )}
      {once && <PasswordOnce {...once} onClose={() => setOnce(null)} />}
    </div>
  );
}
