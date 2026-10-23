/**
 * Doctor margin RULES (owner, 22 + 23 Oct 2026) -- the PC's core/doctor_margin_rules.py, line
 * for line, so the web and the phone show the same figures as the PC's Doctor Margin Report.
 * test/doctorMarginRules.test.mjs checks this file against vectors made by RUNNING the PC
 * python (test/fixtures/doctor_margin_rules_vectors.json).
 *
 * Two ways to give a doctor his margin (owner, 23 Oct 2026), chosen PER MEDICINE TYPE:
 *   on profit       per doctor, product / quantity / MRP / rate / total value with
 *                   total value = (MRP - rate) x quantity. ONLY the products picked into a
 *                   group count; a product of that type in no group is not in the report.
 *   on total sales  X% of the total sale value of the chosen types. No purchase rate.
 *
 * The rules -- one store setting `doctor_margin_rules` (JSON), shop-wide, synced. VERSION 2:
 *   {version: 2, rate_basis: 'purchase' | 'purchase_free', updated,
 *    sets: [{doctor: '' (= All doctors, always first) | 'DR NAME',
 *            rate_basis: null (= as All doctors) | 'purchase' | 'purchase_free',
 *            sales_pct: 0..100 (All doctors: never null) | null (a doctor: All doctors' %),
 *            types: [{type, mode: 'none' | 'groups' | 'sales', groups: [group]}]}]}
 *   group  = {name, margin, all: false, items: [{product, batches: [] (= every batch) | ['B1', ..]}]}
 *          | {name, margin, all: true, items: []}      every product of the type
 *   margin = {kind: 'mrp_rate' | 'pct_mrp' | 'fixed' | 'none', value}
 * VERSION 1 (22 Oct 2026) is still read and turned into version 2 (cleanRules):
 *   mode 'type' -> mode 'groups' with ONE group {name: 'All <type>', all: true, margin};
 *   'rest' (rest of type) -> dropped: a product in no group gives no margin now.
 *   Always written as version 2.
 *
 * Which rule a sold line gets (doctor D, type T, product P, batch B):
 *   1. D's own set when it has a rule for T, else the All doctors rule for T, else none.
 *   2. mode 'none': nothing. mode 'sales': D's own sales_pct when a number, else All doctors'.
 *   3. mode 'groups': a batch-limited item naming B > a one-product group > a group of several
 *      products > an "All products" group (the first when two tie); no group holds P: nothing.
 * On profit: rate = the purchase rate of THAT batch (medicine row), as billed (pack rate x
 * packs / units bought) or with free included (the same money / every unit received). No
 * purchase line: the medicine row's rate, then the bill's cost ("estimated"); neither: "no_rate".
 * On total sales: a line's value = its amount as billed (sales_items.amount, the line discount
 * off), returns pro rata (amount x net qty / qty sold); the commission is worked out on the
 * doctor's TOTAL per % = round(sum of values x pct / 100, 2).
 * Nothing here touches a sale, a purchase or stock: the figures are only for the doctor.
 *
 * Python's round() is half-to-even on the double's exact value: pyRound (billRules.js).
 */
import { pyRound } from './billRules.js';
import { isStripCountType, parseTabletsPerStripe } from '../utils/saleProfit.js';

export const SETTING_NAME = 'doctor_margin_rules';
export const RECALC_SETTING = 'doctor_margin_rules_recalc';
export const RECALC_VERSION = 1;
export const VERSION = 2;
export const NO_DOCTOR = '(No doctor)';
export const RATE_BASES = ['purchase', 'purchase_free'];
export const MODES = ['none', 'groups', 'sales'];
export const WAYS = ['profit', 'sales'];
export const KINDS = ['mrp_rate', 'pct_mrp', 'fixed', 'none'];
export const SALES_KIND = 'sales_pct'; // the kind a total-sales line carries (kind_value = the %)
export const RATE_BASIS_TEXT = {
  purchase: 'Purchase rate',
  purchase_free: 'Purchase rate with free included',
};
export const KIND_TEXT = {
  mrp_rate: 'MRP - rate', pct_mrp: '% of MRP', fixed: 'Fixed per unit', none: 'No margin', sales_pct: '% of total sales',
};
export const MODE_TEXT = { none: 'No margin', groups: 'On profit (groups)', sales: 'On total sales (%)' };
export const FLAG_TEXT = {
  estimated: 'Rate not from a purchase',
  no_rate: 'No purchase rate',
  rate_over_mrp: 'Rate above MRP',
};

