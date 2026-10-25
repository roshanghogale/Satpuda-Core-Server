// Cash & Expenses (PC core/cash_register.py, 25 Oct 2026): the two collections the PC's
// register syncs -- cash_days (opening / counted cash of a date) and cash_expenses (typed
// lines) -- are known to the sync, written with upsertSimple's version rules, and read back by
// the pull and the changes feed with the same columns the PC sends.
// Run: node --test test/cashRegister.test.mjs   (no database: pool.query is replaced)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import { COLLECTIONS, fetchDocsByLocalIds, pullCollection } from '../src/services/syncService.js';
import { upsertCashDay, upsertCashExpense } from '../src/services/extraUpserts.js';
import { CASCADE_TABLES } from '../src/services/storeDelete.js';
import fs from 'node:fs';

const SCHEMA = fs.readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');

/** A client that answers the "is it there?" SELECT from `existing` and records every write. */
function fakeClient(existing = null) {
  const writes = [];
  return {
    writes,
    async query(sql, vals) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/^SELECT version, updated_at, device_id, deleted FROM \w+ WHERE store_pk=\$1 AND local_id=\$2$/.test(s)) {
        return { rows: existing ? [existing] : [] };
      }
      writes.push({ sql: s, vals });
      return { rows: [] };
    },
  };
}

function insertOf(client) {
  const w = client.writes.find((x) => x.sql.startsWith('INSERT INTO'));
  assert.ok(w, 'a row was written');
  const m = /^INSERT INTO (\w+) \(([^)]+)\) VALUES/.exec(w.sql);
  const cols = m[2].split(',').map((c) => c.trim());
  const row = {};
  cols.forEach((c, i) => { row[c] = w.vals[i]; });
  return { table: m[1], row, sql: w.sql };
}

test('the register collections are synced, deleted with the store, and in the schema', () => {
  for (const c of ['cash_days', 'cash_expenses']) {
    assert.ok(COLLECTIONS.includes(c), `${c} in COLLECTIONS`);
    assert.ok(CASCADE_TABLES.includes(c), `${c} cascades with the store`);
    assert.match(SCHEMA, new RegExp(`CREATE TABLE IF NOT EXISTS ${c} \\(`));
    assert.match(SCHEMA, new RegExp(`CREATE TABLE IF NOT EXISTS ${c} \\([^;]*UNIQUE\\(store_pk, local_id\\)`));
  }
});

test('a cash day from the PC is written with its own id, date, money and close stamp', async () => {
  const client = fakeClient();
  const r = await upsertCashDay(client, 7, {
    id: 3000000001, day: '2026-10-25', opening_cash: '1500', counted_cash: 2320.5,
    closed_at: '2026-10-25T14:02:11.120Z', note: 'ok', created_at: '2026-10-25T03:00:00.000Z',
    updated_at: '2026-10-25T14:02:11.120Z', version: 3, device_id: 'pc-a', deleted: false,
  });
  assert.equal(r.status, 'upserted');
  const { table, row, sql } = insertOf(client);
  assert.equal(table, 'cash_days');
  assert.equal(row.store_pk, 7);
  assert.equal(row.local_id, 3000000001);
  assert.equal(row.day, '2026-10-25');
  assert.equal(row.opening_cash, 1500);
  assert.equal(row.counted_cash, 2320.5);
  assert.equal(row.closed_at.toISOString(), '2026-10-25T14:02:11.120Z');
  assert.equal(row.version, 3);
  assert.equal(row.device_id, 'pc-a');
  assert.equal(row.deleted, false);
  assert.match(sql, /ON CONFLICT \(store_pk, local_id\) DO UPDATE SET day=EXCLUDED\.day/);
});

test('an open day carries no count (NULL), not 0', async () => {
  const client = fakeClient();
  await upsertCashDay(client, 7, { id: 1, day: '2026-10-25', opening_cash: 0, counted_cash: null, closed_at: null,
    updated_at: '2026-10-25T03:00:00.000Z', version: 1 });
  const { row } = insertOf(client);
  assert.equal(row.opening_cash, 0);
  assert.equal(row.counted_cash, null);
  assert.equal(row.closed_at, null);
});

