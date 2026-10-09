import { useState } from 'react';
import { api } from '../api.js';

export default function Password({ onDone }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    setError('');
    setMsg('');
    if (next !== again) { setError('The two new passwords are not the same.'); return; }
    try {
      await api('/me/password', { method: 'POST', body: { current, next } });
      setMsg('Password changed.');
      setCurrent(''); setNext(''); setAgain('');
      onDone?.();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <form onSubmit={submit} className="stack">
      {error && <div className="error">{error}</div>}
      {msg && <div className="okmsg">{msg}</div>}
      <label>Current password<input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></label>
      <label>New password<input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></label>
      <label>New password again<input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" /></label>
      <p className="muted small">At least 8 characters, with a letter and a number.</p>
      <button className="btn primary" disabled={!current || !next}>Save password</button>
    </form>
  );
}
