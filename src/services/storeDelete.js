/**
 * Deleting a store, with the guard rails that make it safe to hand the owner.
 *
 * There has never been a way to remove a store from this product -- the only
 * lifecycle control ever written is the is_active toggle -- so the owner's
 * dummy test stores pile up and, worse, their names stay taken: store_id,
 * store_key and android_key are UNIQUE on `stores`, and createStore derives the
 * first two from the shop name with no de-dup suffix. That is why this is a
 * HARD delete and not a soft `archived` flag: only an actually-gone row lets
 * the same shop name be created again, which is the collision that cost this
 * project a whole re-import when store 3 had to come back as store 129.
 *
 * The database is already built for it. 36 of the 37 foreign keys into
 * stores(id) are ON DELETE CASCADE, so one DELETE removes every business row,
 * sync row and fy_serial for that store. Exactly two things need hands:
 *
 *   store_provisions  is ON DELETE SET NULL, on purpose -- the abuse trail
 *                     outlives the store. But provisionService.assertWithinLimits
 *                     counts those rows by device_id / machine_id with no join
 *                     to stores, so an orphan still answers "this computer has
 *                     already been given a free trial". Deleting a store to
 *                     re-test the installer and then being locked out of the
 *                     installer is the exact trap; clear_trial_throttle is the
 *                     way out, and it is opt-in so the trail is kept by default.
 *
 *   audit_log         has store_pk with NO foreign key, which is what makes it
 *                     usable as the permanent record that the store existed.
 *                     The same is true of the ad-hoc fix/backup tables
 *                     (_bal_backup_*, fix20260913_*, stock_repair_backup_*) --
 *                     they also carry store_pk, they are NOT in CASCADE_TABLES,
 *                     and nothing here touches them.
 *
 * Order of operations, and why: the export is written and fsynced BEFORE the
 * transaction opens, the guards are re-checked INSIDE it against a row held
 * FOR UPDATE, and the audit row is written in the same transaction as the
 * delete. So there is no window in which the store is gone and the export is
 * not on disk, and no window in which a bill lands between the guard and the
 * delete without the guard seeing it.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { pool, query } from '../db/pool.js';
import { AppError } from '../utils/http.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const here = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(here, '..', '..');

/**
 * Every table that cascades off stores(id), written out by hand.
 *
 * Deliberately NOT read from pg_catalog at runtime. A table added to the schema
 * next year must be a review decision -- somebody has to look at it and say
 * "yes, that is store data and yes, it should be exported before it is dropped"
 * -- not something that silently joins a destructive operation.
 * assertTablesMatchSchema() below compares this list against pg_constraint and
 * is called by the tests, so the list cannot drift unnoticed either.
 *
 * Order matters for the RESTORE, not for the delete: parents first, so
 * scripts/restore_store_export.mjs can insert straight down the list.
 */
export const CASCADE_TABLES = [
  'pharmacy_profiles',
  'store_settings',
  'store_dropdowns',
  'shelf_settings',
  'store_devices',
  'store_api_tokens',
  'customers',
  'suppliers',
  'doctors',
  'medicines',
  'medicines_master',
  'general_products',
  'racks',
  'sections',
  'boxes',
  'shelves',
  'medicine_shelf',
  'medicine_suppliers',
  'sales',
  'sales_items',
  'purchases',
  'purchase_items',
  'customer_payments',
  'supplier_payments',
  'sales_returns',
  'sales_return_items',
  'purchase_returns',
  'purchase_return_items',
  'stock_disposals',
  'stock_operations',
  'pending_orders',
  'fy_serials',
  'sync_watermarks',
  'store_sync_state',
  'sync_changes',
  'device_sync_state',
];

/** store_provisions is SET NULL, so it is listed apart from the cascading set. */
export const SET_NULL_TABLES = ['store_provisions'];

/** Tables whose rows carry store_pk but which a delete must NEVER touch. */
export const UNTOUCHED_TABLES = ['audit_log'];