export class RulesError extends Error {}

// ── small helpers (the python's, same results) ────────────────────────────────────────────

const squeeze = (v) => String(v || '').split(/\s+/).filter(Boolean).join(' ');
/** Product / doctor key: spaces squeezed, upper case. */
export const normName = (v) => squeeze(v).toUpperCase();
export const normType = (v) => squeeze(v).toLowerCase();
export const normBatch = (v) => squeeze(v).toUpperCase();

/** python float(v) with a default: None / '' / a list or dict / not a number / inf / nan -> default. */
export function f(v, dflt = 0) {
  if (v === null || v === undefined) return dflt;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : dflt;
  if (typeof v === 'object') return dflt;
  const s = String(v).trim();
  if (!s) return dflt;
  const x = Number(s);
  return Number.isFinite(x) ? x : dflt;
}
/** python bool(v) of a JSON value: an empty list / dict is false. */
const truthy = (v) => (Array.isArray(v) ? v.length > 0 : v !== null && typeof v === 'object' ? Object.keys(v).length > 0 : Boolean(v));
/** python int(_f(v)): towards zero. */
const int = (v) => Math.trunc(f(v));
export const r2 = (v) => pyRound(f(v), 2) + 0;
const r3 = (v) => pyRound(v, 3);
const r4 = (v) => pyRound(v, 4);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** python sorted() on tuples of strings / numbers. */
const byKeys = (keyFn) => (a, b) => {
  const ka = keyFn(a);
  const kb = keyFn(b);
  for (let i = 0; i < ka.length; i += 1) {
    const c = cmp(ka[i], kb[i]);
    if (c) return c;
  }
  return 0;
};
const sum = (list, k) => list.reduce((s, r) => s + r[k], 0);

// ── the rule model ────────────────────────────────────────────────────────────────────────

/** {kind, value} or null (no margin given). Throws RulesError on a value out of range. */
export function cleanMargin(m) {
  if (!isObj(m)) return null;
  const kind = String(m.kind || '').trim().toLowerCase();
  if (!KINDS.includes(kind)) return null;
  const value = f(m.value);
  if (kind === 'pct_mrp' && !(value >= 0 && value <= 100)) throw new RulesError('A % of MRP margin must be 0 to 100.');
  if (kind === 'fixed' && value < 0) throw new RulesError('A fixed margin cannot be below 0.');
  return { kind, value: kind === 'pct_mrp' || kind === 'fixed' ? value : 0 };
}

/** The total-sales %: 0..100; null / '' = not set (a doctor's set: as All doctors). */
export function cleanPct(v, allowNull) {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return allowNull ? null : 0;
  const x = f(v, -1);
  if (!(x >= 0 && x <= 100)) throw new RulesError('A % of total sales must be 0 to 100.');
  return x;
}

const sortedUnique = (list) => [...new Set(list)].sort(cmp);

function cleanItems(items) {
  const out = [];
  const seen = new Map();
  for (let it of Array.isArray(items) ? items : []) {
    if (typeof it === 'string') it = { product: it };
    if (!isObj(it)) continue;
    const p = normName(it.product || it.name);
    if (!p) continue;
    const batches = sortedUnique((Array.isArray(it.batches) ? it.batches : []).map(normBatch).filter(Boolean));
    if (seen.has(p)) { // the same product twice in a group: one item, batches merged
      const prev = seen.get(p);
      prev.batches = !prev.batches.length || !batches.length ? [] : sortedUnique([...prev.batches, ...batches]);
      continue;
    }
    const row = { product: p, batches };
    seen.set(p, row);
    out.push(row);
  }
  return out;
}

