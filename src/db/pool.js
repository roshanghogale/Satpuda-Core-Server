import pg from 'pg';
import { config } from '../config/index.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.pgPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 60_000,
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
