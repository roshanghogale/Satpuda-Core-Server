/**
 * Bill arithmetic for saves made on the server (the web login).
 *
 * Not new rules: a port of the PC engine, step for step, so a web bill totals exactly as the
 * same bill typed on the PC would.
 *   sales line      mac2 core/desktop_sales_service.build_line (rate = MRP / tablets per strip)
 *   sales summary   mac2 core/calc_engine.calc_bill_summary + calc_payment_result + auto_round
 *                   (the same port the desktop demo uses, desktop/src/demoCalc.ts, which is
 *                   checked against 360 engine answers)
 *   purchase bill   mac2 core/pharmacy_purchase_calc.compute_purchase_invoice (Decimal, half-up)
 *                   + core/purchase_calculator.PurchaseCalculator._calc_payment
 * test/billRules.vectors.json holds answers recorded from the Python engine; billRules.test.mjs
 * must match every one of them to the paisa.
 */
import { isStripCountType, parseTabletsPerStripe } from '../utils/saleProfit.js';

// ─── Python float rounding: round(x, n) is half-to-even on the double's exact value ─────────

export function pyRound(x, dp = 2) {
  if (!Number.isFinite(x)) return 0;
  if (Math.abs(x) >= 1e15) return x;
  const neg = x < 0;
  const a = Math.abs(x);
  const exact = a.toFixed(20);
  const dot = exact.indexOf('.');
  const tail = exact.slice(dot + 1 + dp);
  let out;
  if (/^50*$/.test(tail)) {
    const lower = Number(Number(exact.slice(0, dot + 1 + dp) || '0').toFixed(dp));
    const asInt = Math.round(lower * 10 ** dp);
    out = asInt % 2 === 0 ? lower : Number((lower + 10 ** -dp).toFixed(dp));
  } else {
    out = Number(a.toFixed(dp));
  }
  return neg ? -out : out + 0;
}

const r2 = (x) => pyRound(x, 2);

export function money(v, dflt = 0) {
  if (v === null || v === undefined || v === '') return dflt;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isNaN(v) ? dflt : v;
  const s = String(v).trim().replace(/,/g, '').replace(/₹/g, '').trim();
  if (!s) return dflt;
  const f = Number(s);
  return Number.isNaN(f) ? dflt : f;
}

// ─── Sales ────────────────────────────────────────────────────────────────────

/** Price per unit sold: a strip medicine is sold by the tablet, its MRP is per strip. */
export function saleUnitRate(med) {
  const mrp = money(med.mrp);
  if (isStripCountType(med.type, med.unit)) {
    const tps = parseTabletsPerStripe(med.unit || '1');
    return tps > 0 ? mrp / tps : mrp;
  }
  return mrp;
}

/** Per-unit purchase cost kept on the sale line (core.stock_utils.snapshot_sale_cost_price). */
export function saleCostPrice(med) {
  const pr = money(med.rate);
  if (pr <= 0) return 0;
  if (isStripCountType(med.type, med.unit)) {
    const tps = Math.max(1, parseTabletsPerStripe(med.unit));
    return pyRound(pr / tps, 4);
  }
  return pyRound(pr, 4);
}

/** One sales line. `discPct` is the line discount in percent (the web's only line discount). */
export function buildSaleLine(med, qty, discPct = 0) {
  const rate = saleUnitRate(med);
  const base = r2(qty * rate);
  let discRs = r2(Math.max(0, base) * Math.max(0, money(discPct)) / 100);
  if (base > 0) discRs = Math.min(discRs, base);
  const amount = r2(base - discRs);
  return {
    rate: pyRound(rate, 4),
    amount,
    original_amount: base,
    medicine_discount: discRs,
  };
}

function autoRound(amount) {
  return r2(Math.floor(amount + 0.5) - amount);
}

export function billSummary(items, discountPct, rounding, discountRs = null) {
  const subtotal = r2(items.reduce((a, i) => a + money(i.amount), 0));
  let discountAmount;
  let actualPct;
  if (discountRs !== null && discountRs !== undefined) {
    discountAmount = r2(Math.min(money(discountRs), subtotal));
    actualPct = subtotal > 0 ? pyRound((discountAmount / subtotal) * 100, 4) : 0;
  } else {
    discountAmount = r2((subtotal * money(discountPct)) / 100);
    actualPct = money(discountPct);
  }
  const preRound = r2(subtotal - discountAmount);
  return {
    subtotal,
    discount_amount: discountAmount,
    discount_pct: actualPct,
    pre_round_total: preRound,
    total_amount: r2(preRound + money(rounding)),
  };
}

