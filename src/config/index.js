import 'dotenv/config';

const required = ['DATABASE_URL', 'JWT_SECRET'];

for (const key of required) {
  if (!process.env[key]) {
    console.warn(`[config] Missing ${key} — set it in .env before production use`);
  }
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://satpuda:satpuda@127.0.0.1:5432/satpuda_core',
  pgPoolMax: Number(process.env.PG_POOL_MAX || 20),
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()),
  syncOverlapSeconds: Number(process.env.SYNC_WATERMARK_OVERLAP_SECONDS || 120),
};
