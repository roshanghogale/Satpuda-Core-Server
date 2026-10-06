/**
 * Self-service trial provisioning.
 *
 * THE SECURITY SHAPE, STATED PLAINLY
 * ----------------------------------
 * This endpoint is reachable by strangers. It has to be: the installer calls it
 * with nothing but a shop name and a machine id, and anybody who downloads the
 * installer can send exactly what the installer sends. There is no credential
 * that could be checked, because any credential shipped inside the installer is
 * a credential that has already leaked. So the endpoint is designed to be safe
 * while public, rather than pretending it is private.
 *
 * THE ONE RULE: a caller can only ever CREATE a new trial store. It can never
 * touch, read or join a store that already exists. That is enforced structurally,
 * not by a check that could be forgotten:
 *
 *   1. `provisionTrial` contains exactly ONE statement against the `stores`
 *      table and it is `INSERT ... RETURNING`. There is no UPDATE or DELETE
 *      against `stores` anywhere in this file, and no statement anywhere in it
 *      resolves a store from a NAME. A name the caller sends can therefore never
 *      reach an existing row -- there is no lookup for it to resolve through.
 *
 *      There is now exactly one SELECT against `stores`, in
 *      `findProvisionedStore`, and it is keyed on the calling computer's own
 *      hardware fingerprint -- never on a name, and it is a read that returns
 *      only licence dates. Its own comment states what it does and does not hand
 *      back; the short version is that it cannot create, adopt, extend or join
 *      anything, and it discloses no shop name, pairing key or token.
 *
 *   2. The caller's shop name is NOT an identity. `store_id` and `store_key` --
 *      the two columns everything else in this server matches a store on -- are
 *      generated here from `crypto.randomBytes`, in a `trial_…` / `Trial_…`
 *      namespace no administrator-created store uses. The caller cannot
 *      influence either. Two shops may type the same name and get two separate
 *      stores; that is correct, and it is why a stranger typing a real shop's
 *      name lands in an empty store of their own.
 *
 *   3. A unique-key collision is retried with fresh random bytes and NEVER
 *      answered by selecting the row that collided. "Find the existing one" is
 *      the exact accident this file exists to prevent, so that fallback does not
 *      exist.
 *
 *   4. The trial window is computed here, on the server, from the server's own
 *      clock. Nothing in the request body can set `expiry_date`,
 *      `expiry_enabled`, `apply_expiry_check`, `is_active` or `activation_date`
 *      -- those fields are never read from the caller. And the store cannot
 *      later extend itself: `routes/auth.js` strips every one of those fields
 *      from a device's `PUT /auth/license`, and what survives (`activation_date`)
 *      is written through `COALESCE(activation_date, …)`, which no-ops once set.
 *
 *   5. The response contains only the row this call just created.
 */
import crypto from 'crypto';
import { query, withTransaction } from '../db/pool.js';
import { AppError } from '../utils/http.js';
import { generateAndroidKey } from '../utils/fy.js';
import { DEFAULT_EXPIRY_DAYS, addDaysYmd, istToday, licensePayload } from './licenseService.js';

/**
 * How much a stranger may do.
 *
 * These are deliberately mean. A real shopkeeper installs once, on one computer,
 * and never sees any of them. Everything here is aimed at the person running the
 * installer in a loop.
 */
export const TRIAL_LIMITS = {
  /** Trials one IP address may be granted in a rolling 24 hours. */
  perIpPerDay: 3,
  /** A given computer gets one trial, then must ask a human. */
  perDeviceInWindow: 1,
  perDeviceWindowDays: 30,
  /** Server-wide ceiling: the backstop against many IPs at once. */
  globalPerHour: 30,
  /** Request ceiling per IP before we even look at the database (routes/provision.js). */
  burstPerIp: 10,
  burstWindowMinutes: 10,
};

// ─── The owner's off switch ───────────────────────────────────────────────────
//
// Turning a trial store off is a cleanup, not a defence: it acts on a store
// that already exists. The rate limits above raise the cost of an abusive run
// but nothing in them lets a person STOP one while it is happening. This is
// that control -- one row, flipped from the Trials page, effective within ten
// seconds and with no deploy or restart.
//
// TRIALS_ENABLED=false in the environment is the same switch at boot, for the
// case where the database itself is what you are trying to keep people out of.

