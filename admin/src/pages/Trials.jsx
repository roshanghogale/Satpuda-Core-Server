import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../api.js';

/**
 * Every store that was created by the installer rather than by you.
 *
 * /api/provision/trial is public — it has to be, since the installer calls it
 * with nothing but a shop name — so this page is where the owner sees what came
 * through it: what was typed, from which computer and address, whether the shop
 * actually started billing, and how long it has left. One click turns any of
 * them off.
 */
function daysLeftLabel(row) {
  if (!row.store_pk) return { text: 'store deleted', cls: 'off' };
  if (!row.is_active) return { text: 'OFF', cls: 'off' };
  if (!row.expiry_enabled || !row.expiry_date) return { text: 'no expiry', cls: 'ok' };
  const today = new Date().toISOString().slice(0, 10);
  const a = new Date(`${row.expiry_date}T00:00:00Z`).getTime();
  const b = new Date(`${today}T00:00:00Z`).getTime();
  const days = Math.round((a - b) / 86400000);
  if (days <= 0) return { text: 'expired', cls: 'off' };
  return { text: days === 1 ? '1 day left' : `${days} days left`, cls: 'ok' };
}

export default function Trials() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  async function load() {
    setError('');
    try {
      setData(await api('/admin/provisions'));
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function setActive(row, active) {
    setBusy(`store-${row.id}`);
    setError('');
    try {
      await api(`/admin/stores/${row.store_id}`, {
        method: 'PATCH',
        body: { is_active: active },
      });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  async function setSignupsOpen(open) {
    if (!open && !window.confirm(
      'Close the public sign-up?\n\n' +
      'The installer will stop being able to create new trial stores until you ' +
      'open it again. Stores that already exist are not affected.',
    )) return;
    setBusy('signups');
    setError('');
    try {
      await api('/admin/provisions/enabled', { method: 'PUT', body: { enabled: open } });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  async function allowAgain(row) {
    if (!window.confirm(
      `Let the computer ${row.device_id} start a brand-new trial?\n\n` +
      'This does not re-open the store it already has — it only clears the ' +
      'one-trial-per-computer limit, so a reinstall can sign up again.',
    )) return;
    setBusy(`device-${row.id}`);
    setError('');
    try {
      await api(`/admin/provisions/device/${encodeURIComponent(row.device_id)}`, {
        method: 'DELETE',
      });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  const rows = data?.rows || [];
  const limits = data?.limits || {};
  const live = rows.filter((r) => r.store_pk && r.is_active).length;

  return (
    <>
      <div className="page-title">
        <div>
          <h2>Trials</h2>
          <p>
            Stores created by the installer through the public sign-up. Free trial is{' '}
            <strong>{data?.trial_days ?? '—'} days</strong>.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {data && (
            <button
              className={data.enabled ? 'btn danger' : 'btn'}
              disabled={busy === 'signups' || data.env_locked}
              title={data.env_locked
                ? 'Held closed by TRIALS_ENABLED=false in the server environment.'
                : undefined}
              onClick={() => setSignupsOpen(!data.enabled)}
            >
              {busy === 'signups'
                ? '…'
                : data.enabled ? 'Close sign-ups' : 'Open sign-ups'}
            </button>
          )}
          <button className="btn" onClick={load}>Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
        <p className="muted" style={{ margin: 0, fontSize: '0.85rem', lineHeight: 1.6 }}>
          {data && !data.enabled && (
            <><strong>The public sign-up is CLOSED.</strong> The installer cannot create new
            trial stores until you open it again.{data.env_locked
              ? ' It is held closed by TRIALS_ENABLED=false in the server environment.'
              : ''}{' '}</>
          )}
          Anyone who downloads the installer can reach the sign-up, so it is capped:{' '}
          <strong>{limits.perDeviceInWindow ?? 1}</strong> trial per computer per{' '}
          <strong>{limits.perDeviceWindowDays ?? 30}</strong> days,{' '}
          <strong>{limits.perIpPerDay ?? 3}</strong> per internet connection per day,{' '}
          <strong>{limits.globalPerHour ?? 30}</strong> across the whole server per hour, and{' '}
          <strong>{limits.burstPerIp ?? 10}</strong> attempts per connection per{' '}
          <strong>{limits.burstWindowMinutes ?? 10}</strong> minutes.
          A sign-up can only ever create a NEW empty store — it can never open, read or join an
          existing one, whatever name is typed.
          {' '}Showing {rows.length} sign-up{rows.length === 1 ? '' : 's'}, {live} still switched on.
        </p>
      </div>

      <div className="panel">
        <div className="panel-b">
          <table>
            <thead>
              <tr>
                <th>Typed name</th>
                <th>Signed up</th>
                <th>Computer</th>
                <th>Address</th>
                <th className="right">Bills</th>
                <th>Trial</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const left = daysLeftLabel(row);
                return (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.requested_name}</strong>
                      <div className="muted mono">
                        {row.store_id ? (
                          <Link to={`/stores/${row.store_id}`}>{row.store_id}</Link>
                        ) : 'store removed'}
                      </div>
                    </td>
                    <td>
                      {fmtDate(row.created_at)}
                      {row.app_version && (
                        <div className="muted mono">v{row.app_version}</div>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>
                      {row.device_id}
                    </td>
                    <td className="mono" style={{ fontSize: '0.75rem' }}>{row.ip || '—'}</td>
                    <td className="right mono">{row.sales_count ?? 0}</td>
                    <td>
                      <span className={`badge ${left.cls}`}>{left.text}</span>
                      {row.expiry_date && (
                        <div className="muted mono" style={{ fontSize: '0.72rem' }}>
                          to {fmtDate(row.expiry_date)}
                        </div>
                      )}
                    </td>
                    <td className="right" style={{ whiteSpace: 'nowrap' }}>
                      {row.store_pk && (
                        row.is_active ? (
                          <button
                            className="btn sm"
                            disabled={busy === `store-${row.id}`}
                            onClick={() => setActive(row, false)}
                          >
                            {busy === `store-${row.id}` ? '…' : 'Turn off'}
                          </button>
                        ) : (
                          <button
                            className="btn sm"
                            disabled={busy === `store-${row.id}`}
                            onClick={() => setActive(row, true)}
                          >
                            {busy === `store-${row.id}` ? '…' : 'Turn on'}
                          </button>
                        )
                      )}
                      {' '}
                      <button
                        className="btn sm ghost"
                        disabled={busy === `device-${row.id}`}
                        onClick={() => allowAgain(row)}
                        title="Clear the one-trial-per-computer limit for this machine"
                      >
                        Allow again
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr><td colSpan={7} className="empty">No trial sign-ups yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
