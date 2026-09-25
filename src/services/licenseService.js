import { query } from '../db/pool.js';
import { AppError } from '../utils/http.js';

/** Default online trial window after activation (IST calendar days).
 *
 * THE one number. Everything that grants or repairs a trial reads it from here:
 * updateStoreLicense below (a device recording its activation date),
 * provisionService.provisionTrial (the installer's self-service trial), and the
 * trial_days the desktop shows the shopkeeper. Changing it changes all three.
 *
 * It does NOT move a store that already has an expiry_date. Every write below
 * goes through COALESCE(expiry_date, ...), so a shop activated under the old
 * ten-day window keeps the date it was given -- shortening the trial must never
 * expire a shop that is already running.
 */
export const DEFAULT_EXPIRY_DAYS = 3;

function toDateOnly(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    // Interpret as calendar date in IST, not UTC, to avoid off-by-one.
    return istDateOnlyFromUtc(value);
  }
  const raw = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

let _istTodayCache = { day: '', expires: 0 };

/** Today's calendar date in Asia/Kolkata (IST). */
export function istToday(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function cachedIstToday() {
  const now = Date.now();
  if (_istTodayCache.expires > now && _istTodayCache.day) return _istTodayCache.day;
  const day = istToday();
  _istTodayCache = { day, expires: now + 30_000 };
  return day;
}

function istDateOnlyFromUtc(date) {
  return istToday(date);
}

/** Add N calendar days to YYYY-MM-DD (date-only arithmetic, no TZ shift). */
export function addDaysYmd(ymd, days) {
  const base = toDateOnly(ymd);
  if (!base) return null;
  const [y, m, d] = base.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(days));
  return dt.toISOString().slice(0, 10);
}

export function expiryFromActivation(activationDate, days = DEFAULT_EXPIRY_DAYS) {
  return addDaysYmd(activationDate, days);
}

/** The four levels an administrator may cap a shop PC at. */
export const VOICE_TIERS = Object.freeze(['auto', '1', '2', '3']);

/**
 * A stored or submitted voice tier, as one of VOICE_TIERS, or null when it is
 * not one. Numbers are accepted (the panel's select may hand over 2, not '2').
 */
export function parseVoiceTier(value) {
  if (value === undefined || value === null) return null;
  const t = String(value).trim().toLowerCase();
  return VOICE_TIERS.includes(t) ? t : null;
}

/**
 * The voice switch as a device should read it. OFF unless the row says TRUE --
 * a row from before the column existed, or a NULL, is OFF -- and an unknown
 * tier reads as 'auto' rather than as something the PC might over-run.
 */
export function voiceFields(store) {
  return {
    voice_enabled: store?.voice_enabled === true,
    voice_tier: parseVoiceTier(store?.voice_tier) || 'auto',
  };
}

export function licensePayload(store) {
  const activationDate = toDateOnly(store.activation_date);
  const expiryDate = toDateOnly(store.expiry_date);
  const expiryEnabled = Boolean(store.expiry_enabled);
  const applyExpiryCheck = store.apply_expiry_check !== false && store.apply_expiry_check !== 0;
  const isActive = store.is_active !== false && store.is_active !== 0;
  const access = evaluateAccess({
    is_active: isActive,
    apply_expiry_check: applyExpiryCheck,
    expiry_enabled: expiryEnabled,
    expiry_date: expiryDate,
  });
  return {
    is_active: isActive,
    activation_date: activationDate,
    expiry_enabled: expiryEnabled,
    expiry_date: expiryDate,
    apply_expiry_check: applyExpiryCheck,
    access_allowed: !access.blocked,
    access_reason: access.reason || null,
    server_date: access.today,
    // The trial length travels WITH the licence so the desktop never has to
    // hold its own copy of the number. A build shipped before this line simply
    // ignores the field; a build shipped after it stops being able to disagree
    // with the server about how long a trial is.
    trial_days: DEFAULT_EXPIRY_DAYS,
    is_trial: Boolean(store.provisioned_trial),
    // Voice assistant switch (admin panel only). Deliberately NOT inside the
    // signed blob: it is a feature toggle, not access, and old blobs must keep
    // verifying. A desktop that finds no field treats voice as OFF.
    ...voiceFields(store),
  };
}

export function evaluateAccess(store, today = null) {
  const day = today || istToday();
  if (store.is_active === false || store.is_active === 0) {
    return { blocked: true, reason: 'access_disabled', today: day };
  }
  const apply = store.apply_expiry_check !== false && store.apply_expiry_check !== 0;
  const enabled = Boolean(store.expiry_enabled);
  const expiryDate = toDateOnly(store.expiry_date);
  // Block starting on the expiry calendar day (IST).
  if (apply && enabled && expiryDate && day >= expiryDate) {
    return { blocked: true, reason: 'expired', today: day };
  }
  return { blocked: false, reason: null, today: day };
}

/** The columns a licence is decided from, plus the row version the seal signs. */
const LICENSE_COLS = `id, store_id, store_key, store_name, is_active,
            activation_date, expiry_enabled, expiry_date, apply_expiry_check,
            provisioned_trial, voice_enabled, voice_tier, updated_at`;

/**
 * The raw store row behind a licence.
 *
 * `getStoreLicense` returns the PAYLOAD, which has already thrown away
 * `updated_at` — and `updated_at` is the serial the signed blob carries so a
 * stale blob loses to a fresh one. Signing needs the row, so the row is what
 * this returns; nothing else about the read changes.
 */
export async function getStoreRecord(storePk) {
  const { rows } = await query(`SELECT ${LICENSE_COLS} FROM stores WHERE id = $1`, [storePk]);
  if (!rows[0]) throw new AppError(404, 'Store not found');
  return rows[0];
}

