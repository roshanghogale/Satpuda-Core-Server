import { useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, clearToken, getToken, setToken } from './api.js';
import Overview from './pages/Overview.jsx';
import Stores from './pages/Stores.jsx';
import StoreDetail from './pages/StoreDetail.jsx';
import MasterMedicines from './pages/MasterMedicines.jsx';
import DemoLogins from './pages/DemoLogins.jsx';
import Trials from './pages/Trials.jsx';
import MasterReview from './pages/MasterReview.jsx';
import { ThemeSwitch } from './theme.jsx';

function Login({ onLogin }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api('/auth/admin/login', {
        method: 'POST',
        body: { username, password },
        token: null,
      });
      setToken(data.token);
      onLogin(data.admin);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <ThemeSwitch />
      <form className="login-card" onSubmit={submit}>
        <h1>Satpuda Core</h1>
        <p className="sub">Admin dashboard — multi-store control</p>
        {error && <div className="error">{error}</div>}
        <div className="field">
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="btn primary" style={{ width: '100%', marginTop: 8 }} disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

// On a phone the tables show as cards; each cell needs its column's name to say what the value is.
function labelCells(root) {
  root.querySelectorAll('table').forEach((t) => {
    const names = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    if (!names.length) return;
    t.querySelectorAll('tbody tr').forEach((tr) => {
      [...tr.children].forEach((td, i) => {
        if (names[i] && td.getAttribute('data-label') !== names[i]) td.setAttribute('data-label', names[i]);
      });
    });
  });
}

function Shell({ admin, onLogout, children }) {
  const mainRef = useRef(null);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return undefined;
    labelCells(el);
    const obs = new MutationObserver(() => labelCells(el));
    obs.observe(el, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>Satpuda Core</h1>
          <p>{admin?.username || 'admin'}</p>
        </div>
        <NavLink className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} to="/" end>
          Overview
        </NavLink>
        <NavLink className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} to="/stores">
          Stores
        </NavLink>
        <NavLink className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} to="/trials">
          Trials
        </NavLink>
        <NavLink className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} to="/master-medicines">
          Master medicines
        </NavLink>
        <NavLink className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} to="/demo-logins">
          Demo logins
        </NavLink>
        <NavLink className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} to="/master-list-check">
          Master list check
        </NavLink>
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={onLogout}>Sign out</button>
      </aside>
      <main className="main" ref={mainRef}>
        <div className="topbar">
          <ThemeSwitch />
        </div>
        {children}
      </main>
    </div>
  );
}

export default function App() {
  const [admin, setAdmin] = useState(null);
  const [booting, setBooting] = useState(!!getToken());
  const navigate = useNavigate();

  useEffect(() => {
    if (!getToken()) {
      setBooting(false);
      return;
    }
    api('/auth/me')
      .then((data) => {
        if (data.auth?.type === 'admin') setAdmin({ username: data.auth.username, id: data.auth.adminId });
        else clearToken();
      })
      .catch(() => clearToken())
      .finally(() => setBooting(false));
  }, []);

  if (booting) return <div className="login-wrap"><p className="muted">Loading…</p></div>;
  if (!admin) return <Login onLogin={setAdmin} />;

  function logout() {
    clearToken();
    setAdmin(null);
    navigate('/');
  }

  return (
    <Shell admin={admin} onLogout={logout}>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/stores" element={<Stores />} />
        <Route path="/stores/:id" element={<StoreDetail />} />
        <Route path="/trials" element={<Trials />} />
        <Route path="/master-medicines" element={<MasterMedicines />} />
        <Route path="/demo-logins" element={<DemoLogins />} />
        <Route path="/master-list-check" element={<MasterReview />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
