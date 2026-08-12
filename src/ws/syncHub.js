/**
 * WebSocket sync hub — revision-only sync_hint broadcasts (never full payloads).
 * Path: /ws/sync
 * Auth: ?token= JWT or first message { type: 'auth', token }
 */
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

/** @type {Map<number, Set<import('ws').WebSocket>>} */
const storeSockets = new Map();

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
        // Re-auth: drop previous store mapping
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
          addSocket(storePk, ws);
          subscribed = true;
        }
        ws.storePk = storePk;
        ws.deviceId = deviceId;
        sendJson(ws, { type: 'subscribed', store_pk: storePk });
        return;
      }

      if (msg?.type === 'ping') {
        sendJson(ws, { type: 'pong' });
      }
    });

    ws.on('close', () => {
      if (storePk != null) removeSocket(storePk, ws);
    });

    ws.on('error', () => {
      if (storePk != null) removeSocket(storePk, ws);
    });
  });

  console.log('[satpuda] ws sync hub on /ws/sync');
  return wss;
}

/**
 * Broadcast revision-only hint to all subscribers for a store.
 * Never includes entity payloads.
 */
export function broadcastSyncHint(storePk, { head_revision, source_device_id = null } = {}) {
  const set = storeSockets.get(Number(storePk));
  if (!set?.size) return;
  const msg = JSON.stringify({
    type: 'sync_hint',
    head_revision: Number(head_revision),
    source_device_id: source_device_id || null,
  });
  for (const ws of set) {
    if (ws.readyState === 1) {
      try {
        ws.send(msg);
      } catch {
        /* ignore */
      }
    }
  }
}

export function syncHubStats() {
  let connections = 0;
  for (const set of storeSockets.values()) connections += set.size;
  return { stores: storeSockets.size, connections };
}
