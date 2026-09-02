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
