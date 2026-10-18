/**
 * The wholesale sale's arithmetic and rules, ported from the PC (mac2 core/wholesale_sale.py,
 * core/wholesale_party.py, core/customer_gst.py, core/wholesale_rates.py; owner, 18 Oct 2026).
 * Pure: no database. The web's wholesale bill (webWholesale.js) uses it, and
 * test/wholesaleSale.test.mjs holds it to answers recorded from the Python engine
 * (test/fixtures/wholesale_vectors.json, made by scripts/make-wholesale-vectors.py).
 *
 * A line is sold in whole packs at a rate that EXCLUDES GST, with GST added on top:
 *
 *     gross   = packs x rate
 *     disc    = gross x disc% / 100
 *     scheme  = (gross - disc) x scheme% / 100
 *     taxable = gross - disc - scheme
 *     GST     = taxable x GST% / 100     (CGST = half rounded up, SGST the rest when the buyer
 *     amount  = taxable + GST             is in the shop's state, else IGST)
 *
 * all in exact decimals, half-up to the paisa. The grand total is the lines' sum rounded to
 * the rupee; the difference is the round off. How a line is stored (so stock, returns and
 * every retail report stay right):
 *
 *     sales_items.qty            units leaving stock = (packs + free packs) x units per pack
 *     sales_items.rate           amount / qty (what one unit cost the buyer, GST included)
 *     sales_items.amount         taxable + GST
 *     sales_items.item_discount  disc + scheme in rupees
 *     extra_fields               free_qty (packs), scheme_pct, taxable, gst_amt, rate_tier
 */
import { pyRound } from './billRules.js';
import { isStripCountType, parseTabletsPerStripe } from '../utils/saleProfit.js';

export const WHOLESALE = 'wholesale';
export const RATE_TIERS = ['A', 'B', 'C'];
export const PARTY_TYPES = ['retail', 'medical'];

/** The sale columns a wholesale invoice carries (extra_fields on the server). */
export const SALE_FIELDS = ['invoice_mode', 'buyer_gstin', 'buyer_dl', 'place_of_supply', 'taxable_total',
  'cgst_total', 'sgst_total', 'igst_total', 'due_date', 'transport', 'lr_no', 'eway_bill_no'];
export const LINE_FIELDS = ['rate_tier', 'free_qty', 'scheme_pct', 'taxable', 'gst_amt', 'batch_no', 'expiry_date',
  'hsn_code'];

// ─── exact decimals (Python Decimal for these sums: products and /100 are exact) ──────

const SCALE = 10n ** 24n;

class Dec {
  constructor(v) { this.v = v; }
  static of(x) {
    if (x instanceof Dec) return x;
    let s = typeof x === 'number' ? String(x) : String(x ?? '0').trim();
    if (!s || !/^[-+]?\d*\.?\d*(e[-+]?\d+)?$/i.test(s) || s === '.') return new Dec(0n);
    let exp = 0;
    const e = s.toLowerCase().indexOf('e');
    if (e >= 0) { exp = Number(s.slice(e + 1)); s = s.slice(0, e); }
    const neg = s.startsWith('-');
    s = s.replace(/^[-+]/, '');
    const [ip, fp = ''] = s.split('.');
    const digits = BigInt((ip || '0') + fp);
    const scale = fp.length - exp;
    const v = scale <= 24 ? digits * 10n ** BigInt(24 - scale) : digits / 10n ** BigInt(scale - 24);
    return new Dec(neg ? -v : v);
  }
  add(o) { return new Dec(this.v + Dec.of(o).v); }
  sub(o) { return new Dec(this.v - Dec.of(o).v); }
  mul(o) { return new Dec((this.v * Dec.of(o).v) / SCALE); }
  div(o) { const b = Dec.of(o).v; return b === 0n ? new Dec(0n) : new Dec((this.v * SCALE) / b); }
  gt(o) { return this.v > Dec.of(o).v; }
  lt(o) { return this.v < Dec.of(o).v; }
  /** quantize(10^-places, ROUND_HALF_UP) */
  q(places = 2) {
    const unit = SCALE / 10n ** BigInt(places);
    const neg = this.v < 0n;
    const a = neg ? -this.v : this.v;
    let n = a / unit;
    if ((a % unit) * 2n >= unit) n += 1n;
    return new Dec((neg ? -n : n) * unit);
  }
  /** float(Decimal) */
  num() {
    const neg = this.v < 0n;
    const a = neg ? -this.v : this.v;
    const ip = a / SCALE;
    const fp = String(a % SCALE).padStart(24, '0').replace(/0+$/, '');
    const n = Number(`${ip}${fp ? `.${fp}` : ''}`);
    return neg ? -n : n;
  }
  /** int(Decimal): toward zero */
  int() { return Number(this.v / SCALE); }
}
const ZERO = new Dec(0n);
const HUNDRED = Dec.of(100);

