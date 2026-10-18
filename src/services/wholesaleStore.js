/**
 * Wholesale is a SEPARATE store (owner, 18 Oct 2026).
 *
 * A retail store whose `wholesale_enabled` the owner switches on gets a companion
 * store of its own: `store_kind = 'wholesale'`, `parent_store_id` = the retail
 * store. The companion is an ordinary store for every sync and document route
 * (its own medicines, purchases, sales, customers, suppliers, payments,
 * settings); nothing is ever copied between the two. The only things that join
 * them are the two columns on `stores` and the links this file puts on the
 * licence / auth payload:
 *
 *   retail store, companion offered:  wholesale_store {store_id, store_key, store_name, android_key}
 *   wholesale store:                   retail_store    {store_id, store_key, store_name, android_key}
 *
 * Missing = no companion. A companion is never deleted from here: switching
 * wholesale OFF on the retail store only stops offering it (no `wholesale_store`)
 * and makes the companion's own payload say `wholesale_enabled: false`. Its data
 * stays, and switching ON again offers the same store again.
 *
 * The companion row is made exactly like the admin panel's "create store"
 * (adminService.createStore): a `stores` row with a fresh SC- key from
 * `generateAndroidKey`, a `pharmacy_profiles` row (name, GST on) and a
 * `store_dropdowns` row. Everything else a store has is created lazily by the
 * routes that use it (store_sync_state, store_settings, shelf_settings, ...).
 */
import { query, withTransaction } from '../db/pool.js';
import { AppError } from '../utils/http.js';
import { generateAndroidKey } from '../utils/fy.js';
import { licensePayload } from './licenseService.js';

export const STORE_KINDS = Object.freeze(['retail', 'wholesale']);

/** Advisory-lock namespace for "make the companion of retail store N". */
const COMPANION_LOCK = 4244;

/** The columns a link and the payload decisions are read from. */
const LINK_COLS = `id, store_id, store_key, store_name, android_key, is_active,
  wholesale_enabled, store_kind, parent_store_id`;

/** 'wholesale' only when the row says so; anything else (missing, NULL, junk) is retail. */
export function storeKindOf(store) {
  return store?.store_kind === 'wholesale' ? 'wholesale' : 'retail';
}

/**
 * The identity a retail store's companion is given. `attempt` > 0 only when the
 * plain names are already taken by some other store (UNIQUE store_id/store_key):
 * the companion then gets `_wholesale_2`, `_wholesale_3`, ... rather than failing.
 */
export function companionIdentity(parent, attempt = 0) {
  const n = attempt > 0 ? `_${attempt + 1}` : '';
  return {
    store_id: `${parent.store_id}_wholesale${n}`,
    store_key: `${parent.store_key}_Wholesale${n}`,
    store_name: `${String(parent.store_name || '').trim()} Wholesale`,
  };
}

/** The four fields a device needs to open the other store. */
export function linkFields(row) {
  if (!row) return null;
  return {
    store_id: row.store_id,
    store_key: row.store_key,
    store_name: row.store_name,
    android_key: row.android_key || null,
  };
}

/**
 * Whether a retail store offers its companion: the retail switch is ON, the
 * companion exists, its own switch is ON and the admin has not turned it off.
 */
export function companionOffered(retail, companion) {
  return storeKindOf(retail) === 'retail'
    && retail?.wholesale_enabled === true
    && Boolean(companion)
    && storeKindOf(companion) === 'wholesale'
    && companion.wholesale_enabled === true
    && companion.is_active !== false;
}

/**
 * The link part of a payload, pure. `companion` is the retail store's companion
 * row (or null), `parent` the wholesale store's retail row (or null).
 */
export function linkPayload(store, { companion = null, parent = null } = {}) {
  const kind = storeKindOf(store);
  const out = { store_kind: kind };
  if (kind === 'retail' && companionOffered(store, companion)) {
    out.wholesale_store = linkFields(companion);
  }
  if (kind === 'wholesale' && parent) {
    out.retail_store = linkFields(parent);
  }
  return out;
}

/** The retail store's companion row, or null. Read only. */
export async function findCompanion(retailStorePk, db = { query }) {
  const { rows } = await db.query(
    `SELECT ${LINK_COLS} FROM stores
      WHERE parent_store_id = $1 AND store_kind = 'wholesale'
      ORDER BY id LIMIT 1`,
    [Number(retailStorePk)],
  );
  return rows[0] || null;
}

async function findLinkRow(storePk) {
  const { rows } = await query(`SELECT ${LINK_COLS} FROM stores WHERE id = $1`, [Number(storePk)]);
  return rows[0] || null;
}

function invalidateAuth(storePk) {
  return import('../middleware/auth.js')
    .then(({ invalidateStoreAuthCache }) => invalidateStoreAuthCache(storePk))
    .catch(() => {});
}

/**
 * Make sure a retail store with wholesale switched on has its companion, and that
 * the companion's own switch is on. Idempotent and safe to race: everything runs
 * in one transaction behind an advisory lock on the retail store, so two calls at
 * once (admin PATCH and a PC reading its licence) make ONE companion.
 *
 * Returns the companion row (LINK_COLS), or null when there is nothing to do:
 * the store is missing, is itself a wholesale store, or has wholesale switched off
 * (an existing companion is then returned untouched -- this never turns anything
 * off and never deletes).
 */
