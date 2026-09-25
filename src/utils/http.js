export class AppError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function ok(res, data = null, meta = undefined) {
  const body = { ok: true, data };
  if (meta !== undefined) body.meta = meta;
  return res.json(body);
}

export function fail(res, status, message, details = null) {
  return res.status(status).json({ ok: false, error: message, details });
}

/**
 * The address the caller ACTUALLY came from, as opposed to the one it claims.
 *
 * `req.ip` is not safe to count anything with on this deployment. Express is
 * configured `trust proxy: 1`, which is correct when every request arrives
 * through Caddy on 127.0.0.1 — Caddy overwrites X-Forwarded-For with the real
 * peer. But the Node process listens on 0.0.0.0:3000 and the host has no
 * firewall, so http://<public-ip>:3000/ answers the open internet directly. On
 * that path there is no proxy to overwrite the header, so `trust proxy: 1`
 * hands express whatever X-Forwarded-For the caller typed, and every per-IP
 * limit in this server silently keys off a value the attacker chooses. It is
 * one header away from unlimited.
 *
 * So: believe the forwarded header ONLY when the TCP peer is the local reverse
 * proxy. Anything arriving from a real remote address is counted against that
 * address, whatever it says about itself. Closing port 3000 is still the right
 * fix at the host level (see the deploy notes); this makes the limits hold
 * whether or not that has been done.
 */
export function trustedClientIp(req) {
  const peer = String(
    req?.socket?.remoteAddress || req?.connection?.remoteAddress || ''
  ).replace(/^::ffff:/, '');
  if (peer && peer !== '127.0.0.1' && peer !== '::1') return peer;
  return String(req?.ip || peer || '').replace(/^::ffff:/, '');
}

let _errSeq = 0;

export function errorMiddleware(err, req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) {
    // Never hand internals to a client: Postgres errors carry SQL fragments,
    // column names and constraint names. Log the detail, return a reference.
    const ref = `E${Date.now().toString(36)}${(++_errSeq).toString(36)}`;
    console.error(`[error][${ref}]`, req.method, req.path, err);
    return res.status(status).json({
      ok: false,
      error: 'Something went wrong on the server. Quote reference ' + ref + ' to support.',
      ref,
    });
  }
  // Deliberate AppErrors are safe and useful to the client.
  res.status(status).json({
    ok: false,
    error: err.message || 'Request failed',
    details: err.details || undefined,
  });
}
