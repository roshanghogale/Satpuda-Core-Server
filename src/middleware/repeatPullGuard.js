/**
 * The same list pull asked again and again in a tight loop (live access log, Oct 2026: a
 * Jagadamba PC on an old build sent GET /api/sync/medicines?after_id=... every ~2 s, the
 * same page each time). Every answer read up to 5,000 rows for nothing.
 *
 * GET /api/sync/<collection> only -- the whole-list pulls. A pull that pages moves its
 * since / after_id every request, so it is never "the same"; an idle poll repeats its URL
 * every few seconds at most (phone offline-first: 6 s, and that one is /changes, not
 * guarded). Only the same caller (Authorization header, else address) asking the very same
 * URL more than `max` times inside `windowMs` is answered 429 with Retry-After, before the
 * token is checked or the database is read. Every client treats it as a failed pull and tries
 * again on its own schedule (PC: the cached list stays; phone / offline-first: next cycle).
 * A caller that keeps at it is held off longer each time (up to `maxBlockSec`).
 */
import crypto from 'node:crypto';

const NOT_LISTS = new Set(['status', 'changes', 'v2', 'bundle', 'fy', 'settings', 'allocate-ids']);

export function createRepeatPullGuard({
  max = 20,
  windowMs = 60_000,
  retryAfterSec = 30,
  maxBlockSec = 300,
  maxKeys = 20_000,
  now = () => Date.now(),
  log = (msg) => console.warn(msg),
} = {}) {
  const hits = new Map(); // key -> { start, count, blockedUntil, strikes, lastBlockAt }

  function prune(t) {
    if (hits.size <= maxKeys) return;
    for (const [k, e] of hits) {
      if (t - e.start > windowMs && t >= e.blockedUntil) hits.delete(k);
    }
    if (hits.size > maxKeys) hits.clear();
  }

  function refuse(res, sec) {
    res.set('Retry-After', String(sec));
    res.status(429).json({
      ok: false,
      error: 'The same list was asked for too many times in a row. Wait and try again.',
      retry_after: sec,
    });
  }

  function guard(req, res, next) {
    if (req.method !== 'GET') return next();
    const seg = String(req.path || '').replace(/^\/+|\/+$/g, '');
    if (!/^[a-z_]+$/.test(seg) || NOT_LISTS.has(seg)) return next();
    const t = now();
    const who = String(req.headers?.authorization || '') || `ip:${req.ip || ''}`;
    const key = crypto.createHash('sha1').update(`${req.originalUrl}\n${who}`).digest('base64');
    let e = hits.get(key);
    if (e && e.blockedUntil > t) return refuse(res, Math.max(1, Math.ceil((e.blockedUntil - t) / 1000)));
    if (!e || t - e.start > windowMs) {
      const strikes = e && t - e.lastBlockAt < 10 * 60_000 ? e.strikes : 0;
      e = { start: t, count: 0, blockedUntil: 0, strikes, lastBlockAt: e?.lastBlockAt || 0 };
      hits.set(key, e);
      prune(t);
    }
    e.count += 1;
    if (e.count > max) {
      e.strikes += 1;
      const sec = Math.min(maxBlockSec, retryAfterSec * 2 ** (e.strikes - 1));
      e.blockedUntil = t + sec * 1000;
      e.lastBlockAt = t;
      e.start = t;
      e.count = 0;
      log(`[repeat-pull] ${req.originalUrl.split('?')[0]} asked ${max + 1}x in ${Math.round(windowMs / 1000)}s `
        + `by one caller; held off ${sec}s (strike ${e.strikes})`);
      return refuse(res, sec);
    }
    return next();
  }
  guard.hits = hits;
  return guard;
}

export const repeatPullGuard = createRepeatPullGuard();