function cleanTypeRule(t) {
  if (!isObj(t)) return null;
  const name = squeeze(t.type);
  if (!name) return null;
  const mode = String(t.mode || 'none').trim().toLowerCase();
  const out = { type: name, mode: 'none', groups: [] };
  if (mode === 'type') { // version 1 "whole type": one All-products group, the same figures
    out.mode = 'groups';
    out.groups.push({ name: `All ${name}`, margin: cleanMargin(t.margin) || { kind: 'mrp_rate', value: 0 }, all: true, items: [] });
    return out;
  }
  if (!MODES.includes(mode)) return out;
  out.mode = mode;
  if (mode === 'groups') {
    // version 1 "rest" (rest of type) is not carried: a product in no group gives nothing.
    (Array.isArray(t.groups) ? t.groups : []).forEach((g, i) => {
      if (!isObj(g)) return;
      const every = truthy(g.all);
      const items = every ? [] : cleanItems(g.items);
      if (!every && !items.length) return;
      out.groups.push({
        name: squeeze(g.name) || (every ? `All ${name}` : `Group ${i + 1}`),
        margin: cleanMargin(g.margin) || { kind: 'none', value: 0 },
        all: every,
        items,
      });
    });
  }
  return out;
}

/** The rules, checked and in their one (version 2) shape; version 1 is read and turned into
 *  version 2. Throws RulesError with what to correct. */
export function cleanRules(data) {
  if (typeof data === 'string') {
    try {
      data = data.trim() ? JSON.parse(data) : {};
    } catch {
      data = {};
    }
  }
  if (!isObj(data)) data = {};
  const basis = String(data.rate_basis || 'purchase').trim().toLowerCase();
  const sets = [];
  const seen = new Set();
  for (const s of Array.isArray(data.sets) ? data.sets : []) {
    if (!isObj(s)) continue;
    const doctor = normName(s.doctor);
    if (doctor === NO_DOCTOR.toUpperCase() || seen.has(doctor)) continue;
    seen.add(doctor);
    const types = [];
    const tseen = new Set();
    for (const t of Array.isArray(s.types) ? s.types : []) {
      const rule = cleanTypeRule(t);
      if (rule && !tseen.has(normType(rule.type))) {
        tseen.add(normType(rule.type));
        types.push(rule);
      }
    }
    const sb = String(s.rate_basis || '').trim().toLowerCase();
    sets.push({
      doctor, rate_basis: RATE_BASES.includes(sb) ? sb : null, sales_pct: cleanPct(s.sales_pct, doctor !== ''), types,
    });
  }
  sets.sort(byKeys((s) => [s.doctor !== '' ? 1 : 0, s.doctor]));
  if (!sets.length || sets[0].doctor !== '') sets.unshift({ doctor: '', rate_basis: null, sales_pct: 0, types: [] });
  return {
    version: VERSION,
    rate_basis: RATE_BASES.includes(basis) ? basis : 'purchase',
    updated: String(data.updated || ''),
    sets,
  };
}

export const emptyRules = () => cleanRules({});

/** cleanRules that never throws (a stored value out of range reads as no rules, as the PC). */
export function safeRules(raw) {
  try {
    return cleanRules(raw);
  } catch {
    return emptyRules();
  }
}

/** Which margin a doctor's sold line gets. Built once per rules version. */
export class Resolver {
  constructor(rules) {
    this.rules = cleanRules(rules);
    this.default = this.rules.sets[0];
    this.byDoctor = new Map(this.rules.sets.slice(1).map((s) => [s.doctor, s]));
  }

  typeRule(doctor, medType) {
    const t = normType(medType);
    const own = this.byDoctor.get(normName(doctor));
    for (const [src, label] of [[own, 'doctor'], [this.default, 'default']]) {
      if (!src) continue;
      for (const rule of src.types) if (normType(rule.type) === t) return [rule, label];
    }
    return [null, ''];
  }

