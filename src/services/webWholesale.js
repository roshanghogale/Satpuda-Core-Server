/**
 * The web's wholesale store (owner, 18-19 Oct 2026): the same B2B tax invoice, parties,
 * invoice print and reports as the PC's wholesale beta (mac2 core/wholesale_sale.py,
 * core/wholesale_party.py, bill_templates/wholesale_invoice.py, core/wholesale_reports.py).
 *
 * The store is the retail store's companion (wholesaleStore.js); routes/web.js decides that a
 * request acts for it. Every save goes through the same path as any web save
 * (webStore.save -> syncV2.applyServerSideSave): stock only through stock operations, the dues
 * cascade, and a sync revision so PCs and phones pull the bill. What is saved is exactly what
 * the PC saves: the sale and its lines in the ordinary columns (qty in stock units, rate =
 * amount / qty) and the tax-invoice fields as the same keys (extra_fields on the server).
 */
import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';
import { AppError } from '../utils/http.js';
import { allocateFySerialInTx, fetchDocsByLocalIds } from './syncService.js';
import { paymentResult, pyRound, saleCostPrice } from './billRules.js';
import { expiryCutoffSql } from './adminFilters.js';
import { partyBillClearing } from './partyDueCascade.js';
import {
  cleanText, currentDoc, isExpiredOn, madeBy, medicinesById, openReturns, partyRow, qtyByMedicine,
  returnsForBill, returnsInBill, save, saleDetail, todayIst,
} from './webStore.js';
import * as W from './wholesaleSale.js';
import { billReturnRows, renderWholesaleInvoiceHtml } from './wholesaleInvoice.js';
import { HEADING_KV, REASON_KV, billHeadingInfo } from './billHeading.js';
import { displaySalesBillNo } from '../utils/fy.js';

const r2 = (x) => pyRound(Number(x) || 0, 2);
const COUNTER_SALE_NAMES = ['COUNTER SALE', 'COUNTER', 'COUNTER SALES', 'COUNTERSALE', 'COUNTERSALES'];
const isWholesaleBill = (doc) => String(doc?.invoice_mode || '').toLowerCase() === W.WHOLESALE;

// ─── the store's own settings rows (store_settings, synced with its PCs) ─────────────────

async function settingRows(storePk, { names = [], prefix = null } = {}) {
  const { rows } = await query(
    `SELECT name, value FROM store_settings
      WHERE store_pk=$1 AND (name = ANY($2::text[]) OR ($3::text IS NOT NULL AND name LIKE $3 || '%'))`,
    [storePk, names, prefix],
  );
  return new Map(rows.map((r) => [r.name, r.value]));
}

function parseGst(raw) {
  try {
    const data = typeof raw === 'object' && raw ? raw : JSON.parse(String(raw || ''));
    return data && typeof data === 'object' && W.cleanGstin(data.gstin) ? data : null;
  } catch {
    return null;
  }
}

/** A customer's GSTIN, kept like the PC keeps it: settings row customer_gst:<id> (core/customer_gst.py). */
export async function customerGst(storePk, ids = null) {
  const list = ids ? [...new Set(ids.map(Number).filter((v) => v > 0))] : null;
  const rows = list
    ? await settingRows(storePk, { names: list.map((id) => `customer_gst:${id}`) })
    : await settingRows(storePk, { prefix: 'customer_gst:' });
  const out = new Map();
  for (const [name, value] of rows) {
    const id = Number(String(name).slice('customer_gst:'.length));
    const data = parseGst(value);
    if (id > 0 && data) {
      const g = W.cleanGstin(data.gstin);
      out.set(id, { gstin: g, legal_name: String(data.legal_name || ''), state: String(data.state || W.stateOf(g)),
        since: String(data.since || '') });
    }
  }
  return out;
}

/** The GSTIN on file for a bill of this date (core/customer_gst.gstin_for_bill). */
function gstinForBill(entry, billDate) {
  if (!entry?.gstin) return '';
  if (entry.since && String(billDate || '').slice(0, 10) < entry.since) return '';
  return entry.gstin;
}

/** Rate A / B / C margins over the purchase rate (settings ws_margin_a/b/c; 8 / 10 / 12). */
export async function margins(storePk) {
  const rows = await settingRows(storePk, { names: ['ws_margin_a', 'ws_margin_b', 'ws_margin_c'] });
  const pick = (k, d) => {
    const raw = rows.get(k);
    if (raw === undefined || raw === null || String(raw).trim() === '') return d;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return { A: pick('ws_margin_a', 8), B: pick('ws_margin_b', 10), C: pick('ws_margin_c', 12) };
}

/** The pharmacy profile as the invoice prints it, with its GST state and bank details. */
export async function shopProfile(storePk) {
  const [{ rows }, kv] = await Promise.all([
    query(`SELECT name, address, phone, email, gstin, dl_number FROM pharmacy_profiles WHERE store_pk=$1`, [storePk]),
    settingRows(storePk, { names: ['profile_bank_name', 'profile_bank_account_no', 'profile_bank_ifsc', 'profile_bank_branch',
      'invoice_bank_details', 'invoice_declaration', 'bill_signature_image', HEADING_KV, REASON_KV] }),
  ]);
  const p = rows[0] || {};
  const gstin = String(p.gstin || '').trim().toUpperCase();
  const bank = [];
  for (const [label, name] of [['Bank', 'profile_bank_name'], ['A/c No', 'profile_bank_account_no'],
    ['IFSC', 'profile_bank_ifsc'], ['Branch', 'profile_bank_branch']]) {
    const v = String(kv.get(name) ?? '').trim();
    if (v) bank.push([label, v]);
  }
  if (!bank.length) {
    for (const line of String(kv.get('invoice_bank_details') ?? '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const at = line.indexOf(':');
      bank.push(at >= 0 && line.slice(at + 1) ? [line.slice(0, at).trim(), line.slice(at + 1).trim()] : ['', line.trim()]);
    }
  }
  const state = W.stateFromGstin(gstin);
  return {
    name: String(p.name || ''), address: String(p.address || ''), phone: String(p.phone || ''), email: String(p.email || ''),
    gstin, dl_numbers: String(p.dl_number || ''), state, state_name: W.stateName(state), bank,
    declaration: String(kv.get('invoice_declaration') ?? ''),
    signature: String(kv.get('bill_signature_image') ?? ''),
    // Tax Invoice or Bill of Supply (services/billHeading.js).
    ...billHeadingInfo(kv.get(HEADING_KV), kv.get(REASON_KV)),
  };
}

// ─── parties ──────────────────────────────────────────────────────────────────

/** Customers for the wholesale party box: medicals first, then the rest by name. */
export async function listParties(storePk, { q = '', limit = 30 } = {}) {
  const term = cleanText(q, 60);
  const { rows } = await query(
    `SELECT local_id AS id, name, phone, address, COALESCE(total_due,0)::float AS total_due,
            COALESCE(extra_fields->>'party_type','retail') AS party_type, extra_fields->>'rate_tier' AS rate_tier,
            extra_fields->>'dl_numbers' AS dl_numbers
       FROM customers
      WHERE store_pk=$1 AND NOT deleted AND UPPER(BTRIM(COALESCE(name,''))) <> ALL($2::text[])
        AND ($3 = '' OR name ILIKE '%' || $3 || '%' OR COALESCE(phone,'') ILIKE '%' || $3 || '%')
      ORDER BY (LOWER(COALESCE(extra_fields->>'party_type',''))='medical') DESC, name
      LIMIT $4`,
    [storePk, COUNTER_SALE_NAMES, term, Math.max(1, Math.min(200, Number(limit) || 30))],
  );
  const gst = await customerGst(storePk, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, gstin: gst.get(Number(r.id))?.gstin || '' }));
}