export async function getStoreLicense(storePk) {
  return licensePayload(await getStoreRecord(storePk));
}

/**
 * The update, returning the ROW rather than the payload.
 *
 * The signed blob has to be made from the row (it carries `updated_at` as its
 * serial), and it has to be made from THIS row -- the one this statement just
 * wrote -- not from a re-read a moment later, so that the record and the blob
 * the desktop stores can never describe two different licences.
 */
export async function updateStoreLicenseRow(storePk, patch = {}) {
  const fields = [];
  const vals = [];
  let i = 1;

  if (patch.is_active !== undefined) {
    fields.push(`is_active = $${i++}`);
    vals.push(Boolean(patch.is_active));
  }
  if (patch.expiry_enabled !== undefined) {
    fields.push(`expiry_enabled = $${i++}`);
    vals.push(Boolean(patch.expiry_enabled));
  }
  if (patch.apply_expiry_check !== undefined) {
    fields.push(`apply_expiry_check = $${i++}`);
    vals.push(Boolean(patch.apply_expiry_check));
  }
  if (patch.expiry_date !== undefined) {
    const d = toDateOnly(patch.expiry_date);
    if (patch.expiry_date && !d) throw new AppError(400, 'expiry_date must be YYYY-MM-DD');
    fields.push(`expiry_date = $${i++}`);
    vals.push(d);
  }
  if (patch.activation_date !== undefined) {
    const d = toDateOnly(patch.activation_date);
    if (patch.activation_date && !d) throw new AppError(400, 'activation_date must be YYYY-MM-DD');
    // Only set activation_date if currently null, unless force=true
    if (patch.force_activation_date) {
      fields.push(`activation_date = $${i++}`);
      vals.push(d);
    } else {
      fields.push(`activation_date = COALESCE(activation_date, $${i++})`);
      vals.push(d);
    }
    // Default: 10 IST days from activation when client records activation
    // and does not send an explicit expiry_date.
    if (d && patch.expiry_date === undefined) {
      const exp = expiryFromActivation(d, DEFAULT_EXPIRY_DAYS);
      fields.push(`expiry_date = COALESCE(expiry_date, $${i++})`);
      vals.push(exp);
      if (patch.expiry_enabled === undefined) {
        fields.push(`expiry_enabled = TRUE`);
      }
      if (patch.apply_expiry_check === undefined) {
        fields.push(`apply_expiry_check = TRUE`);
      }
    }
  }

  if (!fields.length) {
    // A ROW, because that is what this function promises. Returning the payload
    // here (which is what the single-function version did) would leave the
    // caller holding two different shapes depending on whether the patch
    // happened to be empty, and updateStoreLicense would wrap a payload in
    // licensePayload a second time.
    return getStoreRecord(storePk);
  }
  fields.push('updated_at = NOW()');
  vals.push(storePk);
  const { rows } = await query(
    `UPDATE stores SET ${fields.join(', ')} WHERE id = $${i} RETURNING
       id, store_id, store_key, store_name, is_active,
       activation_date, expiry_enabled, expiry_date, apply_expiry_check,
       provisioned_trial, voice_enabled, voice_tier, updated_at`,
    vals
  );
  if (!rows[0]) throw new AppError(404, 'Store not found');
  try {
    const { invalidateStoreAuthCache } = await import('../middleware/auth.js');
    invalidateStoreAuthCache(storePk);
  } catch {
    /* cache is optional */
  }
  return rows[0];
}

export async function updateStoreLicense(storePk, patch = {}) {
  return licensePayload(await updateStoreLicenseRow(storePk, patch));
}

/**
 * Ensure every store with an activation_date has expiry = activation + N days (IST).
 * Used by admin/ops to repair licenses after deploy.
 *
 * `days` is REQUIRED and has no default on purpose. It used to default to
 * DEFAULT_EXPIRY_DAYS, which was survivable while that number was 10 and every
 * shop had been given ten days anyway. At 3 the same call becomes a fleet-wide
 * outage: it rewrites EVERY store with an activation_date to activation + 3, so
 * a shop activated last month lands on an expiry date in the past and is locked
 * out of its own till the moment somebody runs the repair helper with no
 * argument. Whoever repairs licences has to say out loud how long a licence is.
 */
export async function refreshExpiryFromActivation(days, opts = {}) {
  const n = Number(days);
  if (!Number.isInteger(n) || n <= 0) {
    throw new AppError(400, 'refreshExpiryFromActivation needs an explicit positive day count');
  }
  days = n;
  const force = Boolean(opts.force);
  const today = istToday();
  const { rows } = await query(
    `SELECT id, store_name, activation_date, expiry_date, expiry_enabled, is_active
     FROM stores
     WHERE activation_date IS NOT NULL
     ORDER BY id`
  );
  const updated = [];
  for (const row of rows) {
    const act = toDateOnly(row.activation_date);
    if (!act) continue;
    const exp = expiryFromActivation(act, days);
    if (!force && row.expiry_date && toDateOnly(row.expiry_date) === exp && row.expiry_enabled) {
      continue;
    }
    const { rows: out } = await query(
      `UPDATE stores SET
         expiry_enabled = TRUE,
         apply_expiry_check = TRUE,
         expiry_date = $2,
         is_active = TRUE,
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, store_name, activation_date, expiry_date, expiry_enabled`,
      [row.id, exp]
    );
    if (out[0]) updated.push(out[0]);
  }
  return { today_ist: today, days, updated };
}

export async function assertStoreAccess(store) {
  const today = cachedIstToday();
  const access = evaluateAccess(store, today);
  if (access.blocked) {
    const msg =
      access.reason === 'expired'
        ? 'Store license expired. Contact administrator.'
        : 'Store access disabled by administrator.';
    throw new AppError(403, msg);
  }
  return access;
}