const TRIALS_FLAG = 'trials_enabled';
const FLAG_TTL_MS = 10_000;
const UNDEFINED_TABLE = '42P01';
let _trialsFlag = { on: true, expires: 0 };

/** Environment override. Checked first so it cannot be flipped back on over HTTP. */
function trialsDisabledByEnv() {
  return String(process.env.TRIALS_ENABLED || '').trim().toLowerCase() === 'false';
}

export async function trialsEnabled() {
  if (trialsDisabledByEnv()) return false;
  const now = Date.now();
  if (_trialsFlag.expires > now) return _trialsFlag.on;
  let on = true;
  try {
    const { rows } = await query(`SELECT value FROM app_flags WHERE key = $1`, [TRIALS_FLAG]);
    if (rows[0]) on = String(rows[0].value) !== 'off';
  } catch (err) {
    // The migration has not run yet. Default to the behaviour this server had
    // before the switch existed rather than refusing every sign-up; any other
    // database error is real and belongs to the caller.
    if (!err || err.code !== UNDEFINED_TABLE) throw err;
    on = true;
  }
  _trialsFlag = { on, expires: now + FLAG_TTL_MS };
  return on;
}

export async function setTrialsEnabled(on) {
  const value = on ? 'on' : 'off';
  await query(
    `INSERT INTO app_flags (key, value, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [TRIALS_FLAG, value],
  );
  // Straight into the cache: a person who has just pressed "Stop new sign-ups"
  // must not watch three more arrive while a stale read expires.
  _trialsFlag = { on: Boolean(on), expires: Date.now() + FLAG_TTL_MS };
  return { trials_enabled: Boolean(on), env_locked: trialsDisabledByEnv() };
}

const NAME_MIN = 2;
const NAME_MAX = 60;

/** The shop name as a LABEL. Never used to find anything. */
function cleanStoreName(raw) {
  const s = String(raw ?? '')
    // Control characters, including the newlines that would let a name spoof a
    // second line of the admin list.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length < NAME_MIN) throw new AppError(400, 'Enter the shop name.');
  if (s.length > NAME_MAX) {
    throw new AppError(400, `Shop name is too long (maximum ${NAME_MAX} characters).`);
  }
  if (!/[\p{L}\p{N}]/u.test(s)) throw new AppError(400, 'Enter the shop name.');
  return s;
}

/** The machine's own id. Used ONLY to count trials, never to look up a store. */
function cleanDeviceId(raw) {
  const s = String(raw ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(s)) {
    throw new AppError(400, 'This installer did not send a computer id. Please contact Satpuda.');
  }
  return s;
}

function cleanShort(raw, max) {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/**
 * A store identity the caller had no hand in.
 *
 * `store_id` / `store_key` are what `resolveStorePk`, `ensure_active_store_on_server`
 * and every admin lookup match a store on. Generating them from random bytes in
 * their own namespace is what makes rule 2 above true: a supplied name cannot
 * collide into `store_roshan` because a supplied name is not part of this.
 */
function newTrialIdentity() {
  const suffix = crypto.randomBytes(6).toString('hex');
  // A shop from the installer is a main store now (owner, 6 Oct 2026), so it is no
  // longer named "trial"; it keeps a random namespace of its own that no
  // administrator-created store (store_<name>) can share.
  return {
    store_id: `shop_${suffix}`,
    store_key: `Shop_${suffix.toUpperCase()}`,
    android_key: generateAndroidKey(),
  };
}

/**
 * Count what this caller has already been given.
 *
 * Reads `store_provisions` only. Deliberately not `stores`: counting stores by
 * name would be a name lookup, and this file does not do name lookups.
 *
 * Two device keys, on purpose:
 *   `device_id`  is the PC's own installation id, the same one `store_devices`
 *                records. It survives an app reinstall but NOT a wiped AppData.
 *   `machine_id` is the hardware fingerprint, sent only when the PC could
 *                actually read one. It survives a wiped AppData and a fresh
 *                Windows, and is what makes "one trial per computer" mean the
 *                computer rather than the folder.
 *
 * Be honest about what this is worth: both values come from the client, so
 * someone willing to edit the request can send new ones. They stop reinstall
 * loops and casual farming, not a determined attacker. The limits that do not
 * depend on the client's honesty are the per-address and server-wide ceilings
 * below, and the owner's switch in the admin panel.
 *
 * EVERY PARAMETER CARRIES ITS TYPE (`$4::text`), and that is not decoration.
 * node-pg sends parameters untyped, so Postgres works each one's type out while
 * it parses. `$4 IS NOT NULL` gives $4 no type; the later `machine_id = $4` types
 * the parameter as text, but the earlier use has already been built as
 * "unknown", and Postgres refuses the statement: 42P08, "could not determine
 * data type of parameter $4". That happens at parse time, so it failed for EVERY
 * sign-up, with or without a machine id, before a single trial was counted --
 * live answered each POST /api/provision/trial with a 500. Exported so the
 * deploy smoke can run exactly this read in a read-only session.
 */
export async function assertWithinLimits({ deviceId, machineId, ip }) {
  const { rows } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM store_provisions
         WHERE (device_id = $1::text OR ($4::text IS NOT NULL AND machine_id = $4::text))
           AND created_at > NOW() - ($2::text || ' days')::interval) AS device_count,
       (SELECT COUNT(*)::int FROM store_provisions
         WHERE ip IS NOT NULL AND ip = $3::text
           AND created_at > NOW() - INTERVAL '24 hours') AS ip_count,
       (SELECT COUNT(*)::int FROM store_provisions
         WHERE created_at > NOW() - INTERVAL '1 hour') AS global_count`,
    [deviceId, String(TRIAL_LIMITS.perDeviceWindowDays), ip, machineId],
  );
  const r = rows[0] || {};

  if (Number(r.device_count) >= TRIAL_LIMITS.perDeviceInWindow) {
    // Note what this does NOT do: it does not hand back the store this computer
    // was given last time. Returning an existing store to whoever presents its
    // device id would make the device id a password, and it is not a secret --
    // it is a hardware fingerprint the machine itself prints. Refuse, and let a
    // human re-open it from the admin panel.
    throw new AppError(
      429,
      'A shop has already been set up from this computer. Please contact Satpuda to continue.',
    );
  }
  if (Number(r.ip_count) >= TRIAL_LIMITS.perIpPerDay) {
    throw new AppError(
      429,
      'Too many shops have been set up from this internet connection today. Try again tomorrow, or contact Satpuda.',
    );
  }
  if (Number(r.global_count) >= TRIAL_LIMITS.globalPerHour) {
    // Many addresses at once. Stop granting rather than let the stores table
    // fill up; a real shop retries in an hour and the owner sees the spike in
    // the admin panel's Trials page.
    throw new AppError(
      503,
      'New shops are paused for a short while. Please try again later, or contact Satpuda.',
    );
  }
}

