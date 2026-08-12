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

/** Bump head_revision by 1 inside the caller's transaction. */
export async function nextRevision(client, storePk) {
  await ensureStoreSyncState(client, storePk);
  const { rows } = await client.query(
    `UPDATE store_sync_state
     SET head_revision = head_revision + 1,
         updated_at = NOW()
     WHERE store_pk = $1
     RETURNING head_revision`,
    [storePk]
  );
  return Number(rows[0].head_revision);
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

/**
 * Allocate revision + append changelog row. Mutates hint for post-commit broadcast.
 * hint: { revisions: number[], collections: Set, sourceDeviceId: string|null }
 */
export async function recordAcceptedChange(client, hint, {
  storePk,
  collection,
  localId,
  operation = 'upsert',
  entityVersion = null,
  entityUpdatedAt = null,
  deviceId = null,
}) {
  const revision = await nextRevision(client, storePk);
  await appendChange(client, {
    storePk,
    revision,
    collection,
    localId,
    operation,
    entityVersion,
    entityUpdatedAt,
    deviceId,
  });
  if (hint) {
    hint.revisions.push(revision);
    hint.collections.add(collection);
    if (deviceId) hint.sourceDeviceId = deviceId;
  }
  return revision;
}

export function newSyncHint(storePk) {
  return {
    storePk,
    revisions: [],
    collections: new Set(),
    sourceDeviceId: null,
  };
}

export async function getSyncStatus(storePk) {
  await query(
    `INSERT INTO store_sync_state (store_pk, head_revision)
     VALUES ($1, 0)
     ON CONFLICT (store_pk) DO NOTHING`,
    [storePk]
  );
  const { rows } = await query(
    `SELECT head_revision FROM store_sync_state WHERE store_pk = $1`,
    [storePk]
  );
  return {
    head_revision: Number(rows[0]?.head_revision || 0),
    server_time: new Date().toISOString(),
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

  const docsByKey = new Map();
  for (const [collection, idSet] of byCol) {
    const ids = [...idSet];
    const docs = await fetchDocsByLocalIds(storePk, collection, ids);
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