/** The buyer as the wholesale screen and the invoice show it, or null. */
export async function getParty(storePk, id, client = null) {
  const cid = Number(id);
  if (!(cid > 0)) return null;
  const run = client || { query: (t, p) => query(t, p) };
  const { rows } = await run.query(
    `SELECT local_id, name, phone, address, total_due, total_credit, version, extra_fields
       FROM customers WHERE store_pk=$1 AND local_id=$2 AND NOT deleted`, [storePk, cid],
  );
  const c = rows[0];
  if (!c) return null;
  const gst = (await customerGst(storePk, [cid])).get(cid) || {};
  return { ...W.partyView({ ...c, ...(c.extra_fields || {}) }, gst), gst_since: gst.since || '' };
}

function istStamp() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t)?.value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}:${g('second')}`;
}

/**
 * New party or a party's details (Customers -> Party details): name, phone, address and the
 * wholesale fields (party type, GSTIN, DL numbers, state, rate tier, credit limit and days).
 * A field the form does not send is left alone. The GSTIN goes where the PC keeps it.
 */
export async function saveParty(storePk, user, id, body) {
  let party;
  try {
    party = W.cleanParty(Object.fromEntries(Object.entries(body || {})
      .filter(([k]) => ['party_type', 'dl_numbers', 'state_code', 'rate_tier', 'credit_limit', 'credit_days', 'gstin'].includes(k))));
  } catch (err) {
    throw new AppError(400, err.message);
  }
  const name = body.name !== undefined ? cleanText(body.name, 80).toUpperCase() : null;
  if (name !== null && !name) throw new AppError(400, 'Enter the party name.');
  if (name && COUNTER_SALE_NAMES.includes(name)) throw new AppError(400, 'Choose another name: COUNTER SALE is the walk-in customer.');
  const existing = Number(id) > 0 ? await currentDoc(storePk, 'customers', id) : null;
  if (!existing && !name) throw new AppError(400, 'Enter the party name.');
  let made;
  await save(storePk, user, async (client, device, { nextId }) => {
    if (name) {
      const { rows } = await client.query(
        `SELECT local_id FROM customers WHERE store_pk=$1 AND NOT deleted AND UPPER(BTRIM(name))=$2 AND local_id <> $3 LIMIT 1`,
        [storePk, name, Number(id) || 0],
      );
      if (rows[0]) throw new AppError(409, `There is already a party named ${name}.`);
    }
    const cid = existing ? Number(id) : await nextId('customers');
    const doc = existing ? { ...existing } : { total_due: 0, total_credit: 0, created_at: new Date().toISOString() };
    delete doc._pk;
    Object.assign(doc, { id: cid, local_id: cid });
    if (name) doc.name = name;
    if (body.phone !== undefined) doc.phone = cleanText(body.phone, 20) || null;
    if (body.address !== undefined) doc.address = cleanText(body.address, 160) || null;
    for (const k of ['party_type', 'dl_numbers', 'state_code', 'rate_tier', 'credit_limit', 'credit_days']) {
      if (k in party) doc[k] = party[k];
    }
    const events = [{ op: 'upsert', collection: 'customers', doc, base_version: Number(existing?.version || 0) }];
    if ('gstin' in party) {
      const cur = (await customerGst(storePk, [cid])).get(cid);
      if (W.cleanGstin(cur?.gstin) !== party.gstin || (body.legal_name !== undefined && String(cur?.legal_name || '') !== cleanText(body.legal_name, 120).toUpperCase())) {
        const value = party.gstin ? JSON.stringify({
          gstin: party.gstin,
          legal_name: cleanText(body.legal_name ?? cur?.legal_name, 120).toUpperCase(),
          state: W.stateOf(party.gstin),
          since: W.cleanGstin(cur?.gstin) === party.gstin && cur?.since ? cur.since : todayIst(),
          updated: istStamp(),
        }) : '';
        events.push({ op: 'upsert', collection: 'settings', doc: { settings: [{ name: `customer_gst:${cid}`, value }] } });
      }
    }
    made = { id: cid, name: doc.name };
    return events;
  }, () => ({ action: existing ? 'party.edit' : 'party.create', collection: 'customers', localId: made.id, refNo: made.name,
    detail: { ...party } }));
  return getParty(storePk, made.id);
}

// ─── medicines and lines ──────────────────────────────────────────────────────

const MED_RATES = `(extra_fields->>'purchase_rate')::float AS purchase_rate, (extra_fields->>'rate_a')::float AS rate_a,
  (extra_fields->>'rate_b')::float AS rate_b, (extra_fields->>'rate_c')::float AS rate_c`;

/** Batches a wholesale bill can sell today, with their Rate A / B / C and stock in packs. */
export async function searchMedicines(storePk, q, tier = 'A') {
  const term = cleanText(q, 60);
  if (!term) return [];
  const { rows } = await query(
    `SELECT local_id AS id, name, type, unit, batch_no, expiry_date, stock_qty, mrp, rate, gst_percent, hsn_code,
            manufacturer, schedule, ${MED_RATES}
       FROM medicines
      WHERE store_pk=$1 AND NOT deleted AND NOT is_hidden AND COALESCE(stock_qty,0) > 0
        AND (expiry_date IS NULL OR ${expiryCutoffSql('expiry_date')} >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
        AND name ILIKE $2
      ORDER BY (name ILIKE $3) DESC, name, expiry_date NULLS LAST, local_id LIMIT 30`,
    [storePk, `%${term}%`, `${term}%`],
  );
  return rows.map((m) => {
    const ups = W.unitsPerPack(m.type, m.unit);
    const [rate, used] = W.tierRate(m, tier);
    return { ...m, units_per_pack: ups, stock_packs: r2(Number(m.stock_qty || 0) / ups), tier_rate: rate, tier_used: used };
  });
}

/** A new invoice line for a picked batch: the party's tier rate, HSN, GST %, stock (core build_line). */
export async function buildLine(storePk, body) {
  const meds = await medicinesById({ query: (t, p) => query(t, p) }, storePk, [body.medicine_id]);
  const m = meds.get(Number(body.medicine_id));
  if (!m || m.deleted) throw new AppError(404, 'Medicine not found.');
  const med = { ...m, ...(m.extra_fields || {}) };
  const ups = W.unitsPerPack(med.type, med.unit);
  const want = String(body.rate_tier || 'A').trim().toUpperCase();
  const [rate, used] = W.tierRate(med, want);
  const line = {
    id: Number(m.local_id), medicine_id: Number(m.local_id), name: String(m.name || ''), batch: String(m.batch_no || ''),
    expiry: String(m.expiry_date || ''), hsn_code: String(m.hsn_code || ''), type: String(m.type || ''),
    unit: String(m.unit || '1'), units_per_pack: ups, stock_packs: r2(Number(m.stock_qty || 0) / ups),
    qty: Math.max(1, W.pyInt(body.qty || 1)), free: Math.max(0, W.pyInt(body.free)), rate, rate_tier: used,
    tier_rates: Object.fromEntries(W.RATE_TIERS.map((t) => [t, pyRound(W.num(med[`rate_${t.toLowerCase()}`]), 4)])),
    base_rate: pyRound(W.num(m.rate), 4), disc_pct: r2(W.num(body.disc_pct)), scheme_pct: r2(W.num(body.scheme_pct)),
    gst_percent: r2(W.num(m.gst_percent)), mrp: r2(W.num(m.mrp)),
  };
  if (rate <= 0) {
    line.warning = `${line.name}: no Rate A for this batch. Rate A is required -- set it in Purchase (Rate A / B / C) or type the rate here.`;
    line.rate_missing = true;
  } else if (used && used !== want) {
    line.warning = `${line.name}: no Rate ${want} for this batch -- Rate ${used} used.`;
  }
  return line;
}

// ─── the invoice ──────────────────────────────────────────────────────────────

function invoiceFor(body, p, shop) {
  const buyerGstin = W.cleanGstin(body.buyer_gstin || p.gstin || '');
  const pos = W.placeOfSupply(buyerGstin, p.state_code, shop.state);
  const lines = (Array.isArray(body.items) ? body.items : []).filter((it) => it && typeof it === 'object');
  const inv = W.calcInvoice(lines, { shopState: shop.state, pos });
  return { ...inv, buyer_gstin: buyerGstin };
}

function paidOf(body) {
  if (String(body.payment_mode || 'Due').trim().toLowerCase() === 'due') return 0;
  return W.num(body.cash_paid) + W.num(body.online_paid);
}

/** The live totals of the wholesale screen, with the place of supply and the credit check. */
export async function calcSale(storePk, body) {
  const p = (await getParty(storePk, body.customer_id)) || { state_code: '', gstin: '', credit_limit: 0, total_due: 0, credit_days: 0 };
  const shop = await shopProfile(storePk);
  const inv = invoiceFor(body, p, shop);
  const paid = paidOf(body);
  let thisDue = 0;
  let billDate = todayIst();
  if (Number(body.sale_id) > 0) {
    const old = await currentDoc(storePk, 'sales', body.sale_id);
    thisDue = W.num(old.due_amount);
    billDate = String(old.bill_date).slice(0, 10);
  }
  const used = W.returnsUsedInCalc(inv.grand_total, paid, body);
  const warn = W.creditWarning(p.id ? p : null, inv.grand_total, paid + used, { thisBillDue: thisDue });
  return {
    ...inv, ok: true, returns_total: used, net_total: r2(inv.grand_total - used),
    due_date: W.dueDateFor(billDate, p.credit_days), warnings: warn ? [warn] : [],
  };
}

/** The screen's lines checked and priced; the bill's sales_items in the PC's shape. */
function invoiceLines(body, meds, billDate, oldUnits) {
  const items = (Array.isArray(body.items) ? body.items : []).filter((it) => it && typeof it === 'object');
  if (!items.length) throw new AppError(400, 'Please add medicines to the bill.');
  if (items.length > 200) throw new AppError(400, 'A bill can have at most 200 lines.');
  return items.map((it, i) => {
    const mid = Number(it.medicine_id ?? it.id);
    const m = meds.get(mid);
    if (!m || m.deleted) throw new AppError(400, `Line ${i + 1}: medicine ${it.name || mid} not found.`);
    if (W.pyInt(it.qty) <= 0) throw new AppError(400, `${m.name}: quantity must be at least one pack.`);
    if (!(W.num(it.rate) > 0)) throw new AppError(400, `${m.name}: no rate. Rate A is required -- type the rate.`, { code: 'bad_rate' });
    if (m.is_hidden && !oldUnits.has(mid)) throw new AppError(400, `${m.name} is hidden in Inventory.`);
    if (isExpiredOn(m.expiry_date, billDate) && !oldUnits.has(mid)) {
      throw new AppError(400, `${m.name} expired on ${String(m.expiry_date).slice(0, 7)}. It cannot be sold.`);
    }
    const tier = String(it.rate_tier || '').trim().toUpperCase().slice(0, 1);
    return {
      ...it, id: mid, medicine_id: mid,
      hsn_code: String(it.hsn_code || m.hsn_code || ''),
      gst_percent: it.gst_percent === undefined || it.gst_percent === null || it.gst_percent === '' ? W.num(m.gst_percent) : it.gst_percent,
      rate_tier: W.RATE_TIERS.includes(tier) ? tier : '',
      _med: m,
    };
  });
}

function saleItems(inv) {
  return inv.lines.map((line) => {
    const m = line._med;
    const ups = W.unitsPerPack(m.type, m.unit);
    const units = (line.qty + line.free) * ups;
    return {
      medicine_id: line.id,
      name: m.name,
      type: m.type || '',
      batch_no: m.batch_no || '',
      expiry_date: m.expiry_date || '',
      hsn_code: line.hsn_code,
      schedule: m.schedule || '',
      manufacturer: m.manufacturer || '',
      gst_percent: line.gst_percent,
      qty: units,
      rate: units ? pyRound(line.amount / units, 4) : 0,
      amount: line.amount,
      item_discount: r2(line.disc_amt + line.scheme_amt),
      cost_price: saleCostPrice(m),
      // the tax-invoice line (core/wholesale_sale.LINE_FIELDS)
      rate_tier: line.rate_tier || null,
      free_qty: line.free,
      scheme_pct: line.scheme_pct,
      taxable: line.taxable,
      gst_amt: line.gst_amt,
    };
  });
}

function unitsByMedicine(inv) {
  const need = new Map();
  for (const line of inv.lines) {
    const ups = W.unitsPerPack(line._med.type, line._med.unit);
    need.set(line.id, (need.get(line.id) || 0) + (line.qty + line.free) * ups);
  }
  return need;
}

function checkStock(need, meds, held) {
  for (const [mid, q] of need) {
    const m = meds.get(mid);
    const have = Number(m.stock_qty || 0) + (held.get(mid) || 0);
    if (q > have + 1e-6) {
      const ups = W.unitsPerPack(m.type, m.unit);
      throw new AppError(409, `${m.name} (${m.batch_no || ''}): only ${pyRound(have / ups, 2)} pack(s) in stock.`, { code: 'insufficient_stock' });
    }
  }
}

function header(inv, body, p, billDate) {
  return {
    invoice_mode: W.WHOLESALE,
    buyer_gstin: inv.buyer_gstin || null,
    buyer_dl: cleanText(body.buyer_dl || p.dl_numbers, 200) || null,
    place_of_supply: inv.place_of_supply || null,
    taxable_total: inv.taxable_total,
    cgst_total: inv.cgst_total,
    sgst_total: inv.sgst_total,
    igst_total: inv.igst_total,
    due_date: W.dueDateFor(billDate, p.credit_days),
    transport: cleanText(body.transport, 80) || null,
    lr_no: cleanText(body.lr_no, 40) || null,
    eway_bill_no: cleanText(body.eway_bill_no, 40) || null,
  };
}

/** The phone / address typed on the bill go onto the party; an empty box never wipes one. */
function contactEvent(p, doc, body) {
  const phone = cleanText(body.customer_phone, 20);
  const address = cleanText(body.customer_address, 160);
  const ph = phone && phone !== String(p.phone || '').trim() ? phone : '';
  const ad = address && address !== String(p.address || '').trim() ? address : '';
  if (!ph && !ad) return null;
  const next = { ...doc };
  delete next._pk;
  if (ph) next.phone = ph;
  if (ad) next.address = ad;
  return { op: 'upsert', collection: 'customers', doc: next, base_version: Number(doc.version || 0) };
}

async function partyFor(client, storePk, id) {
  const p = await getParty(storePk, id, client);
  if (!p || COUNTER_SALE_NAMES.includes(String(p.name || '').trim().toUpperCase())) {
    throw new AppError(400, 'Pick the party (a customer) for a wholesale bill.', { code: 'party_required' });
  }
  return p;
}

function payFigures(body, grand) {
  const mode = String(body.payment_mode || 'Due').trim().toLowerCase();
  const isDue = mode === 'due';
  let cash = isDue ? 0 : r2(W.num(body.cash_paid));
  const online = isDue ? 0 : r2(W.num(body.online_paid));
  let payFull = false;
  if (!isDue && cash + online <= 0) {
    if (!body.pay_full) throw new AppError(400, 'Cash or Online amount must be greater than zero (or choose Due).', { code: 'payment_required' });
    cash = grand;
    payFull = true;
  }
  return { cash, online, payFull };
}

/** Save a new wholesale tax invoice. */
export async function createSale(storePk, user, body) {
  const billDate = todayIst();
  let made;
  await save(storePk, user, async (client, device, { nextId }) => {
    const p = await partyFor(client, storePk, body.customer_id);
    const shop = await shopProfile(storePk);
    const meds = await medicinesById(client, storePk, (body.items || []).map((i) => i?.medicine_id ?? i?.id));
    const lines = invoiceLines(body, meds, billDate, new Map());
    const inv = invoiceFor({ ...body, items: lines }, p, shop);
    const need = unitsByMedicine(inv);
    checkStock(need, meds, new Map());
    const grand = inv.grand_total;
    let { cash, online, payFull } = payFigures(body, grand);
    const prevDue = r2(p.total_due);
    const prevCredit = r2(p.total_credit);
    const num = await allocateFySerialInTx(client, storePk, 'sales', billDate);
    const id = await nextId('sales');
    // The returns ticked on the screen pay what the payment does not (Return rows on the bill).
    const rets = await returnsForBill(storePk, 'customer', p.id, body.apply_returns, id, num.bill_no,
      r2(grand - (payFull ? 0 : cash + online)));
    if (payFull && rets.total > 0) cash = r2(Math.max(0, cash - rets.total));
    const pay = rets.total > 0
      ? paymentResult(r2(grand - rets.total), cash, online, prevDue, r2(Math.max(0, prevCredit - rets.total)))
      : paymentResult(grand, cash, online, prevDue, prevCredit);
    const cu = `web-${randomUUID()}`;
    const custDoc = await currentDoc(storePk, 'customers', p.id);
    const doc = {
      id, local_id: id, client_uuid: cu, bill_no: num.bill_no, fy_start_year: num.fy_start_year, fy_serial: num.fy_serial,
      customer_id: p.id, customer_name: p.name, customer_phone: cleanText(body.customer_phone, 20) || p.phone || '',
      customer_address: cleanText(body.customer_address, 160) || p.address || '', bill_date: billDate, doctor_name: '',
      total_amount: grand, discount: 0, discount_pct: 0, rounding: inv.round_off,
      amount_paid: pay.amount_paid, cash_paid: cash, online_paid: online,
      previous_due: prevDue, previous_credit: prevCredit, due_amount: pay.due_amount, credit_amount: pay.credit_amount,
      total_due: pay.total_due, bill_cleared: pay.due_amount === 0, account_cleared: false,
      item_count: inv.lines.length, items: saleItems(inv), created_at: new Date().toISOString(), version: 1,
      ...header(inv, body, p, billDate),
    };
    const stockOps = [...need].map(([mid, q]) => ({
      op_uuid: `sale:${cu}:med:${mid}:v1`, op: 'sale', qty_delta: -q, medicine_id: mid, ref_collection: 'sales', ref_id: id,
    }));
    const events = [{ op: 'upsert', collection: 'sales', doc, stock_ops: stockOps, base_version: 0 }];
    for (const r of rets.list) {
      events.push({ op: 'upsert', collection: 'sales_returns', doc: r.doc, stock_ops: [], base_version: r.base_version });
    }
    const contact = contactEvent(p, custDoc, body);
    if (contact) events.push(contact);
    const warn = W.creditWarning(p, grand, cash + online + rets.total);
    made = { id, bill_no: num.bill_no, display_bill_no: num.display_bill_no, total_amount: grand, due_date: doc.due_date,
      returns_applied: rets.total, net_total: r2(grand - rets.total), warnings: warn ? [warn] : [] };
    return events;
  }, () => ({ action: 'sale.create', collection: 'sales', localId: made.id, refNo: made.bill_no,
    detail: { total: made.total_amount, wholesale: true } }));
  return { ...made, sale: await loadSale(storePk, made.id) };
}

/** Re-save a wholesale tax invoice (its returns stay as they were settled). */
export async function editSale(storePk, user, id, body) {
  const old = await currentDoc(storePk, 'sales', id);
  if (!isWholesaleBill(old)) throw new AppError(409, 'This is a retail bill: edit it in the retail store.', { code: 'retail_bill' });
  if (body.version != null && Number(body.version) !== Number(old.version)) {
    throw new AppError(409, 'This bill was changed on another device since you opened it. Open it again.');
  }
  const billDate = String(old.bill_date).slice(0, 10);
  const returned = await returnedUnits(storePk, id);
  let made;
  await save(storePk, user, async (client) => {
    const p = await partyFor(client, storePk, body.customer_id ?? old.customer_id);
    const shop = await shopProfile(storePk);
    const oldUnits = qtyByMedicine(old.items);
    const meds = await medicinesById(client, storePk, [...(body.items || []).map((i) => i?.medicine_id ?? i?.id), ...oldUnits.keys()]);
    const lines = invoiceLines(body, meds, billDate, oldUnits);
    const inv = invoiceFor({ ...body, items: lines }, p, shop);
    const need = unitsByMedicine(inv);
    checkStock(need, meds, oldUnits);
    for (const [mid, q] of returned) {
      if ((need.get(mid) || 0) < q - 1e-6) {
        const m = meds.get(mid);
        throw new AppError(400, `${m?.name || 'A medicine'}: ${q} unit(s) of it were already returned; the bill cannot go below that.`,
          { code: 'below_returned' });
      }
    }
    const grand = inv.grand_total;
    const { cash, online } = payFigures(body, grand);
    const same = Number(p.id) === Number(old.customer_id);
    const prevDue = same ? r2(old.previous_due) : r2(p.total_due);
    const prevCredit = same ? r2(old.previous_credit) : r2(p.total_credit);
    const pay = paymentResult(grand, cash, online, prevDue, prevCredit);
    const ver = Number(old.version || 1) + 1;
    const cu = old.client_uuid || `sale-${id}`;
    const doc = {
      ...old, id: Number(id), local_id: Number(id), customer_id: p.id, customer_name: p.name,
      customer_phone: cleanText(body.customer_phone, 20) || p.phone || '', customer_address: cleanText(body.customer_address, 160) || p.address || '',
      total_amount: grand, discount: 0, discount_pct: 0, rounding: inv.round_off, amount_paid: pay.amount_paid,
      cash_paid: cash, online_paid: online, previous_due: prevDue, previous_credit: prevCredit, due_amount: pay.due_amount,
      credit_amount: pay.credit_amount, total_due: pay.total_due, bill_cleared: pay.due_amount === 0,
      item_count: inv.lines.length, items: saleItems(inv), version: ver, ...header(inv, body, p, billDate),
    };
    delete doc._pk;
    const stockOps = [];
    for (const mid of new Set([...need.keys(), ...oldUnits.keys()])) {
      const delta = (oldUnits.get(mid) || 0) - (need.get(mid) || 0);
      if (!delta) continue;
      stockOps.push({ op_uuid: `sale:${cu}:med:${mid}:edit:v${ver}`, op: 'sale_edit', qty_delta: delta, medicine_id: mid,
        ref_collection: 'sales', ref_id: Number(id) });
    }
    made = { id: Number(id), bill_no: old.bill_no, total_amount: grand, before: old.total_amount, due_date: doc.due_date,
      warnings: [W.creditWarning(p, grand, cash + online, { thisBillDue: W.num(old.due_amount) })].filter(Boolean) };
    return [{ op: 'upsert', collection: 'sales', doc, stock_ops: stockOps, base_version: Number(old.version || 0) }];
  }, () => ({ action: 'sale.edit', collection: 'sales', localId: made.id, refNo: made.bill_no,
    detail: { total_before: made.before, total_after: made.total_amount, wholesale: true } }));
  return { ...made, sale: await loadSale(storePk, made.id) };
}

async function returnedUnits(storePk, saleId) {
  const { rows } = await query(
    `SELECT sri.medicine_id, SUM(sri.qty)::float AS q
       FROM sales_returns sr JOIN sales_return_items sri ON sri.return_id=sr.id
      WHERE sr.store_pk=$1 AND sr.sale_id=$2 AND NOT sr.deleted GROUP BY sri.medicine_id`,
    [storePk, Number(saleId)],
  );
  return new Map(rows.map((r) => [Number(r.medicine_id), Number(r.q)]));
}

/** Returns with their medicines in packs (strips), for the screen and the invoice. */
async function inPacks(storePk, rets) {
  const ids = [...new Set(rets.flatMap((r) => (r.items || []).map((it) => Number(it.medicine_id)).filter((v) => v > 0)))];
  const meds = ids.length ? await medicinesById({ query: (t, p) => query(t, p) }, storePk, ids) : new Map();
  return W.returnsInPacks(rets, (it) => {
    const m = meds.get(Number(it.medicine_id));
    return m ? W.unitsPerPack(m.type, m.unit) : 1;
  });
}

/** The party's returns whose credit is not used yet, qty in packs (the screen's popup). */
export async function openReturnsInPacks(storePk, customerId) {
  return inPacks(storePk, await openReturns(storePk, 'customer', customerId));
}

/** A saved wholesale invoice: header, party and lines as the screen edits them (packs, free,
 *  pack rate, disc %), and the figures as stored. */
export async function loadSale(storePk, id) {
  const s = await saleDetail(storePk, id);
  if (s.deleted) throw new AppError(404, 'Bill not found.');
  if (!isWholesaleBill(s)) throw new AppError(409, 'This is a retail bill: open it in the retail store.', { code: 'retail_bill' });
  const meds = await medicinesById({ query: (t, p) => query(t, p) }, storePk, (s.items || []).map((it) => it.medicine_id));
  const items = (s.items || []).map((r) => {
    const m = meds.get(Number(r.medicine_id)) || {};
    const ups = W.unitsPerPack(m.type ?? r.type, m.unit);
    return {
      id: Number(r.medicine_id), medicine_id: Number(r.medicine_id), name: String(m.name || r.name || ''),
      batch: String(r.batch_no || m.batch_no || ''), expiry: String(r.expiry_date || m.expiry_date || ''),
      hsn_code: String(r.hsn_code || m.hsn_code || ''), type: String(m.type || r.type || ''), unit: String(m.unit || '1'),
      units_per_pack: ups, stock_packs: r2(Number(m.stock_qty || 0) / ups), rate_tier: String(r.rate_tier || ''),
      gst_percent: W.num(r.gst_percent), mrp: W.num(m.mrp), taxable: W.num(r.taxable), gst_amt: W.num(r.gst_amt),
      amount: W.num(r.amount), item_discount: W.num(r.item_discount), manufacturer: String(r.manufacturer || m.manufacturer || ''),
      ...W.lineFromRow(r, ups),
    };
  });
  const party = (await getParty(storePk, s.customer_id)) || { id: Number(s.customer_id) || 0, name: s.customer_name || '' };
  return {
    ok: true, sale_id: Number(s.id), id: Number(s.id), version: s.version, bill_no: displaySalesBillNo(s.bill_no),
    full_bill_no: s.bill_no, bill_date: String(s.bill_date || '').slice(0, 10), party, customer_id: Number(s.customer_id || 0),
    customer_name: s.customer_name, buyer_gstin: String(s.buyer_gstin || ''), buyer_dl: String(s.buyer_dl || ''),
    place_of_supply: String(s.place_of_supply || ''), due_date: String(s.due_date || ''), transport: String(s.transport || ''),
    lr_no: String(s.lr_no || ''), eway_bill_no: String(s.eway_bill_no || ''), taxable_total: W.num(s.taxable_total),
    cgst_total: W.num(s.cgst_total), sgst_total: W.num(s.sgst_total), igst_total: W.num(s.igst_total),
    rounding: W.num(s.rounding), total_amount: W.num(s.total_amount), cash_paid: W.num(s.cash_paid),
    online_paid: W.num(s.online_paid), amount_paid: W.num(s.amount_paid), due_amount: W.num(s.due_amount),
    total_due: W.num(s.total_due), previous_due: W.num(s.previous_due), previous_credit: W.num(s.previous_credit),
    discount: W.num(s.discount), made_by: s.made_by || null, web_history: s.web_history || [],
    items, returns_in_bill: await inPacks(storePk, s.returns_in_bill || []),
  };
}

/** Payments that cleared this bill and carry a receipt number (the invoice's "Paid ... (Rcpt ..)"). */
async function billReceipts(storePk, saleId, customerId) {
  if (!(customerId > 0)) return [];
  const res = await partyBillClearing({ query }, storePk, 'customer', customerId);
  const byPay = new Map();
  for (const a of res.applied) {
    if (a.credit_kind === 'payment' && Number(a.bill_id) === Number(saleId)) {
      byPay.set(Number(a.credit_id), r2((byPay.get(Number(a.credit_id)) || 0) + a.amount));
    }
  }
  if (!byPay.size) return [];
  const { rows } = await query(
    `SELECT local_id, extra_fields->>'receipt_no' AS receipt_no, payment_date FROM customer_payments
      WHERE store_pk=$1 AND local_id = ANY($2::bigint[])`, [storePk, [...byPay.keys()]],
  );
  const no = new Map(rows.map((r) => [Number(r.local_id), r]));
  return [...byPay.entries()].sort((a, b) => a[0] - b[0])
    .filter(([pid, amt]) => String(no.get(pid)?.receipt_no || '').trim() && amt > 0)
    .map(([pid, amt]) => ({ receipt_no: String(no.get(pid).receipt_no).trim(), amount: amt,
      date: String(no.get(pid).payment_date || '').slice(0, 10) }));
}

/** Everything the tax invoice prints, from the saved bill (core/wholesale_sale.invoice_context). */
export async function invoiceContext(storePk, id, { signatureLook } = {}) {
  const sale = await loadSale(storePk, id);
  const shop = await shopProfile(storePk);
  const pos = sale.place_of_supply || sale.party.state_code || shop.state;
  const intra = W.isIntraState(pos, shop.state);
  const lines = sale.items.map((it) => {
    const [cgst, sgst] = intra ? W.splitTax(it.gst_amt) : [0, 0];
    const off = r2(it.item_discount);
    return {
      ...it, cgst, sgst, igst: intra ? 0 : r2(it.gst_amt), mfg: it.manufacturer,
      pack: W.packText(it.unit, it.units_per_pack), gross: r2(r2(it.taxable) + off), line_discount: off,
    };
  });
  const sub = r2(lines.reduce((s, l) => s + l.gross, 0));
  const disc = r2(lines.reduce((s, l) => s + l.line_discount, 0));
  const rets = sale.returns_in_bill || [];
  const returnsTotal = r2(rets.reduce((s, r) => s + W.num(r.amount), 0));
  const total = r2(sale.total_amount);
  const partyTotal = r2(total - returnsTotal);
  const paid = r2(sale.amount_paid);
  const ledger = r2(r2(sale.previous_due) - r2(sale.previous_credit) + partyTotal - paid);
  const party = sale.party || {};
  const buyerState = party.state_code || W.stateFromGstin(sale.buyer_gstin);
  const signature = shop.signature.startsWith('data:image/') ? shop.signature : '';
  const ctx = {
    ...sale,
    shop,
    buyer: {
      name: party.legal_name || party.name || sale.customer_name || '', address: party.address || '', phone: party.phone || '',
      gstin: sale.buyer_gstin, dl_numbers: sale.buyer_dl, state_code: buyerState, state_name: W.stateName(buyerState),
    },
    intra_state: intra,
    place_of_supply: pos,
    place_of_supply_name: W.stateName(pos),
    lines,
    returns: billReturnRows(rets),
    returns_total: returnsTotal,
    sub_total: sub,
    line_discount: disc,
    bill_discount: r2(sale.discount),
    grand_total: total,
    round_off: sale.rounding,
    amount_in_words: W.amountInWords(total),
    party_total: partyTotal,
    party_total_words: W.amountInWords(partyTotal),
    amount_paid: paid,
    receipts: await billReceipts(storePk, sale.sale_id, sale.customer_id),
    ledger_balance: ledger,
    pay_label: paid + returnsTotal >= total - 0.01 ? 'CASH' : 'CREDIT',
    total_items: lines.length,
    total_qty: lines.reduce((s, l) => s + (Number(l.qty) || 0), 0),
    declaration: W.declarationText(shop.declaration, shop.address),
    signature_src: signature,
    bill_of_supply: shop.bill_of_supply,
    supply_declaration: shop.supply_declaration,
  };
  if (signatureLook) ctx.signature_look = signatureLook;
  return ctx;
}

/** The printed invoice: A5 landscape, or two to an A4 portrait sheet (paper "A4"). */
export async function invoiceHtml(storePk, id, { paper = 'A4', copyLabel = '' } = {}) {
  const ctx = await invoiceContext(storePk, id);
  return { bill_no: ctx.bill_no, paper: String(paper).toUpperCase() === 'A5' ? 'A5' : 'A4',
    html: renderWholesaleInvoiceHtml(ctx, { paper, copyLabel: cleanText(copyLabel, 30) }) };
}

// ─── reports (core/wholesale_reports.py) ─────────────────────────────────────

const BUCKETS = ['Not Due', 'Due 0-30', 'Due 31-60', 'Due 61-90', 'Due 90+'];

function bucket(days) {
  if (days <= 0) return BUCKETS[0];
  if (days <= 30) return BUCKETS[1];
  if (days <= 60) return BUCKETS[2];
  if (days <= 90) return BUCKETS[3];
  return BUCKETS[4];
}
const dmy = (iso) => {
  const s = String(iso || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}` : s;
};
const dayNo = (iso) => Math.floor(Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) / 86400000);
const qtyOut = (v) => (Number.isInteger(v) ? v : Math.round(v * 1000) / 1000);
function section(title, columns, rows, totalRow = null) {
  return { title, columns, rows, total_row: rows.length ? totalRow : null };
}
function range(from, to) {
  const f = String(from || `${todayIst().slice(0, 8)}01`).slice(0, 10);
  const t = String(to || todayIst()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t) || f > t) throw new AppError(400, 'Pick a From date on or before the To date.');
  return [f, t];
}

