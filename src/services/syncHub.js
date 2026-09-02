/**
 * WebSocket sync hub — store-scoped sync_hint broadcasts (never full entity payloads).
 * Path: /ws/sync
 * Auth: ?token= JWT or first message { type: 'auth', token }
 */
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { ackDeviceRevision } from '../services/syncRevision.js';

/** @type {Map<number, Set<import('ws').WebSocket>>} */
const storeSockets = new Map();

/** Max change entries on one WS hint before clients must do a full list refresh. */
export const SYNC_HINT_MAX_CHANGES = 50;

/** Ping every 30s: reaps dead sockets and re-checks licence. */
const HEARTBEAT_MS = 30_000;

function verifyStoreToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (payload?.typ !== 'store') return null;
    const storePk = Number(payload.sub);
    if (!Number.isFinite(storePk)) return null;
    return {
      storePk,
      deviceId: payload.device_id || null,
      storeId: payload.store_id || null,
    };
  } catch {
    return null;
  }
}

/**
 * Is this store still allowed on? Mirrors the HTTP requireAuth gate.
 *
 * The socket path used to verify only the JWT signature, so a store the admin
 * disabled (or one whose expiry passed) kept receiving live sync until it
 * happened to disconnect. Expiry now bites on the socket too.
 */
async function storeAccessAllowed(storePk) {
  try {
    const { query } = await import('../db/pool.js');
    const { evaluateAccess } = await import('../services/licenseService.js');
    const { rows } = await query(
      `SELECT is_active, apply_expiry_check, expiry_enabled, expiry_date
       FROM stores WHERE id = $1`,
      [Number(storePk)],
    );
    if (!rows[0]) return false;
    return !evaluateAccess(rows[0]).blocked;
  } catch {
    return true; // never lock people out because of a transient DB blip
  }
}

function addSocket(storePk, ws) {
  let set = storeSockets.get(storePk);
  if (!set) {
    set = new Set();
    storeSockets.set(storePk, set);
  }
  set.add(ws);
}

function removeSocket(storePk, ws) {
  const set = storeSockets.get(storePk);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) storeSockets.delete(storePk);
}

function sendJson(ws, obj) {
  if (ws.readyState !== 1) return; // WebSocket.OPEN
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* ignore send errors */
  }
}

/**
 * Attach WebSocket server to the same HTTP server as Express.
 * @param {import('http').Server} httpServer
 */