export function paymentResult(totalAmount, cashPaid, onlinePaid, previousDue, previousCredit) {
  const eps = 0.01;
  const amountPaid = r2(money(cashPaid) + money(onlinePaid));
  const prevDue = r2(money(previousDue));
  const prevCredit = r2(money(previousCredit));
  const prevNet = r2(Math.max(0, prevDue - prevCredit));
  const total = r2(money(totalAmount));
  let dueAmount = r2(Math.max(0, total - amountPaid));
  if (dueAmount < eps) dueAmount = 0;
  let combined = r2(prevNet + total - amountPaid);
  if (Math.abs(combined) < eps) combined = 0;
  const totalDue = r2(Math.max(0, combined));
  const overpay = r2(amountPaid - (total + prevDue));
  const creditAmount = overpay > eps ? overpay : 0;
  let prevBalance = r2(prevDue - prevCredit);
  if (Math.abs(prevBalance) < eps) prevBalance = 0;
  const spareCredit = r2(Math.max(0, -prevBalance));
  const unpaid = r2(Math.max(0, total - amountPaid));
  let creditApplied = r2(Math.min(spareCredit, unpaid));
  if (creditApplied < eps) creditApplied = 0;
  let netTotalDue = r2(Math.max(0, prevBalance + total - amountPaid));
  if (netTotalDue < eps) netTotalDue = 0;
  return {
    amount_paid: amountPaid,
    due_amount: dueAmount,
    credit_amount: creditAmount,
    need_to_pay: r2(prevNet + total),
    total_due: totalDue,
    credit_applied: creditApplied,
    net_total_due: netTotalDue,
  };
}

/** core.desktop_sales_service.calc_sale with auto rounding (the PC's default). */
export function salesCalc({ items, discount_pct = 0, discount_rs = null, cash_paid = 0, online_paid = 0,
  previous_due = 0, previous_credit = 0, payment_mode = 'Cash', auto_rounding = true, rounding = 0 }) {
  const rounded = auto_rounding
    ? r2(autoRound(billSummary(items, discount_pct, 0, discount_rs).pre_round_total))
    : r2(money(rounding));
  const summary = billSummary(items, discount_pct, rounded, discount_rs);
  const isDue = String(payment_mode || 'Cash').trim().toLowerCase() === 'due';
  const cash = isDue ? 0 : money(cash_paid);
  const online = isDue ? 0 : money(online_paid);
  return {
    summary,
    rounding: rounded,
    cash_paid: cash,
    online_paid: online,
    payment: paymentResult(summary.total_amount, cash, online, previous_due, previous_credit),
  };
}

// ─── Exact decimals for the purchase engine (Python Decimal, 28 digits) ────────

const SCALE = 10n ** 30n;

