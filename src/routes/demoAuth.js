import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler, ok } from '../utils/http.js';
import { DEMO_COOKIE, demoLogin, readDemoSession } from '../services/demoUserService.js';

const router = Router();

// This router is mounted ABOVE the general /api/ limiter so the demo hostname
// can reach it, so it carries its own -- and a much tighter one, because this
// is the only password prompt on the public internet side of this server.
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many attempts. Wait ten minutes and try again.' },
});

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // The demo is served over the tunnel as https; a plain-http visit (only
    // possible on the LAN) still works because this reads what actually
    // arrived rather than assuming.
    secure: req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https',
    path: '/',
    // Deliberately NO maxAge -- this is a SESSION cookie.
    //
    // With maxAge the browser wrote the cookie to disk, so the demo stayed
    // open for twelve hours on any machine it had been signed into once --
    // including a customer's laptop after the salesperson had walked away.
    // Closing the browser now signs the demo out and the next visit asks for
    // the id and password again. That is the rule the admin panel already
    // follows: its token lives in sessionStorage, which dies with the tab.
    //
    // The JWT keeps its own SESSION_MINUTES expiry as a hard ceiling, so a
    // browser left open (or one that restores session cookies) is signed out anyway.
  };
}

router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  const result = await demoLogin(username, password);
  res.cookie(DEMO_COOKIE, result.token, cookieOptions(req));
  ok(res, { user: result.user });
}));

router.post('/logout', (req, res) => {
  res.clearCookie(DEMO_COOKIE, { path: '/' });
  ok(res, { signed_out: true });
});

router.get('/me', (req, res) => {
  const session = readDemoSession(req);
  ok(res, session ? { username: session.username } : null);
});

export default router;
