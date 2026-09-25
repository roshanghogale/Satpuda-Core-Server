const TOKEN_KEY = 'satpuda_admin_token';

// sessionStorage, not localStorage: this is the key to every shop on the
// account, and the panel is now reachable from the public internet. Per tab,
// gone when it closes -- so the sign-in screen is what greets you.
export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch (e) {
    return null;
  }
}

export function setToken(token) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch (e) {
    /* private window: the session simply does not persist */
  }
}

export function clearToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch (e) {
    /* nothing to clear */
  }
  try {
    // Anything left over from when this was localStorage.
    localStorage.removeItem(TOKEN_KEY);
  } catch (e) {
    /* ignore */
  }
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
