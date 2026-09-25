#!/usr/bin/env node
/**
 * Put a deleted store back from its export file.
 *
 * An untested restore script is not an undo path -- it is a comfort blanket --
 * so this one is exercised by tests/admin-store-delete.test.mjs in the same run
 * that exercises the delete: export, delete, restore, then compare row counts
 * and a per-table checksum against what the export recorded.
 *
 *   node scripts/restore_store_export.mjs <file.json.gz> [options]
 *
 *   --dry-run          say what would be inserted, write nothing
 *   --new-id           take a fresh stores.id instead of the original one
 *   --rename <name>    restore under a different shop name (also re-derives
 *                      store_id / store_key so the original can coexist)
 *   --skip-provisions  do not restore store_provisions rows
 *   --force            allow a database named satpuda_core (LIVE). Off by
 *                      default: the normal path is restore into staging, look
 *                      at it, and only then decide.
 *
 * DATABASE_URL picks the database, exactly as the server does.
 *
 * Everything is one transaction. Either the whole store comes back or nothing
 * does; there is no half-restored store to explain to a shopkeeper.
 */
import path from 'path';
import process from 'process';
import { pool } from '../src/db/pool.js';
import {
  readExport,
  CASCADE_TABLES,
  SET_NULL_TABLES,
} from '../src/services/storeDelete.js';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

if (!file) {
  console.error('usage: node scripts/restore_store_export.mjs <file.json.gz> [--dry-run] [--new-id] [--rename NAME] [--skip-provisions] [--force]');
  process.exit(2);
}

const DRY = flag('dry-run');
const NEW_ID = flag('new-id');
const RENAME = value('rename');
const SKIP_PROVISIONS = flag('skip-provisions');
const FORCE = flag('force');

function slugifyStoreId(name) {
  return `store_${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}
function storeKeyFromName(name) {
  return `Store_${String(name).trim().replace(/\s+/g, '_')}`;
}

const payload = await readExport(path.resolve(file));
const { rows: [{ db }] } = await pool.query('SELECT current_database() AS db');
if (db === 'satpuda_core' && !FORCE) {
  console.error(`refusing to restore into "${db}" without --force (restore into a staging copy first)`);
  await pool.end();
  process.exit(2);
}

const store = { ...payload.store };
const originalId = Number(store.id);
if (RENAME) {
  store.store_name = RENAME;
  store.store_id = slugifyStoreId(RENAME);
  store.store_key = storeKeyFromName(RENAME);
  // The pairing key is unique too, and a renamed copy must not steal the
  // original's: drop it and let the admin regenerate one when it is needed.
  store.android_key = null;
}

console.log(`export  : ${file}`);
console.log(`taken   : ${payload.exported_at} from ${payload.server_database}`);
console.log(`store   : ${originalId} ${payload.store.store_name} (${payload.store.store_id})`);
console.log(`target  : ${db}${NEW_ID ? ' with a new id' : ` as id ${originalId}`}`);
console.log(`rows    : ${payload.total_child_rows} across ${CASCADE_TABLES.length} tables`);

// ── Collisions, checked before anything is written ───────────────────────────
const clashes = [];
if (!NEW_ID) {
  const { rows } = await pool.query('SELECT id FROM stores WHERE id = $1', [originalId]);
  if (rows.length) clashes.push(`stores.id ${originalId} is already taken`);
}
for (const col of ['store_id', 'store_key', 'android_key']) {
  if (store[col] == null) continue;
  const { rows } = await pool.query(
    `SELECT id, store_name FROM stores WHERE ${col} = $1`, [store[col]],
  );
  if (rows.length) clashes.push(`stores.${col} "${store[col]}" is already used by store ${rows[0].id} (${rows[0].store_name})`);
}
// Child rows always keep their own surrogate ids, --new-id or not: the foreign
// keys that run BETWEEN child tables (sales_items.sale_id -> sales.id,
// sales_return_items.return_id -> sales_returns.id) are built on them, and
// regenerating them would restore bills with no lines. Only stores.id is
// negotiable. So check up front that those ids are still free -- after a delete
// they are, unless somebody restored this same export already.
const { rows: idTables } = await pool.query(
  `SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'id' AND table_name = ANY($1::text[])`,
  [CASCADE_TABLES],
);
for (const { table_name: table } of idTables) {
  const ids = (payload.tables[table] || []).map((r) => r.id).filter((n) => n != null);
  if (!ids.length) continue;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE id = ANY($1::bigint[])`, [ids],
  );
  if (rows[0].n) clashes.push(`${table}: ${rows[0].n} of ${ids.length} row ids are already taken (has this export been restored already?)`);
}

if (clashes.length) {
  console.error('\nrefusing to restore -- the identity this store needs is not free:');
  for (const c of clashes) console.error(`  - ${c}`);
  console.error('\nuse --new-id and/or --rename, or remove the store that holds it.');
  await pool.end();
  process.exit(1);
}

if (DRY) {
  console.log('\n--dry-run: nothing written. Would insert:');
  for (const t of CASCADE_TABLES) {
    if (payload.counts[t]) console.log(`  ${String(payload.counts[t]).padStart(7)}  ${t}`);
  }
  if (!SKIP_PROVISIONS) {
    for (const t of SET_NULL_TABLES) {
      if (payload.counts[t]) console.log(`  ${String(payload.counts[t]).padStart(7)}  ${t}`);
    }
  }
  await pool.end();
  process.exit(0);
}