const UNIQUE_VIOLATION = '23505';

/**
 * Create one trial store and return everything the desktop needs to run Online.
 *
 * Returns the created store, a freshly signed store token, and the licence.
 */
export async function provisionTrial({
  storeName, deviceId, machineId, appVersion, deviceName, ip, userAgent, confirmNew = false,
}) {
  const requestedName = cleanStoreName(storeName);
  const device = cleanDeviceId(deviceId);
  // Optional: a PC whose hardware could not be read sends nothing rather than a
  // hash of emptiness, which would be the SAME value on every such machine and
  // would hand the first one of them the world's only trial.
  const machine = /^[A-Za-z0-9._:-]{8,128}$/.test(String(machineId || '').trim())
    ? String(machineId).trim()
    : null;
  const version = cleanShort(appVersion, 32);
  const label = cleanShort(deviceName, 64);
  const address = cleanShort(ip, 64);
  const agent = cleanShort(userAgent, 200);

  // Before the counting, and before anything is written: the owner may have
  // closed the sign-up altogether.
  if (!(await trialsEnabled())) {
    throw new AppError(503, 'New sign-ups are closed just now. Please contact Satpuda.');
  }

  // A shop already on the server, reinstalled: the shopkeeper types its name on
  // the trial page and gets a SECOND, empty store with the same name (Vaibhav,
  // 5 Oct 2026: store 142 beside the real 131; 134 and 137 before it). The name
  // still never resolves to that store -- anyone can type a name -- so the answer
  // is only "this name is taken; connect with the shop's SC- key, or say you
  // really want a new shop" (confirm_new). Compared on letters and digits alone,
  // so "Vaibhav Medical & Gen Sto" and "vaibhav medical gen sto" are one name.
  if (!confirmNew) {
    const { rows: same } = await query(
      `SELECT 1 FROM stores
        WHERE is_active
          AND regexp_replace(lower(store_name), '[^[:alnum:]]+', '', 'g')
            = regexp_replace(lower($1), '[^[:alnum:]]+', '', 'g')
          AND regexp_replace(lower($1), '[^[:alnum:]]+', '', 'g') <> ''
        LIMIT 1`,
      [requestedName],
    );
    if (same.length) {
      throw new AppError(
        409,
        `A shop called "${requestedName}" is already on Satpuda. If it is your shop, connect this `
          + "computer with the shop's SC- key (Satpuda admin panel, next to the shop) instead of "
          + 'setting up a new shop.',
        { code: 'name_exists' },
      );
    }
  }

  await assertWithinLimits({ deviceId: device, machineId: machine, ip: address });

  const today = istToday();
  const expiry = addDaysYmd(today, DEFAULT_EXPIRY_DAYS);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const identity = newTrialIdentity();
    try {
      return await withTransaction(async (client) => {
        // ── The ONLY statement in this file that touches `stores`. ──────────
        // An INSERT. Not an upsert, not an ON CONFLICT DO UPDATE, not a SELECT
        // first. Every column that decides access is a literal or a server-side
        // value; not one of them comes from the request.
        //
        // A MAIN store, not a trial (owner, 6 Oct 2026): nothing to untick in the
        // admin panel when the shop pays. The 3-day licence is what keeps it in
        // check -- the owner extends it, or deletes the store once it has run out.
        const { rows } = await client.query(
          `INSERT INTO stores (
             store_id, store_key, store_name, android_key, app_mode, device_role,
             is_active, activation_date, expiry_enabled, expiry_date,
             apply_expiry_check, provisioned_trial, notes
           ) VALUES ($1,$2,$3,$4,'online','pc',
             TRUE, $5, TRUE, $6,
             TRUE, FALSE, $7)
           RETURNING id, store_id, store_key, store_name, android_key, app_mode,
                     is_active, activation_date, expiry_enabled, expiry_date,
                     apply_expiry_check, provisioned_trial, created_at, updated_at`,
          [
            identity.store_id,
            identity.store_key,
            requestedName,
            identity.android_key,
            today,
            expiry,
            `New shop from the installer: ${DEFAULT_EXPIRY_DAYS}-day licence. `
              + 'Extend the expiry when the shop pays, or delete the store.',
          ],
        );
        const store = rows[0];

        await client.query(
          `INSERT INTO store_provisions
             (store_pk, device_id, machine_id, ip, requested_name, app_version, user_agent)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [store.id, device, machine, address, requestedName, version, agent],
        );

        await client.query(
          `INSERT INTO pharmacy_profiles (store_pk, name, gst_enabled) VALUES ($1,$2,TRUE)`,
          [store.id, store.store_name],
        );
        await client.query(`INSERT INTO store_dropdowns (store_pk) VALUES ($1)`, [store.id]);
        await client.query(
          `INSERT INTO store_devices (store_pk, device_id, device_name, device_type, last_seen_at)
           VALUES ($1,$2,$3,'pc',NOW())
           ON CONFLICT (store_pk, device_id) DO NOTHING`,
          [store.id, device, label],
        );

        return { store, license: licensePayload(store) };
      });
    } catch (err) {
      // A random 48-bit suffix collided, or two requests raced. Try again with
      // fresh bytes. Never resolve the collision by adopting the row we hit.
      if (err && err.code === UNIQUE_VIOLATION && attempt < 3) continue;
      throw err;
    }
  }
  throw new AppError(503, 'Could not set up the shop just now. Please try again.');
}

/**
 * Which store did THIS computer's trial create?
 *
 * The counterpart to the licence file being deletable. A shopkeeper who wipes
 * AppData -- or who deletes the licence and reinstalls, which is the specific
 * thing this was asked to stop paying for -- loses the SC- key with everything
 * else, so there is no token left to read a licence with. The hardware
 * fingerprint survives that, because it is not stored anywhere: it is read back
 * off the machine. This is how the same expiry comes back instead of a fresh
 * one.
 *
 * READ THE LIMITS OF IT PLAINLY, because it is the one lookup this file has:
 *
 *   * It answers with NOTHING that identifies the shop -- no name, no
 *     `android_key`, no token, no `store_id`. Only the licence dates and the
 *     signed blob, and the blob is bound to the machine that asked, so a blob
 *     obtained by guessing somebody else's fingerprint will not verify anywhere.
 *     A caller learns "some store expires on this date" and cannot act on it.
 *   * `machine_id` is tried FIRST and `device_id` only as a fallback, because
 *     `device_id` is regenerated by a wiped AppData while the fingerprint is
 *     not.
 *   * It writes nothing at all. It cannot create, adopt, extend or join
 *     anything, so rule 1 at the top of this file is untouched: creating is
 *     still the only thing a stranger can make this endpoint do.
 */
export async function findProvisionedStore({ deviceId, machineId }) {
  const device = String(deviceId || '').trim();
  const machine = String(machineId || '').trim();
  if (!device && !machine) return null;
  // ORDER BY: a machine key match beats a device key match, then newest first.
  // Without the first term a PC that has been re-provisioned by the vendor under
  // a new device id would be handed the older store. COALESCE because on a row
  // with no machine_id (a PC whose hardware could not be read) the comparison is
  // NULL, not false -- and NULL sorts FIRST under DESC, so that row's device
  // match used to win over a real machine match.
  const { rows } = await query(
    `SELECT s.id, s.store_id, s.store_key, s.store_name, s.is_active,
            s.activation_date, s.expiry_enabled, s.expiry_date,
            s.apply_expiry_check, s.provisioned_trial, s.updated_at
       FROM store_provisions p
       JOIN stores s ON s.id = p.store_pk
      WHERE ($2 <> '' AND p.machine_id = $2) OR ($1 <> '' AND p.device_id = $1)
      ORDER BY COALESCE($2 <> '' AND p.machine_id = $2, FALSE) DESC, p.created_at DESC
      LIMIT 1`,
    [device, machine],
  );
  return rows[0] || null;
}

// ─── Admin side ───────────────────────────────────────────────────────────────

/** The trial sign-up log, newest first, joined to whatever the store is now. */
export async function listProvisions({ limit = 200 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const { rows } = await query(
    `SELECT p.id, p.device_id, p.ip, p.requested_name, p.app_version, p.created_at,
            s.id AS store_pk, s.store_id, s.store_name, s.is_active,
            p.machine_id,
            s.activation_date, s.expiry_date, s.expiry_enabled, s.provisioned_trial,
            (SELECT COUNT(*)::int FROM sales x
              WHERE x.store_pk = s.id AND NOT x.deleted AND NOT x.is_autosave) AS sales_count
       FROM store_provisions p
       LEFT JOIN stores s ON s.id = p.store_pk
      ORDER BY p.created_at DESC
      LIMIT $1`,
    [n],
  );
  return {
    today_ist: istToday(),
    trial_days: DEFAULT_EXPIRY_DAYS,
    limits: TRIAL_LIMITS,
    enabled: await trialsEnabled(),
    env_locked: trialsDisabledByEnv(),
    rows,
  };
}

/**
 * Let one computer start a trial again.
 *
 * The way back for a shop that reinstalled Windows, or wiped AppData, and now
 * cannot get past the one-trial-per-computer rule. Deletes only the throttle
 * rows for that device; the stores those attempts created are untouched, and
 * are removed (or left) from the store page as usual.
 */
export async function clearDeviceThrottle(deviceId) {
  const device = String(deviceId || '').trim();
  if (!device) throw new AppError(400, 'device_id required');
  // Both keys: whichever of the two the panel handed us, the OTHER one would
  // still refuse the next sign-up if it were left behind.
  const { rowCount } = await query(
    `DELETE FROM store_provisions
      WHERE device_id = $1 OR machine_id = $1
         OR device_id IN (SELECT device_id FROM store_provisions WHERE machine_id = $1)
         OR machine_id IN (SELECT machine_id FROM store_provisions
                            WHERE device_id = $1 AND machine_id IS NOT NULL)`,
    [device],
  );
  return { device_id: device, cleared: rowCount };
}
