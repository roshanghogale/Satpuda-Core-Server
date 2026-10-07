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
 *
 * `namedIdWins` (medicines only): a document that names a positive id whose client_uuid
 * is held by ANOTHER row stays on the id it names. It comes back with clientUuid null,
 * so the other row keeps its uuid, and with uuidConflict describing that row.
 */
export async function resolveLocalIdByClientUuid(client, table, storePk, doc, { namedIdWins = false } = {}) {
  const allowed = new Set(['medicines', 'sales', 'purchases']);
  if (!allowed.has(table)) {
    return { localId: Number(doc?.id ?? doc?.local_id ?? 0), clientUuid: null };
  }
  const clientUuid = normalizeClientUuid(doc);
  let localId = Number(doc?.id ?? doc?.local_id ?? 0);
  if (clientUuid) {
    const { rows } = await client.query(
      `SELECT local_id, deleted FROM ${table} WHERE store_pk=$1 AND client_uuid=$2 LIMIT 1`,
      [storePk, clientUuid],
    );
    if (rows[0]) {
      const ownerId = Number(rows[0].local_id);
      if (namedIdWins && Number.isFinite(localId) && localId > 0 && ownerId !== localId) {
        return {
          localId,
          clientUuid: null,
          uuidConflict: {
            client_uuid: clientUuid,
            owner_id: ownerId,
            owner_deleted: rows[0].deleted === true,
          },
        };
      }
      localId = ownerId;
    } else if (Number.isFinite(localId) && localId > 0) {
      const { rows: existing } = await client.query(
        `SELECT client_uuid FROM ${table} WHERE store_pk=$1 AND local_id=$2 LIMIT 1`,
        [storePk, localId],
      );
      if (existing[0]) {
        const existingUuid = existing[0].client_uuid
          ? String(existing[0].client_uuid).trim()
          : '';
        // Only a row that already carries a DIFFERENT uuid is a real identity
        // clash. An empty one means the row predates client_uuid (3624 of 3785
        // medicines are in that state), and treating that as a clash meant every
        // edit to such a row -- hiding an out-of-stock batch, correcting stock --
        // silently created a DUPLICATE instead of updating it. The original row
        // stayed exactly as it was, so the change appeared to 'come back' and the
        // medicine showed up twice. persistClientUuid below adopts the uuid.
        if (existingUuid && existingUuid !== clientUuid) {
          const { rows: mx } = await client.query(
            `SELECT COALESCE(MAX(local_id), 0)::bigint AS mx FROM ${table}
              WHERE store_pk=$1 AND local_id < 1000000000`,
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