test('an expense line keeps kind, category, time and amount; an unknown kind reads as an expense', async () => {
  const client = fakeClient();
  await upsertCashExpense(client, 7, {
    id: 3000000002, day: '2026-10-25', at: '10:15:33', kind: 'IN', category: 'Owner', description: 'Added cash',
    amount: '500.00', created_at: '2026-10-25T04:45:00.000Z', updated_at: '2026-10-25T04:45:00.000Z', version: 1,
  });
  let { table, row } = insertOf(client);
  assert.equal(table, 'cash_expenses');
  assert.deepEqual([row.day, row.at, row.kind, row.category, row.description, row.amount],
    ['2026-10-25', '10:15', 'in', 'Owner', 'Added cash', 500]);

  const client2 = fakeClient();
  await upsertCashExpense(client2, 7, { id: 5, day: '2026-10-25', kind: 'tea?', description: 'Tea', amount: 20,
    updated_at: '2026-10-25T04:45:00.000Z' });
  ({ row } = insertOf(client2));
  assert.equal(row.kind, 'out');
  assert.equal(row.category, null);
});

test('a re-push of the same version and time is a no-op; a newer version is taken', async () => {
  const stored = { version: 2, updated_at: '2026-10-25T04:45:00.000Z', device_id: 'pc-a', deleted: false };
  const same = fakeClient(stored);
  const r1 = await upsertCashExpense(same, 7, { id: 5, day: '2026-10-25', description: 'Tea', amount: 20,
    version: 2, updated_at: '2026-10-25T04:45:00.000Z' });
  assert.equal(r1.status, 'skipped');
  assert.equal(same.writes.length, 0);

  const newer = fakeClient(stored);
  const r2 = await upsertCashExpense(newer, 7, { id: 5, day: '2026-10-25', description: 'Tea x2', amount: 40,
    version: 3, updated_at: '2026-10-25T05:00:00.000Z' });
  assert.equal(r2.status, 'upserted');
  assert.equal(insertOf(newer).row.amount, 40);

  // A delete from the PC arrives as deleted: true and is taken whatever the version.
  const gone = fakeClient(stored);
  const r3 = await upsertCashExpense(gone, 7, { id: 5, day: '2026-10-25', description: 'Tea', amount: 20,
    version: 2, updated_at: '2026-10-25T04:45:00.000Z', deleted: true });
  assert.equal(r3.status, 'upserted');
  assert.equal(insertOf(gone).row.deleted, true);
});

/** Run fn with pool.query answering from `rows`; returns the SQL it was asked. */
async function withQuery(rows, fn) {
  const asked = [];
  const real = pool.query;
  pool.query = async (text, params) => { asked.push({ text: text.replace(/\s+/g, ' '), params }); return { rows, rowCount: rows.length }; };
  try {
    return { out: await fn(), asked };
  } finally {
    pool.query = real;
  }
}

const DAY_COLS = ['id', 'day', 'opening_cash', 'counted_cash', 'closed_at', 'note', 'created_at', 'updated_at',
  'version', 'device_id', 'deleted', 'sync_status'];
const EXP_COLS = ['id', 'day', 'at', 'kind', 'category', 'description', 'amount', 'created_at', 'updated_at',
  'version', 'device_id', 'deleted', 'sync_status'];

test('the pull and the changes feed read both tables with every column the PC writes', async () => {
  for (const [col, cols] of [['cash_days', DAY_COLS], ['cash_expenses', EXP_COLS]]) {
    const row = Object.fromEntries(cols.map((c) => [c, c === 'id' ? 3000000001 : null]));
    const pulled = await withQuery([row], () => pullCollection(7, col, { since: null, limit: 100 }));
    assert.equal(pulled.asked.length, 1, `${col}: one query`);
    const sql = pulled.asked[0].text;
    assert.match(sql, new RegExp(`FROM ${col} WHERE store_pk=\\$1 AND updated_at > \\$2`));
    for (const c of cols.filter((c) => c !== 'id')) assert.match(sql, new RegExp(`\\b${c}\\b`), `${col} pull selects ${c}`);
    assert.match(sql, /^SELECT to_char\(updated_at/, 'carries the microsecond sync_cursor');
    assert.equal(pulled.out.length, 1);
    assert.equal(pulled.out[0].id, 3000000001);

    const byId = await withQuery([row], () => fetchDocsByLocalIds(7, col, [3000000001]));
    assert.match(byId.asked[0].text, new RegExp(`FROM ${col} WHERE store_pk=\\$1 AND local_id = ANY\\(\\$2::bigint\\[\\]\\)`));
    assert.deepEqual(byId.asked[0].params, [7, [3000000001]]);
    assert.equal(byId.out[0].id, 3000000001);
  }
});
