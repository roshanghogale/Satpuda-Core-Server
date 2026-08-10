const TOKEN_KEY = 'satpuda_admin_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const t = token ?? getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || res.statusText || 'Request failed');
    err.status = res.status;
    err.details = json.details;
    throw err;
  }
  return json.data;
}

export function inr(n) {
  const v = Number(n || 0);
  return v.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
}

export function fmtDate(d) {
  if (!d) return '—';
  return String(d).slice(0, 10);
}
