/**
 * B4.2 — idempotent stock delta log.
 * Apply once per (store_pk, op_uuid); updates medicines.stock_qty by qty_delta.
 */
import { recordAcceptedChange } from './syncRevision.js';
import { AppError } from '../utils/http.js';

function normalizeOpUuid(raw) {
  const s = String(raw || '').trim();
  return s || null;
}

function normalizeOp(raw) {
  const s = String(raw || 'adjust').trim().toLowerCase() || 'adjust';
  return s.slice(0, 40);
}

/** Stable positive local_id from op_uuid when client omits local_id. */
export function localIdFromOpUuid(opUuid) {
  let h = 0;
  const s = String(opUuid);
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  const n = Math.abs(h) || 1;
  // Keep in signed 32-bit positive range for client SQLite comfort
  return n;
}

/**
 * Apply one stock operation inside an open transaction.
 * @returns {{ id: number, status: string, medicine_id?: number, qty_delta?: number }}
 */
export async function applyStockOperation(client, storePk, doc, hint = null) {
  const opUuid = normalizeOpUuid(doc.op_uuid || doc.opUuid || doc.uuid);
  if (!opUuid) {
    return { id: 0, status: 'skipped', error: 'op_uuid required' };
  }

  const existing = await client.query(
    `SELECT local_id, medicine_id, qty_delta FROM stock_operations
     WHERE store_pk=$1 AND op_uuid=$2`,
    [storePk, opUuid],
  );
  if (existing.rows[0]) {
    const held = existing.rows[0];
    // One op_uuid is one stock movement, so a replay of it is skipped. A push that
    // reuses the op_uuid for a DIFFERENT quantity is another movement under a key the
    // server has already spent: skipping it dropped the change without a word (three
    // purchase lines on one medicine landed as the first line alone, store 4), and
    // applying it would double the first. Refuse it, say why, change nothing.
    const incomingQty = Number(doc.qty_delta ?? doc.qtyDelta);
    if (Number.isFinite(incomingQty) && incomingQty !== 0 && incomingQty !== Number(held.qty_delta)) {
      console.warn(
        `[stock] op ${opUuid} store=${storePk} refused: already applied with ` +
        `qty_delta ${Number(held.qty_delta)}, pushed again with ${incomingQty}`,
      );
      return {
        id: Number(held.local_id),
        status: 'failed',
        error:
          `stock op ${opUuid} was already applied with qty_delta ${Number(held.qty_delta)}; ` +
          `this push carries ${incomingQty} under the same op_uuid. Nothing was changed.`,
        reason: 'op_uuid_qty_conflict',
        medicine_id: Number(held.medicine_id),
        qty_delta: Number(held.qty_delta),
      };
    }
    return {
      id: Number(held.local_id),
      status: 'skipped',
      medicine_id: Number(held.medicine_id),
      qty_delta: Number(held.qty_delta),
    };
  }

  const medicineId = Number(doc.medicine_id ?? doc.medicineId ?? 0);
  if (!Number.isFinite(medicineId) || medicineId <= 0) {
    return { id: 0, status: 'skipped', error: 'medicine_id required' };
  }

  const qtyDelta = Number(doc.qty_delta ?? doc.qtyDelta ?? 0);
  if (!Number.isFinite(qtyDelta) || qtyDelta === 0) {
    return { id: 0, status: 'skipped', error: 'qty_delta required' };
  }

  let localId = Number(doc.id ?? doc.local_id ?? doc.localId ?? 0);
  if (!Number.isFinite(localId) || localId <= 0) {
    const next = await client.query(
      `SELECT COALESCE(MAX(local_id), 0) + 1 AS n FROM stock_operations WHERE store_pk=$1`,
      [storePk],
    );
    localId = Number(next.rows[0]?.n || 1);
  }

  const op = normalizeOp(doc.op);
  const refCollection = doc.ref_collection || doc.refCollection || null;
  const refId =
    doc.ref_id != null || doc.refId != null
      ? Number(doc.ref_id ?? doc.refId)
      : null;
  const deviceId = doc.device_id || doc.deviceId || null;

  // Ensure medicine row exists before delta (no-op if missing — still log)
  const med = await client.query(
    `SELECT stock_qty FROM medicines WHERE store_pk=$1 AND local_id=$2`,
    [storePk, medicineId],
  );
  if (med.rows[0]) {
    // No GREATEST(0, ...) here on purpose.
    //
    // "Add No Stock" sells a medicine that has not been delivered yet, and the
    // client is built around the resulting NEGATIVE row -- it is the record of
    // what the shop owes. Clamping the delta at zero erased that debt silently:
    // the shortage disappeared, and when the delivery arrived its quantity was
    // added to 0 instead of to -6, leaving MORE stock on the books than on the
    // shelf. The clamp was never protecting against a double-applied delta
    // either; the op_uuid check at the top of this function already makes every
    // operation idempotent.
    await client.query(
      `UPDATE medicines
       SET stock_qty = COALESCE(stock_qty, 0) + $3,
           updated_at = GREATEST(COALESCE(updated_at, NOW()), NOW()),
           version = COALESCE(version, 0) + 1,
           device_id = COALESCE($4, device_id),
           sync_status = 'synced'
       WHERE store_pk=$1 AND local_id=$2`,
      [storePk, medicineId, qtyDelta, deviceId],
    );
  }

  const revision = hint
    ? await recordAcceptedChange(client, hint, {
        storePk,
        collection: 'stock_operations',
        localId,
        operation: 'upsert',
        entityVersion: 1,
        entityUpdatedAt: new Date().toISOString(),
        deviceId,
      })
    : null;

  await client.query(
    `INSERT INTO stock_operations (
       store_pk, local_id, op_uuid, medicine_id, op, qty_delta,
       ref_collection, ref_id, revision, device_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (store_pk, op_uuid) DO NOTHING`,
    [
      storePk,
      localId,
      opUuid,
      medicineId,
      op,
      qtyDelta,
      refCollection,
      Number.isFinite(refId) ? refId : null,
      revision,
      deviceId,
    ],
  );

  return {
    id: localId,
    status: 'applied',
    medicine_id: medicineId,
    qty_delta: qtyDelta,
    revision,
  };
}

