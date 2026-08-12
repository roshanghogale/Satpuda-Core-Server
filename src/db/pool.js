import pg from 'pg';
import { config } from '../config/index.js';

const { Pool, types } = pg;

// node-pg returns BIGINT (int8) as strings by default — coerce to Number so
// Android/Mac clients can parse customer_id / supplier_id without string casts.
types.setTypeParser(types.builtins.INT8, (val) => {
  if (val === null || val === undefined) return val;
  const n = Number(val);
  return Number.isSafeInteger(n) ? n : val;
});
// NUMERIC also arrives as string; keep as Number when safe for sync payloads.
types.setTypeParser(types.builtins.NUMERIC, (val) => {
  if (val === null || val === undefined) return val;
  const n = Number(val);
  return Number.isFinite(n) ? n : val;
});
// DATE must stay YYYY-MM-DD. Default node-pg → JS Date → JSON becomes
// "2026-08-10T00:00:00.000Z", which breaks Android history labels/filters.
types.setTypeParser(types.builtins.DATE, (val) => val);

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.pgPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Large store pulls/pushes (sales + nested items) need more headroom than 60s.
  statement_timeout: 180_000,
});

pool.on('error', (err) => {
  console.error('[pg] unexpected pool error', err);
});

/** Run a query with optional values */
export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const ms = Date.now() - start;
  if (ms > 500) console.warn(`[pg] slow query ${ms}ms:`, text.slice(0, 120));
  return res;
}

/** Get a client for transactions */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function healthCheck() {
  const r = await query('SELECT 1 AS ok');
  return r.rows[0]?.ok === 1;
}
