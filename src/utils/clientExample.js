/**
 * Minimal sync client contract for Mac2 / Android migration.
 * Point clients at: http://200.234.32.222 (or your domain)
 */

export const API_BASE = typeof process !== 'undefined'
  ? (process.env.SATPUDA_API_BASE || 'http://127.0.0.1:3000')
  : 'http://127.0.0.1:3000';

export async function pairDevice({ androidKey, storeName, deviceId, deviceType = 'pc' }) {
  const res = await fetch(`${API_BASE}/api/auth/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      android_key: androidKey,
      store_name: storeName,
      device_id: deviceId,
      device_type: deviceType,
    }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Pair failed');
  return json.data; // { token, store }
}

export function makeSyncClient(token) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  return {
    async push(collection, docs) {
      const res = await fetch(`${API_BASE}/api/sync/${collection}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(docs),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Push failed');
      return json.data;
    },
    async pushBundle(bundle) {
      const res = await fetch(`${API_BASE}/api/sync/bundle`, {
        method: 'POST',
        headers,
        body: JSON.stringify(bundle),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Bundle push failed');
      return json.data;
    },
    async pull(collection, since) {
      const q = since ? `?since=${encodeURIComponent(since)}` : '';
      const res = await fetch(`${API_BASE}/api/sync/${collection}${q}`, { headers });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Pull failed');
      return { docs: json.data, meta: json.meta };
    },
    async pullAll(since) {
      const q = since ? `?since=${encodeURIComponent(since)}` : '';
      const res = await fetch(`${API_BASE}/api/sync${q}`, { headers });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Pull all failed');
      return { data: json.data, meta: json.meta };
    },
    async allocateFy(kind, date) {
      const res = await fetch(`${API_BASE}/api/sync/fy/allocate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind, date }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'FY allocate failed');
      return json.data;
    },
  };
}
