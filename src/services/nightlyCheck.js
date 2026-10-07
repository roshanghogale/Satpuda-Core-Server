/**
 * The nightly check (offline-first design, phase 1): every stock and every party due is
 * worked out again from its ledger and compared with what the store holds, so a difference
 * is found the next morning instead of weeks later.
 *
 * Stock: since the last run, each medicine's stock must have moved by exactly the sum of its
 * stock_operations lines. The run holds the store's push lock (lockStorePush), which every
 * write that moves stock also takes, so it never sees half a push, and it counts lines by id
 * (every line written after the run has a higher id).
 *
 * Dues: each customer's and supplier's total due / credit must equal what its bills,
 * payments and returns add up to -- the same formulas as partyDueCascade.
 *
 * Read-only for the business tables: it writes only stock_snapshots, sync_check_runs and
 * sync_check_items.
 */
import { query, withTransaction } from '../db/pool.js';
import { lockStorePush } from './syncService.js';
import { PURCHASE_ENTRY_PAID_SQL } from './partyDueCascade.js';

const EPS = 0.009;
const MAX_ITEMS = 500;

function r2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

async function checkStock(client, storePk, prevRun) {
  const { rows: top } = await client.query(
    `SELECT COALESCE(MAX(id), 0) AS m FROM stock_operations WHERE store_pk=$1`, [storePk],
  );
  const lastOpId = Number(top[0]?.m || 0);
  const { rows: meds } = await client.query(
    `SELECT local_id, name, batch_no, stock_qty FROM medicines WHERE store_pk=$1`, [storePk],
  );
  const items = [];
  let baseline = false;
  if (!prevRun) {
    baseline = true;
  } else {
    const { rows: snap } = await client.query(
      `SELECT medicine_id, stock_qty FROM stock_snapshots WHERE store_pk=$1`, [storePk],
    );
    const before = new Map(snap.map((r) => [Number(r.medicine_id), Number(r.stock_qty)]));
    const { rows: led } = await client.query(
      `SELECT medicine_id, SUM(qty_delta)::bigint AS d FROM stock_operations
        WHERE store_pk=$1 AND id > $2 AND id <= $3 GROUP BY medicine_id`,
      [storePk, Number(prevRun.last_op_id || 0), lastOpId],
    );
    const moved = new Map(led.map((r) => [Number(r.medicine_id), Number(r.d)]));
    for (const m of meds) {
      const id = Number(m.local_id);
      const was = before.get(id) ?? 0;
      const expected = was + (moved.get(id) ?? 0);
      const actual = Number(m.stock_qty || 0);
      if (expected !== actual) {
        items.push({
          kind: 'stock',
          ref_id: id,
          label: `${m.name || ''}${m.batch_no ? ` (${m.batch_no})` : ''}`.slice(0, 120),
          expected,
          actual,
          detail: `was ${was}, ledger moved ${moved.get(id) ?? 0}`,
        });
      }
    }
  }
  await client.query(`DELETE FROM stock_snapshots WHERE store_pk=$1`, [storePk]);
  await client.query(
    `INSERT INTO stock_snapshots (store_pk, medicine_id, stock_qty)
     SELECT $1, local_id, COALESCE(stock_qty, 0) FROM medicines WHERE store_pk=$1`,
    [storePk],
  );
  return { checked: meds.length, items, baseline, lastOpId };
}