/**
 * Fail loudly if the hand-written list and the live schema disagree.
 *
 * Called by the tests, and safe to call from ops. A table that cascades but is
 * missing here would be deleted WITHOUT being exported -- the one failure mode
 * that the export cannot be recovered from -- so this check is the real
 * safeguard behind the "written out by hand" decision above.
 */
export async function assertTablesMatchSchema() {
  const { rows } = await query(
    `SELECT conrelid::regclass::text AS table_name, confdeltype
       FROM pg_constraint
      WHERE confrelid = 'stores'::regclass AND contype = 'f'`,
  );
  const cascade = new Set(rows.filter((r) => r.confdeltype === 'c').map((r) => r.table_name));
  const setNull = new Set(rows.filter((r) => r.confdeltype === 'n').map((r) => r.table_name));
  const listed = new Set(CASCADE_TABLES);
  const missing = [...cascade].filter((t) => !listed.has(t)).sort();
  const extra = [...listed].filter((t) => !cascade.has(t)).sort();
  const setNullMissing = [...setNull].filter((t) => !SET_NULL_TABLES.includes(t)).sort();
  const other = rows
    .filter((r) => r.confdeltype !== 'c' && r.confdeltype !== 'n')
    .map((r) => `${r.table_name}(${r.confdeltype})`)
    .sort();
  return {
    ok: !missing.length && !extra.length && !setNullMissing.length && !other.length,
    missing_from_list: missing,
    listed_but_not_cascading: extra,
    set_null_not_listed: setNullMissing,
    other_delete_rules: other,
  };
}

