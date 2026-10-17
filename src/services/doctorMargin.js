/**
 * Doctor Margin Report (owner, 17 Oct 2026; Sales History -> Export). One rule, written the
 * same way here, on the PC (core/doctor_margin.py) and on the phone (DoctorMargin.kt);
 * test/fixtures/doctor_margin_vectors.json holds the cases all three must agree on.
 *
 * Input, already read from the books:
 *   sales:     [{id, bill_no, date, patient, doctor, total_amount,
 *                items: [{medicine_id, name, type, batch, qty, amount, cost_price}],
 *                returns: [{medicine_id, qty}]}]     -- deleted / draft bills left out
 *   purchases: [{medicine_id, qty, free_qty, item_amount, units}]
 *              units = sale units in one purchased pack (tablets per strip for strip
 *              medicines, else 1)
 *   opts:      {mode: 'regular'|'injection', pct, types: [..] | null, doctor: '' | name}
 *
 * The rules:
 *  - Scheme-adjusted effective purchase rate of a batch (medicine row) = what its purchase
 *    lines cost (item_amount, after discount, with GST -- the sale amount is MRP with GST)
 *    / every unit received, free ones included: (qty + free_qty) x units. 10 bought + 10 free
 *    for Rs 100 = Rs 5 a unit. No purchase line: the cost the bill recorded at sale time
 *    (cost_price, "estimated"); none either: no cost ("unavailable"), flagged.
 *  - A line's eligible sale amount is its amount after line discount, times the bill's
 *    total / the sum of its lines (the bill discount and rounding shared out, never counted
 *    twice), less what came back on a return of that bill (in proportion to qty).
 *  - Regular report: every type except injections (or the types chosen, injections never);
 *    commission = eligible sale amount x pct / 100; store remaining = profit - commission.
 *  - Injection report: injection types only; doctor margin = profit when positive, else 0
 *    and the line is flagged; the percentage is not used.
 *  - A loss (profit < 0) is flagged "loss" for review in both reports.
 *  - Doctor = the name on the bill; a bill without one is "(No doctor)", never guessed.
 *  - Summary groups by doctor, medicine row (= batch) and purchase rate; average selling
 *    rate and purchase rate are weighted by quantity. Nothing is rounded until it is shown.
 */

export const NO_DOCTOR = '(No doctor)';

export function r2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

export function isInjection(type) {
  return String(type || '').toLowerCase().includes('inj');
}

/** medicine_id -> {rate, basis: 'scheme'} from purchase lines. */
export function effectiveRates(purchases) {
  const acc = new Map();
  for (const p of purchases || []) {
    const id = Number(p.medicine_id);
    if (!(id > 0)) continue;
    const units = Math.max(1, Number(p.units) || 1);
    const got = ((Number(p.qty) || 0) + (Number(p.free_qty) || 0)) * units;
    if (!(got > 0)) continue;
    const a = acc.get(id) || { cost: 0, units: 0 };
    a.cost += Number(p.item_amount) || 0;
    a.units += got;
    acc.set(id, a);
  }
  const out = new Map();
  for (const [id, a] of acc) if (a.units > 0) out.set(id, { rate: a.cost / a.units, basis: 'scheme' });
  return out;
}