export function attachSyncHub(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/sync' });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let storePk = null;
    let deviceId = null;
    let subscribed = false;

    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const queryToken = url.searchParams.get('token');
    const auth = verifyStoreToken(queryToken);
    if (auth) {
      storePk = auth.storePk;
      deviceId = auth.deviceId;
      sendJson(ws, { type: 'auth_ok', store_pk: storePk });
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        sendJson(ws, { type: 'error', error: 'invalid_json' });
        return;
      }

      if (msg?.type === 'auth') {
        const a = verifyStoreToken(msg.token);
        if (!a) {
          sendJson(ws, { type: 'error', error: 'unauthorized' });
          ws.close(4401, 'unauthorized');
          return;
        }
        if (storePk != null) removeSocket(storePk, ws);
        storePk = a.storePk;
        deviceId = a.deviceId;
        subscribed = false;
        sendJson(ws, { type: 'auth_ok', store_pk: storePk });
        return;
      }

      if (msg?.type === 'subscribe') {
        if (storePk == null) {
          sendJson(ws, { type: 'error', error: 'unauthorized' });
          return;
        }
        if (!subscribed) {
          // Same gate the HTTP API applies — an expired store must not subscribe.
          storeAccessAllowed(storePk).then((allowed) => {
            if (!allowed) {
              sendJson(ws, { type: 'licence_blocked' });
              try { ws.close(4403, 'store access disabled'); } catch { /* ignore */ }
              return;
            }
            addSocket(storePk, ws);
            subscribed = true;
            ws.storePk = storePk;
            ws.deviceId = deviceId;
            sendJson(ws, { type: 'subscribed', store_pk: storePk });
          });
          return;
        }
        ws.storePk = storePk;
        ws.deviceId = deviceId;
        sendJson(ws, { type: 'subscribed', store_pk: storePk });
        return;
      }

      if (msg?.type === 'ping') {
        sendJson(ws, { type: 'pong' });
        return;
      }

      if (msg?.type === 'ack') {
        if (storePk == null) {
          sendJson(ws, { type: 'error', error: 'unauthorized' });
          return;
        }
        const rev = msg.revision ?? msg.head_revision;
        const did = deviceId || msg.device_id || null;
        ackDeviceRevision(storePk, did, rev)
          .then((r) => sendJson(ws, { type: 'ack_ok', ...r }))
          .catch(() => sendJson(ws, { type: 'error', error: 'ack_failed' }));
      }
    });

    ws.on('close', () => {
      if (storePk != null) removeSocket(storePk, ws);
    });

    ws.on('error', () => {
      if (storePk != null) removeSocket(storePk, ws);
    });
  });

  // Heartbeat: reap half-open sockets (mobile networks and Cloudflare drop them
  // silently, and without this they accumulate forever and we broadcast to ghosts)
  // and re-check licence on the same tick so a disabled store is cut off promptly.
  const heartbeat = setInterval(async () => {
    for (const [storePk, set] of [...storeSockets.entries()]) {
      const allowed = await storeAccessAllowed(storePk);
      for (const ws of [...set]) {
        if (ws.isAlive === false) {
          removeSocket(storePk, ws);
          try { ws.terminate(); } catch { /* already gone */ }
          continue;
        }
        if (!allowed) {
          sendJson(ws, { type: 'licence_blocked' });
          removeSocket(storePk, ws);
          try { ws.close(4403, 'store access disabled'); } catch { /* ignore */ }
          continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(heartbeat));

  console.log('[satpuda] ws sync hub on /ws/sync');
  return wss;
}

/**
 * Broadcast store-scoped sync_hint to peers (never entity bodies).
 */
export function broadcastSyncHint(
  storePk,
  {
    head_revision,
    source_device_id = null,
    changes = [],
    full_refresh = false,
  } = {},
) {
  const set = storeSockets.get(Number(storePk));
  if (!set?.size) return;
  const list = Array.isArray(changes) ? changes : [];
  const overflow = list.length > SYNC_HINT_MAX_CHANGES;
  const msg = JSON.stringify({
    type: 'sync_hint',
    head_revision: Number(head_revision),
    source_device_id: source_device_id || null,
    changes: overflow || full_refresh ? [] : list.slice(0, SYNC_HINT_MAX_CHANGES),
    full_refresh: Boolean(full_refresh || overflow),
  });
  const src = source_device_id || null;
  for (const ws of set) {
    if (ws.readyState !== 1) continue;
    if (src && ws.deviceId && String(ws.deviceId) === String(src)) continue;
    try {
      ws.send(msg);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Tell every device of a store that its licence/expiry changed, so the admin
 * panel's date edit takes effect on the PC and Android at once instead of on
 * next restart.
 */
export function broadcastLicenceChange(storePk, payload = {}) {
  const set = storeSockets.get(Number(storePk));
  if (!set?.size) return;
  const msg = JSON.stringify({ type: 'licence_changed', ...payload });
  for (const ws of set) {
    if (ws.readyState !== 1) continue;
    try { ws.send(msg); } catch { /* ignore */ }
  }
  if (payload.access_allowed === false) {
    for (const ws of [...set]) {
      removeSocket(Number(storePk), ws);
      try { ws.close(4403, 'store access disabled'); } catch { /* ignore */ }
    }
  }
}

export function syncHubStats() {
  let connections = 0;
  for (const set of storeSockets.values()) connections += set.size;
  return { stores: storeSockets.size, connections };
}
