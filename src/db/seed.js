import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query, pool } from './pool.js';
import { config } from '../config/index.js';

function slugifyStoreId(name) {
  return `store_${String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)}`;
}

function storeKeyFromName(name) {
  const clean = String(name).trim().replace(/\s+/g, '_');
  return clean.startsWith('Store_') ? clean : `Store_${clean}`;
}

function androidKey() {
  return `SC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

async function seed() {
  const demoStores = [
    { name: 'Roshan Medical', notes: 'Demo store' },
    { name: 'Shivkrupa Medical General Store', notes: 'Demo store' },
  ];

  for (const s of demoStores) {
    const storeId = slugifyStoreId(s.name);
    const storeKey = storeKeyFromName(s.name);
    const existing = await query('SELECT id FROM stores WHERE store_id = $1', [storeId]);
    if (existing.rows.length) {
      console.log(`[seed] skip existing ${storeId}`);
      continue;
    }
    const { rows } = await query(
      `INSERT INTO stores (store_id, store_key, store_name, android_key, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, store_id, android_key`,
      [storeId, storeKey, s.name, androidKey(), s.notes]
    );
    const store = rows[0];
    await query(
      `INSERT INTO pharmacy_profiles (store_pk, name, address, phone, gst_enabled)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [store.id, s.name, 'India', '']
    );
    await query(
      `INSERT INTO store_dropdowns (store_pk, villages, med_types, schedules)
       VALUES ($1, '[]'::jsonb, '["TAB","SYRUP","INJ","CAP","OINT"]'::jsonb, '["H","H1","X"]'::jsonb)`,
      [store.id]
    );
    console.log(`[seed] created ${store.store_id} key=${store.android_key}`);
  }

  // Ensure admin exists with current password from env
  const hash = await bcrypt.hash(config.adminPassword, 12);
  await query(
    `INSERT INTO admins (username, password_hash, name)
     VALUES ($1, $2, 'Super Admin')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [config.adminUsername, hash]
  );
  console.log('[seed] admin password synced from .env');
  console.log('[seed] done');
  await pool.end();
}

seed().catch(async (err) => {
  console.error('[seed] failed', err);
  await pool.end();
  process.exit(1);
});