function slug(name) {
  return String(name || 'store')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'store';
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Where per-store exports live. Override with STORE_EXPORT_DIR (tests do). */
export function exportDir() {
  return process.env.STORE_EXPORT_DIR || path.join(APP_ROOT, 'backups', 'store-deletes');
}

async function loadStore(storePk) {
  const { rows } = await query(`SELECT * FROM stores WHERE id = $1`, [storePk]);
  if (!rows[0]) throw new AppError(404, 'Store not found');
  return rows[0];
}

/**
 * What deleting this store would remove, and what it last did.
 *
 * `last activity` is the reason this endpoint exists. It reports BUSINESS
 * activity -- the last non-deleted, non-autosave bill and purchase, the last
 * payment -- and reports device check-ins separately, because those are not the
 * same thing at all. The owner's test machines keep polling /sync for as long
 * as the app is open, so on live, store 25 "ZZ Test Pharmacy" had a PC seen
 * minutes ago and its last real bill two weeks earlier. A guard keyed on
 * last_seen would refuse to delete precisely the dummy stores this feature is
 * for.
 */
export async function storeDeleteReport(storePk, { recentDays = 30, bigStoreRows = 5000 } = {}) {
  const store = await loadStore(storePk);
  const counts = {};
  // One statement per table rather than one giant UNION: 37 cheap indexed
  // counts, and a failure names the table it failed on.
  for (const t of CASCADE_TABLES) {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE store_pk = $1`, [storePk]);
    counts[t] = Number(rows[0].n) || 0;
  }
  for (const t of SET_NULL_TABLES) {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE store_pk = $1`, [storePk]);
    counts[t] = Number(rows[0].n) || 0;
  }
  const totalChildRows = CASCADE_TABLES.reduce((n, t) => n + counts[t], 0);

  const { rows: act } = await query(
    `SELECT
       (SELECT MAX(bill_date)::text FROM sales
         WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave)          AS last_sale_date,
       (SELECT MAX(purchase_date)::text FROM purchases
         WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave)          AS last_purchase_date,
       (SELECT GREATEST(
           COALESCE((SELECT MAX(payment_date) FROM customer_payments WHERE store_pk=$1 AND NOT deleted), '-infinity'::date),
           COALESCE((SELECT MAX(payment_date) FROM supplier_payments WHERE store_pk=$1 AND NOT deleted), '-infinity'::date)
         )::text)                                                        AS last_payment_date,
       (SELECT MAX(created_at) FROM sync_changes WHERE store_pk=$1)      AS last_sync_change_at,
       (SELECT MAX(last_seen_at) FROM store_devices WHERE store_pk=$1)   AS last_device_seen_at,
       (SELECT COUNT(*)::int FROM sales
         WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave
           AND bill_date >= CURRENT_DATE - $2::int)                      AS recent_sales,
       (SELECT COUNT(*)::int FROM purchases
         WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave
           AND purchase_date >= CURRENT_DATE - $2::int)                  AS recent_purchases,
       (SELECT COUNT(*)::int FROM sales
         WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave)          AS total_sales,
       (SELECT COUNT(*)::int FROM purchases
         WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave)          AS total_purchases`,
    [storePk, recentDays],
  );
  const a = act[0] || {};
  const lastPayment = a.last_payment_date && !String(a.last_payment_date).startsWith('-')
    ? a.last_payment_date
    : null;

  const { rows: devices } = await query(
    `SELECT device_id, device_name, device_type, last_seen_at
       FROM store_devices WHERE store_pk=$1 ORDER BY last_seen_at DESC NULLS LAST`,
    [storePk],
  );
  const { rows: provisions } = await query(
    `SELECT id, device_id, machine_id, ip, requested_name, created_at
       FROM store_provisions WHERE store_pk=$1 ORDER BY created_at DESC`,
    [storePk],
  );

  const guards = evaluateGuards(store, {
    recentSales: Number(a.recent_sales || 0),
    recentPurchases: Number(a.recent_purchases || 0),
    totalChildRows,
    recentDays,
    bigStoreRows,
  });

  return {
    store: {
      id: store.id,
      store_id: store.store_id,
      store_key: store.store_key,
      store_name: store.store_name,
      is_active: store.is_active,
      app_mode: store.app_mode,
      provisioned_trial: store.provisioned_trial,
      activation_date: store.activation_date,
      expiry_enabled: store.expiry_enabled,
      expiry_date: store.expiry_date,
      created_at: store.created_at,
    },
    counts,
    total_child_rows: totalChildRows,
    untouched_tables: UNTOUCHED_TABLES,
    last_activity: {
      last_sale_date: a.last_sale_date || null,
      last_purchase_date: a.last_purchase_date || null,
      last_payment_date: lastPayment,
      last_sync_change_at: a.last_sync_change_at || null,
      // Reported, never used as a guard -- see the note above this function.
      last_device_seen_at: a.last_device_seen_at || null,
      total_sales: Number(a.total_sales || 0),
      total_purchases: Number(a.total_purchases || 0),
      recent_sales: Number(a.recent_sales || 0),
      recent_purchases: Number(a.recent_purchases || 0),
      recent_days: recentDays,
    },
    devices,
    provisions,
    guards: guards.details,
    blocked: guards.blocked,
    reasons: guards.reasons,
    confirm_name_required: store.store_name,
  };
}

/**
 * The four things that make a store look like somebody's living shop.
 *
 * All four are overridable with force:true, because "looks like" is a
 * heuristic and the owner knows his own stores. The typed name is NOT
 * overridable and is checked separately: force answers "I know this store is
 * busy", it never answers "I know which store I picked".
 */
