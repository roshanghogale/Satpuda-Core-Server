/**
 * Generic upsert helpers for simple sync collections (masters without nested items).
 * Used by syncService for shelves, disposals, orders, settings, etc.
 */
import { AppError } from '../utils/http.js';
import { parseTs, toBool } from '../utils/fy.js';

export function shouldAcceptIncoming(existing, incoming) {
  if (!existing) return 'accept';
  if (incoming.deleted && !existing.deleted) return 'accept';
  const ev = Number(existing.version || 1);
  const iv = Number(incoming.version || 1);
  if (iv > ev) return 'accept';
  if (iv < ev) return 'skip';
  const et = parseTs(existing.updated_at)?.getTime() || 0;
  const it = parseTs(incoming.updated_at)?.getTime() || 0;
  if (it > et) return 'accept';
  if (it < et) return 'skip';
  const ed = existing.device_id || '';
  const id = incoming.device_id || '';
  if (id && !ed) return 'accept';
  if (ed && !id) return 'skip';
  if (id && ed && id > ed) return 'accept';
  if (id && ed && id < ed) return 'skip';
  return 'skip';
}

export function syncMeta(doc) {
  return {
    updated_at: parseTs(doc.updated_at) || parseTs(doc.synced_at) || new Date(),
    version: Number(doc.version || 1),
    device_id: doc.device_id || null,
    deleted: toBool(doc.deleted),
    sync_status: doc.sync_status || 'synced',
  };
}

export function localIdOf(doc) {
  const id = doc.id ?? doc.local_id;
  if (id === undefined || id === null || id === '') throw new AppError(400, 'Document id required');
  return Number(id);
}

/**
 * Upsert a simple row-keyed-by-(store_pk, local_id) table.
 * columns: array of { key, sqlType?, transform? } — business fields only
 * Table must have sync columns: updated_at, version, device_id, deleted, sync_status
 */
export async function upsertSimple(client, {
  table,
  storePk,
  doc,
  columns,
  defaults = {},
}) {
  const localId = localIdOf(doc);
  const meta = syncMeta(doc);
  const existing = await client.query(
    `SELECT version, updated_at, device_id, deleted FROM ${table} WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId]
  );
  if (shouldAcceptIncoming(existing.rows[0], meta) === 'skip') {
    return { id: localId, status: 'skipped' };
  }

  const colNames = columns.map((c) => (typeof c === 'string' ? c : c.key));
  const values = columns.map((c) => {
    const key = typeof c === 'string' ? c : c.key;
    const transform = typeof c === 'object' ? c.transform : null;
    let v = doc[key];
    if (v === undefined && defaults[key] !== undefined) v = defaults[key];
    if (transform) return transform(v, doc);
    return v ?? null;
  });

  const allCols = ['store_pk', 'local_id', ...colNames, 'updated_at', 'version', 'device_id', 'deleted', 'sync_status'];
  const allVals = [storePk, localId, ...values, meta.updated_at, meta.version, meta.device_id, meta.deleted, meta.sync_status];
  const placeholders = allVals.map((_, i) => `$${i + 1}`).join(',');
  const updates = colNames
    .map((c) => `${c}=EXCLUDED.${c}`)
    .concat([
      'updated_at=EXCLUDED.updated_at',
      'version=EXCLUDED.version',
      'device_id=EXCLUDED.device_id',
      'deleted=EXCLUDED.deleted',
      'sync_status=EXCLUDED.sync_status',
    ])
    .join(', ');

  await client.query(
    `INSERT INTO ${table} (${allCols.join(',')}) VALUES (${placeholders})
     ON CONFLICT (store_pk, local_id) DO UPDATE SET ${updates}`,
    allVals
  );
  return { id: localId, status: 'upserted' };
}
