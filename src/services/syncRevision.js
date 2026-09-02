/**
 * Option B sync: monotonic per-store head_revision + append-only sync_changes log.
 */
import { query } from '../db/pool.js';

export async function ensureStoreSyncState(client, storePk) {
  await client.query(
    `INSERT INTO store_sync_state (store_pk, head_revision)
     VALUES ($1, 0)
     ON CONFLICT (store_pk) DO NOTHING`,
    [storePk]
  );
}

/** Bump head_revision by `count` inside the caller's transaction. */
export async function nextRevisions(client, storePk, count = 1) {
  const n = Math.max(1, Number(count) || 1);
  await ensureStoreSyncState(client, storePk);
  const { rows } = await client.query(
    `UPDATE store_sync_state
     SET head_revision = head_revision + $2,
         updated_at = NOW()
     WHERE store_pk = $1
     RETURNING head_revision`,
    [storePk, n]
  );
  const head = Number(rows[0].head_revision);
  return { start: head - n + 1, head };
}

/** Bump head_revision by 1 inside the caller's transaction. */
export async function nextRevision(client, storePk) {
  const { head } = await nextRevisions(client, storePk, 1);
  return head;
}

export async function appendChange(client, {
  storePk,
  revision,
  collection,
  localId,
  operation,
  entityVersion = null,
  entityUpdatedAt = null,
  deviceId = null,
}) {
  await client.query(
    `INSERT INTO sync_changes (
       store_pk, revision, collection, local_id, operation,
       entity_version, entity_updated_at, device_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      storePk,
      revision,
      collection,
      Number(localId),
      operation,
      entityVersion == null ? null : Number(entityVersion),
      entityUpdatedAt || null,
      deviceId || null,
    ]
  );
}

function pushHint(hint, revision, collection, localId, operation, deviceId) {
  if (!hint) return;
  hint.revisions.push(revision);
  hint.collections.add(collection);
  if (!Array.isArray(hint.changes)) hint.changes = [];
  hint.changes.push({
    collection: String(collection),
    local_id: Number(localId),
    operation: String(operation || 'upsert'),
  });
  if (deviceId) hint.sourceDeviceId = deviceId;
}

/**
 * Bulk allocate revisions + multi-INSERT changelog. Mutates hint for broadcast.
 * entries: {storePk, collection, localId, operation, entityVersion, entityUpdatedAt, deviceId}[]
 */
export async function recordAcceptedChanges(client, hint, entries) {
  const list = (entries || []).filter(
    (e) => e && e.collection != null && e.localId != null && Number.isFinite(Number(e.storePk)),
  );
  if (!list.length) return [];

  const storePk = Number(list[0].storePk);
  const { start } = await nextRevisions(client, storePk, list.length);
  const width = 8;
  const batchSize = 200;
  const revisions = [];

  for (let i = 0; i < list.length; i += batchSize) {
    const slice = list.slice(i, i + batchSize);
    const params = [];
    const placeholders = slice.map((e, ri) => {
      const rev = start + i + ri;
      revisions.push(rev);
      const base = ri * width;
      params.push(
        storePk,
        rev,
        String(e.collection),
        Number(e.localId),
        String(e.operation || 'upsert'),
        e.entityVersion == null ? null : Number(e.entityVersion),
        e.entityUpdatedAt || null,
        e.deviceId || null,
      );
      return `(${Array.from({ length: width }, (_, ci) => `$${base + ci + 1}`).join(',')})`;
    }).join(',');
    await client.query(
      `INSERT INTO sync_changes (
         store_pk, revision, collection, local_id, operation,
         entity_version, entity_updated_at, device_id
       ) VALUES ${placeholders}`,
      params,
    );
  }

  list.forEach((e, idx) => {
    pushHint(hint, revisions[idx], e.collection, e.localId, e.operation || 'upsert', e.deviceId);
  });
  return revisions;
}

/**
 * Allocate revision + append changelog row. Mutates hint for post-commit broadcast.
 */
export async function recordAcceptedChange(client, hint, entry) {
  const [revision] = await recordAcceptedChanges(client, hint, [entry]);
  return revision;
}

export function newSyncHint(storePk) {
  return {
    storePk,
    revisions: [],
    collections: new Set(),
    changes: [],
    sourceDeviceId: null,
  };
}

export async function getSyncStatus(storePk) {
  const { rows } = await query(
    `SELECT head_revision FROM store_sync_state WHERE store_pk = $1`,
    [storePk]
  );
  if (!rows[0]) {
    await query(
      `INSERT INTO store_sync_state (store_pk, head_revision)
       VALUES ($1, 0)
       ON CONFLICT (store_pk) DO NOTHING`,
      [storePk]
    );
    return { head_revision: 0, server_time: new Date().toISOString() };
  }
  return {
    head_revision: Number(rows[0].head_revision || 0),
    server_time: new Date().toISOString(),
  };
}

/** B4.3 — device acknowledges applied head revision (lag for admin). */
export async function ackDeviceRevision(storePk, deviceId, revision) {
  const did = String(deviceId || '').trim();
  if (!did) return { ok: false, error: 'device_id required' };
  const rev = Math.max(0, Number(revision) || 0);
  await query(
    `INSERT INTO device_sync_state (store_pk, device_id, last_ack_revision, last_seen_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (store_pk, device_id) DO UPDATE SET
       last_ack_revision = GREATEST(device_sync_state.last_ack_revision, EXCLUDED.last_ack_revision),
       last_seen_at = NOW()`,
    [storePk, did, rev],
  );
  return { ok: true, last_ack_revision: rev };
}

export async function getAdminSyncOverview(storePk) {
  await query(
    `INSERT INTO store_sync_state (store_pk, head_revision)
     VALUES ($1, 0)
     ON CONFLICT (store_pk) DO NOTHING`,
    [storePk],
  );
  const head = await query(
    `SELECT head_revision, updated_at FROM store_sync_state WHERE store_pk=$1`,
    [storePk],
  );
  const headRevision = Number(head.rows[0]?.head_revision || 0);
  const devices = await query(
    `SELECT d.device_id, d.device_name, d.device_type, d.last_seen_at,
            COALESCE(s.last_ack_revision, 0)::bigint AS last_ack_revision,
            s.last_seen_at AS ack_seen_at
     FROM store_devices d
     LEFT JOIN device_sync_state s
       ON s.store_pk = d.store_pk AND s.device_id = d.device_id
     WHERE d.store_pk = $1
     ORDER BY d.last_seen_at DESC NULLS LAST`,
    [storePk],
  );
  const changes = await query(
    `SELECT revision, collection, local_id, operation, entity_version,
            entity_updated_at, device_id, created_at
     FROM sync_changes
     WHERE store_pk = $1
     ORDER BY revision DESC
     LIMIT 50`,
    [storePk],
  );
  const now = Date.now();
  return {
    head_revision: headRevision,
    head_updated_at: head.rows[0]?.updated_at || null,
    devices: devices.rows.map((d) => {
      const ack = Number(d.last_ack_revision || 0);
      const seen = d.last_seen_at || d.ack_seen_at;
      const lagRevisions = Math.max(0, headRevision - ack);
      const lagSeconds = seen
        ? Math.max(0, Math.round((now - new Date(seen).getTime()) / 1000))
        : null;
      return {
        device_id: d.device_id,
        device_name: d.device_name,
        device_type: d.device_type,
        last_seen_at: d.last_seen_at,
        last_ack_revision: ack,
        lag_revisions: lagRevisions,
        lag_seconds: lagSeconds,
      };
    }),
    recent_changes: changes.rows.map((r) => ({
      revision: Number(r.revision),
      collection: r.collection,
      local_id: Number(r.local_id),
      operation: r.operation,
      entity_version: r.entity_version == null ? null : Number(r.entity_version),
      entity_updated_at: r.entity_updated_at,
      device_id: r.device_id,
      created_at: r.created_at,
    })),
  };
}

export async function getChanges(storePk, { after = 0, limit = 200 } = {}) {
  const afterRev = Math.max(0, Number(after) || 0);
  const lim = Math.min(Math.max(1, Number(limit) || 200), 1000);

  const { rows } = await query(
    `SELECT revision, collection, local_id, operation,
            entity_version, entity_updated_at, device_id, created_at
     FROM sync_changes
     WHERE store_pk = $1 AND revision > $2
     ORDER BY revision ASC
     LIMIT $3`,
    [storePk, afterRev, lim + 1]
  );

  const hasMore = rows.length > lim;
  const page = hasMore ? rows.slice(0, lim) : rows;
  const changes = page.map((r) => ({
    revision: Number(r.revision),
    collection: r.collection,
    local_id: Number(r.local_id),
    operation: r.operation,
    entity_version: r.entity_version == null ? null : Number(r.entity_version),
    entity_updated_at: r.entity_updated_at,
    device_id: r.device_id,
    created_at: r.created_at,
  }));

  const fromRevision = changes.length ? changes[0].revision : afterRev;
  const toRevision = changes.length ? changes[changes.length - 1].revision : afterRev;

  return {
    from_revision: fromRevision,
    to_revision: toRevision,
    changes,
    has_more: hasMore,
  };
}

/**
 * Changelog page + entity docs (sales/purchases/returns include items[]).
 * Uses dynamic import to avoid circular dependency with syncService.
 */
export async function getChangesFull(storePk, { after = 0, limit = 200 } = {}) {
  const page = await getChanges(storePk, { after, limit });
  if (!page.changes.length) {
    return { ...page, changes: [] };
  }

  const { fetchDocsByLocalIds } = await import('./syncService.js');

  const byCol = new Map();
  for (const ch of page.changes) {
    if (ch.operation === 'delete') continue;
    if (!byCol.has(ch.collection)) byCol.set(ch.collection, new Set());
    byCol.get(ch.collection).add(ch.local_id);
  }

  // These are independent queries against different tables, but they used to run
  // strictly one after another — a page touching 12 collections meant 12 serial
  // round trips on the endpoint the clients hit most (sales/purchases each fire
  // extra queries for their nested items on top). Same queries, one wait.
  const docsByKey = new Map();
  const fetched = await Promise.all(
    [...byCol].map(async ([collection, idSet]) => {
      try {
        return [collection, await fetchDocsByLocalIds(storePk, collection, [...idSet])];
      } catch (err) {
        // One bad collection must not blank the whole page.
        console.error(`[sync] changes/full ${collection}:`, err.message);
        return [collection, []];
      }
    }),
  );
  for (const [collection, docs] of fetched) {
    for (const doc of docs) {
      const lid = Number(doc.id ?? doc.local_id ?? 0);
      docsByKey.set(`${collection}:${lid}`, doc);
    }
  }

  return {
    ...page,
    changes: page.changes.map((ch) => ({
      ...ch,
      doc:
        ch.operation === 'delete'
          ? null
          : docsByKey.get(`${ch.collection}:${ch.local_id}`) ?? null,
    })),
  };
}