function evaluateGuards(store, { recentSales, recentPurchases, totalChildRows, recentDays, bigStoreRows }) {
  const details = {
    recent_sales: {
      hit: recentSales > 0,
      detail: `${recentSales} non-deleted sale(s) in the last ${recentDays} days`,
    },
    recent_purchases: {
      hit: recentPurchases > 0,
      detail: `${recentPurchases} purchase(s) in the last ${recentDays} days`,
    },
    large_store: {
      hit: totalChildRows > bigStoreRows,
      detail: `${totalChildRows} child rows (limit ${bigStoreRows})`,
    },
    paying_licence: {
      // A paid shop carries a far-future expiry: the live ones are dated 3026.
      hit: Boolean(
        store.is_active
        && store.expiry_enabled
        && store.expiry_date
        && new Date(`${String(store.expiry_date).slice(0, 10)}T00:00:00Z`).getTime()
           > Date.now() + 365 * 86400000,
      ),
      detail: `active licence with expiry ${store.expiry_date || '(none)'} more than a year out`,
    },
  };
  const reasons = Object.entries(details)
    .filter(([, v]) => v.hit)
    .map(([k, v]) => `${k}: ${v.detail}`);
  return { details, blocked: reasons.length > 0, reasons };
}

/** Case- and space-insensitive equality, the way a human types a shop name. */
function nameMatches(typed, actual) {
  const norm = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const t = norm(typed);
  return t !== '' && t === norm(actual);
}

/**
 * Write everything this store owns to one gzipped JSON file, and fsync it.
 *
 * No pg_dump child process: no credentials to plumb through, no PATH
 * assumptions on the VPS, and the biggest dummy store on live is 5,633 rows.
 * The header carries the row counts so a restore can verify it put back what
 * was taken out. Returns the path, size and SHA-256 of the file on disk.
 */
