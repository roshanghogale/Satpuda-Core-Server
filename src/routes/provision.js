/**
 * The one endpoint the installer calls.
 *
 * POST /api/provision/trial
 *   { store_name, device_id, [machine_id], [app_version], [device_name] }
 *
 * No token, no admin credential, no signing key -- by design. Anything the
 * installer could carry, anyone who downloads the installer also carries. See
 * services/provisionService.js for the full security shape and, in particular,
 * for why a shop name sent to this endpoint can never reach an existing store.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError, asyncHandler, ok, trustedClientIp } from '../utils/http.js';
import { signStoreToken } from '../middleware/auth.js';
import {
  TRIAL_LIMITS,
  findProvisionedStore,
  provisionTrial,
} from '../services/provisionService.js';
import { licensePayload } from '../services/licenseService.js';
import { sealAvailable, signLicense } from '../services/licenseSeal.js';

const router = Router();

/**
 * The cheap gate, in front of the database.
 *
 * The counts in provisionService are the real limits, but they cost a query
 * each. This one costs nothing and stops a machine hammering the endpoint from
 * ever reaching Postgres. Failed attempts count too -- the point is the volume,
 * not the outcome.
 */
export const provisionLimiter = rateLimit({
  windowMs: TRIAL_LIMITS.burstWindowMinutes * 60 * 1000,
  max: TRIAL_LIMITS.burstPerIp,
  standardHeaders: true,
  legacyHeaders: false,
  // NOT the default `req.ip`. With the Node port reachable from the internet
  // (0.0.0.0:3000, no firewall) a caller that skips Caddy sets its own
  // X-Forwarded-For, and `trust proxy: 1` believes it -- so the default key
  // gives every forged header a fresh, empty bucket and this limiter counts
  // nothing at all. trustedClientIp falls back to the TCP peer whenever the
  // request did not come through the local proxy.
  keyGenerator: (req) => trustedClientIp(req),
  message: {
    ok: false,
    error: 'Too many attempts from this connection. Wait a few minutes and try again.',
  },
});

router.post(
  '/trial',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const result = await provisionTrial({
      storeName: body.store_name,
      deviceId: body.device_id,
      machineId: body.machine_id,
      appVersion: body.app_version,
      deviceName: body.device_name,
      // The peer's real address. Deliberately not `req.ip`: that is
      // X-Forwarded-For when the caller talks to :3000 directly, which makes
      // the per-address grant limit below something the caller sets for itself.
      ip: trustedClientIp(req),
      userAgent: req.headers['user-agent'],
      // Strictly true: "a shop with this name exists, make a new one anyway".
      confirmNew: body.confirm_new === true,
    });
    const { store, license } = result;
    // Handed over so the desktop is Online in one call instead of pairing again
    // straight afterwards. It is a token for the store this call just created
    // and nothing else -- signStoreToken puts that store's own id in the claim.
    const token = signStoreToken(store, body.device_id);
    ok(res, {
      token,
      store: {
        id: store.id,
        store_id: store.store_id,
        store_key: store.store_key,
        store_name: store.store_name,
        app_mode: store.app_mode,
        android_key: store.android_key,
      },
      license,
      // The seal, in the same call that granted the trial, so a fresh install is
      // never briefly running on an unsigned licence. An Offline shop especially:
      // this is the one moment it is known to have internet, and it is the moment
      // it must come away with a blob it can be held to later.
      signed: signLicense({
        store,
        license,
        machineId: body.machine_id,
        deviceId: body.device_id,
        binding: body.hw_parts,
      }),
      seal_available: sealAvailable(),
      trial_days: license.trial_days,
    });
  }),
);

/**
 * A second, tighter bucket in front of the recovery endpoint.
 *
 * The trial limiter above is shared across /api/provision, and its allowance is
 * sized for a person pressing Start a few times. This one is sized for what
 * recovery actually is: a PC that has lost its licence file asks once, gets the
 * blob, and stores it. Anything doing it hundreds of times is enumerating
 * fingerprints, and there is nothing at the other end of that worth the queries.
 */
const recoverLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => trustedClientIp(req),
  message: {
    ok: false,
    error: 'Too many licence requests from this connection. Wait a few minutes and try again.',
  },
});

/**
 * POST /api/provision/license — the licence this computer already has.
 *
 * The whole point of the exercise: deleting the licence file must not reset the
 * expiry. It cannot reset it, because the expiry does not live in the file. This
 * hands the same signed blob back to the same computer, and it needs no
 * credential because the computer that lost its licence file lost its key with
 * it.
 *
 * WHAT IT WILL NOT DO. It never creates, adopts, extends or joins a store. It
 * returns no shop name, no pairing key and no token -- only the dates, and a
 * blob bound to the machine that asked, which is worthless on any other machine.
 * A stranger who guesses a fingerprint learns a date.
 *
 * 404 when this computer has no trial on record. That is a real answer: it means
 * "you have never been given a licence here", and the caller's next move is the
 * sign-up, not a retry.
 */
router.post(
  '/license',
  recoverLimiter,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const store = await findProvisionedStore({
      deviceId: body.device_id,
      machineId: body.machine_id,
    });
    if (!store) throw new AppError(404, 'No licence on record for this computer.');
    const license = licensePayload(store);
    const signed = signLicense({
      store,
      license,
      machineId: body.machine_id,
      deviceId: body.device_id,
      binding: body.hw_parts,
    });
    ok(res, {
      // Deliberately NOT the store: no name, no store_id, no android_key, no
      // token. Only what a licence is.
      license: {
        activation_date: license.activation_date,
        expiry_date: license.expiry_date,
        expiry_enabled: license.expiry_enabled,
        apply_expiry_check: license.apply_expiry_check,
        is_active: license.is_active,
        access_allowed: license.access_allowed,
        server_date: license.server_date,
        trial_days: license.trial_days,
      },
      signed,
      seal_available: sealAvailable(),
    });
  }),
);

export default router;
