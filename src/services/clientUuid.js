/**
 * B4.1 — client_uuid helpers for sales / purchases / medicines.
 */

export function normalizeClientUuid(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const raw = doc.client_uuid ?? doc.clientUuid;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s || null;
}

/**
 * Prefer existing row matched by client_uuid; else use doc local_id.
 * If local_id is already owned by a different (or null) client_uuid, allocate a
 * fresh id so Android Room ids and Mac2 server-allocated ids cannot overwrite
 * each other's sales/purchases.
 */
export async function resolveLocalIdByClientUuid(client, table, storePk, doc) {
  const allowed = new Set(['medicines', 'sales', 'purchases']);
  if (!allowed.has(table)) {
    return { localId: Number(doc?.id ?? doc?.local_id ?? 0), clientUuid: null };
  }
  const clientUuid = normalizeClientUuid(doc);
  let localId = Number(doc?.id ?? doc?.local_id ?? 0);
  if (clientUuid) {
    const { rows } = await client.query(
      `SELECT local_id FROM ${table} WHERE store_pk=$1 AND client_uuid=$2 LIMIT 1`,
      [storePk, clientUuid],
    );
    if (rows[0]) {
      localId = Number(rows[0].local_id);
    } else if (Number.isFinite(localId) && localId > 0) {
      const { rows: existing } = await client.query(
        `SELECT client_uuid FROM ${table} WHERE store_pk=$1 AND local_id=$2 LIMIT 1`,
        [storePk, localId],
      );
      if (existing[0]) {
        const existingUuid = existing[0].client_uuid
          ? String(existing[0].client_uuid).trim()
          : '';
        if (existingUuid !== clientUuid) {
          const { rows: mx } = await client.query(
            `SELECT COALESCE(MAX(local_id), 0)::bigint AS mx FROM ${table} WHERE store_pk=$1`,
            [storePk],
          );
          localId = Number(mx[0]?.mx || 0) + 1;
        }
      }
    }
  }
  return { localId, clientUuid };
}

/** Set client_uuid once (never overwrite a different uuid). */
export async function persistClientUuid(client, table, storePk, localId, clientUuid) {
  if (!clientUuid || !localId) return;
  const allowed = new Set(['medicines', 'sales', 'purchases']);
  if (!allowed.has(table)) return;
  await client.query(
    `UPDATE ${table}
     SET client_uuid = COALESCE(client_uuid, $3)
     WHERE store_pk=$1 AND local_id=$2
       AND (client_uuid IS NULL OR client_uuid = $3)`,
    [storePk, localId, clientUuid],
  );
}