export async function exportStore(storePk, { dir = exportDir() } = {}) {
  const store = await loadStore(storePk);
  const tables = {};
  const counts = {};
  for (const t of [...CASCADE_TABLES, ...SET_NULL_TABLES]) {
    const { rows } = await query(`SELECT * FROM ${t} WHERE store_pk = $1`, [storePk]);
    tables[t] = rows;
    counts[t] = rows.length;
  }
  const payload = {
    format: 'satpuda-store-export',
    version: 1,
    exported_at: new Date().toISOString(),
    server_database: (await query('SELECT current_database() AS db')).rows[0].db,
    store,
    counts,
    total_child_rows: CASCADE_TABLES.reduce((n, t) => n + counts[t], 0),
    cascade_tables: CASCADE_TABLES,
    set_null_tables: SET_NULL_TABLES,
    tables,
  };
  const body = await gzip(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
  // The file carries the store's android_key -- which alone buys a store token
  // from the unauthenticated POST /auth/pair -- and every customer's name,
  // phone and address. It is written owner-only, in an owner-only directory,
  // and mkdir's mode is applied explicitly because an existing directory keeps
  // whatever mode it already had.
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.promises.chmod(dir, 0o700);
  } catch { /* a directory we do not own: the 0600 file below still holds */ }
  // The timestamp is only second-resolution, so it carries a short random tail:
  // two exports of the same store id inside one second (delete, restore,
  // delete again -- what the tests do, and what an owner retrying will do) must
  // not make a destructive operation die on EEXIST. The 'wx' open below still
  // guarantees an existing file is never overwritten.
  const file = path.join(
    dir,
    `${stamp()}_store${store.id}_${slug(store.store_name)}_${crypto.randomBytes(3).toString('hex')}.json.gz`,
  );
  // Write, flush to the platter, and flush the directory entry too: an export
  // that is only in the page cache is not a backup if the box loses power
  // between the export and the DELETE.
  const fh = await fs.promises.open(file, 'wx', 0o600);
  try {
    await fh.writeFile(body);
    await fh.sync();
    await fh.chmod(0o600);
  } finally {
    await fh.close();
  }
  try {
    const dh = await fs.promises.open(dir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* directory fsync is best-effort on some filesystems */ }
  return {
    path: file,
    bytes: body.length,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    counts,
    total_child_rows: payload.total_child_rows,
  };
}

/**
 * Delete a store, for good.
 *
 * @param {number} storePk
 * @param {object} opts
 * @param {string} opts.confirmName        must equal the store name (required, never forceable)
 * @param {boolean} [opts.force]           proceed despite the activity guards
 * @param {boolean} [opts.clearTrialThrottle] also drop store_provisions rows for this store
 * @param {string} [opts.actorId]          admin username, for the audit row
 * @param {boolean} [opts.skipExport]      tests only; refuses outside a staging database
 */
export async function deleteStore(storePk, {
  confirmName,
  force = false,
  clearTrialThrottle = false,
  actorId = null,
  recentDays = 30,
  bigStoreRows = 5000,
  exportDir: dir = exportDir(),
  skipExport = false,
  // Test seam: run between the export landing on disk and the transaction
  // opening, so the "a row arrived while we were exporting" guard below can be
  // exercised. Nothing in the server passes it.
  onExported = null,
} = {}) {
  const store = await loadStore(storePk);
  if (!nameMatches(confirmName, store.store_name)) {
    throw new AppError(400, 'Type the store name exactly to confirm this deletion', {
      expected_name: store.store_name,
    });
  }

  // Pre-flight guard check on the report, so a refusal costs no export file.
  const report = await storeDeleteReport(storePk, { recentDays, bigStoreRows });
  if (report.blocked && !force) {
    throw new AppError(409, 'This store still looks active; re-send with force to delete it anyway', {
      reasons: report.reasons,
      guards: report.guards,
      last_activity: report.last_activity,
    });
  }

  let exported = null;
  if (skipExport) {
    const db = (await query('SELECT current_database() AS db')).rows[0].db;
    if (!/^(satpuda_stage_|satpuda_test_)/.test(db)) {
      throw new AppError(400, 'skipExport is only allowed against a staging database');
    }
  } else {
    exported = await exportStore(storePk, { dir });
  }
  if (typeof onExported === 'function') await onExported(exported);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE, then re-read: two admins on the delete button at once, or a
    // rename between the name check and the delete, both end here.
    const { rows: locked } = await client.query(
      `SELECT * FROM stores WHERE id = $1 FOR UPDATE`, [storePk],
    );
    if (!locked[0]) throw new AppError(404, 'Store not found');
    if (!nameMatches(confirmName, locked[0].store_name)) {
      throw new AppError(409, 'The store was renamed while this deletion was being confirmed');
    }
    if (!force) {
      // Re-check inside the lock against rows that may have landed since the
      // preview: a bill pushed by a sync in the last few seconds still counts.
      const { rows: fresh } = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM sales
             WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave
               AND bill_date >= CURRENT_DATE - $2::int) AS recent_sales,
           (SELECT COUNT(*)::int FROM purchases
             WHERE store_pk=$1 AND NOT deleted AND NOT is_autosave
               AND purchase_date >= CURRENT_DATE - $2::int) AS recent_purchases`,
        [storePk, recentDays],
      );
      const g = evaluateGuards(locked[0], {
        recentSales: Number(fresh[0].recent_sales || 0),
        recentPurchases: Number(fresh[0].recent_purchases || 0),
        totalChildRows: report.total_child_rows,
        recentDays,
        bigStoreRows,
      });
      if (g.blocked) {
        throw new AppError(409, 'This store became active while the deletion was being confirmed', {
          reasons: g.reasons,
        });
      }
    }

    // The export is taken before this transaction opens, so that the file is on
    // disk and fsynced before anything is destroyed. That leaves a short window
    // in which a device could sync a row in: it would be deleted below and
    // would not be in the export. Rather than lose it silently, count again
    // under the lock and refuse if anything GREW. (A table that shrank is
    // harmless -- the export holds more than the database did.)
    if (exported) {
      const grew = [];
      for (const t of CASCADE_TABLES) {
        const { rows: c } = await client.query(
          `SELECT COUNT(*)::int AS n FROM ${t} WHERE store_pk = $1`, [storePk],
        );
        const now = Number(c[0].n) || 0;
        if (now > (exported.counts[t] || 0)) grew.push(`${t}: ${exported.counts[t]} -> ${now}`);
      }
      if (grew.length) {
        // Nothing is being deleted, so the export is an unreferenced copy of a
        // LIVE store -- its pairing key included. Take it back off the disk
        // rather than leave it for whoever finds it.
        let exportRemoved = false;
        try {
          await fs.promises.unlink(exported.path);
          exportRemoved = true;
        } catch { /* keep the refusal, report that the file is still there */ }
        throw new AppError(409, 'The store received new data while it was being exported; nothing was deleted. Try again.', {
          grew,
          export_path: exportRemoved ? null : exported.path,
          export_removed: exportRemoved,
        });
      }
    }

    let provisionsCleared = 0;
    if (clearTrialThrottle) {
      const res = await client.query(
        `DELETE FROM store_provisions WHERE store_pk = $1`, [storePk],
      );
      provisionsCleared = res.rowCount || 0;
    }

    // The audit row goes in BEFORE the DELETE and inside the same transaction:
    // audit_log has no foreign key to stores, so it survives, and if the delete
    // rolls back the audit row rolls back with it.
    const { rows: audit } = await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, store_pk, meta)
       VALUES ('admin', $1, 'store.delete', $2, $3::jsonb) RETURNING id, created_at`,
      [
        actorId ? String(actorId) : null,
        storePk,
        JSON.stringify({
          store_id: locked[0].store_id,
          store_key: locked[0].store_key,
          store_name: locked[0].store_name,
          android_key_present: Boolean(locked[0].android_key),
          provisioned_trial: locked[0].provisioned_trial,
          counts: report.counts,
          total_child_rows: report.total_child_rows,
          last_activity: report.last_activity,
          forced: Boolean(force),
          guard_reasons: report.reasons,
          clear_trial_throttle: Boolean(clearTrialThrottle),
          provisions_cleared: provisionsCleared,
          export_path: exported ? exported.path : null,
          export_sha256: exported ? exported.sha256 : null,
          export_bytes: exported ? exported.bytes : null,
        }),
      ],
    );

    await client.query(`DELETE FROM stores WHERE id = $1`, [storePk]);
    await client.query('COMMIT');

    // After the commit, and best-effort: any device still holding a token has
    // to be told, and requireAuth caches the store row for 45 seconds. The
    // PRE-delete row is passed in because evaluateAccess needs a row to read.
    await notifyStoreGone(locked[0]);

    return {
      deleted: true,
      store_pk: storePk,
      store_id: locked[0].store_id,
      store_name: locked[0].store_name,
      forced: Boolean(force),
      counts: report.counts,
      total_child_rows: report.total_child_rows,
      provisions_cleared: provisionsCleared,
      provisions_left: clearTrialThrottle ? 0 : report.counts.store_provisions,
      audit_id: Number(audit[0].id),
      audit_created_at: audit[0].created_at,
      export: exported,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function notifyStoreGone(store) {
  try {
    const { invalidateStoreAuthCache } = await import('../middleware/auth.js');
    invalidateStoreAuthCache(store.id);
  } catch { /* cache is best-effort */ }
  try {
    const { broadcastLicenceChange } = await import('../ws/syncHub.js');
    broadcastLicenceChange(store.id, {
      access_allowed: false,
      access_reason: 'store_deleted',
      expiry_date: store.expiry_date ? String(store.expiry_date).slice(0, 10) : null,
      is_active: false,
    });
  } catch { /* ws is best-effort */ }
}

/** Read one export file back (used by the restore script and the tests). */
export async function readExport(file) {
  const raw = await fs.promises.readFile(file);
  const json = await gunzip(raw);
  const payload = JSON.parse(json.toString('utf8'));
  if (payload?.format !== 'satpuda-store-export') {
    throw new AppError(400, `${file} is not a Satpuda store export`);
  }
  return payload;
}
