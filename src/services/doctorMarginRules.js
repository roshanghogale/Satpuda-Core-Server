/**
 * Doctor margin RULES (owner, 22 Oct 2026) -- the PC's core/doctor_margin_rules.py, line for
 * line, so the web and the phone show the same figures as the PC's Doctor Margin Report.
 * test/doctorMarginRules.test.mjs checks this file against vectors made by RUNNING the PC
 * python (test/fixtures/doctor_margin_rules_vectors.json).
 *
 * The rules -- one store setting `doctor_margin_rules` (JSON), shop-wide, synced:
 *   {version: 1, rate_basis: 'purchase' | 'purchase_free', updated,
 *    sets: [{doctor: '' (= all doctors) | 'DR NAME', rate_basis: null | ..,
 *            types: [{type, mode: 'none' | 'type' | 'groups', margin, groups, rest}]}]}
 *   group  = {name, margin, items: [{product, batches: [] (= every batch) | ['B1', ..]}]}
 *   margin = {kind: 'mrp_rate' | 'pct_mrp' | 'fixed' | 'none', value}
 *
 * Which rule a sold line gets (doctor D, type T, product P, batch B):
 *   1. D's own set when it has a rule for T, else the All doctors rule for T, else none.
 *   2. mode 'none': no margin; 'type': the type's margin for every product.
 *   3. mode 'groups': a batch-limited item naming B > a one-product group > a bigger group
 *      (the first when two tie); no group holds P: 'rest' (null = no margin).
 * Rate = the purchase rate of THAT batch (medicine row): as billed (pack rate x packs /
 * units bought) or with free included (the same money / every unit received). No purchase
 * line: the medicine row's rate, then the bill's cost ("estimated"); neither: "no_rate".
 * Nothing here touches a sale, a purchase or stock: the figures are only for the doctor.
 *
 * Python's round() is half-to-even on the double's exact value: pyRound (billRules.js).
 */
import { pyRound } from './billRules.js';
import { isStripCountType, parseTabletsPerStripe } from '../utils/saleProfit.js';

export const SETTING_NAME = 'doctor_margin_rules';
export const RECALC_SETTING = 'doctor_margin_rules_recalc';
export const VERSION = 1;
export const NO_DOCTOR = '(No doctor)';
export const RATE_BASES = ['purchase', 'purchase_free'];
export const MODES = ['none', 'type', 'groups'];
export const KINDS = ['mrp_rate', 'pct_mrp', 'fixed', 'none'];
export const RATE_BASIS_TEXT = {
  purchase: 'Purchase rate',
  purchase_free: 'Purchase rate with free included',
};
export const KIND_TEXT = { mrp_rate: 'MRP - rate', pct_mrp: '% of MRP', fixed: 'Fixed per unit', none: 'No margin' };
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

/** python float(v) with a default: None / '' / not a number / inf / nan -> default. */
export function f(v, dflt = 0) {
  if (v === null || v === undefined) return dflt;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : dflt;
  const s = String(v).trim();
  if (!s) return dflt;
  const x = Number(s);
  return Number.isFinite(x) ? x : dflt;
}
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
  let mode = String(t.mode || 'none').trim().toLowerCase();
  if (!MODES.includes(mode)) mode = 'none';
  const out = { type: name, mode, margin: null, groups: [], rest: null };
  if (mode === 'type') {
    out.margin = cleanMargin(t.margin) || { kind: 'mrp_rate', value: 0 };
  } else if (mode === 'groups') {
    (Array.isArray(t.groups) ? t.groups : []).forEach((g, i) => {
      if (!isObj(g)) return;
      const items = cleanItems(g.items);
      if (!items.length) return;
      out.groups.push({
        name: squeeze(g.name) || `Group ${i + 1}`,
        margin: cleanMargin(g.margin) || { kind: 'none', value: 0 },
        items,
      });
    });
    out.rest = cleanMargin(t.rest);
  }
  return out;
}

/** The rules, checked and in their one shape. Throws RulesError with what to correct. */
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
    sets.push({ doctor, rate_basis: RATE_BASES.includes(sb) ? sb : null, types });
  }
  sets.sort(byKeys((s) => [s.doctor !== '' ? 1 : 0, s.doctor]));
  if (!sets.length || sets[0].doctor !== '') sets.unshift({ doctor: '', rate_basis: null, types: [] });
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

  /** {kind, value, rule, source} -- the margin this line gets, null when it gets none. */
  resolve(doctor, medType, product, batch) {
    const [rule, source] = this.typeRule(doctor, medType);
    if (!rule || rule.mode === 'none') return null;
    let m;
    let label;
    if (rule.mode === 'type') {
      m = rule.margin;
      label = `${rule.type} (whole type)`;
    } else {
      const p = normName(product);
      const b = normBatch(batch);
      let best = null;
      for (const g of rule.groups) {
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
      if (best !== null) {
        m = best[1].margin;
        label = `${rule.type} > ${best[1].name}`;
      } else {
        m = rule.rest;
        label = `${rule.type} > rest of type`;
      }
    }
    if (!m || m.kind === 'none') return null;
    return { kind: m.kind, value: m.value, rule: label, source };
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
      if (t.mode === 'type') return true;
      if (t.mode === 'groups' && (t.rest || t.groups.some((g) => g.margin.kind !== 'none'))) return true;
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
  const mid = int(item.medicine_id);
  const flags = [];
  const mrp = Math.max(0, f(item.mrp_unit));
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
 *  and rule; only which of the two rates is used changes (the PC's with_basis). */
export function withBasis(row, basis) {
  if (!RATE_BASES.includes(basis) || basis === row.rate_basis) return row;
  const flags = (row.flags || []).filter((x) => x !== 'rate_over_mrp');
  const rate = f(basis === 'purchase_free' ? row.rate_free : row.rate_purchase);
  const unit = marginPerUnit(String(row.kind || ''), f(row.kind_value), f(row.mrp), rate, flags);
  return {
    ...row, rate_basis: basis, rate: r4(rate), margin_unit: r4(unit), value: r2(r4(unit) * f(row.qty)), flags,
  };
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
    ln.value = r2(f(ln.margin_unit) * ln.qty);
  }
}

/** The margin lines of one bill, returns applied; lines that give no margin left out. */
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
      qty_sold: r3(Math.max(0, sold)),
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

/** Lines -> {rows, summary (the owner's Excel: per doctor, product, batch, MRP, rate),
 *  doctors, totals}. Every total adds the lines' own (already rounded) values. */
export function assemble(input) {
  const rows = [...input].sort(byKeys((r) => [r.doctor, r.name, r.batch, r.date, r.bill_no]));
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
  const sum = (list, k) => list.reduce((s, r) => s + r[k], 0);
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
