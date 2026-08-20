/**
 * Generic upsert helpers for simple sync collections (masters without nested items).
 * Used by syncService for shelves, disposals, orders, settings, etc.
 */
import { AppError } from '../utils/http.js';
import { parseTs, toBool } from '../utils/fy.js';

/**
 * Conflict / no-op resolution:
 * - missing row → accept
 * - soft-delete incoming → accept
 * - higher version → accept
 * - lower version → skip
 * - same version + newer updated_at → accept
 * - same version + same/older updated_at → skip (idempotent re-push)
 *
 * Re-pushing the same bulk Sync/Push payload must not rewrite Postgres rows.
 */
export function shouldAcceptIncoming(existing, incoming) {
  if (!existing) return 'accept';
  if (incoming.deleted && !existing.deleted) return 'accept';

  const ev = Number(existing.version || 1);
  const iv = Number(incoming.version || 1);
  if (iv > ev) return 'accept';
  if (iv < ev) return 'skip';

  const et = parseTs(existing.updated_at)?.getTime() || 0;
  const it = parseTs(incoming.updated_at)?.getTime() || 0;
  // Require a strictly newer timestamp for same-version updates.
  // Equal / missing / older → skip so repeated Sync to Server is a no-op.
  if (it > et) return 'accept';
  return 'skip';
}

export function syncMeta(doc) {
  // Do NOT default to Date.now() — that makes every re-push look "newer".
  const updated =
    parseTs(doc.updated_at) ||
    parseTs(doc.synced_at) ||
    parseTs(doc.last_updated) ||
    null;
  return {
    updated_at: updated,
    version: Number(doc.version || 1),
    device_id: doc.device_id || null,
    deleted: toBool(doc.deleted),
    sync_status: doc.sync_status || 'synced',
  };
}

/** Timestamp used when actually writing a row. */
export function writeTimestamp(meta, existing) {
  return (
    meta?.updated_at ||
    parseTs(existing?.updated_at) ||
    new Date()
  );
}

export function localIdOf(doc) {
  const id = doc.id ?? doc.local_id;
  if (id === undefined || id === null || id === '') throw new AppError(400, 'Document id required');
  return Number(id);
}

function stableJson(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

/** True when business fields are unchanged (special singleton docs). */
export function sameScalarFields(existing, incoming, fields) {
  if (!existing) return false;
  for (const f of fields) {
    const a = existing[f];
    const b = incoming[f];
    if (a == null && b == null) continue;
    if (typeof a === 'object' || typeof b === 'object') {
      if (stableJson(a) !== stableJson(b)) return false;
    } else if (String(a ?? '') !== String(b ?? '')) {
      return false;
    }
  }
  return true;
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

  const writeAt = writeTimestamp(meta, existing.rows[0]);
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
  const allVals = [storePk, localId, ...values, writeAt, meta.version, meta.device_id, meta.deleted, meta.sync_status];
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
  // 'upserted' retained for API compatibility; changelog treats it as applied.
  return { id: localId, status: 'upserted', applied: true };
}

/** Non-empty trimmed text, or ''. */
export function filledText(value) {
  return String(value ?? '').trim();
}

/** Keep an existing filled phone/address when the incoming value is blank. */
export function keepFilledText(incoming, existing) {
  const next = filledText(incoming);
  if (next) return next;
  const prev = filledText(existing);
  return prev || null;
}

/** True when a write was accepted (changelog should append). */
export function isAcceptedWrite(status) {
  return (
    status === 'applied' ||
    status === 'upserted' ||
    status === 'stock_patched' ||
    status === 'soft_deleted' ||
    status === 'hard_deleted'
  );
}

/** Changelog operation for an accepted write status. */
export function changelogOperation(status) {
  if (status === 'soft_deleted' || status === 'hard_deleted') return 'delete';
  return 'upsert';
}