  rateBasis(doctor) {
    const own = this.byDoctor.get(normName(doctor));
    if (own && own.rate_basis) return own.rate_basis;
    if (this.default.rate_basis) return this.default.rate_basis;
    return this.rules.rate_basis;
  }

  salesPct(doctor) {
    const own = this.byDoctor.get(normName(doctor));
    if (own && own.sales_pct !== null && own.sales_pct !== undefined) return Number(own.sales_pct);
    return Number(this.default.sales_pct || 0);
  }

  /** The way this line gives a margin, null when it gives none:
   *    on profit       {way: 'profit', kind, value, rule, source}
   *    on total sales  {way: 'sales', kind: 'sales_pct', value: pct, rule, source} */
  resolve(doctor, medType, product, batch) {
    const [rule, source] = this.typeRule(doctor, medType);
    if (!rule || rule.mode === 'none') return null;
    if (rule.mode === 'sales') {
      return { way: 'sales', kind: SALES_KIND, value: this.salesPct(doctor), rule: `${rule.type} (total sales)`, source };
    }
    const p = normName(product);
    const b = normBatch(batch);
    let best = null;
    for (const g of rule.groups) {
      if (g.all) { // "All products": the weakest, the first such group
        if (best === null) best = [0, g];
        continue;
      }
      for (const it of g.items) {
        if (it.product !== p) continue;
        let rank;
        if (it.batches.length) {
          if (!it.batches.includes(b)) continue;
          rank = 3;
        } else {
          rank = g.items.length === 1 ? 2 : 1;
        }
        if (best === null || rank > best[0]) best = [rank, g];
      }
    }
    if (best === null) return null; // not in any group: not in the report
    const m = best[1].margin;
    if (!m || m.kind === 'none') return null;
    return { way: 'profit', kind: m.kind, value: m.value, rule: `${rule.type} > ${best[1].name}`, source };
  }
}

// ── the calculation ───────────────────────────────────────────────────────────────────────

/** medicine_id -> {purchase, purchase_free} per sale unit, from live purchase lines.
 *  purchases: [{medicine_id, qty, free_qty, rate (per pack, as billed), units (per pack)}] */
export function batchRates(purchases) {
  const acc = new Map();
  for (const p of purchases || []) {
    const raw = Number(p?.medicine_id || 0);
    if (!Number.isFinite(raw)) continue;
    const mid = Math.trunc(raw);
    if (mid <= 0) continue;
    const units = Math.max(1, f(p.units, 1) || 1);
    const qty = Math.max(0, f(p.qty));
    const free = Math.max(0, f(p.free_qty));
    if (qty + free <= 0) continue;
    const a = acc.get(mid) || [0, 0, 0]; // money, billed units, all units
    a[0] += f(p.rate) * qty;
    a[1] += qty * units;
    a[2] += (qty + free) * units;
    acc.set(mid, a);
  }
  const out = new Map();
  for (const [mid, [money, billed, got]] of acc) {
    if (got <= 0) continue;
    out.set(mid, { purchase: billed > 0 ? money / billed : 0, purchase_free: money / got });
  }
  return out;
}

/** True when any set gives a margin on anything (else nothing is worked out). */
export function hasRules(rules) {
  for (const s of safeRules(rules).sets) {
    for (const t of s.types) {
      if (t.mode === 'sales') return true;
      if (t.mode === 'groups' && t.groups.some((g) => g.margin.kind !== 'none')) return true;
    }
  }
  return false;
}

/** Rupees one unit gives the doctor. flags gains 'rate_over_mrp' when MRP - rate is below 0. */
export function marginPerUnit(kind, value, mrp, rate, flags) {
  if (kind === 'mrp_rate') {
    if (flags.includes('no_rate')) return 0;
    const unit = mrp - rate;
    if (unit < 0) {
      if (!flags.includes('rate_over_mrp')) flags.push('rate_over_mrp');
      return 0;
    }
    return unit;
  }
  if (kind === 'pct_mrp') return (mrp * value) / 100;
  if (kind === 'fixed') return value;
  return 0;
}