// ─── numbers, as the PC reads them ────────────────────────────────────────────

/** core/wholesale_sale._f */
export function num(v, dflt = 0) {
  if (v === null || v === undefined || v === '') return dflt;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isNaN(v) ? dflt : v;
  const s = String(v).replace(/,/g, '').trim();
  if (!s || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return dflt;
  const x = Number(s);
  return Number.isNaN(x) ? dflt : x;
}

/** _d(v, places): Decimal(repr(round(float(v), places))) */
function d(v, places = 2) {
  return Dec.of(String(pyRound(num(v), places))).q(places);
}

/** int(round(x)): Python rounds a half to the even integer. */
export function pyInt(v) {
  const x = num(v);
  if (!Number.isFinite(x)) return 0;
  return Math.trunc(pyRound(x, 0));
}

/** f"{x:.2f}" */
export function fmt2(x) {
  const r = pyRound(num(x), 2);
  return (Object.is(r, -0) ? 0 : r).toFixed(2);
}

// ─── GST states and GSTIN (core/customer_gst.py) ──────────────────────────────

export const STATES = Object.freeze({
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur',
  15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam', 19: 'West Bengal',
  20: 'Jharkhand', 21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat',
  26: 'Dadra and Nagar Haveli and Daman and Diu', 27: 'Maharashtra', 29: 'Karnataka',
  30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala', 33: 'Tamil Nadu', 34: 'Puducherry',
  35: 'Andaman and Nicobar Islands', 36: 'Telangana', 37: 'Andhra Pradesh', 38: 'Ladakh',
  97: 'Other Territory',
});
const hasState = (code) => Object.prototype.hasOwnProperty.call(STATES, code);

export function cleanGstin(v) {
  return String(v ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** '' for a well-formed GSTIN (shape, state and check digit), else why not. */
export function gstinProblem(v) {
  const g = cleanGstin(v);
  if (g.length !== 15) return 'A GSTIN has 15 characters.';
  if (!GSTIN_RE.test(g)) return 'The GSTIN is not in the right shape (2 digits, 10 PAN, 1, Z, 1).';
  if (!hasState(g.slice(0, 2))) return `State code ${g.slice(0, 2)} in the GSTIN is not a state.`;
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const val = GST_CHARS.indexOf(g[i]) * (i % 2 ? 2 : 1);
    total += Math.trunc(val / 36) + (val % 36);
  }
  if (GST_CHARS[(36 - (total % 36)) % 36] !== g[14]) return 'The last (check) character of the GSTIN does not match. Check the GSTIN again.';
  return '';
}

export function stateOf(gstin) {
  const g = cleanGstin(gstin);
  return g.length >= 2 && hasState(g.slice(0, 2)) ? g.slice(0, 2) : '';
}
export const stateFromGstin = stateOf;

export function stateName(code) {
  const s = String(code ?? '').trim();
  return s ? (STATES[s.padStart(2, '0')] || '') : '';
}

export function cleanState(code) {
  let s = String(code ?? '').replace(/\D/g, '').slice(0, 2);
  if (s.length === 1) s = `0${s}`;
  return stateName(s) ? s : '';
}

/** Buyer GSTIN's state first, else the party's state code, else the shop's state. */
export function placeOfSupply(buyerGstin, buyerState, shopState) {
  return stateFromGstin(buyerGstin) || cleanState(buyerState) || cleanState(shopState);
}

/** Same state as the shop (or the shop's state unknown) -> CGST + SGST, else IGST. */
export function isIntraState(pos, shopState) {
  return !shopState || !pos || pos === shopState;
}

/** (CGST, SGST): half rounded up, and the rest (core/bill_gst.split_tax). */
function splitHalf(tax) {
  const t = Dec.of(tax).q(2);
  const cgst = t.div(2).q(2);
  return [cgst, t.sub(cgst)];
}
export function splitTax(tax) {
  return splitHalf(tax).map((x) => x.num());
}

// ─── the sum ─────────────────────────────────────────────────────────────────

/** One invoice line's figures. raw: qty (packs), free, rate (per pack, GST excluded),
 *  disc_pct, scheme_pct, gst_percent. */
export function calcLine(raw, { intra = true } = {}) {
  const packs = Dec.of(Math.max(0, pyInt(raw.qty)));
  const rate = d(raw.rate, 4);
  const discPct = d(raw.disc_pct, 2);
  const schemePct = d(raw.scheme_pct, 2);
  const gstPct = d(raw.gst_percent, 2);
  const gross = packs.mul(rate).q(2);
  const disc = gross.mul(discPct).div(HUNDRED).q(2);
  const scheme = gross.sub(disc).mul(schemePct).div(HUNDRED).q(2);
  const taxable = gross.sub(disc).sub(scheme);
  const gst = taxable.mul(gstPct).div(HUNDRED).q(2);
  let cgst = ZERO; let sgst = ZERO; let igst = ZERO;
  if (intra) [cgst, sgst] = splitHalf(gst);
  else igst = gst;
  const freeRaw = raw.free !== undefined ? raw.free : raw.free_qty;
  return {
    qty: packs.int(),
    free: Math.max(0, pyInt(freeRaw)),
    rate: rate.num(),
    disc_pct: discPct.num(),
    scheme_pct: schemePct.num(),
    gst_percent: gstPct.num(),
    gross: gross.num(),
    disc_amt: disc.num(),
    scheme_amt: scheme.num(),
    taxable: taxable.num(),
    gst_amt: gst.num(),
    cgst: cgst.num(),
    sgst: sgst.num(),
    igst: igst.num(),
    amount: taxable.add(gst).num(),
  };
}

/** Every line, the HSN-wise tax summary and the totals of one invoice. */
export function calcInvoice(lines, { shopState = '', pos = '' } = {}) {
  const shop = cleanState(shopState);
  const place = cleanState(pos) || shop;
  const intra = isIntraState(place, shop);
  const outLines = [];
  const hsn = new Map();
  const tot = { gross: ZERO, disc: ZERO, taxable: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO, amount: ZERO };
  for (const raw of lines || []) {
    const line = { ...raw, ...calcLine(raw, { intra }) };
    outLines.push(line);
    tot.gross = tot.gross.add(d(line.gross));
    tot.disc = tot.disc.add(d(line.disc_amt)).add(d(line.scheme_amt));
    tot.taxable = tot.taxable.add(d(line.taxable));
    tot.cgst = tot.cgst.add(d(line.cgst));
    tot.sgst = tot.sgst.add(d(line.sgst));
    tot.igst = tot.igst.add(d(line.igst));
    tot.amount = tot.amount.add(d(line.amount));
    const code = String(line.hsn_code ?? '').trim();
    const key = JSON.stringify([code, line.gst_percent]);
    const h = hsn.get(key) || { code, pct: line.gst_percent, taxable: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO };
    h.taxable = h.taxable.add(d(line.taxable));
    h.cgst = h.cgst.add(d(line.cgst));
    h.sgst = h.sgst.add(d(line.sgst));
    h.igst = h.igst.add(d(line.igst));
    hsn.set(key, h);
  }
  const preRound = tot.taxable.add(tot.cgst).add(tot.sgst).add(tot.igst);
  const grand = preRound.q(0);
  const roundOff = grand.sub(preRound);
  const summary = [...hsn.values()]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.pct - b.pct))
    .map((h) => ({
      hsn_code: h.code,
      gst_percent: h.pct,
      taxable: h.taxable.num(),
      cgst_rate: intra ? h.pct / 2 : 0,
      cgst: h.cgst.num(),
      sgst_rate: intra ? h.pct / 2 : 0,
      sgst: h.sgst.num(),
      igst_rate: intra ? 0 : h.pct,
      igst: h.igst.num(),
      tax: h.cgst.add(h.sgst).add(h.igst).num(),
    }));
  return {
    lines: outLines,
    hsn_summary: summary,
    intra_state: intra,
    shop_state: shop,
    place_of_supply: place,
    place_of_supply_name: stateName(place),
    gross_total: tot.gross.num(),
    discount_total: tot.disc.num(),
    taxable_total: tot.taxable.num(),
    cgst_total: tot.cgst.num(),
    sgst_total: tot.sgst.num(),
    igst_total: tot.igst.num(),
    gst_total: tot.cgst.add(tot.sgst).add(tot.igst).num(),
    pre_round_total: preRound.num(),
    round_off: roundOff.num(),
    grand_total: grand.num(),
    amount_in_words: amountInWords(grand.num()),
  };
}

