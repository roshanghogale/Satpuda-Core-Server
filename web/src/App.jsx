import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, clearToken, getToken, setToken, whenSignedOut } from './api.js';
import Billing from './pages/Billing.jsx';
import SalesHistory from './pages/SalesHistory.jsx';
import Purchases from './pages/Purchases.jsx';
import Inventory from './pages/Inventory.jsx';
import Parties from './pages/Parties.jsx';
import Reports from './pages/Reports.jsx';
import Staff from './pages/Staff.jsx';
import Password from './pages/Password.jsx';

/** Menu: each entry shows only when the login has one of its permissions. */
const MENU = [
  { to: '/billing', label: 'Billing', any: ['billing'] },
  { to: '/sales', label: 'Sales history', any: ['sales_view'] },
  { to: '/purchases', label: 'Purchases', any: ['purchase_view', 'purchase_entry'] },
  { to: '/inventory', label: 'Inventory', any: ['inventory_view'] },
  { to: '/parties', label: 'Customers & suppliers', any: ['parties'] },
  { to: '/reports', label: 'Reports', any: ['reports'] },
  { to: '/staff', label: 'Staff', any: ['staff'] },
];

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const out = await api('/auth/login', { method: 'POST', body: { username, password } });
      setToken(out.token);
      onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>Satpuda Core</h1>
        <p className="muted">Sign in to your shop</p>
        {error && <div className="error">{error}</div>}
        <label>Login ID<input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
        <button className="btn primary wide" disabled={busy || !username || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="muted small">Works only with internet. Ask your shop owner for a login.</p>
      </form>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState(null);
  const [state, setState] = useState(getToken() ? 'loading' : 'out');
  const nav = useNavigate();

  const load = useCallback(async () => {
    try {
      setMe(await api('/me'));
      setState('in');
    } catch {
      setState('out');
    }
  }, []);

  useEffect(() => {
    whenSignedOut(() => { setMe(null); setState('out'); });
    if (getToken()) load();
  }, [load]);

  async function logout() {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* signed out anyway */ }
    clearToken();
    setMe(null);
    setState('out');
    nav('/');
  }

  if (state === 'loading') return <div className="center muted">Loading…</div>;
  if (state === 'out' || !me) return <Login onLogin={load} />;
  if (me.user.must_change_password) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1>Set your password</h1>
          <p className="muted">This password was given to you by someone else. Choose your own now.</p>
          <Password onDone={load} />
          <button className="btn link" onClick={logout}>Sign out</button>
        </div>
      </div>
    );
  }

  const perms = new Set(me.permissions);
  const can = (...p) => p.some((x) => perms.has(x));
  const menu = MENU.filter((m) => can(...m.any));
  const home = menu[0]?.to || '/password';

  return (
    <div className="shell">
      <header className="topbar no-print">
        <div className="brand">
          <strong>{me.profile?.name || me.store_name}</strong>
          <span className="muted small">Satpuda Core web · online only</span>
        </div>
        <nav className="menu">
          {menu.map((m) => <NavLink key={m.to} to={m.to}>{m.label}</NavLink>)}
        </nav>
        <div className="who">
          <NavLink to="/password" className="small">{me.user.full_name || me.user.username}{me.user.role === 'owner' ? ' (owner)' : ''}</NavLink>
          <button className="btn small" onClick={logout}>Sign out</button>
        </div>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to={home} replace />} />
          {can('billing') && <Route path="/billing" element={<Billing me={me} can={can} />} />}
          {can('sales_edit') && <Route path="/billing/edit/:id" element={<Billing me={me} can={can} />} />}
          {can('sales_view') && <Route path="/sales" element={<SalesHistory me={me} can={can} />} />}
          {can('purchase_view', 'purchase_entry') && <Route path="/purchases/*" element={<Purchases me={me} can={can} />} />}
          {can('inventory_view') && <Route path="/inventory" element={<Inventory can={can} />} />}
          {can('parties') && <Route path="/parties" element={<Parties can={can} />} />}
          {can('reports') && <Route path="/reports" element={<Reports me={me} />} />}
          {can('staff') && <Route path="/staff" element={<Staff me={me} />} />}
          <Route path="/password" element={<div className="card narrow"><h2>Change my password</h2><Password onDone={load} /></div>} />
          <Route path="*" element={<div className="card">This screen is not available for your login. <NavLink to={home}>Go back</NavLink></div>} />
        </Routes>
      </main>
    </div>
  );
}