/** One sold line's margin figures per unit, null when it gives no margin.
 *  item: {medicine_id, name, type, batch, mrp_unit, med_rate_unit, cost_price} */
export function evaluateLine(res, doctor, item, rates, basis) {
  const rule = res.resolve(doctor, item.type || '', item.name || '', item.batch || '');
  if (rule === null) return null;
  const mrp = Math.max(0, f(item.mrp_unit));
  if (rule.way === 'sales') {
    return {
      way: 'sales', mrp: r4(mrp), rate_purchase: 0, rate_free: 0, rate_basis: '', rate: 0,
      kind: SALES_KIND, kind_value: rule.value, margin_unit: 0, rule: rule.rule, flags: [],
    };
  }
  const mid = int(item.medicine_id);
  const flags = [];
  let rp;
  let rf;
  if (rates.has(mid)) {
    ({ purchase: rp, purchase_free: rf } = rates.get(mid));
  } else if (f(item.med_rate_unit) > 0) {
    rp = rf = f(item.med_rate_unit);
    flags.push('estimated');
  } else if (f(item.cost_price) > 0) {
    rp = rf = f(item.cost_price);
    flags.push('estimated');
  } else {
    rp = rf = 0;
    flags.push('no_rate');
  }
  const rate = basis === 'purchase_free' ? rf : rp;
  const unit = marginPerUnit(rule.kind, rule.value, mrp, rate, flags);
  return {
    way: 'profit',
    mrp: r4(mrp),
    rate_purchase: r4(rp),
    rate_free: r4(rf),
    rate_basis: basis,
    rate: r4(rate),
    kind: rule.kind,
    kind_value: rule.value,
    margin_unit: r4(unit),
    rule: rule.rule,
    flags,
  };
}

/** A line seen with the other rate (the report's rate choice): the line's MRP, both rates
 *  and rule; only which of the two rates is used changes (the PC's with_basis). A total-sales
 *  line has no rate: as it is. */
export function withBasis(row, basis) {
  if (!RATE_BASES.includes(basis) || basis === row.rate_basis || row.way === 'sales') return row;
  const flags = (row.flags || []).filter((x) => x !== 'rate_over_mrp');
  const rate = f(basis === 'purchase_free' ? row.rate_free : row.rate_purchase);
  const unit = marginPerUnit(String(row.kind || ''), f(row.kind_value), f(row.mrp), rate, flags);
  return {
    ...row, rate_basis: basis, rate: r4(rate), margin_unit: r4(unit), value: r2(r4(unit) * f(row.qty)), flags,
  };
}

/** A line's value at its net qty: the margin (on profit) or the sale value (total sales). */
export function lineValue(ln) {
  const qty = f(ln.qty);
  if (ln.way === 'sales') {
    const sold = f(ln.qty_sold);
    return sold > 0 ? r2((f(ln.amount) * qty) / sold) : 0;
  }
  return r2(f(ln.margin_unit) * qty);
}

/** Spread a bill's returned qty (per medicine) over its lines in bill order; sets
 *  qty_returned, qty and value on each line (in place). */
export function applyReturns(lines, returns) {
  const back = new Map();
  for (const r of returns || []) {
    const mid = int(r.medicine_id);
    back.set(mid, (back.get(mid) || 0) + Math.max(0, f(r.qty)));
  }
  for (const ln of lines) {
    const mid = int(ln.medicine_id);
    const sold = Math.max(0, f(ln.qty_sold));
    const took = Math.min(sold, back.get(mid) || 0);
    if (took > 0) back.set(mid, back.get(mid) - took);
    ln.qty_returned = r3(took);
    ln.qty = r3(sold - took);
    // Each line's value is rounded once; every total adds these.
    ln.value = lineValue(ln);
  }
}