/** Wholesale invoices dated from..to, each with its GST heads and its lines. */
async function invoices(storePk, from, to, partyId = 0) {
  const params = [storePk, from, to];
  let extra = '';
  if (partyId > 0) { params.push(partyId); extra = ` AND s.customer_id = $${params.length}`; }
  const { rows } = await query(
    `SELECT s.id AS pk, s.local_id AS id, s.bill_no, s.bill_date::text AS bill_date, COALESCE(s.customer_id,0) AS customer_id,
            COALESCE(NULLIF(BTRIM(c.name),''), s.customer_name, '') AS party, COALESCE(s.extra_fields->>'buyer_gstin','') AS gstin,
            COALESCE(s.extra_fields->>'place_of_supply','') AS pos, (s.extra_fields->>'taxable_total')::float AS taxable,
            (s.extra_fields->>'cgst_total')::float AS cgst, (s.extra_fields->>'sgst_total')::float AS sgst,
            (s.extra_fields->>'igst_total')::float AS igst, COALESCE(s.total_amount,0)::float AS total,
            COALESCE(s.amount_paid,0)::float AS paid, COALESCE(s.extra_fields->>'due_date','') AS due_date
       FROM sales s LEFT JOIN customers c ON c.store_pk=s.store_pk AND c.local_id=s.customer_id
      WHERE s.store_pk=$1 AND NOT s.deleted AND NOT COALESCE(s.is_autosave,false)
        AND s.extra_fields->>'invoice_mode' = 'wholesale' AND s.bill_date BETWEEN $2 AND $3${extra}
      ORDER BY s.bill_date, s.local_id`,
    params,
  );
  const pks = rows.map((r) => Number(r.pk));
  const { rows: li } = pks.length ? await query(
    `SELECT si.sale_id, COALESCE(si.medicine_id,0) AS medicine_id, COALESCE(m.name, si.name, '') AS name,
            COALESCE(NULLIF(si.batch_no,''), m.batch_no, '') AS batch, COALESCE(NULLIF(si.hsn_code,''), m.hsn_code, '') AS hsn,
            COALESCE(si.qty,0)::float AS qty, COALESCE((si.extra_fields->>'free_qty')::float,0) AS free_qty,
            (si.extra_fields->>'taxable')::float AS taxable, (si.extra_fields->>'gst_amt')::float AS gst_amt,
            COALESCE(si.amount,0)::float AS amount, COALESCE(si.gst_percent, m.gst_percent, 0)::float AS gst_pct,
            COALESCE(m.type, si.type) AS type, m.unit
       FROM sales_items si LEFT JOIN medicines m ON m.store_pk=si.store_pk AND m.local_id=si.medicine_id
      WHERE si.sale_id = ANY($1::bigint[]) ORDER BY si.sale_id, si.id`,
    [pks],
  ) : { rows: [] };
  const lines = new Map();
  for (const r of li) {
    let taxable; let gst;
    if (r.taxable !== null) {
      taxable = r2(r.taxable);
      gst = r.gst_amt !== null ? r2(r.gst_amt) : r2(taxable * r.gst_pct / 100);
    } else {
      const amount = r2(r.amount);
      taxable = r.gst_pct > 0 ? r2(amount * 100 / (100 + r.gst_pct)) : amount;
      gst = r2(amount - taxable);
    }
    let q = r.qty;
    if (r.taxable !== null) q = Math.max(0, Math.round((r.qty / Math.max(1, W.unitsPerPack(r.type, r.unit)) - r.free_qty) * 1000) / 1000);
    const list = lines.get(Number(r.sale_id)) || [];
    list.push({ medicine_id: Number(r.medicine_id), name: r.name, batch: r.batch, hsn: r.hsn, qty: q, free_qty: r.free_qty,
      taxable, gst, amount: r2(taxable + gst) });
    lines.set(Number(r.sale_id), list);
  }
  const gstOf = await customerGst(storePk, rows.map((r) => r.customer_id));
  const shop = await shopProfile(storePk);
  return rows.map((r) => {
    const ls = lines.get(Number(r.pk)) || [];
    let gstin = String(r.gstin || '').trim().toUpperCase();
    if (!gstin) gstin = gstinForBill(gstOf.get(Number(r.customer_id)), r.bill_date);
    let { taxable, cgst, sgst, igst } = r;
    if (taxable === null) {
      taxable = r2(ls.reduce((s, l) => s + l.taxable, 0));
      const tax = r2(ls.reduce((s, l) => s + l.gst, 0));
      const st = String(r.pos || '').trim().slice(0, 2) || (gstin ? gstin.slice(0, 2) : '');
      if (st && shop.state && st !== shop.state) { igst = tax; cgst = 0; sgst = 0; } else { [cgst, sgst] = W.splitTax(tax); igst = 0; }
    }
    return { id: Number(r.id), bill_no: displaySalesBillNo(r.bill_no), date: String(r.bill_date).slice(0, 10),
      customer_id: Number(r.customer_id), party: r.party, gstin, taxable: r2(taxable), cgst: r2(cgst), sgst: r2(sgst),
      igst: r2(igst), total: r2(r.total), paid_at_counter: r2(r.paid), due_date: String(r.due_date || '').slice(0, 10), lines: ls };
  });
}