/**
 * Apply stock_ops embedded on a medicine doc (preferred over absolute LWW).
 * Returns true if at least one op was applied.
 */
export async function applyEmbeddedStockOps(client, storePk, doc, hint = null) {
  const ops = doc?.stock_ops || doc?.stockOps;
  if (!Array.isArray(ops) || !ops.length) return false;
  let any = false;
  for (const raw of ops) {
    if (!raw || typeof raw !== 'object') continue;
    const opDoc = {
      ...raw,
      medicine_id: raw.medicine_id ?? raw.medicineId ?? doc.id ?? doc.local_id,
      device_id: raw.device_id ?? raw.deviceId ?? doc.device_id ?? doc.deviceId,
    };
    const result = await applyStockOperation(client, storePk, opDoc, hint);
    if (result.status === 'failed') {
      // Thrown so the medicine document is refused whole under its savepoint: the
      // push answer marks it failed with this message, and no half of it stays.
      throw new AppError(409, result.error);
    }
    if (result.status === 'applied') any = true;
  }
  return any;
}

/**
 * Audit-only log when absolute stock_qty was patched without stock_ops.
 * IMPORTANT: do NOT append sync_changes / hint — medicine changelog already
 * carries absolute stock_qty. Emitting a delta revision would double-apply
 * on clients that also apply the medicine doc.
 */
export async function recordAbsoluteStockPatch(client, storePk, {
  medicineId,
  prevQty,
  nextQty,
  deviceId = null,
  hint = null,
} = {}) {
  void hint;
  const delta = Number(nextQty) - Number(prevQty);
  if (!Number.isFinite(delta) || delta === 0) return null;
  // Stable uuid so re-pushes of the same absolute transition are idempotent
  const opUuid = `abs:${storePk}:${medicineId}:${prevQty}->${nextQty}:${deviceId || 'na'}`;
  const next = await client.query(
    `SELECT COALESCE(MAX(local_id), 0) + 1 AS n FROM stock_operations WHERE store_pk=$1`,
    [storePk],
  );
  const localId = Number(next.rows[0]?.n || 1);
  await client.query(
    `INSERT INTO stock_operations (
       store_pk, local_id, op_uuid, medicine_id, op, qty_delta,
       ref_collection, ref_id, revision, device_id
     ) VALUES ($1,$2,$3,$4,'set',$5,NULL,NULL,NULL,$6)
     ON CONFLICT (store_pk, op_uuid) DO NOTHING`,
    [storePk, localId, opUuid, medicineId, delta, deviceId],
  );
  return { id: localId, revision: null, qty_delta: delta };
}

export async function fetchStockOpsByLocalIds(storePk, ids) {
  if (!ids?.length) return [];
  const { rows } = await (await import('../db/pool.js')).query(
    `SELECT local_id AS id, op_uuid, medicine_id, op, qty_delta,
            ref_collection, ref_id, revision, device_id, created_at
     FROM stock_operations
     WHERE store_pk=$1 AND local_id = ANY($2::bigint[])`,
    [storePk, ids.map(Number)],
  );
  return rows;
}