/** The margin lines of one bill (both ways), returns applied; lines that give no margin left
 *  out. Sale items may carry the bill line's own figures (the total-sales way needs them):
 *  sale_rate (per unit as billed), amount (the line's amount, its discount off), disc (the
 *  line's discount in rupees), pack (the medicine's pack text). */
export function billLines(res, sale, rates, rateBasis = '') {
  const doctor = normName(sale.doctor);
  if (!doctor) return []; // a bill without a doctor gives no one a margin
  const basis = RATE_BASES.includes(rateBasis) ? rateBasis : res.rateBasis(doctor);
  const lines = [];
  (sale.items || []).forEach((it, i) => {
    const sold = f(it.qty);
    const ev = sold > 0 ? evaluateLine(res, doctor, it, rates, basis) : null;
    lines.push({
      line_no: i + 1,
      sale_id: int(sale.id),
      sale_item_id: int(it.id),
      doctor,
      date: String(sale.date || '').slice(0, 10),
      bill_no: String(sale.bill_no || ''),
      patient: String(sale.patient || ''),
      medicine_id: int(it.medicine_id),
      name: String(it.name || ''),
      type: String(it.type || ''),
      batch: String(it.batch || ''),
      pack: String(it.pack || ''),
      qty_sold: r3(Math.max(0, sold)),
      sale_rate: r4(f(it.sale_rate)),
      disc: r2(f(it.disc)),
      amount: r2(f(it.amount)),
      way: ev ? ev.way : '',
      margin_unit: ev ? ev.margin_unit : 0,
      _ev: ev,
    });
  });
  // Lines without a margin still take their share of a return first, as the bill has them.
  applyReturns(lines, sale.returns);
  const out = [];
  for (const ln of lines) {
    const ev = ln._ev;
    delete ln._ev;
    if (ev === null) continue;
    const { margin_unit: _drop, ...rest } = ev;
    out.push(Object.assign(ln, rest));
  }
  return out;
}

const sortKey = (r) => [r.doctor, r.name, r.batch, r.date, r.bill_no];

/** On-profit lines -> {rows, summary (the owner's Excel: per doctor, product, batch, MRP,
 *  rate), doctors, totals}. Every total adds the lines' own (already rounded) values. */
export function assembleProfit(input) {
  const rows = [...input].sort(byKeys(sortKey));
  const groups = new Map();
  for (const r of rows) {
    const k = JSON.stringify([r.doctor, r.name, r.batch, r.mrp, r.rate, r.margin_unit]);
    let g = groups.get(k);
    if (!g) {
      g = {
        doctor: r.doctor, name: r.name, type: r.type, batch: r.batch, mrp: r.mrp, rate: r.rate,
        rate_basis: r.rate_basis, kind: r.kind, margin_unit: r.margin_unit, qty: 0, value: 0, rule: r.rule, flags: [],
      };
      groups.set(k, g);
    }
    g.qty = r3(g.qty + r.qty);
    g.value = r2(g.value + r.value);
    for (const x of r.flags) if (!g.flags.includes(x)) g.flags.push(x);
  }
  const doctors = [...new Set(rows.map((r) => r.doctor))].sort(cmp).map((d) => {
    const mine = rows.filter((r) => r.doctor === d);
    return { doctor: d, qty: r3(sum(mine, 'qty')), value: r2(sum(mine, 'value')), lines: mine.length };
  });
  return {
    rows,
    summary: [...groups.values()],
    doctors,
    totals: { qty: r3(sum(rows, 'qty')), value: r2(sum(rows, 'value')), lines: rows.length },
  };
}

/** The "Customer-Wise Product-Batch Wise Sales" layout: per product (name + pack heading), its
 *  bill lines by customer, date, bill no, and the product's sub-total qty and value. */
