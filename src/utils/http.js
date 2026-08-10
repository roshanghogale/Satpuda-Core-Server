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

export function errorMiddleware(err, req, res, _next) {
  const status = err.status || 500;
  const message = err.message || 'Internal server error';
  if (status >= 500) console.error('[error]', req.method, req.path, err);
  res.status(status).json({
    ok: false,
    error: message,
    details: err.details || undefined,
  });
}
