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
import adminRoutes from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(
  cors({
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    credentials: true,
  })
);
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));

app.use(
  '/api/',
  rateLimit({
    windowMs: 60_000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use('/api', authRoutes);
app.use('/api/sync', syncRoutes);
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
  });
});

app.use(errorMiddleware);

app.listen(config.port, config.host, () => {
  console.log(`[satpuda] listening on http://${config.host}:${config.port}`);
  console.log(`[satpuda] env=${config.env}`);
});