export function salesProducts(rows) {
  const out = new Map();
  const sorted = [...rows].sort(byKeys((r) => [r.name, r.pack || '', r.patient, r.date, r.bill_no, r.line_no || 0]));
  for (const r of sorted) {
    const k = JSON.stringify([r.name, r.pack || '']);
    let g = out.get(k);
    if (!g) {
      g = { name: r.name, pack: r.pack || '', type: r.type, lines: [], qty: 0, value: 0 };
      out.set(k, g);
    }
    g.lines.push(r);
    g.qty = r3(g.qty + r.qty);
    g.value = r2(g.value + r.value);
  }
  return [...out.values()];
}

/** Total-sales lines -> {rows, doctors: [{doctor, qty, value, lines, types, by_pct:
 *  [{pct, value, commission}], commission, products}], totals: {qty, value, lines, commission}}.
 *  The commission is worked out per doctor on the total of each %: round(value x pct / 100, 2). */
export function assembleSales(input) {
  const rows = [...input].sort(byKeys(sortKey));
  const doctors = [...new Set(rows.map((r) => r.doctor))].sort(cmp).map((d) => {
    const mine = rows.filter((r) => r.doctor === d);
    const pcts = [...new Set(mine.map((r) => f(r.kind_value)))].sort((a, b) => b - a);
    const byPct = pcts.map((pct) => {
      const value = r2(sum(mine.filter((r) => f(r.kind_value) === pct), 'value'));
      return { pct, value, commission: r2((value * pct) / 100) };
    });
    const types = [];
    for (const r of mine) {
      if (r.type && !types.some((t) => normType(t) === normType(r.type))) types.push(r.type);
    }
    return {
      doctor: d,
      qty: r3(sum(mine, 'qty')),
      value: r2(sum(mine, 'value')),
      lines: mine.length,
      types: types.sort(byKeys((t) => [normType(t)])),
      by_pct: byPct,
      commission: r2(sum(byPct, 'commission')),
      products: salesProducts(mine),
    };
  });
  return {
    rows,
    doctors,
    totals: {
      qty: r3(sum(rows, 'qty')), value: r2(sum(rows, 'value')), lines: rows.length, commission: r2(sum(doctors, 'commission')),
    },
  };
}

/** Both ways' lines -> the on-profit report at the top level (rows, summary, doctors, totals),
 *  the total-sales report under `sales`, and per doctor the two added under `grand`:
 *  {doctors: [{doctor, profit, sales_value, commission, total}], totals: {profit, sales_value,
 *  commission, total}}. */
export function assemble(input) {
  const profit = assembleProfit(input.filter((r) => r.way !== 'sales'));
  const sales = assembleSales(input.filter((r) => r.way === 'sales'));
  const pd = new Map(profit.doctors.map((d) => [d.doctor, d]));
  const sd = new Map(sales.doctors.map((d) => [d.doctor, d]));
  const grand = [...new Set([...pd.keys(), ...sd.keys()])].sort(cmp).map((d) => {
    const p = pd.has(d) ? pd.get(d).value : 0;
    const s = sd.get(d);
    const c = s ? s.commission : 0;
    return { doctor: d, profit: p, sales_value: s ? s.value : 0, commission: c, total: r2(p + c) };
  });
  return {
    ...profit,
    sales,
    grand: {
      doctors: grand,
      totals: {
        profit: profit.totals.value,
        sales_value: sales.totals.value,
        commission: sales.totals.commission,
        total: r2(profit.totals.value + sales.totals.commission),
      },
    },
  };
}

/** The report straight from bills with ONE rules version (the PC's compute()). The server's
 *  report uses billLines per bill with that bill's own version (doctorMarginRulesStore.js). */
export function compute(sales, purchases, rules, opts = {}) {
  const res = new Resolver(rules);
  const want = new Set((opts.doctors || []).map(normName).filter(Boolean));
  const forced = String(opts.rate_basis || '').trim().toLowerCase();
  const rates = batchRates(purchases);
  const rows = [];
  for (const s of sales || []) {
    if (want.size && !want.has(normName(s.doctor))) continue;
    for (const r of billLines(res, s, rates, forced)) if (r.qty > 0) rows.push(r);
  }
  return assemble(rows);
}

