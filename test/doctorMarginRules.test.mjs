// Doctor margin by RULES: the server's port against vectors made by RUNNING the PC python
// (scripts/make-doctor-margin-rules-vectors.py -> test/fixtures/doctor_margin_rules_vectors.json),
// and the rules-history choice (which version, which purchase lines) of doctorMarginHistory.js.
// Rules version 2 (23 Oct 2026): per type none / on profit (groups only, "All products" groups)
// / on total sales (a % of the sale value); version 1 still read. Both ways in every vector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as R from '../src/services/doctorMarginRules.js';
import {
  buildVersions, effectiveFrom, parseRuns, parseShopTime, pickVersion, recordRulesHistory, shopNowText,
} from '../src/services/doctorMarginHistory.js';
import { computeReport, parseFilters, shapeBooks } from '../src/services/doctorMarginRulesStore.js';

const V = JSON.parse(fs.readFileSync(new URL('./fixtures/doctor_margin_rules_vectors.json', import.meta.url)));
const plain = (x) => JSON.parse(JSON.stringify(x));

/** The PC's saved-lines report in memory (the vectors' "saved"): one rules version. */
function savedPipeline(sales, purchases, rules, opts) {
  const res = new R.Resolver(rules);
  const rates = R.batchRates(purchases);
  const want = new Set((opts.doctors || []).map(R.normName).filter(Boolean));
  let lines = [];
  for (const s of sales) for (const r of R.billLines(res, s, rates)) if (r.qty > 0) lines.push(r);
  lines = lines.filter((r) => !want.size || want.has(r.doctor));
  const k = (r) => [r.doctor, r.name, r.batch, r.date, r.bill_no, r.line_no];
  lines.sort((a, b) => {
    const ka = k(a); const kb = k(b);
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
  const basis = String(opts.rate_basis || '').trim().toLowerCase();
  if (R.RATE_BASES.includes(basis)) lines = lines.map((r) => R.withBasis(r, basis));
  const rep = R.assemble(lines);
  return { ...rep, products: R.byProduct(rep.rows) };
}

for (const c of V.pure) {
  test(`PC parity: ${c.name} -- rules cleaned, resolved, rates`, () => {
    assert.deepEqual(plain(R.cleanRules(c.rules)), c.clean);
    assert.equal(R.hasRules(c.rules), c.has_rules);
    const rates = R.batchRates(c.purchases);
    assert.deepEqual(Object.fromEntries([...rates].map(([k, v]) => [String(k), v])), c.rates);
    const res = new R.Resolver(c.rules);
    for (const p of c.probes) assert.deepEqual(res.resolve(...p.args), p.out, JSON.stringify(p.args));
  });
  for (const run of c.runs) {
    test(`PC parity: ${c.name} ${JSON.stringify(run.opts)} -- every line, summary, doctor and total`, () => {
      assert.deepEqual(plain(R.compute(c.sales, c.purchases, c.rules, run.opts)), run.compute);
      assert.deepEqual(plain(savedPipeline(c.sales, c.purchases, c.rules, run.opts)), run.saved);
    });
  }
}

test('PC parity: cleaning odd rules, and the errors the owner reads', () => {
  for (const c of V.clean) {
    if (c.error) {
      assert.throws(() => R.cleanRules(c.in), (e) => e instanceof R.RulesError && e.message === c.error, JSON.stringify(c.in));
    } else {
      assert.deepEqual(plain(R.cleanRules(c.in)), c.out, JSON.stringify(c.in));
      assert.equal(R.hasRules(c.in), c.has);
    }
  }
});

test('PC parity: sale units of a pack (MRP per tablet) and units a purchased pack put on the shelf', () => {
  for (const d of V.units.divisor) {
    assert.equal(R.saleUnitDivisor(d.type, d.unit || '1', d.name), d.div, JSON.stringify(d));
  }
  for (const u of V.units.units_per_pack) {
    assert.equal(R.purchaseUnitsPerPack(u.type, u.unit, u.qty, u.free, 0), u.units, JSON.stringify(u));
  }
  for (const p of V.units.pack) assert.equal(R.packText(p.unit), p.pack, JSON.stringify(p));
});

test('the vectors really hold both ways: total-sales lines, All-products groups, a doctor\'s own % and null', () => {
  const cleaned = V.pure.filter((c) => c.clean).map((c) => c.clean);
  const types = cleaned.flatMap((r) => r.sets.flatMap((st) => st.types));
  assert.ok(types.some((t) => t.mode === 'sales'));
  assert.ok(types.some((t) => t.mode === 'groups' && t.groups.some((g) => g.all)));
  assert.ok(cleaned.some((r) => r.sets.some((st) => st.doctor && st.sales_pct === null)));
  assert.ok(cleaned.some((r) => r.sets.some((st) => st.doctor && typeof st.sales_pct === 'number')));
  assert.ok(V.pure.some((c) => c.runs?.some((run) => run.compute.sales.rows.length && run.compute.grand.totals.commission > 0)));
  const sd = V.store.reports[0].expect.sales.doctors;
  assert.ok(sd.some((d) => d.by_pct.length === 2), 'a doctor with bills under two different %');
  assert.ok(V.store.reports[0].expect.sales.rows.some((r) => r.qty_returned > 0), 'a return on a total-sales line');
});

// ── a real PC store: rules changed, Recalculate, a later purchase ───────────────────────

const S = V.store;
function storeState() {
  const versions = buildVersions(S.history, S.current);
  return { rules: R.safeRules(S.current.value), versions, runs: parseRuns(S.recalc) };
}

for (const rep of S.reports) {
  test(`PC store parity: ${S.name} ${JSON.stringify(rep.q)}`, () => {
    const fl = parseFilters(rep.q);
    const want = new Set(fl.doctors);
    const bills = S.bills.filter((b) => b.d >= fl.from && b.d <= fl.to && String(b.doctor_name || '').trim()
      && (!want.size || want.has(R.normName(b.doctor_name))));
    const books = shapeBooks(bills, S.items, S.returns, S.purchases);
    const got = computeReport(storeState(), books, fl);
    for (const k of ['rows', 'summary', 'doctors', 'totals', 'products', 'flag_counts', 'sales', 'grand']) {
      assert.deepEqual(plain(got[k]), rep.expect[k], k);
    }
  });
}

test('the store case really exercises each way a bill gets its rules', () => {
  const fl = parseFilters({ from: '2026-10-10', to: '2026-10-20' });
  const got = computeReport(storeState(), shapeBooks(S.bills, S.items, S.returns, S.purchases), fl);
  assert.deepEqual(got.sync.by, { saved: 5, recalculated: 1, first_rules: 1, none: 0 });
  // the first version is a version 1 value (a PC of 22 Oct): read as version 2
  assert.equal(JSON.parse(S.history[0].value).version, 1);
  assert.equal(buildVersions(S.history, S.current)[0].rules.version, 2);
  // Rules NOT changed (only the latest version) and no Recalculate: the plain PC compute.
  const only = { rules: R.safeRules(S.current.value), versions: buildVersions([], S.current), runs: [] };
  const all = computeReport(only, shapeBooks(S.bills, S.items, S.returns, S.purchases.map((p) => ({ ...p, saved_ms: null }))), fl);
  const sales = shapeBooks(S.bills, S.items, S.returns, S.purchases).sales;
  const plainPc = R.compute(sales, shapeBooks([], [], [], S.purchases).purchases, S.current.value, {});
  const noStamp = (rows) => plain(rows).map(({ rules_at: _r, ...r }) => r);
  assert.ok(all.rows.every((r) => r.rules_at === R.safeRules(S.current.value).updated));
  assert.deepEqual(noStamp(all.rows), plain(plainPc.rows));
  assert.deepEqual(noStamp(all.sales.rows), plain(plainPc.sales.rows));
  assert.deepEqual(all.totals, plainPc.totals);
  assert.deepEqual(all.grand, plainPc.grand);
});

test('the report (web and the phone route: the same service) carries both ways and the doctor\'s margin', () => {
  const fl = parseFilters({ from: '2026-10-10', to: '2026-10-20' });
  const got = computeReport(storeState(), shapeBooks(S.bills, S.items, S.returns, S.purchases), fl);
  assert.deepEqual(Object.keys(got.grand), ['doctors', 'totals']);
  assert.deepEqual(Object.keys(got.sales), ['rows', 'doctors', 'totals']);
  for (const g of got.grand.doctors) {
    const p = got.doctors.find((d) => d.doctor === g.doctor);
    const sd = got.sales.doctors.find((d) => d.doctor === g.doctor);
    assert.equal(g.total, R.r2((p ? p.value : 0) + (sd ? sd.commission : 0)));
  }
  assert.ok(got.sales.rows.every((r) => r.way === 'sales' && r.kind === R.SALES_KIND));
  assert.ok(got.rows.every((r) => r.way === 'profit'));
  // the rate choice never touches a total-sales line
  const free = computeReport(storeState(), shapeBooks(S.bills, S.items, S.returns, S.purchases), { ...fl, rate_basis: 'purchase_free' });
  assert.deepEqual(plain(free.sales), plain(got.sales));
});

test('a total-sales line: the amount as billed, returns pro rata, commission on the doctor\'s total', () => {
  const rules = { sets: [{ doctor: '', sales_pct: 10, types: [{ type: 'Syrup', mode: 'sales' }] },
    { doctor: 'dr x', sales_pct: 12.5, types: [] }, { doctor: 'dr y', sales_pct: null, types: [] }] };
  const item = (id, qty, amount) => ({ id, medicine_id: 1, name: 'SYR', type: 'syrup', batch: 'B', qty, sale_rate: 30, amount, disc: 0, pack: '100ML' });
  const sales = [
    { id: 1, bill_no: 'A', date: '2026-10-12', patient: 'P', doctor: 'Dr X', items: [item(1, 3, 85.5)], returns: [{ medicine_id: 1, qty: 1 }] },
    { id: 2, bill_no: 'B', date: '2026-10-12', patient: 'P', doctor: 'Dr X', items: [item(2, 1, 0.05), item(3, 1, 0.05)] },
    { id: 3, bill_no: 'C', date: '2026-10-12', patient: 'P', doctor: 'Dr Y', items: [item(4, 2, 60)] },
  ];
  const rep = R.compute(sales, [], rules);
  assert.equal(rep.rows.length, 0);
  assert.deepEqual(rep.sales.rows.map((r) => [r.doctor, r.qty, r.value, r.kind_value]),
    [['DR X', 2, 57, 12.5], ['DR X', 1, 0.05, 12.5], ['DR X', 1, 0.05, 12.5], ['DR Y', 2, 60, 10]]);
  // 57.10 x 12.5% = 7.1375 -> 7.14 on the total (line by line it would be 7.13 + 0.01 + 0.01)
  assert.deepEqual(rep.sales.doctors.map((d) => [d.doctor, d.value, d.commission, d.products[0].pack]),
    [['DR X', 57.1, 7.14, '100ML'], ['DR Y', 60, 6, '100ML']]);
  assert.deepEqual(rep.grand.totals, { profit: 0, sales_value: 117.1, commission: 13.14, total: 13.14 });
  assert.equal(R.RECALC_VERSION, 1, 'the Recalculate marker keeps its own version');
});

// ── the history choice on its own ───────────────────────────────────────────────────────

test('shop times: a time without a zone is IST; now is written as the PC writes it', () => {
  assert.equal(parseShopTime('2026-10-23T10:00:00'), Date.parse('2026-10-23T04:30:00Z'));
  assert.equal(parseShopTime('2026-10-23 10:00'), Date.parse('2026-10-23T04:30:00Z'));
  assert.equal(parseShopTime('2026-10-23T10:00:00Z'), Date.parse('2026-10-23T10:00:00Z'));
  assert.equal(parseShopTime(''), null);
  assert.equal(parseShopTime('junk'), null);
  assert.equal(shopNowText(new Date('2026-10-23T04:30:05Z')), '2026-10-23T10:00:05');
  const v = JSON.stringify({ updated: '2026-10-23T10:00:00', sets: [] });
  assert.equal(effectiveFrom(v, Date.parse('2026-10-23T12:00:00Z')), Date.parse('2026-10-23T04:30:00.999Z'));
  // a device clock ahead of the server: never in force before it arrived
  assert.equal(effectiveFrom(v, Date.parse('2026-10-23T01:00:00Z')), Date.parse('2026-10-23T01:00:00Z'));
});

const T = (h) => Date.parse(`2026-10-1${h}T00:00:00Z`);
const rulesV = (updated, margin) => JSON.stringify(R.cleanRules({
  updated, sets: [{ doctor: '', types: [{ type: 'Tablet', mode: margin ? 'groups' : 'none', groups: [{ all: true, margin }] }] }],
}));

test('versions: in arrival order, never in force before the one that arrived before', () => {
  const v = buildVersions([
    { id: 2, value: rulesV('B', { kind: 'fixed', value: 2 }), effective_at: new Date(T(2)) },
    { id: 1, value: rulesV('A', { kind: 'fixed', value: 1 }), effective_at: new Date(T(5)) },
  ], null);
  assert.deepEqual(v.map((x) => [x.updated, x.from]), [['A', T(5)], ['B', T(5)]]);
  // the setting now differs from the last kept version: it is the last version
  const v2 = buildVersions([{ id: 1, value: rulesV('A', { kind: 'fixed', value: 1 }), effective_at: T(1) }],
    { value: rulesV('2026-10-14T05:30:00', { kind: 'fixed', value: 9 }), updated_at: new Date(T(6)) });
  assert.deepEqual(v2.map((x) => [x.updated, x.from]), [['A', T(1)], ['2026-10-14T05:30:00', T(4) + 999]]);
  // no history yet: the setting alone, in force from its own stamp
  assert.equal(buildVersions([], { value: rulesV('A', null), updated_at: T(3) }).length, 1);
  assert.deepEqual(buildVersions([], null), []);
});

test('which version a bill gets: saved time, a later Recalculate, the first rules', () => {
  const versions = buildVersions([
    { id: 1, value: rulesV('NONE', null), effective_at: T(1) },
    { id: 2, value: rulesV('V1', { kind: 'fixed', value: 1 }), effective_at: T(3) },
    { id: 3, value: rulesV('V2', { kind: 'fixed', value: 2 }), effective_at: T(5) },
  ], null);
  const at = (d, ms, runs = []) => {
    const p = pickVersion(versions, runs, d, ms);
    return p && [p.version.updated, p.at, p.via];
  };
  assert.deepEqual(at('2026-10-12', T(4)), ['V1', T(4), 'saved']);
  assert.deepEqual(at('2026-10-12', T(6)), ['V2', T(6), 'saved']);
  // saved while the rules gave nothing (or before any rules): the first rules after that
  assert.deepEqual(at('2026-10-12', T(2)), ['V1', T(3), 'first_rules']);
  assert.deepEqual(at('2026-10-12', T(0)), ['V1', T(3), 'first_rules']);
  const runs = parseRuns(JSON.stringify({ runs: [
    { from: '2026-10-12', to: '2026-10-12', at: '2026-10-17T05:30:00', rules_updated: 'V1' },
    { from: '2026-10-10', to: '2026-10-11', at: '2026-10-17T05:30:00', rules_updated: 'gone' },
    { from: 'bad', to: '2026-10-11', at: 'x' },
  ] }));
  assert.equal(runs.length, 2);
  // a Recalculate after the bill, of a period holding its date: that run's rules and time
  assert.deepEqual(at('2026-10-12', T(6), runs), ['V1', T(7) + 999, 'recalculated']);
  // a run naming rules no longer known: the version in force when it ran
  assert.deepEqual(at('2026-10-11', T(4), runs), ['V2', T(7) + 999, 'recalculated']);
  // a bill saved after the run, or of another date: not touched by it
  assert.deepEqual(at('2026-10-12', T(8), runs), ['V2', T(8), 'saved']);
  assert.deepEqual(at('2026-10-13', T(4), runs), ['V1', T(4), 'saved']);
  // no rules ever giving a margin: nothing
  assert.equal(pickVersion(buildVersions([{ id: 1, value: rulesV('N', null), effective_at: T(1) }], null), [], '2026-10-12', T(2)), null);
});

test('the rules history is written on the push client and never fails the push', async () => {
  const calls = [];
  const client = (failOn) => ({
    query: async (sql, params) => {
      calls.push([sql.trim().split(/\s+/).slice(0, 3).join(' '), params]);
      if (failOn && sql.includes(failOn)) throw new Error('boom');
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: 0 }] };
      return { rows: [] };
    },
  });
  const prev = { value: rulesV('2026-10-12T09:00:00', { kind: 'fixed', value: 1 }), updated_at: new Date(T(2)) };
  await recordRulesHistory(client(), 7, prev, rulesV('2026-10-14T09:00:00', { kind: 'fixed', value: 2 }));
  const inserts = calls.filter(([s]) => s.startsWith('INSERT INTO'));
  assert.equal(inserts.length, 2, 'the value it replaced, then the new one');
  assert.equal(inserts[0][1][2], '2026-10-12T09:00:00');
  assert.equal(inserts[1][1][2], '2026-10-14T09:00:00');
  assert.ok(calls.some(([s]) => s.startsWith('RELEASE SAVEPOINT')));
  calls.length = 0;
  await recordRulesHistory(client('INSERT INTO'), 7, null, rulesV('X', null));
  assert.ok(calls.some(([s]) => s.startsWith('ROLLBACK TO SAVEPOINT')), 'only its own savepoint is undone');
});

test('nothing outside the doctor report: the calculation never changes its input bills', () => {
  const c = V.pure[0];
  const before = JSON.stringify([c.sales, c.purchases]);
  R.compute(c.sales, c.purchases, c.rules, { rate_basis: 'purchase_free' });
  savedPipeline(c.sales, c.purchases, c.rules, {});
  assert.equal(JSON.stringify([c.sales, c.purchases]), before);
});
