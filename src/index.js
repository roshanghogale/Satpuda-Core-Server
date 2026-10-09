import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/index.js';
import { errorMiddleware, trustedClientIp } from './utils/http.js';
import authRoutes from './routes/auth.js';
import syncRoutes from './routes/sync.js';
import syncV2Routes from './routes/syncV2.js';
import storeQueryRoutes from './routes/storeQuery.js';
import adminRoutes from './routes/admin.js';
import masterMedicineRoutes from './routes/masterMedicines.js';
import demoAuthRoutes from './routes/demoAuth.js';
import webRoutes from './routes/web.js';
import provisionRoutes, { provisionLimiter } from './routes/provision.js';
import { consumeDemoEntry, readDemoSession } from './services/demoUserService.js';
import { attachSyncHub } from './ws/syncHub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression({ threshold: 1024 }));
app.use(
  cors({
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    credentials: true,
  })
);
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(
  morgan(config.env === 'production' ? 'combined' : 'dev', {
    skip: (req) => {
      const u = String(req.originalUrl || '');
      return u === '/api/health' || u.includes('/sync/status');
    },
  })
);

// General API budget (auth, admin, health). Sync uses a higher ceiling because
// store pull/push is page-based and can legitimately issue many requests/min.
const generalLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Slow down and retry.' },
  skip: (req) => {
    const u = String(req.originalUrl || '');
    return u.startsWith('/api/sync') || u.startsWith('/api/store');
  },
});
const syncLimiter = rateLimit({
  windowMs: 60_000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many sync requests. Slow down and retry.' },
});

// Sales demonstration copy of the desktop UI, served exactly like /admin above.
// Reachable two ways: at /demo on any hostname, and at the ROOT of its own
// hostname when a Cloudflare tunnel public hostname points here -- so the link
// a sales person hands out is just the domain, with no path.
const DEMO_HOSTS = new Set(['demo.satpudacore.online']);
// The root-relative build (--base=/), not the /demo/ one: at the root of
// this hostname the HTML must ask for /assets/*, not /demo/assets/*.
const demoDistRoot = '/var/www/satpuda-demo';
const demoRootStatic = express.static(demoDistRoot);
const demoLoginPage = '/var/www/satpuda-demo-login.html';
// The second product on the same door: the hospital software, built with its
// cloud switched off, so it runs entirely inside the visitor's browser on a
// sample hospital seeded there. Same sign-in, same hostname, its own path.
const healthDistRoot = '/var/www/satpuda-health-demo';
const healthStatic = express.static(healthDistRoot);
const demoChoosePage = '/var/www/satpuda-demo-choose.html';

// The administrator password prompt. It is the only credential on the public
// internet side of this server that opens the whole account, and it sat under
// the general 600-per-minute /api/ budget -- 600 guesses a minute against a
// username that is always "admin". Slow it right down; a person signing in
// needs three or four attempts, never twenty.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  // The default key is `req.ip`, and `req.ip` is the caller's own
  // X-Forwarded-For for anything that reaches this process without going
  // through Caddy -- which the open 0.0.0.0:3000 port allows. That gave every
  // forged header its own fresh allowance of ten, i.e. no limit at all on the
  // one credential that opens every store. Count the TCP peer instead.
  keyGenerator: (req) => trustedClientIp(req),
  message: {
    ok: false,
    error: 'Too many sign-in attempts. Wait fifteen minutes and try again.',
  },
});
app.use('/api/auth/admin/login', adminLoginLimiter);

// Sales people sign in here. Mounted before the demo host handler below (which
// 404s every other /api/ path on that hostname) and before the general /api/
// limiter, so it carries its own tighter one.
app.use('/api/demo', demoAuthRoutes);

/** Keep the page itself out of the browser cache.
 *
 * A cached index.html renders the entire app without a single request to this
 * server, so the sign-in check never runs -- the demo opened for anyone whose
 * browser had been there before, and then broke when its data came back 401.
 * The hashed asset files keep their normal caching: their names change when
 * they do.
 */
function noStoreForDemoEntry(req, res) {
  const p = req.path;
  if (p === '/' || p.endsWith('.html') || p.endsWith('demo-fixture.json')) {
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
  }
}

/** Is this the browser OPENING the page, rather than the page fetching a file?
 *
 * A navigation asks for text/html; a script, stylesheet or fetch() does not.
 * That is the same signal demoSignInRequired uses to decide between the login
 * form and a bare 401, and it is what makes "ask every time" possible without
 * breaking the app as it loads: only navigations spend the sign-in.
 */
function isDemoPageLoad(req) {
  return (
    req.method === 'GET' &&
    String(req.headers.accept || '').includes('text/html')
  );
}

/** Serve the sign-in page, or refuse an asset request outright.
 *
 * Answering an asset with the login HTML would hand the browser text/html for
 * a .js request, which is a console error and no explanation. A page request
 * gets the login form; anything else gets a plain 401.
 */
function demoSignInRequired(req, res) {
  const wantsPage =
    req.method === 'GET' &&
    String(req.headers.accept || '').includes('text/html');
  if (!wantsPage) {
    return res.status(401).json({ ok: false, error: 'Sign in to open the demo.' });
  }
  res.set('Cache-Control', 'no-store');
  return res.sendFile(demoLoginPage, (err) => {
    if (err) res.status(404).json({ ok: false, error: 'Demo sign-in page not deployed.' });
  });
}

