/**
 * Global medicines_master catalog (store_pk IS NULL).
 * Identity key: case-insensitive trimmed name.
 * Business store sync must not touch this table.
 */
import { query, withTransaction } from '../db/pool.js';
import { AppError } from '../utils/http.js';
import { parseTs, toBool } from '../utils/fy.js';
import { shouldAcceptIncoming, syncMeta, writeTimestamp } from './upsertHelper.js';

function normName(raw) {
  return String(raw || '').trim().toUpperCase();
}

function nonBlank(v) {
  const s = v == null ? '' : String(v).trim();
  return s ? s : null;
}

function pickText(incoming, existing) {
  return nonBlank(incoming) ?? nonBlank(existing) ?? null;
}

function pickNum(incoming, existing) {
  const n = Number(incoming);
  if (Number.isFinite(n) && n > 0) return n;
  const e = Number(existing);
  if (Number.isFinite(e) && e > 0) return e;
  if (incoming === 0 || incoming === '0') return 0;
  if (existing != null && Number.isFinite(Number(existing))) return Number(existing);
  return null;
}

function rowToDoc(r) {
  return {
    id: r.id,
    local_id: r.id,
    name: r.name,
    manufacturer: r.manufacturer,
    mrp: r.mrp,
    content_drug: r.content_drug,
    med_type: r.med_type,
    pack_size: r.pack_size,
    schedule: r.schedule,
    hsn_code: r.hsn_code,
    gst_percent: r.gst_percent,
    created_at: r.created_at,
    updated_at: r.updated_at,
    version: r.version,
    device_id: r.device_id,
    deleted: r.deleted,
    sync_status: r.sync_status || 'synced',
  };
}

async function findGlobalByName(client, name) {
  const { rows } = await client.query(
    `SELECT * FROM medicines_master
     WHERE store_pk IS NULL AND LOWER(TRIM(name)) = LOWER(TRIM($1))
     LIMIT 1`,
    [name],
  );
  return rows[0] || null;
}

/**
 * Upsert one global master row by name. Fill-or-upgrade non-blank fields.
 */
export async function upsertGlobalMasterDoc(client, doc) {
  const name = normName(doc?.name);
  if (!name) throw new AppError(400, 'Medicine name required');

  const meta = syncMeta(doc || {});
  const existing = await findGlobalByName(client, name);

  if (existing) {
    // Soft-delete / version gate when client sends meta; enrich-from-stock may omit version bump
    const gate = shouldAcceptIncoming(
      {
        version: existing.version,
        updated_at: existing.updated_at,
        device_id: existing.device_id,
        deleted: existing.deleted,
      },
      meta,
    );
    // Same-version enrich with newer/equal fields: allow when enrich flag set or version bumped
    const forceEnrich = !!doc?._enrich;
    if (gate === 'skip' && !forceEnrich && !meta.deleted) {
      return { id: existing.id, name, status: 'skipped' };
    }

    const next = {
      name,
      manufacturer: pickText(doc.manufacturer, existing.manufacturer),
      mrp: pickNum(doc.mrp, existing.mrp),
      content_drug: pickText(doc.content_drug, existing.content_drug),
      med_type: pickText(doc.med_type ?? doc.type, existing.med_type),
      pack_size: pickText(doc.pack_size ?? doc.unit, existing.pack_size),
      schedule: pickText(doc.schedule, existing.schedule),
      hsn_code: pickText(doc.hsn_code ?? doc.hsn, existing.hsn_code),
      gst_percent: pickNum(doc.gst_percent ?? doc.gst_pct, existing.gst_percent),
    };

    const version = forceEnrich
      ? Math.max(Number(existing.version || 1), Number(meta.version || 1)) + (gate === 'skip' ? 1 : 0)
      : Math.max(Number(meta.version || 1), Number(existing.version || 1));
    // For force enrich when skip, bump version so peers pull the change
    const writeVersion = forceEnrich && gate === 'skip'
      ? Number(existing.version || 1) + 1
      : version;

    await client.query(
      `UPDATE medicines_master SET
         name=$2, manufacturer=$3, mrp=$4, content_drug=$5, med_type=$6, pack_size=$7,
         schedule=$8, hsn_code=$9, gst_percent=$10,
         updated_at=$11, version=$12, device_id=$13, deleted=$14, sync_status=$15
       WHERE id=$1`,
      [
        existing.id,
        next.name,
        next.manufacturer,
        next.mrp,
        next.content_drug,
        next.med_type,
        next.pack_size,
        next.schedule,
        next.hsn_code,
        next.gst_percent,
        writeTimestamp(meta, existing),
        writeVersion,
        meta.device_id || existing.device_id,
        meta.deleted,
        meta.sync_status || 'synced',
      ],
    );
    return { id: existing.id, name, status: 'upserted', version: writeVersion };
  }

  const { rows } = await client.query(
    `INSERT INTO medicines_master (
       store_pk, name, manufacturer, mrp, content_drug, med_type, pack_size,
       schedule, hsn_code, gst_percent,
       created_at, updated_at, version, device_id, deleted, sync_status
     ) VALUES (
       NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9,
       NOW(), $10, $11, $12, $13, $14
     )
     RETURNING id`,
    [
      name,
      nonBlank(doc.manufacturer),
      pickNum(doc.mrp, null),
      nonBlank(doc.content_drug),
      nonBlank(doc.med_type ?? doc.type),
      nonBlank(doc.pack_size ?? doc.unit),
      nonBlank(doc.schedule),
      nonBlank(doc.hsn_code ?? doc.hsn),
      pickNum(doc.gst_percent ?? doc.gst_pct, null),
      writeTimestamp(meta, null),
      Number(meta.version || 1),
      meta.device_id,
      meta.deleted,
      meta.sync_status || 'synced',
    ],
  );
  return { id: rows[0].id, name, status: 'upserted', version: Number(meta.version || 1) };
}