export async function ensureWholesaleCompanion(retailStorePk) {
  const pk = Number(retailStorePk);
  if (!Number.isInteger(pk) || pk <= 0) throw new AppError(400, 'retail store id required');
  const result = await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(${COMPANION_LOCK}, $1::int)`, [pk]);
    const { rows: parents } = await client.query(`SELECT * FROM stores WHERE id = $1 FOR UPDATE`, [pk]);
    const parent = parents[0];
    if (!parent || storeKindOf(parent) !== 'retail') return { companion: null, changed: false };

    const existing = await findCompanion(pk, client);
    if (parent.wholesale_enabled !== true) return { companion: existing, changed: false };
    if (existing) {
      if (existing.wholesale_enabled === true) return { companion: existing, changed: false };
      const { rows } = await client.query(
        `UPDATE stores SET wholesale_enabled = TRUE, updated_at = NOW()
          WHERE id = $1 RETURNING ${LINK_COLS}`,
        [existing.id],
      );
      return { companion: rows[0], changed: true };
    }

    // Pick names nobody holds. Under the lock only an unrelated admin "create
    // store" could race us, and that would fail on the UNIQUE index, not merge.
    let identity = null;
    for (let attempt = 0; attempt < 20 && !identity; attempt += 1) {
      const cand = companionIdentity(parent, attempt);
      const { rows: taken } = await client.query(
        `SELECT id FROM stores WHERE store_id = $1 OR store_key = $2 LIMIT 1`,
        [cand.store_id, cand.store_key],
      );
      if (!taken.length) identity = cand;
    }
    if (!identity) throw new AppError(409, 'No free store id for the wholesale store');
    let androidKey = null;
    for (let attempt = 0; attempt < 10 && !androidKey; attempt += 1) {
      const key = generateAndroidKey();
      const { rows: taken } = await client.query(
        `SELECT id FROM stores WHERE android_key = $1 LIMIT 1`, [key],
      );
      if (!taken.length) androidKey = key;
    }
    if (!androidKey) throw new AppError(503, 'Could not make a pairing key, try again');

    const { rows } = await client.query(
      `INSERT INTO stores (
         store_id, store_key, store_name, android_key, app_mode, device_role,
         is_active, activation_date, expiry_enabled, expiry_date, apply_expiry_check,
         provisioned_trial, wholesale_enabled, store_kind, parent_store_id, notes
       ) VALUES ($1,$2,$3,$4,$5,'pc',
         TRUE, $6, $7, $8, $9,
         FALSE, TRUE, 'wholesale', $10, $11)
       RETURNING ${LINK_COLS}`,
      [
        identity.store_id,
        identity.store_key,
        identity.store_name,
        androidKey,
        parent.app_mode || 'online',
        parent.activation_date || null,
        parent.expiry_enabled === true,
        parent.expiry_date || null,
        parent.apply_expiry_check !== false,
        pk,
        `Wholesale store of ${parent.store_name} (${parent.store_id}). Its own data; never copied from the retail store.`,
      ],
    );
    const companion = rows[0];
    await client.query(
      `INSERT INTO pharmacy_profiles (store_pk, name, gst_enabled) VALUES ($1,$2,TRUE)`,
      [companion.id, companion.store_name],
    );
    await client.query(`INSERT INTO store_dropdowns (store_pk) VALUES ($1)`, [companion.id]);
    return { companion, changed: true };
  });
  if (result.changed && result.companion) await invalidateAuth(result.companion.id);
  return result.companion;
}

/**
 * Wholesale switched OFF on a retail store: the companion stays (with its data)
 * but its own switch goes off, so its payload says `wholesale_enabled: false`.
 * Returns the ids it switched off.
 */
export async function switchOffCompanion(retailStorePk) {
  const { rows } = await query(
    `UPDATE stores SET wholesale_enabled = FALSE, updated_at = NOW()
      WHERE parent_store_id = $1 AND store_kind = 'wholesale' AND wholesale_enabled = TRUE
      RETURNING id`,
    [Number(retailStorePk)],
  );
  for (const r of rows) await invalidateAuth(r.id);
  return rows.map((r) => r.id);
}

/**
 * The links for one store row, read from the database. For a retail store with
 * wholesale switched on whose companion is missing (or switched off), the
 * companion is made / switched on here first -- the lazy half of the contract.
 */
export async function storeLinks(store) {
  if (!store) return { store_kind: 'retail' };
  const kind = storeKindOf(store);
  if (kind === 'wholesale') {
    const parent = store.parent_store_id ? await findLinkRow(store.parent_store_id) : null;
    return linkPayload(store, { parent });
  }
  if (store.wholesale_enabled !== true) return linkPayload(store);
  let companion = await findCompanion(store.id);
  if (!companion || companion.wholesale_enabled !== true) {
    companion = await ensureWholesaleCompanion(store.id);
  }
  return linkPayload(store, { companion });
}

/** licensePayload plus the store links: what /auth and the licence routes answer. */
export async function licensePayloadWithLinks(store) {
  return { ...licensePayload(store), ...(await storeLinks(store)) };
}

/**
 * For the admin panel: the other half of a store, whichever way round.
 * { kind, companion: {id, store_id, store_name, android_key, wholesale_enabled, is_active} }
 * for a retail store with one, { kind, retail: {...} } for a wholesale store.
 */
export async function adminStoreLink(store) {
  const kind = storeKindOf(store);
  const pick = (r) => (r ? {
    id: r.id,
    store_id: r.store_id,
    store_key: r.store_key,
    store_name: r.store_name,
    android_key: r.android_key || null,
    wholesale_enabled: r.wholesale_enabled === true,
    is_active: r.is_active !== false,
  } : null);
  if (kind === 'wholesale') {
    return { kind, retail: pick(store.parent_store_id ? await findLinkRow(store.parent_store_id) : null) };
  }
  return { kind, companion: pick(await findCompanion(store.id)) };
}

/** The fields a device may never set on its own store row. */
export const STORE_LINK_FIELDS = Object.freeze([
  'store_kind', 'parent_store_id', 'wholesale_store', 'retail_store',
]);
