import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Sign-ins for the sales demonstration site.
 *
 * One per sales person, so access is handed out and withdrawn one at a time.
 * The demo itself runs off a recorded, redacted snapshot inside the browser and
 * reaches no shop's data -- this is about who may open it, and who has.
 */

function when(value) {
  if (!value) return 'never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16);
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function DemoLogins() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [resetFor, setResetFor] = useState(null);
  const [newPassword, setNewPassword] = useState('');

  async function load() {
    try {
      const data = await api('/admin/demo-users');
      setRows(data.rows || []);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function run(fn, done) {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      await fn();
      if (done) setMsg(done);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function create(e) {
    e.preventDefault();
    run(
      async () => {
        await api('/admin/demo-users', {
          method: 'POST',
          body: { username, password, name, note },
        });
        setUsername('');
        setPassword('');
        setName('');
        setNote('');
        setShowForm(false);
      },
      `Demo login "${username.trim().toLowerCase()}" created.`,
    );
  }

  function saveNewPassword(e) {
    e.preventDefault();
    const row = resetFor;
    run(
      async () => {
        await api(`/admin/demo-users/${row.id}`, {
          method: 'PATCH',
          body: { password: newPassword },
        });
        setResetFor(null);
        setNewPassword('');
      },
      `New password set for "${row.username}".`,
    );
  }

  function toggle(row) {
    run(
      () => api(`/admin/demo-users/${row.id}`, {
        method: 'PATCH',
        body: { is_active: !row.is_active },
      }),
      row.is_active
        ? `"${row.username}" can no longer open the demo.`
        : `"${row.username}" can open the demo again.`,
    );
  }

  function remove(row) {
    if (!window.confirm(`Delete the demo login "${row.username}"? They will not be able to sign in again.`)) return;
    run(
      () => api(`/admin/demo-users/${row.id}`, { method: 'DELETE' }),
      `Demo login "${row.username}" deleted.`,
    );
  }

  return (
    <>
      <div className="page-title">
        <div>
          <h2>Demo logins</h2>
          <p>Who may open demo.satpudacore.online — one id per sales person</p>
        </div>
        <button className="btn primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'New demo login'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {msg && <div className="panel" style={{ padding: 12, marginBottom: 16 }}>{msg}</div>}

      {showForm && (
        <form className="panel" style={{ padding: 16, marginBottom: 16 }} onSubmit={create}>
          <div className="field">
            <label>Id (what they type to sign in)</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. sagar"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck="false"
              required
            />
          </div>
          <div className="field">
            <label>Password (at least 6 characters)</label>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Tell them this yourself — it is not shown again"
              required
            />
          </div>
          <div className="field">
            <label>Person's name (optional)</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sagar Patil" />
          </div>
          <div className="field">
            <label>Note (optional)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Jalgaon territory" />
          </div>
          <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create demo login'}</button>
        </form>
      )}

      {resetFor && (
        <form className="panel" style={{ padding: 16, marginBottom: 16 }} onSubmit={saveNewPassword}>
          <div className="field">
            <label>New password for “{resetFor.username}”</label>
            <input
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 6 characters"
              required
            />
          </div>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Set password'}</button>{' '}
          <button
            type="button"
            className="btn ghost"
            onClick={() => { setResetFor(null); setNewPassword(''); }}
          >
            Cancel
          </button>
        </form>
      )}

      <div className="panel">
        <div className="panel-b">
          <table>
            <thead>
              <tr>
                <th>Id</th>
                <th>Person</th>
                <th>Status</th>
                <th>Last opened</th>
                <th className="right">Times</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong className="mono">{r.username}</strong>
                    {r.note ? <div className="muted">{r.note}</div> : null}
                  </td>
                  <td>{r.name || '—'}</td>
                  <td>
                    <span className={`badge ${r.is_active ? 'ok' : 'off'}`}>
                      {r.is_active ? 'active' : 'switched off'}
                    </span>
                  </td>
                  <td>{when(r.last_login_at)}</td>
                  <td className="right mono">{r.login_count}</td>
                  <td className="right">
                    <button className="btn sm" disabled={busy} onClick={() => { setResetFor(r); setNewPassword(''); }}>
                      New password
                    </button>{' '}
                    <button className="btn sm" disabled={busy} onClick={() => toggle(r)}>
                      {r.is_active ? 'Switch off' : 'Switch on'}
                    </button>{' '}
                    <button className="btn sm danger" disabled={busy} onClick={() => remove(r)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={6} className="muted">
                    No demo logins yet. Nobody can open the demonstration site until you create one.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
