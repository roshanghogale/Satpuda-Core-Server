/**
 * The signed licence — "the seal".
 *
 * WHAT THIS IS FOR. A shop's expiry date used to live in one encrypted file on
 * the shop's own PC (`expiry.dat`), and the app believed whatever it found
 * there. Two things followed, and both were free:
 *
 *   * DELETE the file and the Offline app found no expiry at all, which it read
 *     as "no restriction". Reinstalling produced the same result. The licence
 *     was one keystroke from permanent.
 *   * The file's encryption key is a constant compiled into every copy of the
 *     build (`_SECRET` in core/license_manager.py), so anyone willing to open
 *     the exe could also WRITE a new date rather than merely delete the old one.
 *
 * The fix is that the expiry stops being a local fact. The server decides it and
 * SIGNS it; the desktop keeps the signed blob and verifies it before believing a
 * word of it. A blob that has been edited fails the signature. A blob copied from
 * another shop fails the machine binding. A blob that is missing is not a licence
 * with no restriction — it is no licence, and the app asks for internet once and
 * fetches the same one back.
 *
 * WHY AN ASYMMETRIC SIGNATURE, AND WHY THIS ONE.
 *
 *   RSA-2048, RSASSA-PKCS#1 v1.5, SHA-256.
 *
 *   * ASYMMETRIC, not an HMAC. The desktop needs to VERIFY, not to mint. An HMAC
 *     would put the minting key inside every installer that can be downloaded —
 *     which is the same mistake this server already refused to make when it
 *     built /api/provision/trial rather than shipping the vendor's administrator
 *     password inside the build. The private key never leaves this machine; the
 *     build carries the public half, and decompiling it yields a key that can
 *     check a licence and cannot write one.
 *
 *   * PKCS#1 v1.5 over Ed25519 or PSS, deliberately. Ed25519 is a better
 *     signature in the abstract and this file could sign it in one line. The
 *     constraint is the OTHER side: the desktop must be able to verify with
 *     nothing but the Python standard library, because `cryptography` failing to
 *     import inside a frozen build is a case that code base has already been
 *     bitten by and still carries a fallback for (see `_get_fernet`). A
 *     hand-written Ed25519 verifier is ~80 lines of modular arithmetic with real
 *     traps — cofactor, canonical encodings, malleability. A PKCS#1 v1.5
 *     VERIFIER is `pow(sig, e, n)` and one byte-for-byte comparison against the
 *     expected block: about twenty lines, no attacker-steerable branches, and
 *     because the comparison is against the WHOLE block rather than a parse of
 *     it, the lenient-parser family of bugs (Bleichenbacher '06) cannot exist in
 *     it. One algorithm, two implementations, no weak mode to fall into.
 *
 *   * 2048 bits. What the signature protects is worth months of one shop's
 *     subscription, and the key rotates with a build. `kid` travels in every
 *     blob so a second key can be added before the first is retired.
 *
 * THE BLOB. A JWS-shaped compact string, and shaped that way for one reason: the
 * signature covers the exact ASCII bytes that are transmitted, so neither side
 * has to agree on a canonical JSON spelling. Key order, spacing and unicode
 * escaping stop being able to break a signature.
 *
 *     SATPUDA1.<base64url(payload JSON)>.<base64url(signature)>
 *
 * and the signing input is the ASCII of everything before the second dot.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** Blob format marker. Bump only for a breaking change to the payload shape. */
export const SEAL_PREFIX = 'SATPUDA1';
export const SEAL_ALG = 'RS256';

/**
 * Where the private key lives.
 *
 * A FILE, not an environment variable. `.env` on this host is world-readable
 * (0644) and is read by anything that can read the repo; a signing key that can
 * mint a licence for every shop on the account does not belong in it. The path
 * is overridable so a staged copy on /tmp can be tested with a throwaway key
 * without going anywhere near the real one.
 */
const DEFAULT_KEY_PATH = '/opt/Satpuda-Core-Server/secrets/license-signing.key.pem';

function keyPath() {
  return String(process.env.LICENSE_SIGNING_KEY_PATH || DEFAULT_KEY_PATH);
}

let _key = null; // { pem, keyObject, kid, path, mtimeMs }

/**
 * Load (and cache) the signing key.
 *
 * Returns null rather than throwing when there is no key. A server without a
 * signing key must keep answering every licence read it answered before — the
 * blob is simply absent from the response, and a desktop that has not been
 * rebuilt with a public key does not look for one. That is what makes this
 * deployable in two steps instead of one flag day.
 */
export function loadSigningKey() {
  const p = keyPath();
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    _key = null;
    return null;
  }
  if (_key && _key.path === p && _key.mtimeMs === stat.mtimeMs) return _key;
  let pem;
  try {
    pem = fs.readFileSync(p, 'utf8');
  } catch (err) {
    console.error('[licenseSeal] cannot read signing key', p, err && err.message);
    _key = null;
    return null;
  }
  let keyObject;
  try {
    keyObject = crypto.createPrivateKey(pem);
  } catch (err) {
    console.error('[licenseSeal] signing key is not a usable private key', err && err.message);
    _key = null;
    return null;
  }
  if (keyObject.asymmetricKeyType !== 'rsa') {
    console.error('[licenseSeal] signing key must be RSA, got', keyObject.asymmetricKeyType);
    _key = null;
    return null;
  }
  const bits = Number(keyObject.asymmetricKeyDetails?.modulusLength || 0);
  if (bits && bits < 2048) {
    console.error('[licenseSeal] signing key is too small:', bits, 'bits');
    _key = null;
    return null;
  }
  const pub = crypto.createPublicKey(keyObject);
  const der = pub.export({ type: 'spki', format: 'der' });
  const kid = crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
  _key = { pem, keyObject, kid, path: p, mtimeMs: stat.mtimeMs };
  return _key;
}