app.use((req, res, next) => {
  const host = String(req.hostname || '').toLowerCase();
  if (!DEMO_HOSTS.has(host)) return next();
  // The demo answers every /api/ call inside the browser, so nothing on this
  // hostname has any business reaching the store API or the database.
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) {
    return res.status(404).json({ ok: false, error: 'Not available on the demo site.' });
  }
  // The gate goes in front of the files, not inside the app: the recorded
  // fixture is served from this same folder, so a check the React app makes
  // after loading itself would already have handed the data over.
  const session = readDemoSession(req);
  if (!session) return demoSignInRequired(req, res);

  // After signing in, the sales person picks which software to show. The
  // chooser is behind the same sign-in but spends no ticket of its own: it is
  // the page they come back to between the two demonstrations.
  if (req.path === '/choose' || req.path === '/choose/') {
    res.set('Cache-Control', 'no-store');
    return res.sendFile(demoChoosePage, (err) => {
      if (err) res.status(404).json({ ok: false, error: 'Demo chooser not deployed.' });
    });
  }

  // The hospital software. Its own ticket, so showing the shop software first
  // does not lock this one -- and a reload still asks for the password.
  if (req.path === '/health' || req.path.startsWith('/health/')) {
    if (req.path === '/health') return res.redirect(302, '/health/');
    if (isDemoPageLoad(req) && !consumeDemoEntry(session, 'health')) {
      return demoSignInRequired(req, res);
    }
    noStoreForDemoEntry(req, res);
    req.url = req.url.slice('/health'.length) || '/';
    return healthStatic(req, res, () => {
      res.sendFile(path.join(healthDistRoot, 'index.html'), (err) => {
        if (err) res.status(404).json({ ok: false, error: 'Hospital demo not deployed.' });
      });
    });
  }

  // One sign-in opens the page once. A reload, a second tab or F5 finds the
  // ticket spent and asks for the id and password again.
  if (isDemoPageLoad(req) && !consumeDemoEntry(session, 'medical')) {
    return demoSignInRequired(req, res);
  }
  noStoreForDemoEntry(req, res);
  return demoRootStatic(req, res, () => {
    res.sendFile(path.join(demoDistRoot, 'index.html'), (err) => {
      if (err) res.status(404).json({ ok: false, error: 'Demo not deployed.' });
    });
  });
});

// Static files only: it has no store and saves nothing -- every /api/ call is
// answered inside the browser from a recorded, redacted snapshot, so this mount
// cannot reach the database or the store API.
app.use('/api/', generalLimiter);
app.use('/api/sync', syncLimiter);
app.use('/api/store', syncLimiter);
app.use('/api/master-medicines', syncLimiter);

// Self-service trial sign-up. The only unauthenticated write on this server, so
// it gets a limiter of its own -- ten attempts per address per ten minutes,
// tighter than the general 600/min budget above, and in front of the route so a
// refused attempt never reaches the database. The per-computer and per-address
// grant limits live in services/provisionService.js.
//
// Mounted here, AFTER the demo-hostname handler above, so the demo site keeps
// 404ing every /api/ path including this one.
app.use('/api/provision', provisionLimiter);
app.use('/api/provision', provisionRoutes);

app.use('/api', authRoutes);
// Before /api/sync: its /:collection routes would read "v2" as a collection name.
app.use('/api/sync/v2', syncV2Routes);
app.use('/api/sync', syncRoutes);
app.use('/api/store', storeQueryRoutes);
app.use('/api/master-medicines', masterMedicineRoutes);
app.use('/api/admin', adminRoutes);
// The shop's web login (phase 5): online-only, one login per person with their own rights.
app.use('/api/web', webRoutes);

// The web app itself (built from ../web): served like /admin, index.html never cached so a
// new build reaches every browser at once.
const webDist = path.join(__dirname, '../web/dist');
app.use('/web', express.static(webDist, {
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.set('Cache-Control', 'no-store'); },
}));
app.get(/^\/web(\/.*)?$/, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(webDist, 'index.html'), (err) => {
    if (err) res.status(404).json({ ok: false, error: 'Web app not built. Run: npm run web:build' });
  });
});

// Serve admin dashboard (built assets under /admin/)
const adminDist = path.join(__dirname, '../admin/dist');
app.use('/admin', express.static(adminDist));
app.get(/^\/admin(\/.*)?$/, (_req, res) => {
  res.sendFile(path.join(adminDist, 'index.html'), (err) => {
    if (err) {
      res.status(404).json({
        ok: false,
        error: 'Admin dashboard not built. Run: npm run admin:build',
      });
    }
  });
});

// The same demo under a path on any hostname. It needs the same gate: an
// ungated second door makes the first one decoration.
const demoDist = path.join(__dirname, '../demo/dist');
const demoPathGate = (req, res, next) => {
  const session = readDemoSession(req);
  if (!session) return demoSignInRequired(req, res);
  if (isDemoPageLoad(req) && !consumeDemoEntry(session)) {
    return demoSignInRequired(req, res);
  }
  noStoreForDemoEntry(req, res);
  return next();
};
app.use('/demo', demoPathGate, express.static(demoDist));
app.get(/^\/demo(\/.*)?$/, demoPathGate, (_req, res) => {
  res.sendFile(path.join(demoDist, 'index.html'), (err) => {
    if (err) {
      res.status(404).json({ ok: false, error: 'Demo not deployed.' });
    }
  });
});

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    name: 'Satpuda Core Server',
    version: '1.0.0',
    docs: '/api/meta',
    admin: '/admin',
    demo: '/demo',
    health: '/api/health',
    ws_sync: '/ws/sync',
  });
});

app.use(errorMiddleware);

const server = http.createServer(app);
attachSyncHub(server);

server.listen(config.port, config.host, () => {
  console.log(`[satpuda] listening on http://${config.host}:${config.port}`);
  console.log(`[satpuda] env=${config.env}`);
});