/** sale id -> what is still owed on it, by the dues rule. */
async function stillOwed(storePk, invs) {
  const left = new Map();
  for (const pid of [...new Set(invs.map((i) => i.customer_id).filter((v) => v > 0))]) {
    const res = await partyBillClearing({ query }, storePk, 'customer', pid);
    for (const b of res.remaining) left.set(Number(b.id), r2(b.remaining));
  }
  for (const inv of invs) if (!left.has(inv.id)) left.set(inv.id, r2(Math.max(0, inv.total - inv.paid_at_counter)));
  return left;
}

export async function salesRegister(storePk, { from, to, party_id } = {}) {
  const [f, t] = range(from, to);
  const invs = await invoices(storePk, f, t, Number(party_id) || 0);
  const left = await stillOwed(storePk, invs);
  const tot = { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0, paid: 0, balance: 0 };
  const rows = invs.map((inv) => {
    const bal = left.get(inv.id) ?? 0;
    const paid = r2(inv.total - bal);
    for (const [k, v] of [['taxable', inv.taxable], ['cgst', inv.cgst], ['sgst', inv.sgst], ['igst', inv.igst],
      ['total', inv.total], ['paid', paid], ['balance', bal]]) tot[k] = r2(tot[k] + v);
    return [inv.bill_no, dmy(inv.date), inv.party, inv.gstin, inv.taxable, inv.cgst, inv.sgst, inv.igst, inv.total,
      inv.due_date ? dmy(inv.due_date) : '', paid, bal, inv.id];
  });
  const cols = ['Invoice No', 'Date', 'Party', 'GSTIN', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total', 'Due Date', 'Paid', 'Balance'];
  return { report: 'register', title: 'Wholesale sales register', subtitle: `${dmy(f)} to ${dmy(t)}`, count: invs.length, totals: tot,
    sections: [section('Wholesale sales register', cols, rows.map((r) => r.slice(0, 12)),
      ['TOTAL', `${invs.length} invoices`, '', '', tot.taxable, tot.cgst, tot.sgst, tot.igst, tot.total, '', tot.paid, tot.balance])],
    sale_ids: rows.map((r) => r[12]) };
}

export async function partySales(storePk, { from, to } = {}) {
  const [f, t] = range(from, to);
  const invs = await invoices(storePk, f, t);
  const by = new Map();
  for (const inv of invs) {
    const key = inv.customer_id || inv.party.toUpperCase();
    const p = by.get(key) || { party: inv.party, gstin: inv.gstin, n: 0, qty: 0, free: 0, taxable: 0, gst: 0, amount: 0, total: 0 };
    p.gstin = p.gstin || inv.gstin;
    p.n += 1; p.total = r2(p.total + inv.total);
    for (const l of inv.lines) {
      p.qty += l.qty; p.free += l.free_qty; p.taxable = r2(p.taxable + l.taxable); p.gst = r2(p.gst + l.gst); p.amount = r2(p.amount + l.amount);
    }
    by.set(key, p);
  }
  const t2 = { n: 0, qty: 0, free: 0, taxable: 0, gst: 0, amount: 0, total: 0 };
  const rows = [...by.values()].sort((a, b) => b.total - a.total || a.party.toUpperCase().localeCompare(b.party.toUpperCase()))
    .map((p) => {
      for (const k of Object.keys(t2)) t2[k] = ['n', 'qty', 'free'].includes(k) ? t2[k] + p[k] : r2(t2[k] + p[k]);
      return [p.party, p.gstin, p.n, qtyOut(p.qty), qtyOut(p.free), p.taxable, p.gst, p.amount, p.total];
    });
  return { report: 'party', title: 'Party-wise sales', subtitle: `${dmy(f)} to ${dmy(t)}`, count: by.size,
    sections: [section('Party-wise sales', ['Party', 'GSTIN', 'Bills', 'Qty', 'Free Qty', 'Taxable Value', 'GST', 'Amount', 'Invoice Total'],
      rows, ['TOTAL', `${by.size} parties`, t2.n, qtyOut(t2.qty), qtyOut(t2.free), t2.taxable, t2.gst, t2.amount, t2.total])] };
}

export async function itemSales(storePk, { from, to, party_id } = {}) {
  const [f, t] = range(from, to);
  const invs = await invoices(storePk, f, t, Number(party_id) || 0);
  const by = new Map();
  for (const inv of invs) {
    const pkey = inv.customer_id || inv.party.toUpperCase();
    for (const l of inv.lines) {
      const key = JSON.stringify([pkey, l.medicine_id || l.name.toUpperCase(), l.batch]);
      const it = by.get(key) || { party: inv.party, name: l.name, batch: l.batch, hsn: l.hsn, qty: 0, free: 0, taxable: 0, gst: 0, amount: 0 };
      it.qty += l.qty; it.free += l.free_qty; it.taxable = r2(it.taxable + l.taxable); it.gst = r2(it.gst + l.gst); it.amount = r2(it.amount + l.amount);
      by.set(key, it);
    }
  }
  const t2 = { qty: 0, free: 0, taxable: 0, gst: 0, amount: 0 };
  const rows = [...by.values()]
    .sort((a, b) => a.party.toUpperCase().localeCompare(b.party.toUpperCase()) || a.name.toUpperCase().localeCompare(b.name.toUpperCase()) || a.batch.localeCompare(b.batch))
    .map((it) => {
      for (const k of Object.keys(t2)) t2[k] = ['qty', 'free'].includes(k) ? t2[k] + it[k] : r2(t2[k] + it[k]);
      return [it.party, it.name, it.batch, it.hsn, qtyOut(it.qty), qtyOut(it.free), it.taxable, it.gst, it.amount];
    });
  return { report: 'items', title: 'Item-wise sales by party', subtitle: `${dmy(f)} to ${dmy(t)}`, count: by.size,
    sections: [section('Item-wise sales by party', ['Party', 'Medicine', 'Batch', 'HSN', 'Qty', 'Free Qty', 'Taxable Value', 'GST', 'Amount'],
      rows, ['TOTAL', `${by.size} lines`, '', '', qtyOut(t2.qty), qtyOut(t2.free), t2.taxable, t2.gst, t2.amount])] };
}

/** Every party that still owes, its open bills aged from their due dates on as_of. */
export async function outstanding(storePk, { as_of, party_id } = {}) {
  const when = /^\d{4}-\d{2}-\d{2}$/.test(String(as_of || '')) ? String(as_of) : todayIst();
  const pid = Number(party_id) || 0;
  const { rows: parties } = await query(
    `SELECT local_id AS id, name, COALESCE(phone,'') AS phone, COALESCE((extra_fields->>'credit_limit')::float,0) AS credit_limit
       FROM customers WHERE store_pk=$1 AND NOT deleted AND ${pid ? 'local_id=$2' : 'COALESCE(total_due,0) > 0.009'}`,
    pid ? [storePk, pid] : [storePk],
  );
  const { rows: dues } = await query(
    `SELECT local_id, extra_fields->>'due_date' AS due_date FROM sales
      WHERE store_pk=$1 AND NOT deleted AND COALESCE(extra_fields->>'due_date','') <> ''`, [storePk],
  );
  const dueOf = new Map(dues.map((r) => [Number(r.local_id), String(r.due_date).slice(0, 10)]));
  const gstOf = await customerGst(storePk, parties.map((p) => p.id));
  const { rows: invG } = await query(
    `SELECT customer_id, extra_fields->>'buyer_gstin' AS g FROM sales
      WHERE store_pk=$1 AND NOT deleted AND COALESCE(extra_fields->>'buyer_gstin','') <> '' AND COALESCE(customer_id,0) > 0
      ORDER BY bill_date, local_id`, [storePk],
  );
  const invoiceGstin = new Map(invG.map((r) => [Number(r.customer_id), String(r.g).trim().toUpperCase()]));
  const summary = [];
  const detail = [];
  const tot = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  let totBal = 0; let nBills = 0;
  for (const p of parties) {
    const res = await partyBillClearing({ query }, storePk, 'customer', Number(p.id));
    const rem = new Map(res.remaining.map((b) => [Number(b.id), r2(b.remaining)]));
    const open = res.rows
      .map((b) => ({ b, owed: rem.get(Number(b.local_id)) || 0 }))
      .filter((x) => x.owed > 0)
      .sort((a, c) => (String(a.b.bill_date) < String(c.b.bill_date) ? -1 : String(a.b.bill_date) > String(c.b.bill_date) ? 1 : a.b.local_id - c.b.local_id))
      .map(({ b, owed }) => {
        const bdate = String(b.bill_date).slice(0, 10);
        const due = dueOf.get(Number(b.local_id)) || bdate;
        return { b, bdate, due, owed, days: dayNo(when) - dayNo(due) };
      });
    if (!open.length) continue;
    const buckets = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    let bal = 0;
    for (const o of open) {
      const bk = bucket(o.days);
      buckets[bk] = r2(buckets[bk] + o.owed);
      bal = r2(bal + o.owed);
      detail.push([p.name, displaySalesBillNo(o.b.bill_no), dmy(o.bdate), dmy(o.due), r2(o.b.total_amount), o.owed, Math.max(o.days, 0), bk]);
    }
    const limit = r2(p.credit_limit);
    const oldest = Math.max(0, ...open.map((o) => o.days));
    summary.push({ party: p.name, gstin: gstOf.get(Number(p.id))?.gstin || invoiceGstin.get(Number(p.id)) || '', phone: p.phone,
      bills: open.length, balance: bal, buckets, oldest, limit, crossed: limit > 0 && bal > limit });
    for (const b of BUCKETS) tot[b] = r2(tot[b] + buckets[b]);
    totBal = r2(totBal + bal);
    nBills += open.length;
  }
  summary.sort((a, b) => b.oldest - a.oldest || b.balance - a.balance || a.party.toUpperCase().localeCompare(b.party.toUpperCase()));
  const rows = summary.map((s) => [s.party, s.gstin, s.phone, s.bills, s.balance, ...BUCKETS.map((b) => s.buckets[b]), s.oldest,
    s.limit > 0 ? s.limit : '', s.limit > 0 ? (s.crossed ? 'Yes' : 'No') : '']);
  const crossed = summary.filter((s) => s.crossed).length;
  detail.sort((a, b) => a[0].toUpperCase().localeCompare(b[0].toUpperCase())
    || (a[2].slice(6) + a[2].slice(3, 5) + a[2].slice(0, 2)).localeCompare(b[2].slice(6) + b[2].slice(3, 5) + b[2].slice(0, 2)));
  return {
    report: 'outstanding', title: 'Outstanding and ageing', subtitle: `as on ${dmy(when)}`, as_of: when, count: summary.length,
    totals: { balance: totBal, ...tot, bills: nBills, crossed },
    sections: [
      section('Outstanding by party', ['Party', 'GSTIN', 'Phone', 'Bills', 'Balance', ...BUCKETS, 'Days Late (oldest)', 'Limit', 'Limit Crossed'],
        rows, ['TOTAL', `${summary.length} parties`, '', nBills, totBal, ...BUCKETS.map((b) => tot[b]), '', '', `${crossed} crossed`]),
      section('Open bills', ['Party', 'Bill No', 'Bill Date', 'Due Date', 'Bill Total', 'Balance', 'Days Late', 'Bucket'],
        detail, ['TOTAL', `${nBills} bills`, '', '', '', totBal, '', '']),
    ],
  };
}

/** Every medicine batch with its rates; `tier` A / B / C gives that rate alone (a party's list). */
export async function priceList(storePk, { tier = '', in_stock = '1', search = '' } = {}) {
  const t = String(tier || '').trim().toUpperCase().slice(0, 1);
  if (t && !W.RATE_TIERS.includes(t)) throw new AppError(400, 'Tier is A, B or C.');
  const inStock = !['0', 'false', 'no'].includes(String(in_stock ?? '1').toLowerCase());
  const term = cleanText(search, 60);
  const { rows } = await query(
    `SELECT name, COALESCE(batch_no,'') AS batch, COALESCE(expiry_date::text,'') AS expiry, COALESCE(hsn_code,'') AS hsn,
            COALESCE(gst_percent,0)::float AS gst, COALESCE((extra_fields->>'purchase_rate')::float, rate)::float AS pr,
            ${MED_RATES}, COALESCE(stock_qty,0)::float AS stock, COALESCE(unit,'') AS unit, COALESCE(type,'') AS type
       FROM medicines WHERE store_pk=$1 AND NOT deleted AND NOT is_hidden ${inStock ? 'AND COALESCE(stock_qty,0) > 0' : ''}
        ${term ? 'AND UPPER(name) LIKE $2' : ''}
      ORDER BY UPPER(name), expiry_date`,
    term ? [storePk, `%${term.toUpperCase()}%`] : [storePk],
  );
  const money = (v) => (v === null || v === undefined || v === '' ? '' : r2(v));
  const gst = (v) => `${Number.isInteger(v) ? v : v}%`;
  const strips = (r) => qtyOut(r2(r.stock / Math.max(1, W.unitsPerPack(r.type, r.unit))));
  let columns; let out; let title;
  if (t) {
    columns = ['Medicine', 'Type', 'Batch', 'Expiry', 'HSN', 'GST %', `Rate ${t}`, 'Stock (strips)'];
    out = rows.map((r) => [r.name, r.type, r.batch, r.expiry, r.hsn, gst(r.gst), money(r[`rate_${t.toLowerCase()}`]), strips(r)]);
    title = `Price list - Rate ${t}`;
  } else {
    columns = ['Medicine', 'Type', 'Batch', 'Expiry', 'HSN', 'GST %', 'Purchase Rate', 'Rate A', 'Rate B', 'Rate C', 'Stock (strips)'];
    out = rows.map((r) => [r.name, r.type, r.batch, r.expiry, r.hsn, gst(r.gst), money(r.pr), money(r.rate_a), money(r.rate_b), money(r.rate_c), strips(r)]);
    title = 'Price list';
  }
  const missing = rows.filter((r) => !(Number(r[t ? `rate_${t.toLowerCase()}` : 'rate_a']) > 0)).length;
  return { report: 'price_list', title, subtitle: `${dmy(todayIst())} · rates exclude GST${inStock ? ' · in stock only' : ''}`,
    count: out.length, tier: t, without_rate: missing, sections: [section(title, columns, out)] };
}

export async function report(storePk, name, q = {}) {
  switch (String(name || '')) {
    case 'register': return salesRegister(storePk, q);
    case 'party': return partySales(storePk, q);
    case 'items': return itemSales(storePk, q);
    case 'outstanding': return outstanding(storePk, q);
    case 'price_list': return priceList(storePk, q);
    default: throw new AppError(400, `Unknown wholesale report: ${name || '(none)'}`);
  }
}

/** Parties for the report filter: every medical party and anyone with a wholesale bill. */
export async function reportParties(storePk) {
  const { rows } = await query(
    `SELECT c.local_id AS id, c.name FROM customers c
      WHERE c.store_pk=$1 AND NOT c.deleted AND (LOWER(COALESCE(c.extra_fields->>'party_type',''))='medical' OR EXISTS
        (SELECT 1 FROM sales s WHERE s.store_pk=c.store_pk AND s.customer_id=c.local_id AND s.extra_fields->>'invoice_mode'='wholesale'))
      ORDER BY UPPER(c.name)`, [storePk],
  );
  return rows;
}

/** Sales history rows say which bills are wholesale (the web's list reads the same table). */
export async function wholesaleIds(storePk, ids) {
  if (!ids.length) return new Set();
  const { rows } = await query(
    `SELECT local_id FROM sales WHERE store_pk=$1 AND local_id = ANY($2::bigint[]) AND extra_fields->>'invoice_mode'='wholesale'`,
    [storePk, ids],
  );
  return new Set(rows.map((r) => Number(r.local_id)));
}

export { madeBy, partyRow, fetchDocsByLocalIds, returnsInBill };
