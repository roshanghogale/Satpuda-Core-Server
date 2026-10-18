/**
 * The statements services/wholesaleStore.js sends, answered from an in-memory
 * `stores` Map, for the no-database tests (wholesale-test.mjs, wholesale-store-test.mjs).
 *
 *   companionStatement(stores, sql, vals, sideTables) -> { rows } | undefined
 *   fakeConnect(runQuery)  -> a pool.connect() whose client runs through runQuery and
 *                             honours pg_advisory_xact_lock (held until COMMIT/ROLLBACK),
 *                             so a race between two callers is a real race here too.
 *
 * `sql` is the statement with whitespace collapsed. Unique store_id / store_key /
 * android_key are enforced on INSERT like the real table.
 */

const LOCKS = new Map(); // key -> Promise chain tail

function splitTop(s) {
  const out = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of s) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth += 1;
    if (!quoted && ch === ')') depth -= 1;
    if (!quoted && ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function project(row, colList) {
  const cols = splitTop(colList.replace(/\s+/g, ' '));
  if (cols.length === 1 && cols[0] === '*') return { ...row };
  const out = {};
  for (const c of cols) out[c] = row[c];
  return out;
}

function literal(expr, vals) {
  let m;
  if ((m = /^\$(\d+)$/.exec(expr))) return vals[Number(m[1]) - 1];
  if (expr === 'TRUE') return true;
  if (expr === 'FALSE') return false;
  if (expr === 'NULL') return null;
  if (expr === 'NOW()') return new Date(Date.now() + 1000);
  if ((m = /^'([^']*)'$/.exec(expr))) return m[1];
  throw new Error(`fake db: unsupported value ${expr}`);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

export async function companionStatement(stores, sql, vals = [], side = {}) {
  let m;
  if ((m = /^SELECT (.+) FROM stores WHERE parent_store_id = \$1 AND store_kind = 'wholesale' ORDER BY id LIMIT 1$/.exec(sql))) {
    await tick();
    const row = [...stores.values()]
      .filter((r) => r.parent_store_id === Number(vals[0]) && r.store_kind === 'wholesale')
      .sort((a, b) => a.id - b.id)[0];
    return { rows: row ? [project(row, m[1])] : [] };
  }
  if ((m = /^SELECT (.+) FROM stores WHERE id = \$1 FOR UPDATE$/.exec(sql))) {
    await tick();
    const row = stores.get(Number(vals[0]));
    return { rows: row ? [project(row, m[1])] : [] };
  }
  if (/^SELECT \* FROM stores WHERE parent_store_id = \$1 AND store_kind = 'wholesale' FOR UPDATE$/.test(sql)) {
    const rows = [...stores.values()]
      .filter((r) => r.parent_store_id === Number(vals[0]) && r.store_kind === 'wholesale')
      .map((r) => ({ ...r }));
    return { rows };
  }
  if (/^SELECT store_id, store_name FROM stores WHERE id = \$1$/.test(sql)) {
    const row = stores.get(Number(vals[0]));
    return { rows: row ? [{ store_id: row.store_id, store_name: row.store_name }] : [] };
  }
  if (/^SELECT \* FROM stores WHERE android_key = \$1$/.test(sql)) {
    const row = [...stores.values()].find((r) => r.android_key === vals[0]);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (/^SELECT id FROM stores WHERE store_id = \$1 OR store_key = \$2 LIMIT 1$/.test(sql)) {
    await tick();
    const row = [...stores.values()].find((r) => r.store_id === vals[0] || r.store_key === vals[1]);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (/^SELECT id FROM stores WHERE android_key = \$1 LIMIT 1$/.test(sql)) {
    const row = [...stores.values()].find((r) => r.android_key === vals[0]);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if ((m = /^INSERT INTO stores \((.+?)\) VALUES \((.+)\) RETURNING (.+)$/.exec(sql))) {
    await tick();
    const cols = splitTop(m[1]);
    const exprs = splitTop(m[2]);
    if (cols.length !== exprs.length) throw new Error('fake db: INSERT column/value count');
    const row = {
      app_mode: 'online', is_active: true, device_role: 'pc', notes: null,
      activation_date: null, expiry_enabled: false, expiry_date: null,
      apply_expiry_check: true, provisioned_trial: false,
      voice_enabled: false, voice_tier: 'auto', wholesale_enabled: false,
      store_kind: 'retail', parent_store_id: null,
      created_at: new Date(), updated_at: new Date(),
    };
    cols.forEach((c, i) => { row[c] = literal(exprs[i], vals); });
    for (const r of stores.values()) {
      for (const k of ['store_id', 'store_key', 'android_key']) {
        if (row[k] != null && r[k] === row[k]) {
          const err = new Error(`duplicate key value violates unique constraint "stores_${k}_key"`);
          err.code = '23505';
          throw err;
        }
      }
    }
    row.id = Math.max(0, ...stores.keys()) + 1;
    stores.set(row.id, row);
    return { rows: [project(row, m[3])] };
  }
  if ((m = /^INSERT INTO (pharmacy_profiles|store_dropdowns) /.exec(sql))) {
    (side[m[1]] ||= []).push(vals.slice());
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE stores SET wholesale_enabled = FALSE, updated_at = NOW\(\) WHERE parent_store_id = \$1 AND store_kind = 'wholesale' AND wholesale_enabled = TRUE RETURNING id$/.test(sql)) {
    const out = [];
    for (const r of stores.values()) {
      if (r.parent_store_id === Number(vals[0]) && r.store_kind === 'wholesale' && r.wholesale_enabled === true) {
        stores.set(r.id, { ...r, wholesale_enabled: false, updated_at: new Date() });
        out.push({ id: r.id });
      }
    }
    return { rows: out, rowCount: out.length };
  }
  return undefined;
}

/**
 * The plain store statements the licence / auth / admin paths send (read by id,
 * admin getStore, UPDATE ... WHERE id = $n, store_devices bookkeeping).
 */
export async function plainStoresStatement(stores, sql, vals = []) {
  let m;
  if ((m = /^SELECT (.+) FROM stores WHERE id = \$1$/.exec(sql))) {
    const row = stores.get(Number(vals[0]));
    return { rows: row ? [project(row, m[1])] : [] };
  }
  if (/^SELECT \* FROM stores WHERE id::text = \$1 OR store_id = \$1$/.test(sql)) {
    const row = [...stores.values()].find((r) => String(r.id) === vals[0] || r.store_id === vals[0]);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (/^SELECT id FROM stores WHERE store_id = \$1 OR id::text = \$1$/.test(sql)) {
    const row = [...stores.values()].find((r) => String(r.id) === vals[0] || r.store_id === vals[0]);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if ((m = /^UPDATE stores SET (.+) WHERE id = \$(\d+) RETURNING (.+)$/.exec(sql))) {
    const row = stores.get(Number(vals[Number(m[2]) - 1]));
    if (!row) return { rows: [] };
    const next = { ...row };
    for (const a of splitTop(m[1])) {
      const [, col, expr] = /^(\w+) = (.+)$/.exec(a) || [];
      if (!col) throw new Error(`fake db: unsupported assignment ${a}`);
      const c = /^COALESCE\((\w+),\s*\$(\d+)\)$/.exec(expr.trim());
      next[col] = c ? (row[c[1]] ?? vals[Number(c[2]) - 1]) : literal(expr.trim(), vals);
    }
    stores.set(row.id, next);
    return { rows: [project(next, m[3])] };
  }
  if (/^(UPDATE|INSERT INTO) store_devices\b/.test(sql)) return { rows: [] };
  return undefined;
}

/** pool.connect() for withTransaction, with advisory locks that really block. */
export function fakeConnect(runQuery) {
  return async () => {
    const held = [];
    return {
      async query(text, vals = []) {
        const sql = String(text).replace(/\s+/g, ' ').trim();
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          while (held.length) held.pop()();
          return { rows: [] };
        }
        const m = /^SELECT pg_advisory_xact_lock\((\d+), \$1::int\)$/.exec(sql);
        if (m) {
          const key = `${m[1]}:${Number(vals[0])}`;
          const prev = LOCKS.get(key) || Promise.resolve();
          let release;
          const mine = new Promise((resolve) => { release = resolve; });
          LOCKS.set(key, prev.then(() => mine));
          await prev;
          held.push(release);
          return { rows: [{}] };
        }
        return runQuery(text, vals);
      },
      release() {},
    };
  };
}
