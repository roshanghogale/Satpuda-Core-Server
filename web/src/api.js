// The web is online-only: nothing about the shop is kept in the browser. Only the sign-in
// token is, in localStorage so a counter PC stays signed in across a reload; the server ends
// the session after 12 idle hours, or at once when the login is switched off or reset.
const TOKEN_KEY = 'satpuda_web_token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t) {
  try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private window */ }
}
export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

let onSignedOut = () => {};
export function whenSignedOut(fn) { onSignedOut = fn; }

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  let res;
  try {
    res = await fetch(`/api/web${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('No internet connection. The web needs the internet; nothing was saved.');
  }
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    clearToken();
    onSignedOut();
  }
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || res.statusText || 'Request failed');
    err.status = res.status;
    err.code = json.details?.code;
    throw err;
  }
  return json.data;
}

export const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export function money(n) {
  return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtDate(d) {
  if (!d) return '';
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split('-');
  return day ? `${day}-${m}-${y}` : s;
}
export function fmtExpiry(d) {
  if (!d) return '';
  const s = String(d).slice(0, 10);
  const [y, m] = s.split('-');
  return m ? `${m}/${y.slice(2)}` : s;
}
/** "SCB12/FY2026-27" is printed as "SCB12". */
export function shortNo(no) {
  return String(no || '').split('/FY')[0];
}
export function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}
export function monthStartIso() {
  return `${todayIso().slice(0, 8)}01`;
}