export async function upsertGlobalMasterBatch(docs, { enrich = false } = {}) {
  if (!Array.isArray(docs) || !docs.length) {
    return { results: [], upserted: 0, skipped: 0 };
  }
  return withTransaction(async (client) => {
    const results = [];
    let upserted = 0;
    let skipped = 0;
    for (const raw of docs) {
      const doc = enrich ? { ...raw, _enrich: true } : raw;
      try {
        const r = await upsertGlobalMasterDoc(client, doc);
        results.push(r);
        if (r.status === 'upserted') upserted++;
        else skipped++;
      } catch (err) {
        results.push({ name: raw?.name, status: 'error', error: err.message });
        skipped++;
      }
    }
    return { results, upserted, skipped };
  });
}

export async function pullGlobalMaster({ since = null, limit = 500, afterId = 0, includeDeleted = true } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const cutoff = parseTs(since) || new Date(0);
  const after = Number(afterId) || 0;
  const delClause = includeDeleted ? '' : ' AND NOT deleted';

  if (after > 0) {
    const { rows } = await query(
      `SELECT * FROM medicines_master
       WHERE store_pk IS NULL
         AND (updated_at > $1 OR (updated_at = $1 AND id > $2))
         ${delClause}
       ORDER BY updated_at ASC, id ASC
       LIMIT $3`,
      [cutoff, after, lim],
    );
    return rows.map(rowToDoc);
  }

  const { rows } = await query(
    `SELECT * FROM medicines_master
     WHERE store_pk IS NULL AND updated_at > $1${delClause}
     ORDER BY updated_at ASC, id ASC
     LIMIT $2`,
    [cutoff, lim],
  );
  return rows.map(rowToDoc);
}

export async function exportGlobalMaster({ q = '', limit = 0 } = {}) {
  const params = [];
  let sql = `SELECT * FROM medicines_master WHERE store_pk IS NULL AND NOT deleted`;
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim()}%`);
    sql += ` AND name ILIKE $${params.length}`;
  }
  sql += ` ORDER BY name ASC`;
  if (limit && Number(limit) > 0) {
    params.push(Number(limit));
    sql += ` LIMIT $${params.length}`;
  }
  const { rows } = await query(sql, params);
  return rows.map(rowToDoc);
}

export async function countGlobalMaster() {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM medicines_master WHERE store_pk IS NULL AND NOT deleted`,
  );
  return rows[0]?.n || 0;
}

/**
 * Purchase dropdown search — prefix matches first, then contains.
 * Matches Mac2 offline search_master_names behaviour.
 */
