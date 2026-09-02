#!/usr/bin/env node
/**
 * Snapshot Shivkrupa medicines, then rebuild stock from purchase − sales.
 *
 *   node scripts/rebuild_shivkrupa_stock.js           # dry-run
 *   node scripts/rebuild_shivkrupa_stock.js --apply   # backup + write
 *   node scripts/restore_store_medicines.js --file=backups/...json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, withTransaction, pool } from '../src/db/pool.js';
import { newSyncHint, recordAcceptedChange } from '../src/services/syncRevision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const DEVICE = 'server-stock-rebuild-20260817';
const STRIP_TYPES = new Set(['tablet', 'bolus', 'capsule']);

function parseTps(unit) {
  const s = String(unit ?? '').trim();
  if (!s) return 1;
  const oneBy = s.match(/^1\s*[Xx×*]\s*(\d+)$/);
  if (oneBy) return Math.max(1, parseInt(oneBy[1], 10) || 1);
  const bottle = s.match(/^(\d+)\s*tablet/i);
  if (bottle) return Math.max(1, parseInt(bottle[1], 10) || 1);
  const n = Number(s);
  if (Number.isFinite(n) && n >= 2) return Math.floor(n);
  const packS = s.match(/(\d+)\s*'S\b/i);
  if (packS) {
    const v = parseInt(packS[1], 10);
    if (v >= 8 && v <= 30) return v;
  }
  const digits = s.match(/\d+/);
  const v = digits ? parseInt(digits[0], 10) : 0;
  return v >= 2 ? v : 1;
}

function packFromName(name) {
  const s = String(name || '').toUpperCase();
  const packS = s.match(/(\d+)\s*'S\b/);
  if (packS) {
    const v = parseInt(packS[1], 10);
    if (v >= 8 && v <= 30) return v;
  }
  const oneBy = s.match(/1\s*[Xx×*]\s*(\d{1,3})\b/);
  if (oneBy) {
    const v = parseInt(oneBy[1], 10);
    if (v >= 8 && v <= 30) return v;
  }
  return 0;
}

function coreName(name) {
  const key = String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
  return key.replace(/(TABLETS?|TABS?|CAPSULES?|CAPS?|MG|MCG)$/g, '');
}

function isStrip(type) {
  return STRIP_TYPES.has(String(type || '').trim().toLowerCase());
}

function bottleUnit(unit) {
  const m = String(unit || '').trim().match(/^(\d+)\s*tablet/i);
  return m ? m[1] : null;
}

function itemPack(it, med) {
  const type = it.type || med.type;
  const raw = it.tablets_per_stripe || it.unit || med.unit || 1;
  if (isStrip(type) || bottleUnit(it.unit) || bottleUnit(med.unit)) {
    return Math.max(1, parseTps(raw));
  }
  return 1;
}

async function main() {
  const stores = await query(
    `SELECT id, store_id, store_name FROM stores
     WHERE store_name ILIKE '%shivkrupa%' OR store_id ILIKE '%shivkrupa%'
     ORDER BY id`,
  );
  if (!stores.rows.length) throw new Error('Shivkrupa store not found');
  const store = stores.rows[0];
  const storePk = Number(store.id);
  const head = await query(
    `SELECT head_revision FROM store_sync_state WHERE store_pk=$1`,
    [storePk],
  );
  const headBefore = Number(head.rows[0]?.head_revision || 0);

  const meds = await query(`SELECT * FROM medicines WHERE store_pk=$1`, [storePk]);
  const purchItems = await query(
    `SELECT pi.id, pi.medicine_id, pi.qty, pi.free_qty, pi.type, pi.unit, pi.tablets_per_stripe
     FROM purchase_items pi
     JOIN purchases p ON p.id = pi.purchase_id
     WHERE pi.store_pk=$1 AND NOT p.deleted AND NOT p.is_autosave`,
    [storePk],
  );
  const saleItems = await query(
    `SELECT si.medicine_id, si.qty
     FROM sales_items si
     JOIN sales s ON s.id = si.sale_id
     WHERE si.store_pk=$1 AND NOT s.deleted AND NOT s.is_autosave`,
    [storePk],
  );
  const sretItems = await query(
    `SELECT sri.medicine_id, sri.qty
     FROM sales_return_items sri
     JOIN sales_returns sr ON sr.id = sri.return_id
     WHERE sri.store_pk=$1 AND NOT sr.deleted`,
    [storePk],
  );
  const pretItems = await query(
    `SELECT pri.medicine_id, pri.qty
     FROM purchase_return_items pri
     JOIN purchase_returns pr ON pr.id = pri.return_id
     WHERE pri.store_pk=$1 AND NOT pr.deleted`,
    [storePk],
  );
  const disps = await query(
    `SELECT medicine_id, qty FROM stock_disposals
     WHERE store_pk=$1 AND NOT deleted`,
    [storePk],
  );

  const byId = new Map();
  for (const m of meds.rows) byId.set(Number(m.local_id), m);

  const byCore = new Map();
  for (const m of meds.rows) {
    if (m.deleted) continue;
    const core = coreName(m.name);
    if (core.length < 4) continue;
    if (!byCore.has(core)) byCore.set(core, []);
    byCore.get(core).push(m);
  }

  const proposed = new Map();
  for (const m of meds.rows) {
    let type = m.type || '';
    let unit = String(m.unit || '');
    const bottle = bottleUnit(unit);
    if (bottle && !isStrip(type)) {
      type = 'Tablet';
      unit = bottle;
    }
    const fromItem = purchItems.rows.find(
      (it) => Number(it.medicine_id) === Number(m.local_id)
        && parseTps(it.tablets_per_stripe || it.unit) > 1,
    );
    if (fromItem && (isStrip(type) || bottle)) {
      const t = parseTps(fromItem.tablets_per_stripe || fromItem.unit);
      if (t > 1) unit = String(t);
    }
    if (isStrip(type) && parseTps(unit) <= 1) {
      const sibs = byCore.get(coreName(m.name)) || [];
      for (const sib of sibs) {
        if (Number(sib.local_id) === Number(m.local_id)) continue;
        const st = parseTps(sib.unit);
        if (st > 1) {
          unit = String(st);
          break;
        }
      }
    }
    const namedPack = packFromName(m.name);
    if (isStrip(type) && namedPack > parseTps(unit)) unit = String(namedPack);
    proposed.set(Number(m.local_id), { type, unit });
  }

  const purchTabs = new Map();
  const pretTabs = new Map();
  const sold = new Map();
  const sret = new Map();
  const disp = new Map();
  const add = (map, id, n) => map.set(id, (map.get(id) || 0) + n);

  for (const it of purchItems.rows) {
    const mid = Number(it.medicine_id || 0);
    if (mid <= 0) continue;
    const med = { ...byId.get(mid), ...proposed.get(mid) };
    const qty = Number(it.qty || 0) + Number(it.free_qty || 0);
    add(purchTabs, mid, qty * itemPack(it, med));
  }
  for (const it of pretItems.rows) {
    const mid = Number(it.medicine_id || 0);
    if (mid <= 0) continue;
    const med = { ...byId.get(mid), ...proposed.get(mid) };
    add(pretTabs, mid, Number(it.qty || 0) * itemPack(it, med));
  }
  for (const it of saleItems.rows) {
    const mid = Number(it.medicine_id || 0);
    if (mid > 0) add(sold, mid, Number(it.qty || 0));
  }
  for (const it of sretItems.rows) {
    const mid = Number(it.medicine_id || 0);
    if (mid > 0) add(sret, mid, Number(it.qty || 0));
  }
  for (const it of disps.rows) {
    const mid = Number(it.medicine_id || 0);
    if (mid > 0) add(disp, mid, Number(it.qty || 0));
  }

  const changes = [];
  for (const m of meds.rows) {
    if (m.deleted) continue;
    const mid = Number(m.local_id);
    const next = proposed.get(mid) || { type: m.type, unit: m.unit };
    const stock = Math.max(0, Math.round(Number(m.stock_qty || 0)));
    const ledger = Math.max(
      0,
      Math.round(
        (purchTabs.get(mid) || 0)
        - (sold.get(mid) || 0)
        + (sret.get(mid) || 0)
        - (pretTabs.get(mid) || 0)
        - (disp.get(mid) || 0),
      ),
    );
    const rebuildStock = isStrip(next.type) || Boolean(bottleUnit(m.unit));
    const expected = rebuildStock ? ledger : stock;
    const typeChanged = String(next.type || '') !== String(m.type || '');
    const unitChanged = String(next.unit || '') !== String(m.unit || '');
    if (expected === stock && !typeChanged && !unitChanged) continue;
    changes.push({
      id: mid,
      name: m.name,
      from_stock: stock,
      to_stock: expected,
      from_type: m.type,
      to_type: next.type,
      from_unit: m.unit,
      to_unit: next.unit,
      version: Number(m.version || 1),
    });
  }

  changes.sort((a, b) => Math.abs(b.to_stock - b.from_stock) - Math.abs(a.to_stock - a.from_stock));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `shivkrupa-medicines-before-stock-rebuild-${stamp}.json`;
  const backup = {
    created_at: new Date().toISOString(),
    store_pk: storePk,
    store_id: store.store_id,
    store_name: store.store_name,
    head_revision_before: headBefore,
    device_id: DEVICE,
    medicines: meds.rows,
    purchase_item_packs: purchItems.rows.map((r) => ({
      id: r.id,
      unit: r.unit,
      tablets_per_stripe: r.tablets_per_stripe,
    })),
    planned_changes: changes.length,
  };

  console.log(JSON.stringify({
    store: store.store_name,
    store_pk: storePk,
    head_revision_before: headBefore,
    medicines: meds.rows.length,
    planned_changes: changes.length,
    apply: APPLY,
    sample: changes.slice(0, 25).map((c) => ({
      id: c.id,
      name: c.name,
      stock: `${c.from_stock}→${c.to_stock}`,
      unit: `${c.from_unit || ''}→${c.to_unit || ''}`,
      type: c.from_type === c.to_type ? undefined : `${c.from_type}→${c.to_type}`,
    })),
  }, null, 2));

  if (!APPLY) {
    console.log('Dry-run only. Re-run with --apply to backup and write.');
    await pool.end();
    return;
  }

  const backupDir = path.join(ROOT, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, backupName);
  fs.writeFileSync(backupPath, JSON.stringify(backup));
  console.log('BACKUP', backupPath);

  const hint = newSyncHint(storePk);
  hint.sourceDeviceId = DEVICE;
  const applied = await withTransaction(async (client) => {
    let n = 0;
    for (const c of changes) {
      const now = new Date();
      const nextVersion = c.version + 1;
      await client.query(
        `UPDATE medicines
         SET stock_qty=$3, type=$4, unit=$5,
             version=$6, updated_at=$7, device_id=$8, sync_status='synced'
         WHERE store_pk=$1 AND local_id=$2`,
        [storePk, c.id, c.to_stock, c.to_type, c.to_unit || null, nextVersion, now, DEVICE],
      );
      await recordAcceptedChange(client, hint, {
        storePk,
        collection: 'medicines',
        localId: c.id,
        operation: 'upsert',
        entityVersion: nextVersion,
        entityUpdatedAt: now.toISOString(),
        deviceId: DEVICE,
      });
      n += 1;
    }
    for (const it of purchItems.rows) {
      const mid = Number(it.medicine_id || 0);
      const next = proposed.get(mid);
      if (!next || !next.unit) continue;
      if (it.unit && it.tablets_per_stripe) continue;
      const tps = parseTps(next.unit);
      await client.query(
        `UPDATE purchase_items
         SET unit = COALESCE(NULLIF(btrim(unit), ''), $2),
             tablets_per_stripe = COALESCE(tablets_per_stripe, $3)
         WHERE id=$1`,
        [it.id, next.unit, tps > 1 ? tps : null],
      );
    }
    return n;
  });

  const headAfter = await query(
    `SELECT head_revision FROM store_sync_state WHERE store_pk=$1`,
    [storePk],
  );
  console.log(JSON.stringify({
    applied,
    backup: backupName,
    head_revision_after: Number(headAfter.rows[0]?.head_revision || 0),
    restore: `node scripts/restore_store_medicines.js --file=backups/${backupName}`,
  }, null, 2));
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