// ─── amount in words (Indian numbering) ───────────────────────────────────────

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function two(n) {
  if (n < 20) return ONES[n];
  return (TENS[Math.trunc(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '')).trim();
}
function three(n) {
  const parts = [];
  if (n >= 100) { parts.push(`${ONES[Math.trunc(n / 100)]} Hundred`); n %= 100; }
  if (n) parts.push(two(n));
  return parts.join(' ');
}
function indianWords(n) {
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.trunc(n / 10_000_000); n %= 10_000_000;
  const lakh = Math.trunc(n / 100_000); n %= 100_000;
  const thousand = Math.trunc(n / 1000); n %= 1000;
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (n) parts.push(three(n));
  return parts.join(' ');
}

/** 'Rupees One Thousand Two Hundred Five and Fifty Paise Only' */
export function amountInWords(amount) {
  const value = d(Math.abs(num(amount)));
  const rupees = value.int();
  const paise = value.sub(rupees).mul(100).int();
  let text = `Rupees ${indianWords(rupees)}`;
  if (paise) text += ` and ${two(paise)} Paise`;
  return `${num(amount) < 0 ? 'Minus ' : ''}${text} Only`;
}

// ─── medicines, rates, parties ────────────────────────────────────────────────

/** How many stock units one pack is: tablets per strip for a strip type, else 1. */
export function unitsPerPack(type, unit) {
  if (isStripCountType(type, unit)) return Math.max(1, parseTabletsPerStripe(unit || '1'));
  return 1;
}

/** [rate per pack, the tier it came from]: the party's tier, else Rate A, else 0. */
export function tierRate(med, tier) {
  let t = String(tier || 'A').trim().toUpperCase();
  if (!RATE_TIERS.includes(t)) t = 'A';
  const r = num(med?.[`rate_${t.toLowerCase()}`]);
  if (r > 0) return [pyRound(r, 4), t];
  const a = num(med?.rate_a);
  if (a > 0) return [pyRound(a, 4), 'A'];
  return [0, ''];
}

/** YYYY-MM-DD + credit days. */
export function dueDateFor(billDate, creditDays) {
  const s = String(billDate || '').slice(0, 10);
  const dt = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return s;
  dt.setUTCDate(dt.getUTCDate() + Math.max(0, pyInt(creditDays)));
  return dt.toISOString().slice(0, 10);
}

/** A warning (never a refusal) when the party's due plus this bill passes its limit. */
export function creditWarning(p, billTotal, paidNow = 0, { thisBillDue = 0 } = {}) {
  if (!p) return '';
  const limit = num(p.credit_limit);
  if (limit <= 0) return '';
  const due = Math.max(0, num(p.total_due) - num(thisBillDue));
  const after = pyRound(due + Math.max(0, num(billTotal) - num(paidNow)), 2);
  if (after <= limit + 0.005) return '';
  return `Credit limit crossed: ${p.name || 'party'} owes Rs ${fmt2(due)}; with this bill Rs ${fmt2(after)}, limit Rs ${fmt2(limit)}.`;
}

/** The Return total of the live totals (a new bill: the ticked returns' open credit, no more
 *  than the payment leaves unpaid; an edit: what its returns settled). */
export function returnsUsedInCalc(grand, paid, body = {}) {
  const settled = num(body.returns_settled);
  if (settled > 0) return pyRound(Math.min(settled, Math.max(0, num(grand))), 2);
  const ticked = num(body.returns_total);
  if (ticked > 0) return pyRound(Math.min(ticked, Math.max(0, pyRound(num(grand) - num(paid), 2))), 2);
  return 0;
}

/** A stored line back in invoice terms: packs, free, pack rate, disc %. */
export function lineFromRow(r, ups) {
  const u = Math.max(1, Math.trunc(Number(ups) || 1));
  const units = num(r.qty);
  const free = num(r.free_qty);
  const packs = pyRound(units / u - free, 4);
  const taxable = d(r.taxable);
  const off = d(r.item_discount);
  const schemePct = d(r.scheme_pct);
  const gross = taxable.add(off);
  const schemeAmt = schemePct.gt(ZERO) && schemePct.lt(HUNDRED)
    ? taxable.mul(schemePct).div(HUNDRED.sub(schemePct)).q(2) : ZERO;
  let discAmt = off.sub(schemeAmt);
  if (discAmt.lt(ZERO)) discAmt = ZERO;
  const discPct = gross.gt(ZERO) ? discAmt.mul(HUNDRED).div(gross).q(2).num() : 0;
  const rate = packs > 0 ? pyRound(gross.num() / packs, 4) : 0;
  return {
    qty: pyInt(packs),
    free: pyInt(free),
    rate: Math.abs(rate - pyRound(rate, 2)) < 0.0051 ? pyRound(rate, 2) : rate,
    disc_pct: discPct,
    scheme_pct: schemePct.num(),
  };
}

/** The PACK column: 1x10 for a strip of ten, 100ML for a bottle, blank for a single. */
export function packText(unit, ups) {
  const u = String(unit ?? '').trim();
  if (!u || u === '1') return '';
  if (/^\d+$/.test(u)) return Number(ups || 1) > 1 ? `1x${u}` : u;
  return u.toUpperCase();
}

export const DEFAULT_DECLARATION = 'Declaration :- I/We declare that this invoice shows actual price of the goods '
  + 'described and that all particulars are true and correct. Goods once sold will not be '
  + 'taken back or exchanged. Bills not paid by the due date will attract 24% interest. '
  + 'Subject to {city} jurisdiction only.';

/** The town of the shop's address: its last part that is not a PIN code or a state. */
export function cityOf(address) {
  const parts = String(address ?? '').split(/[,\n]/).reverse();
  for (const part of parts) {
    const word = part.trim().replace(/[\d\-\s]+$/, '').trim().replace(/^[ .-]+|[ .-]+$/g, '');
    if (word && !['MAHARASHTRA', 'INDIA', 'MS', 'M.S'].includes(word.toUpperCase())) return word.toUpperCase();
  }
  return 'LOCAL';
}

export function declarationText(custom, shopAddress) {
  return (String(custom || '').trim() || DEFAULT_DECLARATION).replaceAll('{city}', cityOf(shopAddress));
}

/** The party fields present in `data`, checked and normalised (core/wholesale_party.clean_party).
 *  Throws Error with the reason. */
export function cleanParty(data) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(data, k);
  if (has('party_type')) {
    const pt = String(data.party_type || 'retail').trim().toLowerCase();
    if (!PARTY_TYPES.includes(pt)) throw new Error('Party type must be Retail or Medical.');
    out.party_type = pt;
  }
  if (has('dl_numbers')) out.dl_numbers = String(data.dl_numbers ?? '').split(/\s+/).filter(Boolean).join(' ').slice(0, 200);
  if (has('rate_tier')) {
    const t = String(data.rate_tier || 'A').trim().toUpperCase() || 'A';
    if (!RATE_TIERS.includes(t)) throw new Error('Rate tier must be A, B or C.');
    out.rate_tier = t;
  }
  if (has('credit_limit')) {
    const raw = data.credit_limit;
    const v = raw === null || raw === undefined || raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(v)) throw new Error('Credit limit must be a number.');
    if (v < 0) throw new Error('Credit limit cannot be negative.');
    out.credit_limit = pyRound(v, 2);
  }
  if (has('credit_days')) {
    const raw = data.credit_days;
    const v = raw === null || raw === undefined || raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(v)) throw new Error('Credit days must be a whole number.');
    const dd = Math.trunc(v);
    if (dd < 0 || dd > 3650) throw new Error('Credit days must be between 0 and 3650.');
    out.credit_days = dd;
  }
  if (has('gstin')) {
    const g = cleanGstin(data.gstin);
    if (g) {
      const problem = gstinProblem(g);
      if (problem) throw new Error(problem);
    }
    out.gstin = g;
  }
  if (has('state_code') || out.gstin) {
    let st = out.gstin ? stateOf(out.gstin) : '';
    if (!st) {
      st = String(data.state_code ?? '').trim();
      if (/^\d+$/.test(st)) st = st.padStart(2, '0');
      if (st && !hasState(st)) throw new Error(`Unknown state code ${st}.`);
    }
    out.state_code = st;
  }
  return out;
}