export async function searchGlobalMaster({ q = '', limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const queryText = String(q || '').trim();
  if (!queryText) {
    const { rows } = await query(
      `SELECT name, med_type, pack_size, manufacturer, mrp, schedule, hsn_code, gst_percent, content_drug
       FROM medicines_master
       WHERE store_pk IS NULL AND NOT deleted
       ORDER BY name ASC
       LIMIT $1`,
      [lim],
    );
    return rows;
  }

  // ORDER BY name COLLATE "C", not plain name. The database collation is C.UTF-8, which
  // orders by code point exactly as "C" orders UTF-8 bytes (checked on all 390,552 live
  // global rows: 0 positions differ), so the dropdown order is unchanged. Plain `name`
  // let the planner walk idx_med_master_name from the top of the alphabet and filter
  // (379,830 rows thrown away for 'z%', ~0.3-2 s); under "C" it takes the trigram index
  // and a top-N sort instead.
  const { rows: prefix } = await query(
    `SELECT name, med_type, pack_size, manufacturer, mrp, schedule, hsn_code, gst_percent, content_drug
     FROM medicines_master
     WHERE store_pk IS NULL AND NOT deleted AND name ILIKE $1
     ORDER BY name COLLATE "C" ASC
     LIMIT $2`,
    [`${queryText}%`, lim],
  );
  if (prefix.length >= lim) return prefix;

  const seen = new Set(prefix.map((r) => String(r.name || '').toLowerCase()));
  const { rows: contains } = await query(
    `SELECT name, med_type, pack_size, manufacturer, mrp, schedule, hsn_code, gst_percent, content_drug
     FROM medicines_master
     WHERE store_pk IS NULL AND NOT deleted
       AND name ILIKE $1
       AND name NOT ILIKE $2
     ORDER BY name ASC
     LIMIT $3`,
    [`%${queryText}%`, `${queryText}%`, lim - prefix.length],
  );
  for (const r of contains) {
    const key = String(r.name || '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    prefix.push(r);
  }
  return prefix;
}

/**
 * Alphabetical chunk for progressive local cache (letter / prefix page).
 * letter: A-Z or '#' for non-alpha; after_name for keyset paging within letter.
 */
export async function chunkGlobalMaster({
  letter = '',
  afterName = '',
  limit = 500,
} = {}) {
  const lim = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const L = String(letter || '').trim().toUpperCase();
  const after = String(afterName || '').trim();
  const params = [];
  let where = `store_pk IS NULL AND NOT deleted`;

  if (L === '#') {
    where += ` AND name !~* '^[A-Z]'`;
  } else if (L && L.length === 1 && L >= 'A' && L <= 'Z') {
    params.push(`${L}%`);
    where += ` AND name ILIKE $${params.length}`;
  }

  if (after) {
    params.push(after);
    where += ` AND name > $${params.length}`;
  }
  params.push(lim);

  const { rows } = await query(
    `SELECT *
     FROM medicines_master
     WHERE ${where}
     ORDER BY name ASC
     LIMIT $${params.length}`,
    params,
  );
  return {
    docs: rows.map(rowToDoc),
    count: rows.length,
    letter: L || null,
    next_after: rows.length ? rows[rows.length - 1].name : null,
    has_more: rows.length >= lim,
  };
}

/** Merge inventory medicines from a store into the global catalog. */
export async function mergeFromStoreInventory(storePk) {
  const { rows } = await query(
    `SELECT m.name,
            COALESCE(m.manufacturer, '') AS manufacturer,
            COALESCE(m.mrp, 0) AS mrp,
            COALESCE(m.content_drug, '') AS content_drug,
            COALESCE(m.type, '') AS med_type,
            COALESCE(m.unit, '') AS pack_size,
            COALESCE(m.schedule, '') AS schedule,
            COALESCE(m.hsn_code, '') AS hsn_code,
            COALESCE(m.gst_percent, 0) AS gst_percent,
            m.device_id,
            m.updated_at,
            m.version
     FROM medicines m
     JOIN (
       SELECT UPPER(TRIM(name)) AS nkey, MAX(local_id) AS max_id
       FROM medicines
       WHERE store_pk=$1 AND NOT deleted AND COALESCE(TRIM(name),'')<>''
       GROUP BY UPPER(TRIM(name))
     ) latest ON latest.max_id = m.local_id AND m.store_pk=$1
     WHERE m.store_pk=$1 AND NOT m.deleted`,
    [storePk],
  );

  const docs = rows.map((r) => ({
    name: r.name,
    manufacturer: r.manufacturer,
    mrp: r.mrp,
    content_drug: r.content_drug,
    med_type: r.med_type,
    pack_size: r.pack_size,
    schedule: r.schedule,
    hsn_code: r.hsn_code,
    gst_percent: r.gst_percent,
    device_id: r.device_id || 'admin-merge',
    updated_at: r.updated_at || new Date().toISOString(),
    version: Number(r.version || 1),
    deleted: false,
    _enrich: true,
  }));

  const result = await upsertGlobalMasterBatch(docs, { enrich: true });
  return {
    store_pk: storePk,
    source_names: docs.length,
    ...result,
    global_count: await countGlobalMaster(),
  };
}

/** One-time: fold store-scoped master rows into global by name. */
export async function migrateStoreScopedToGlobal() {
  const { rows } = await query(
    `SELECT * FROM medicines_master WHERE store_pk IS NOT NULL AND NOT deleted`,
  );
  if (!rows.length) return { migrated: 0 };
  const docs = rows.map((r) => ({
    name: r.name,
    manufacturer: r.manufacturer,
    mrp: r.mrp,
    content_drug: r.content_drug,
    med_type: r.med_type,
    pack_size: r.pack_size,
    schedule: r.schedule,
    hsn_code: r.hsn_code,
    gst_percent: r.gst_percent,
    device_id: r.device_id || 'migrate',
    updated_at: r.updated_at,
    version: r.version || 1,
    deleted: false,
    _enrich: true,
  }));
  const result = await upsertGlobalMasterBatch(docs, { enrich: true });
  await query(`UPDATE medicines_master SET deleted=TRUE, updated_at=NOW()
               WHERE store_pk IS NOT NULL AND NOT deleted`);
  return { migrated: result.upserted, ...result };
}