async function checkDues(client, storePk) {
  const { rows: cust } = await client.query(
    `SELECT c.local_id, c.name, COALESCE(c.total_due,0)::float AS due, COALESCE(c.total_credit,0)::float AS credit,
       COALESCE((SELECT SUM(total_amount) FROM sales s WHERE s.store_pk=c.store_pk AND s.customer_id=c.local_id
                 AND NOT s.deleted AND NOT s.is_autosave),0)::float
       - COALESCE((SELECT SUM(amount_paid) FROM sales s WHERE s.store_pk=c.store_pk AND s.customer_id=c.local_id
                 AND NOT s.deleted AND NOT s.is_autosave),0)::float
       - COALESCE((SELECT SUM(amount) FROM customer_payments p WHERE p.store_pk=c.store_pk
                 AND p.customer_id=c.local_id AND NOT p.deleted),0)::float
       - COALESCE((SELECT SUM(refund_amount) FROM sales_returns r WHERE r.store_pk=c.store_pk
                 AND r.customer_id=c.local_id AND NOT r.deleted),0)::float AS net
     FROM customers c WHERE c.store_pk=$1 AND NOT c.deleted`,
    [storePk],
  );
  const { rows: sup } = await client.query(
    `SELECT s.local_id, s.name, COALESCE(s.total_due,0)::float AS due, COALESCE(s.total_credit,0)::float AS credit,
       COALESCE((SELECT SUM(COALESCE(final_amount, total_amount)) FROM purchases p WHERE p.store_pk=s.store_pk
                 AND p.supplier_id=s.local_id AND NOT p.deleted AND NOT COALESCE(p.is_autosave,false)),0)::float
       - COALESCE((SELECT SUM(${PURCHASE_ENTRY_PAID_SQL}) FROM purchases p WHERE p.store_pk=s.store_pk
                 AND p.supplier_id=s.local_id AND NOT p.deleted AND NOT COALESCE(p.is_autosave,false)),0)::float
       - COALESCE((SELECT SUM(amount) FROM supplier_payments x WHERE x.store_pk=s.store_pk
                 AND x.supplier_id=s.local_id AND NOT x.deleted),0)::float
       - COALESCE((SELECT SUM(refund_amount) FROM purchase_returns r WHERE r.store_pk=s.store_pk
                 AND r.supplier_id=s.local_id AND NOT r.deleted),0)::float AS net
     FROM suppliers s WHERE s.store_pk=$1 AND NOT s.deleted`,
    [storePk],
  );
  const items = [];
  const judge = (kind, row) => {
    const net = r2(row.net);
    const held = r2(Number(row.due) - Number(row.credit));
    if (Math.abs(net - held) > EPS) {
      items.push({
        kind,
        ref_id: Number(row.local_id),
        label: String(row.name || '').slice(0, 120),
        expected: net,
        actual: held,
        detail: `ledger ${net >= 0 ? 'due' : 'credit'} ${Math.abs(net).toFixed(2)}, stored due ${Number(row.due).toFixed(2)} / credit ${Number(row.credit).toFixed(2)}`,
      });
    }
  };
  cust.forEach((r) => judge('customer_due', r));
  sup.forEach((r) => judge('supplier_due', r));
  return { checked: cust.length + sup.length, items };
}

/** One store: compare, record the run and its differences. */
export async function runStoreCheck(storePk) {
  return withTransaction(async (client) => {
    await lockStorePush(client, storePk);
    const { rows: prev } = await client.query(
      `SELECT id, last_op_id FROM sync_check_runs WHERE store_pk=$1 ORDER BY id DESC LIMIT 1`,
      [storePk],
    );
    const stock = await checkStock(client, storePk, prev[0] || null);
    const dues = await checkDues(client, storePk);
    const { rows: fl } = await client.query(
      `SELECT COUNT(*)::int AS n FROM device_events
        WHERE store_pk=$1 AND outcome <> 'applied' AND resolved_at IS NULL`,
      [storePk],
    );
    const stockItems = stock.items.length;
    const duesItems = dues.items.length;
    const { rows: run } = await client.query(
      `INSERT INTO sync_check_runs (store_pk, baseline, stock_checked, stock_mismatches,
         dues_checked, dues_mismatches, open_flags, last_op_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, run_at`,
      [
        storePk, stock.baseline, stock.checked, stockItems, dues.checked, duesItems,
        Number(fl[0]?.n || 0), stock.lastOpId,
        stock.baseline ? 'first run: stock snapshot taken, compared from the next run' : null,
      ],
    );
    const runId = run[0].id;
    const all = [...stock.items, ...dues.items].slice(0, MAX_ITEMS);
    for (const it of all) {
      await client.query(
        `INSERT INTO sync_check_items (run_id, kind, ref_id, label, expected, actual, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [runId, it.kind, it.ref_id, it.label, it.expected, it.actual, it.detail],
      );
    }
    return {
      store_pk: storePk,
      run_id: Number(runId),
      run_at: run[0].run_at,
      baseline: stock.baseline,
      stock_checked: stock.checked,
      stock_mismatches: stockItems,
      dues_checked: dues.checked,
      dues_mismatches: duesItems,
      open_flags: Number(fl[0]?.n || 0),
    };
  });
}

export async function runAllStoreChecks() {
  const { rows } = await query(`SELECT id FROM stores WHERE is_active ORDER BY id`);
  const out = [];
  for (const r of rows) {
    try {
      out.push(await runStoreCheck(Number(r.id)));
    } catch (err) {
      out.push({ store_pk: Number(r.id), error: String(err.message || err) });
    }
  }
  return out;
}

/** For the admin panel: the latest runs of a store and the differences of the newest. */
export async function latestChecks(storePk, { runs = 14 } = {}) {
  const { rows: list } = await query(
    `SELECT id, run_at, baseline, stock_checked, stock_mismatches, dues_checked,
            dues_mismatches, open_flags, notes
       FROM sync_check_runs WHERE store_pk=$1 ORDER BY id DESC LIMIT $2`,
    [storePk, Math.max(1, Math.min(60, Number(runs) || 14))],
  );
  let items = [];
  if (list[0]) {
    const { rows } = await query(
      `SELECT kind, ref_id, label, expected::float, actual::float, detail
         FROM sync_check_items WHERE run_id=$1 ORDER BY kind, label LIMIT ${MAX_ITEMS}`,
      [list[0].id],
    );
    items = rows;
  }
  return { runs: list, latest_items: items };
}
