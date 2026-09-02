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
import { errorMiddleware } from './utils/http.js';
import authRoutes from './routes/auth.js';
import syncRoutes from './routes/sync.js';
import storeQueryRoutes from './routes/storeQuery.js';
import adminRoutes from './routes/admin.js';
import masterMedicineRoutes from './routes/masterMedicines.js';
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

app.use('/api/', generalLimiter);
app.use('/api/sync', syncLimiter);
app.use('/api/store', syncLimiter);
app.use('/api/master-medicines', syncLimiter);

app.use('/api', authRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/store', storeQueryRoutes);
app.use('/api/master-medicines', masterMedicineRoutes);
app.use('/api/admin', adminRoutes);

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

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    name: 'Satpuda Core Server',
    version: '1.0.0',
    docs: '/api/meta',
    admin: '/admin',
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
