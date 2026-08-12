import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, clearToken, getToken, setToken } from './api.js';
import Overview from './pages/Overview.jsx';
import Stores from './pages/Stores.jsx';
import StoreDetail from './pages/StoreDetail.jsx';
import MasterMedicines from './pages/MasterMedicines.jsx';

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

function Shell({ admin, onLogout, children }) {
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
        <NavLink className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} to="/master-medicines">
          Master medicines
        </NavLink>
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={onLogout}>Sign out</button>
      </aside>
      <main className="main">{children}</main>
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
        <Route path="/master-medicines" element={<MasterMedicines />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
