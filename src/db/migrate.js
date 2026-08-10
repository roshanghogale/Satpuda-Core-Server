import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, query } from './pool.js';
import { config } from '../config/index.js';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  console.log('[migrate] connecting…');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(schema);
  console.log('[migrate] schema applied');

  const { rows } = await query('SELECT id FROM admins WHERE username = $1', [config.adminUsername]);
  if (!rows.length) {
    const hash = await bcrypt.hash(config.adminPassword, 12);
    await query(
      'INSERT INTO admins (username, password_hash, name) VALUES ($1, $2, $3)',
      [config.adminUsername, hash, 'Super Admin']
    );
    console.log(`[migrate] admin user created: ${config.adminUsername}`);
  } else {
    console.log('[migrate] admin user already exists');
  }

  console.log('[migrate] done');
  await pool.end();
}

migrate().catch(async (err) => {
  console.error('[migrate] failed', err);
  await pool.end();
  process.exit(1);
});