/** The party's rates and terms as the wholesale screen shows them. */
export function partyView(c, gst = {}) {
  const gstin = cleanGstin(gst.gstin);
  const state = stateFromGstin(gstin) || cleanState(c.state_code);
  const tier = String(c.rate_tier || '').trim().toUpperCase();
  return {
    id: Number(c.local_id ?? c.id),
    name: String(c.name || ''),
    phone: String(c.phone || ''),
    address: String(c.address || ''),
    party_type: String(c.party_type || 'retail'),
    gstin,
    legal_name: String(gst.legal_name || ''),
    dl_numbers: String(c.dl_numbers || ''),
    state_code: state,
    state_name: stateName(state),
    rate_tier: RATE_TIERS.includes(tier) ? tier : 'A',
    credit_limit: pyRound(num(c.credit_limit), 2),
    credit_days: Math.max(0, pyInt(c.credit_days)),
    total_due: pyRound(num(c.total_due), 2),
    total_credit: pyRound(num(c.total_credit), 2),
  };
}

/** {rate_a, rate_b, rate_c} typed on a purchase line, only those above zero (wholesale_rates.line_rates). */
export function lineRates(item) {
  const out = {};
  if (!item || typeof item !== 'object') return out;
  for (const [key, names] of [['rate_a', ['rate_a', 'rateA']], ['rate_b', ['rate_b', 'rateB']], ['rate_c', ['rate_c', 'rateC']]]) {
    for (const n of names) {
      const v = item[n];
      if (v === null || v === undefined || v === '') continue;
      const f = pyRound(Number(v), 2);
      if (Number.isFinite(f) && f > 0) { out[key] = f; break; }
    }
  }
  return out;
}

/** Rate A / B / C = purchase rate + the shop's margins (desktop wholesale/mode.ts suggestedRates). */
export function suggestedRates(purchaseRate, margins = { A: 8, B: 10, C: 12 }) {
  const pr = Number(purchaseRate) || 0;
  const r = (pct) => (pr > 0 ? Math.round(pr * (1 + pct / 100) * 100) / 100 : 0);
  return { rate_a: r(margins.A), rate_b: r(margins.B), rate_c: r(margins.C) };
}

/** Returns with their medicines counted the way the wholesale bill counts them: qty in packs,
 *  units the stock units, rate per pack (core/wholesale_sale.returns_in_packs). `upsOf(it)`
 *  gives a return line's units per pack. */
export function returnsInPacks(rows, upsOf) {
  return (rows || []).map((r) => ({
    ...r,
    items: (r.items || []).map((it) => {
      const ups = Math.max(1, Number(upsOf(it)) || 1);
      const units = num(it.qty);
      const q = pyRound(units / ups, 2);
      const item = { ...it, qty: q, units: it.qty, units_per_pack: ups };
      if ('rate' in it) item.rate = pyRound(num(it.rate) * ups, 2);
      return item;
    }),
  }));
}