/** The medicine's pack as the product heading shows it ("15", "30ML"); a bare 1 is none. */
export function packText(unit) {
  const u = squeeze(unit);
  return u === '' || u === '1' || u === '0' ? '' : u;
}

/** The detail layout: per product (name), its lines by batch / date, and a sub-total. */
export function byProduct(rows) {
  const out = new Map();
  for (const r of [...rows].sort(byKeys((x) => [x.name, x.batch, x.date, x.bill_no]))) {
    let g = out.get(r.name);
    if (!g) {
      g = { name: r.name, type: r.type, lines: [], qty: 0, value: 0 };
      out.set(r.name, g);
    }
    g.lines.push(r);
    g.qty = r3(g.qty + r.qty);
    g.value = r2(g.value + r.value);
  }
  return [...out.values()];
}

export function flagCounts(rows) {
  const out = Object.fromEntries(Object.keys(FLAG_TEXT).map((k) => [k, 0]));
  for (const r of rows) for (const x of r.flags || []) if (x in out) out[x] += 1;
  return out;
}

// ── sale units (the PC's margin_unit_divisor / _units_per_pack) ───────────────────────────

/** Pack size from names like 'FOO 10 TAB' or '1*10' (not strength like 500MG). */
export function inferTpsFromName(name) {
  const s = String(name || '').toUpperCase();
  if (!s) return 1;
  let m = s.match(/1\s*[Xx×*]\s*(\d{1,3})\b/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 2 && n <= 100) return n;
  }
  m = s.match(/\b(\d{1,3})\s*(?:TAB|TABLET|CAP|CAPS|CAPSULE)s?\b/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 2 && n <= 100) return n;
  }
  return 1;
}

/** Sale units in one pack for the MRP / rate per unit (tablets per strip for strip types).
 *  The PC's sibling-catalog guess runs Online only, and its report reads Offline books. */
export function saleUnitDivisor(type, unit, name) {
  const u = String(unit || '1');
  if (!isStripCountType(type, u)) return 1;
  const tps = parseTabletsPerStripe(u);
  if (tps > 1) return tps;
  const inferred = inferTpsFromName(name);
  return inferred > 1 ? inferred : Math.max(1, tps);
}

/** The PC's legacy strip types and their default units (layout_config) decide whether a
 *  purchase line was counted in tablets: is_strip_count_type(type) without a unit. */
const TYPE_DEFAULT_UNIT = {
  Tablet: 'd', Capsule: 'd', Bolus: 'd', Syrup: 'ml', Suspension: 'ml', Liquid: 'ml', Powder: 'g', Drops: 'ml',
  Drop: 'ml', 'Eye Drops': 'ml', 'Ear Drops': 'ml', 'Nasal Drops': 'ml', Injection: 'ml', 'Injection - Vial': 'Vial',
  Gel: 'g', Vaccine: 'ml', Ointment: 'g', Cream: 'g', Liniment: 'ml', Granules: 'g', Lotion: 'ml', Spray: 'ml',
  Shampoo: 'ml', Sachet: 'pack', Soap: 'pack', Inhaler: 'pack', 'Instrument / Medical Device': '',
  'Feed Supplement': 'g', 'Tablet Pack': 'pack', 'Bolus Pack': 'pack', Others: '',
};

/** Sale units one purchased pack put on the shelf (the PC's _units_per_pack with no logged
 *  stock_units: tablets per strip for strip types, capped at 1000 as the PC caps it). */
export function purchaseUnitsPerPack(type, unit, qty, free, lineTps = 0) {
  if (!(f(qty) + f(free) > 0)) return 1;
  const t = String(type || '');
  if (!isStripCountType(t, TYPE_DEFAULT_UNIT[t] ?? '')) return 1;
  let tps = Math.trunc(f(lineTps));
  if (!(tps > 0)) tps = parseTabletsPerStripe(String(unit || '1'));
  if (tps <= 0 || tps > 1000) return 1;
  return tps;
}