/** True when this server can sign. Cheap; safe to call per request. */
export function sealAvailable() {
  return Boolean(loadSigningKey());
}

/** The public half, PEM, for the build that has to verify. */
export function publicKeyPem() {
  const key = loadSigningKey();
  if (!key) return '';
  return crypto.createPublicKey(key.keyObject).export({ type: 'spki', format: 'pem' }).toString();
}

/** The key id the blobs carry. '' when there is no key. */
export function signingKid() {
  const key = loadSigningKey();
  return key ? key.kid : '';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function dateOrNull(value) {
  if (value == null || value === '') return null;
  const raw = value instanceof Date
    ? new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(value)
    : String(value).trim().slice(0, 10);
  return DATE_ONLY.test(raw) ? raw : null;
}

/** The identity keys of a PC, in the order the desktop hashes them. */
export const HW_KEYS = ['cpu', 'board', 'sysuuid', 'disk'];

/**
 * Normalise the machine binding the caller sent.
 *
 * The desktop sends the SHA-256 of each hardware component, never the serial
 * numbers themselves. That keeps disk and board serials out of this server's
 * logs and database while leaving the comparison the desktop actually performs
 * ("all but one component still matches") exactly as sharp.
 *
 * Be honest about what a client-supplied binding is worth: it is worth "the
 * values this PC claims today must equal the values it claims tomorrow". A
 * tamperer can put anything here — but whatever they put is what their own
 * machine will be held to, and a blob bound to somebody else's numbers will not
 * verify on theirs. That is the whole job.
 */
export function cleanBinding(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of HW_KEYS) {
    const v = String(src[k] ?? '').trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(v)) out[k] = v;
  }
  return out;
}

function cleanId(raw, max = 128) {
  const s = String(raw ?? '').trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(s) ? s.slice(0, max) : '';
}

/**
 * The serial that makes a stale blob lose to a fresh one.
 *
 * `stores.updated_at` in whole seconds. It needs no migration, it moves every
 * time an administrator changes a licence, and it never moves backwards under
 * normal operation. The desktop keeps the highest serial it has ever seen and
 * refuses a blob READ FROM DISK that is older — so a shop cannot keep last
 * year's generous blob and replay it after the vendor shortens the date. A blob
 * that arrives FRESH from this server is always accepted and resets that floor,
 * which is what stops a restored database from locking a fleet out.
 */
function serialOf(store) {
  const t = store && store.updated_at ? new Date(store.updated_at).getTime() : 0;
  return Number.isFinite(t) && t > 0 ? Math.floor(t / 1000) : 0;
}

/**
 * Sign one store's licence for one machine.
 *
 * `store` is a row from `stores`. Every field that decides access is read from
 * that row and from this server's clock. Nothing the caller sent decides
 * anything except WHICH MACHINE the result is bound to — and binding it to a
 * machine that is not yours only produces a blob that will not work on yours.
 *
 * Returns '' when this server has no signing key, so every caller can be written
 * as "include the seal when there is one".
 */
export function signLicense({ store, license, machineId, deviceId, binding } = {}) {
  const key = loadSigningKey();
  if (!key || !store) return '';
  const payload = {
    v: 1,
    alg: SEAL_ALG,
    kid: key.kid,
    // WHICH store. The server's own random id, never the shop name.
    sid: String(store.store_id || ''),
    // WHAT the licence says. Exactly the four fields check_expiry acts on.
    act: dateOrNull(store.activation_date),
    exp: dateOrNull(store.expiry_date),
    een: Boolean(store.expiry_enabled),
    aec: store.apply_expiry_check !== false && store.apply_expiry_check !== 0,
    // Whether the store is switched off entirely, so a blob read while the
    // server is unreachable still knows about a disabled shop.
    act_ok: store.is_active !== false && store.is_active !== 0,
    // WHERE it may be used.
    hw: cleanId(machineId) || '',
    dev: cleanId(deviceId) || '',
    hwp: cleanBinding(binding),
    // WHEN, and in which order.
    iat: Math.floor(Date.now() / 1000),
    ser: serialOf(store),
    // Advisory only: the desktop refetches on every Online licence read anyway.
    // An Offline shop is not blocked when this passes — it is nagged.
    refresh_days: 30,
  };
  if (license && typeof license === 'object' && license.trial_days) {
    payload.trial_days = Number(license.trial_days) || undefined;
  }
  const head = `${SEAL_PREFIX}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(head, 'ascii'), {
    key: key.keyObject,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  return `${head}.${b64url(sig)}`;
}

/**
 * Verify a blob with this server's own public key.
 *
 * Not used to serve a request — the server never needs to be told what a licence
 * is. It exists so the staged test on /tmp can prove that what was signed can be
 * read back, and so an operator can check a blob a shop has sent in.
 */
export function verifyLicense(blob) {
  const key = loadSigningKey();
  if (!key) return null;
  const parts = String(blob || '').split('.');
  if (parts.length !== 3 || parts[0] !== SEAL_PREFIX) return null;
  const head = `${parts[0]}.${parts[1]}`;
  let sig;
  try {
    sig = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return null;
  }
  const okSig = crypto.verify(
    'sha256',
    Buffer.from(head, 'ascii'),
    { key: crypto.createPublicKey(key.keyObject), padding: crypto.constants.RSA_PKCS1_PADDING },
    sig,
  );
  if (!okSig) return null;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export const _internals = { keyPath, DEFAULT_KEY_PATH, serialOf, path };