class D {
  constructor(big) { this.v = big; }
  static of(x) {
    if (x instanceof D) return x;
    if (x === null || x === undefined || x === '') return new D(0n);
    let s = typeof x === 'number' ? pyStr(x) : String(x).trim();
    if (!/^[-+]?\d*\.?\d*(e[-+]?\d+)?$/i.test(s) || s === '' || s === '.') return new D(0n);
    let exp = 0;
    const e = s.toLowerCase().indexOf('e');
    if (e >= 0) { exp = Number(s.slice(e + 1)); s = s.slice(0, e); }
    const neg = s.startsWith('-');
    s = s.replace(/^[-+]/, '');
    let [ip, fp = ''] = s.split('.');
    ip = ip || '0';
    let digits = BigInt(ip + fp);
    let scale = fp.length - exp;
    let v;
    if (scale <= 30) v = digits * 10n ** BigInt(30 - scale);
    else v = digits / 10n ** BigInt(scale - 30);
    return new D(neg ? -v : v);
  }
  add(o) { return new D(this.v + D.of(o).v); }
  sub(o) { return new D(this.v - D.of(o).v); }
  mul(o) { return new D((this.v * D.of(o).v) / SCALE); }
  div(o) {
    const b = D.of(o).v;
    if (b === 0n) return new D(0n);
    return new D((this.v * SCALE) / b);
  }
  gt(o) { return this.v > D.of(o).v; }
  lte(o) { return this.v <= D.of(o).v; }
  isZero() { return this.v === 0n; }
  abs() { return new D(this.v < 0n ? -this.v : this.v); }
  /** quantize(0.01, ROUND_HALF_UP): halves away from zero */
  r2() {
    const unit = SCALE / 100n;
    const neg = this.v < 0n;
    const a = neg ? -this.v : this.v;
    let q = a / unit;
    const rem = a % unit;
    if (rem * 2n >= unit) q += 1n;
    return new D((neg ? -q : q) * unit);
  }
  /** quantize(0.01, ROUND_CEILING) for a positive value; 0 for <= 0 (pharmacy _round_up2) */
  up2() {
    if (this.v <= 0n) return new D(0n);
    const unit = SCALE / 100n;
    let q = this.v / unit;
    if (this.v % unit !== 0n) q += 1n;
    return new D(q * unit);
  }
  toNumber() { return Number(this.r2().v / (SCALE / 100n)) / 100; }
  /** int(x) in Python: toward zero */
  trunc() { return new D((this.v / SCALE) * SCALE); }
}

/** str(float) in Python: the shortest repr, which JavaScript's String() also gives. */
function pyStr(x) {
  if (!Number.isFinite(x)) return '0';
  return String(x);
}

const ZERO = D.of(0);
const f = (d) => d.r2().toNumber();

function slabKey(item) {
  return D.of(item.gst_pct ?? item.gst_percent ?? item.gst_value ?? 0).r2();
}