export function doctorMargin(sales, purchases, opts = {}) {
  const mode = opts.mode === 'injection' ? 'injection' : 'regular';
  const pct = Math.min(100, Math.max(0, Number(opts.pct ?? 10)));
  const types = Array.isArray(opts.types) && opts.types.length
    ? new Set(opts.types.map((t) => String(t).trim().toLowerCase())) : null;
  const injTypes = types && [...types].some(isInjection) ? new Set([...types].filter(isInjection)) : null;
  const wantDoctor = String(opts.doctor || '').trim().toUpperCase();
  const rates = effectiveRates(purchases);

  const rows = [];
  for (const s of sales || []) {
    const doctor = String(s.doctor || '').trim().toUpperCase() || NO_DOCTOR;
    if (wantDoctor && doctor.toUpperCase() !== wantDoctor) continue;
    const items = s.items || [];
    const lineSum = items.reduce((x, it) => x + (Number(it.amount) || 0), 0);
    const factor = lineSum > 0 ? (Number(s.total_amount) || 0) / lineSum : 0;
    const back = new Map();
    for (const r of s.returns || []) back.set(Number(r.medicine_id), (back.get(Number(r.medicine_id)) || 0) + (Number(r.qty) || 0));
    for (const it of items) {
      const type = String(it.type || '');
      const inj = isInjection(type);
      if (mode === 'injection' ? !inj : inj) continue;
      if (mode === 'regular' && types && !types.has(type.trim().toLowerCase())) continue;
      // Injection report: every injection type, or only the injection types ticked.
      if (mode === 'injection' && injTypes && !injTypes.has(type.trim().toLowerCase())) continue;
      const mid = Number(it.medicine_id);
      const sold = Number(it.qty) || 0;
      if (!(sold > 0)) continue;
      const returned = Math.min(sold, back.get(mid) || 0);
      if (returned > 0) back.set(mid, (back.get(mid) || 0) - returned);
      const qty = sold - returned;
      if (!(qty > 0)) continue;
      const amount = (Number(it.amount) || 0) * factor * (qty / sold);
      let rate = 0;
      let basis = 'unavailable';
      const scheme = rates.get(mid);
      if (scheme) { rate = scheme.rate; basis = 'scheme'; }
      else if ((Number(it.cost_price) || 0) > 0) { rate = Number(it.cost_price); basis = 'estimated'; }
      const cost = qty * rate;
      const profit = amount - cost;
      const commission = mode === 'regular' ? amount * pct / 100 : Math.max(0, profit);
      const flags = [];
      if (basis !== 'scheme') flags.push(basis);
      if (profit < 0) flags.push('loss');
      rows.push({
        date: String(s.date || '').slice(0, 10), patient: s.patient || '', doctor, bill_no: s.bill_no || '',
        medicine_id: mid, name: it.name || '', type, batch: it.batch || '', qty,
        sale_rate: amount / qty, purchase_rate: rate, basis, amount, cost, profit,
        pct: mode === 'regular' ? pct : 100, commission, remaining: profit - commission, flags,
      });
    }
  }
  rows.sort((a, b) => (a.doctor < b.doctor ? -1 : a.doctor > b.doctor ? 1
    : a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.bill_no) < String(b.bill_no) ? -1 : String(a.bill_no) > String(b.bill_no) ? 1 : 0));

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.doctor}\u0000${r.medicine_id}\u0000${r.batch}\u0000${r.purchase_rate.toFixed(6)}`;
    const g = groups.get(key) || {
      doctor: r.doctor, medicine_id: r.medicine_id, name: r.name, type: r.type, batch: r.batch,
      basis: r.basis, qty: 0, amount: 0, cost: 0, commission: 0, flags: new Set(),
    };
    g.qty += r.qty; g.amount += r.amount; g.cost += r.cost; g.commission += r.commission;
    for (const f of r.flags) g.flags.add(f);
    groups.set(key, g);
  }
  const summary = [...groups.values()].map((g) => ({
    doctor: g.doctor, medicine_id: g.medicine_id, name: g.name, type: g.type, batch: g.batch, basis: g.basis,
    qty: g.qty, avg_sale_rate: g.amount / g.qty, purchase_rate: g.cost / g.qty,
    amount: g.amount, cost: g.cost, profit: g.amount - g.cost,
    pct: mode === 'regular' ? pct : 100, commission: g.commission, remaining: g.amount - g.cost - g.commission,
    flags: [...g.flags].sort(),
  })).sort((a, b) => (a.doctor < b.doctor ? -1 : a.doctor > b.doctor ? 1
    : a.name < b.name ? -1 : a.name > b.name ? 1 : a.batch < b.batch ? -1 : a.batch > b.batch ? 1 : a.medicine_id - b.medicine_id));

  const total = (list) => {
    const t = { qty: 0, amount: 0, cost: 0, commission: 0 };
    for (const r of list) { t.qty += r.qty; t.amount += r.amount; t.cost += r.cost; t.commission += r.commission; }
    return { ...t, profit: t.amount - t.cost, remaining: t.amount - t.cost - t.commission };
  };
  const doctors = [...new Set(rows.map((r) => r.doctor))].sort()
    .map((d) => ({ doctor: d, ...total(rows.filter((r) => r.doctor === d)) }));
  return { mode, pct: mode === 'regular' ? pct : 100, rows, summary, doctors, totals: total(rows) };
}

/** The same report with money rounded to paise for showing / comparing. */
export function rounded(rep) {
  const m = (o) => {
    const out = { ...o };
    for (const k of ['sale_rate', 'avg_sale_rate', 'purchase_rate', 'amount', 'cost', 'profit', 'commission', 'remaining']) {
      if (k in out) out[k] = r2(out[k]);
    }
    if ('qty' in out) out.qty = Math.round(out.qty * 1000) / 1000;
    return out;
  };
  return { ...rep, rows: rep.rows.map(m), summary: rep.summary.map(m), doctors: rep.doctors.map(m), totals: m(rep.totals) };
}
