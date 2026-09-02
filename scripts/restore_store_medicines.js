#!/usr/bin/env node
/**
 * Restore medicines stock/type/unit from a rebuild backup JSON.
 * Bumps version so Online clients pull the restored rows.
 *
 *   node scripts/restore_store_medicines.js --file=backups/shivkrupa-medicines-before-stock-rebuild-....json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, withTransaction, query } from '../src/db/pool.js';
import { newSyncHint, recordAcceptedChange } from '../src/services/syncRevision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEVICE = 'server-stock-restore-20260817';

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

async function main() {
  const rel = arg('file');
  if (!rel) throw new Error('Pass --file=backups/....json');
  const file = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const storePk = Number(snap.store_pk);
  if (!storePk) throw new Error('Backup missing store_pk');
  const rows = Array.isArray(snap.medicines) ? snap.medicines : [];
  if (!rows.length) throw new Error('Backup has no medicines');

  const hint = newSyncHint(storePk);
  hint.sourceDeviceId = DEVICE;
  const restored = await withTransaction(async (client) => {
    let n = 0;
    for (const m of rows) {
      const localId = Number(m.local_id);
      if (!localId) continue;
      const live = await client.query(
        `SELECT version FROM medicines WHERE store_pk=$1 AND local_id=$2`,
        [storePk, localId],
      );
      if (!live.rows[0]) continue;
      const nextVersion = Number(live.rows[0].version || 1) + 1;
      const now = new Date();
      await client.query(
        `UPDATE medicines
         SET stock_qty=$3, type=$4, unit=$5, is_hidden=$6,
             version=$7, updated_at=$8, device_id=$9, sync_status='synced'
         WHERE store_pk=$1 AND local_id=$2`,
        [
          storePk,
          localId,
          Number(m.stock_qty || 0),
          m.type || null,
          m.unit || null,
          Boolean(m.is_hidden),
          nextVersion,
          now,
          DEVICE,
        ],
      );
      await recordAcceptedChange(client, hint, {
        storePk,
        collection: 'medicines',
        localId,
        operation: 'upsert',
        entityVersion: nextVersion,
        entityUpdatedAt: now.toISOString(),
        deviceId: DEVICE,
      });
      n += 1;
    }
    for (const it of snap.purchase_item_packs || []) {
      if (!it?.id) continue;
      await client.query(
        `UPDATE purchase_items SET unit=$2, tablets_per_stripe=$3 WHERE id=$1`,
        [it.id, it.unit ?? null, it.tablets_per_stripe ?? null],
      );
    }
    return n;
  });

  const head = await query(
    `SELECT head_revision FROM store_sync_state WHERE store_pk=$1`,
    [storePk],
  );
  console.log(JSON.stringify({
    restored,
    store_pk: storePk,
    file,
    head_revision: Number(head.rows[0]?.head_revision || 0),
  }, null, 2));
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