/** core.pharmacy_purchase_calc.compute_purchase_invoice (intra-state, no product discount). */
export function computePurchaseInvoice(items, { globalCashDiscount = 0, roundOff = null, gstCalcMethod = 'discount_after_gst' } = {}) {
  const mode = String(gstCalcMethod || 'discount_after_gst').trim() === 'discount_before_gst' ? 'exclusive' : 'inclusive';
  const billInclusive = mode === 'inclusive';
  const totalBillDiscount = D.of(globalCashDiscount).r2();

  // Step 1: lines
  const working = items.map((raw) => {
    const row = { ...raw };
    const qty = D.of(row.qty);
    const rate = D.of(row.rate);
    const disc = D.of(row.item_disc_percent ?? row.discount_pct ?? row.item_discount ?? 0);
    const gst = slabKey(row);
    const inclusive = 'is_tax_inclusive' in row ? !!row.is_tax_inclusive : billInclusive;
    const gross = qty.mul(rate).r2();
    const lineDisc = gross.mul(disc).div(100).r2();
    const net = gross.sub(lineDisc).r2();
    Object.assign(row, {
      qty: f(qty), rate: f(rate), free_qty: f(D.of(row.free_qty)), discount_pct: f(disc),
      gst_pct: f(gst), gst_percent: f(gst), is_tax_inclusive: inclusive, base: f(gross),
      discount_amt: f(lineDisc), net_line_amount: f(net), _net: net, _key: gst,
    });
    return row;
  });

  // Step 2: slabs (insertion order as Python dicts keep it)
  const slabs = new Map();
  const keyOf = (d) => d.v.toString();
  for (const it of working) {
    const k = keyOf(it._key);
    const cur = slabs.get(k) || { key: it._key, gross: ZERO, items: [] };
    cur.gross = cur.gross.add(it._net).r2();
    cur.items.push(it);
    slabs.set(k, cur);
  }
  const totalGross = [...slabs.values()].reduce((a, s) => a.add(s.gross), ZERO).r2();
  for (const s of slabs.values()) { s.disc = ZERO; s.basis = s.gross; }
  const gcd = totalBillDiscount.v > 0n ? totalBillDiscount.r2() : ZERO;
  if (totalGross.gt(0) && gcd.gt(0)) {
    let remaining = gcd;
    const ordered = [...slabs.values()].sort((a, b) => (b.gross.v > a.gross.v ? 1 : b.gross.v < a.gross.v ? -1 : 0));
    const last = ordered[ordered.length - 1];
    for (const s of ordered) {
      let disc;
      if (s === last) disc = remaining.r2();
      else {
        disc = s.gross.div(totalGross).mul(gcd).r2();
        remaining = remaining.sub(disc).r2();
      }
      s.disc = disc;
      const b = s.gross.sub(disc);
      s.basis = (b.v > 0n ? b : ZERO).r2();
    }
  }

  // Step 3: tax per slab, slabs in ascending GST order
  const sorted = [...slabs.values()].sort((a, b) => (a.key.v > b.key.v ? 1 : a.key.v < b.key.v ? -1 : 0));
  let totalCgst = ZERO; let totalSgst = ZERO; let totalGst = ZERO; let taxableTotal = ZERO;
  const breakdown = [];
  for (const s of sorted) {
    const rate = s.key;
    let taxable = ZERO; let cgst = ZERO; let sgst = ZERO; let gsum = ZERO;
    if (s.basis.gt(0) && s.items.length) {
      let inc = ZERO; let exc = ZERO;
      for (const it of s.items) { if (it.is_tax_inclusive) inc = inc.add(it._net); else exc = exc.add(it._net); }
      inc = inc.r2(); exc = exc.r2();
      let slabNet = inc.add(exc).r2();
      if (slabNet.isZero()) slabNet = s.gross;
      const incBasis = slabNet.gt(0) ? s.basis.mul(inc).div(slabNet).r2() : ZERO;
      const excBasis = s.basis.sub(incBasis).r2();
      if (incBasis.gt(0)) {
        if (!rate.gt(0)) { taxable = taxable.add(incBasis.r2()); }
        else {
          const realTaxable = incBasis.div(D.of(1).add(rate.div(100))).r2();
          const slabGst = incBasis.sub(realTaxable).r2();
          const half = slabGst.div(2).up2();
          taxable = taxable.add(realTaxable); cgst = cgst.add(half); sgst = sgst.add(half);
          gsum = gsum.add(half.add(half).r2());
        }
      }
      if (excBasis.gt(0)) {
        const realTaxable = excBasis.r2();
        if (realTaxable.gt(0) && rate.gt(0)) {
          const halfRate = rate.div(2);
          const c = realTaxable.mul(halfRate).div(100).r2();
          const sg = realTaxable.mul(halfRate).div(100).r2();
          taxable = taxable.add(realTaxable); cgst = cgst.add(c); sgst = sgst.add(sg);
          gsum = gsum.add(c.add(sg).r2());
        } else {
          taxable = taxable.add(realTaxable);
        }
      }
    }
    const row = { gst_pct: f(rate), taxable: taxable.r2(), cgst: cgst.r2(), sgst: sgst.r2(), total_gst: gsum.r2() };
    // A slab whose basis is zero reports zero taxable (Python's breakdown branch).
    if (!(s.basis.gt(0) && s.items.length)) { row.taxable = ZERO; row.cgst = ZERO; row.sgst = ZERO; row.total_gst = ZERO; }
    totalCgst = totalCgst.add(D.of(f(row.cgst)));
    totalSgst = totalSgst.add(D.of(f(row.sgst)));
    totalGst = totalGst.add(D.of(f(row.total_gst)));
    taxableTotal = taxableTotal.add(D.of(f(row.taxable)));
    breakdown.push({ s, row });
  }
  totalCgst = totalCgst.r2(); totalSgst = totalSgst.r2(); totalGst = totalGst.r2(); taxableTotal = taxableTotal.r2();

  // Lines: share of the slab's discount, taxable and GST (last line takes the remainder)
  for (const { s, row } of breakdown) {
    const grp = s.items;
    let remDisc = s.disc; let remTax = D.of(f(row.taxable)); let remGst = D.of(f(row.total_gst));
    const slabTax = remTax; const slabGst = remGst;
    grp.forEach((it, i) => {
      const share = s.gross.gt(0) ? it._net.div(s.gross) : ZERO;
      let d; let t; let g;
      if (i === grp.length - 1) { d = remDisc; t = remTax; g = remGst; }
      else {
        d = s.disc.mul(share).r2(); t = slabTax.mul(share).r2(); g = slabGst.mul(share).r2();
        remDisc = remDisc.sub(d).r2(); remTax = remTax.sub(t).r2(); remGst = remGst.sub(g).r2();
      }
      const c = g.div(2).r2();
      const sg = g.sub(c).r2();
      if (it._net.gt(0) && t.lte(0) && g.lte(0)) t = it._net.sub(d).r2();
      it.overall_discount_amt = f(d);
      it.taxable = f(t);
      it.gst_amt = f(g);
      it.cgst_amt = f(c);
      it.sgst_amt = f(sg);
      it.item_amount = f(t.add(g).r2());
      it.amount = it.item_amount;
    });
  }

  const hasExc = working.some((i) => !i.is_tax_inclusive);
  const hasInc = working.some((i) => i.is_tax_inclusive);
  const preRound = hasInc && !hasExc ? totalGross.sub(totalBillDiscount).r2() : taxableTotal.add(totalGst).r2();
  let rounding;
  if (roundOff !== null && roundOff !== undefined) rounding = D.of(roundOff).r2();
  else {
    let rounded = preRound.r2();
    if (preRound.v !== rounded.v) rounded = preRound.add(D.of('0.5')).trunc();
    rounding = rounded.sub(preRound).r2();
  }
  const totalAmount = preRound.add(rounding).r2();
  for (const it of working) { delete it._net; delete it._key; }
  return {
    gross_total: f(totalGross),
    subtotal: f(taxableTotal),
    taxable_total: f(taxableTotal),
    discount_amount: f(totalBillDiscount),
    total_gst: f(totalGst),
    cgst: f(totalCgst),
    sgst: f(totalSgst),
    pre_round_total: f(preRound),
    rounding: f(rounding),
    total_amount: f(totalAmount),
    items: working,
    tax_mode: mode,
    gst_calc_method: mode === 'exclusive' ? 'discount_before_gst' : 'discount_after_gst',
  };
}