/**
 * The json/jsonb columns of one table.
 *
 * node-pg turns a JS array parameter into a POSTGRES array literal ({}), not
 * JSON, so store_dropdowns.villages -- which comes back from the export as a
 * JS array -- has to be stringified on the way in or it is restored as
 * something else entirely. Checked per table rather than guessed per value.
 */
const jsonColumnCache = new Map();
async function jsonColumns(client, table) {
  if (!jsonColumnCache.has(table)) {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
          AND data_type IN ('json', 'jsonb')`,
      [table],
    );
    jsonColumnCache.set(table, new Set(rows.map((r) => r.column_name)));
  }
  return jsonColumnCache.get(table);
}

/** INSERT one table's rows, remapping store_pk (and, for a new id, dropping the PK). */
async function insertRows(client, table, rows, { storePk, dropId }) {
  if (!rows.length) return 0;
  const jsonCols = await jsonColumns(client, table);
  const columns = Object.keys(rows[0]).filter((c) => !(dropId && c === 'id'));
  const colSql = columns.map((c) => `"${c}"`).join(', ');
  // One multi-row INSERT per chunk: 500 rows is well under the 65535-parameter
  // limit for every table here and keeps a 30k-row store to a few statements.
  const perStatement = Math.max(1, Math.floor(20000 / columns.length));
  let written = 0;
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    const params = [];
    const tuples = chunk.map((row) => {
      const holes = columns.map((c) => {
        let v = c === 'store_pk' ? storePk : row[c];
        if (jsonCols.has(c) && v !== null && typeof v === 'object') v = JSON.stringify(v);
        params.push(v);
        return `$${params.length}`;
      });
      return `(${holes.join(', ')})`;
    });
    const res = await client.query(
      `INSERT INTO ${table} (${colSql}) VALUES ${tuples.join(', ')}`, params,
    );
    written += res.rowCount || 0;
  }
  return written;
}

const client = await pool.connect();
let failed = null;
try {
  await client.query('BEGIN');

  const storeCols = Object.keys(store).filter((c) => !(NEW_ID && c === 'id'));
  const storeParams = storeCols.map((c) => store[c]);
  const { rows: [inserted] } = await client.query(
    `INSERT INTO stores (${storeCols.map((c) => `"${c}"`).join(', ')})
     VALUES (${storeCols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    storeParams,
  );
  const newPk = Number(inserted.id);
  console.log(`\nstores  : restored as id ${newPk}`);

  const written = {};
  for (const table of CASCADE_TABLES) {
    const rows = payload.tables[table] || [];
    // Child ids are always kept, so the foreign keys BETWEEN child tables still
    // line up; only store_pk is remapped. The pre-flight above proved those ids
    // are free.
    written[table] = await insertRows(client, table, rows, { storePk: newPk, dropId: false });
    if (written[table]) console.log(`  ${String(written[table]).padStart(7)}  ${table}`);
    if (written[table] !== payload.counts[table]) {
      throw new Error(`${table}: wrote ${written[table]} of ${payload.counts[table]} rows`);
    }
  }

  if (!SKIP_PROVISIONS) {
    // store_provisions is ON DELETE SET NULL, so its rows SURVIVED the delete,
    // orphaned. Re-link those instead of inserting copies -- inserting would
    // double the abuse trail and hand that computer's device_id two rows to
    // trip over the next time it asks for a trial.
    for (const table of SET_NULL_TABLES) {
      let relinked = 0;
      let added = 0;
      for (const row of payload.tables[table] || []) {
        // Match on the row's own id: it survived the delete untouched. A match
        // on device_id + created_at loses to timestamp precision on the way
        // through JSON.
        const res = await client.query(
          `UPDATE ${table} SET store_pk = $1 WHERE id = $2 AND store_pk IS NULL`,
          [newPk, row.id],
        );
        if (res.rowCount) { relinked += res.rowCount; continue; }
        added += await insertRows(client, table, [row], { storePk: newPk, dropId: true });
      }
      written[table] = relinked + added;
      if (written[table]) {
        console.log(`  ${String(written[table]).padStart(7)}  ${table} (${relinked} re-linked, ${added} re-inserted)`);
      }
    }
  }

  // Every table with an `id` is SERIAL/BIGSERIAL. Rows were inserted with
  // explicit ids, which does NOT move the sequence, so without this the next
  // client push collides with a restored row on the primary key. Several
  // tables here have no id at all (fy_serials, sync_watermarks,
  // store_sync_state, device_sync_state, the store_pk-keyed settings tables),
  // and pg_get_serial_sequence RAISES on a column that does not exist rather
  // than answering NULL -- so the list is filtered first.
  const { rows: withId } = await client.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id'
        AND table_name = ANY($1::text[])`,
    [[...CASCADE_TABLES, 'stores']],
  );
  for (const { table_name: table } of withId) {
    await client.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'),
                     GREATEST(COALESCE((SELECT MAX(id) FROM ${table}), 0), 1))
        WHERE pg_get_serial_sequence($1, 'id') IS NOT NULL`,
      [table],
    );
  }

  await client.query('COMMIT');
  const total = CASCADE_TABLES.reduce((n, t) => n + (written[t] || 0), 0);
  console.log(`\nrestored ${total} child rows into store ${newPk} of ${db}.`);
  if (total !== payload.total_child_rows) {
    console.error(`WARNING: export recorded ${payload.total_child_rows} child rows`);
    failed = new Error('row count mismatch');
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`\nrestore failed, nothing was written: ${err.message}`);
  failed = err;
} finally {
  client.release();
  await pool.end();
}
process.exit(failed ? 1 : 0);