/** core.purchase_calculator.PurchaseCalculator(...).calculate(): auto rounding + payment. */
export function purchaseCalc({ items, overall_discount = 0, rounding = 0, previous_due = 0, previous_credit = 0,
  cash_paid = 0, online_paid = 0, amount_paid = null, expenditure = 0, gst_calc_method = 'discount_before_gst' }) {
  const method = ['discount_before_gst', 'discount_after_gst'].includes(String(gst_calc_method || '').trim())
    ? String(gst_calc_method).trim() : 'discount_before_gst';
  const od = r2(money(overall_discount));
  let rnd = r2(money(rounding));
  const opts = { globalCashDiscount: od, gstCalcMethod: method };
  let calc = computePurchaseInvoice(items, { ...opts, roundOff: rnd || null });
  if (!rnd) {
    rnd = autoRound(Number(calc.pre_round_total || 0));
    if (rnd) calc = computePurchaseInvoice(items, { ...opts, roundOff: rnd });
  }
  const eps = 0.01;
  const pd = r2(money(previous_due));
  const pc = r2(money(previous_credit));
  const cash = r2(money(cash_paid));
  const online = r2(money(online_paid));
  const paid = amount_paid !== null && amount_paid !== undefined ? r2(money(amount_paid)) : r2(cash + online);
  const exp = r2(money(expenditure));
  const finalAmount = r2(calc.total_amount + exp);
  const needToPay = r2(finalAmount + pd - pc);
  let due = r2(Math.max(0, needToPay - paid));
  if (due < eps) due = 0;
  const overpay = r2(paid - (finalAmount + pd));
  const credit = overpay > eps ? overpay : 0;
  return {
    ...calc,
    overall_discount: od,
    expenditure: exp,
    previous_due: pd,
    previous_credit: pc,
    cash_paid: cash,
    online_paid: online,
    amount_paid: paid,
    need_to_pay: needToPay,
    final_amount: finalAmount,
    due,
    due_amount: due,
    current_credit: credit,
    credit_amount: credit,
    total_due: due,
    bill_cleared: due < eps ? 1 : 0,
    account_cleared: due < eps ? 1 : 0,
    gst_calc_method: method,
  };
}

/** Tablets (or units) a purchase line adds to stock: (qty + free) x tablets per strip for strips. */
export function purchaseStockUnits(line, med) {
  const qty = money(line.qty) + money(line.free_qty);
  if (isStripCountType(med?.type ?? line.type, med?.unit ?? line.unit)) {
    return Math.round(qty * Math.max(1, parseTabletsPerStripe(med?.unit ?? line.unit)));
  }
  return Math.round(qty);
}
