/**
 * Doctor Margin Report BY RULES on the server (web; the phone reads the same routes) --
 * the PC's core/doctor_margin_rules_report.py over the server's books.
 *
 * The figures are doctorMarginRules.js (the PC's calculation, checked against it); which rules
 * version and which purchase lines count for a bill is doctorMarginHistory.js (the PC freezes
 * a bill's figures when it is saved; only Recalculate period works old bills out again).
 * Nothing here writes a sale, a purchase or stock. The only writes are the two shop settings:
 * the rules (doctor_margin_rules) and the Recalculate marker (doctor_margin_rules_recalc),
 * both through the normal sync save, so every PC and phone pulls them.
 */
import { query } from '../db/pool.js';
import { AppError } from '../utils/http.js';
import { displaySalesBillNo } from '../utils/fy.js';
import * as R from './doctorMarginRules.js';
import {
  HISTORY_DDL, HISTORY_TABLE, buildVersions, parseRuns, parseShopTime, pickVersion, shopNowText,
} from './doctorMarginHistory.js';
import { save, todayIst } from './webStore.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VIEWS = ['doctor', 'detail'];
const RECALC_KEEP = 200;

/** The PC's default medicine types (layout_config._DEFAULT_MED_TYPES): offered in the rules
 *  with the types the shop's medicines use. */
const DEFAULT_TYPES = [
  'Bolus', 'Bolus Pack', 'Capsule', 'Cream', 'Drops', 'Ear Drops', 'Eye Drops',
  'Feed Supplement', 'Gel', 'Granules', 'Inhaler', 'Injection', 'Injection - Vial',
  'Instrument / Medical Device', 'Liniment', 'Liquid', 'Lotion', 'Nasal Drops',
  'Others', 'Ointment', 'Powder', 'Sachet', 'Shampoo', 'Soap', 'Spray',
  'Suspension', 'Syrup', 'Tablet', 'Tablet Pack', 'Vaccine',
];

function validDate(label, v) {
  if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))
    || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw new AppError(400, `${label} date is not a date (YYYY-MM-DD).`);
  }
}

/** The PC's parse_filters. */
export function parseFilters(q = {}) {
  const today = todayIst();
  const from = String(q.from || today).trim().slice(0, 10);
  const to = String(q.to || today).trim().slice(0, 10);
  validDate('From', from);
  validDate('To', to);
  if (from > to) throw new AppError(400, 'From date is after To date.');
  let raw = q.doctors;
  if ((raw === undefined || raw === null || raw === '') && q.doctor) raw = [q.doctor];
  if (typeof raw === 'string') raw = raw.split(',');
  const doctors = [...new Set((Array.isArray(raw) ? raw : []).map(R.normName).filter(Boolean))].sort();
  const basis = String(q.rate_basis || '').trim().toLowerCase();
  const view = String(q.view || 'doctor').trim().toLowerCase();
  return {
    from, to, doctors,
    rate_basis: R.RATE_BASES.includes(basis) ? basis : '',
    view: VIEWS.includes(view) ? view : 'doctor',
  };
}

// ── the rules and their history ─────────────────────────────────────────────────────────

async function settingRows(storePk) {
  const { rows } = await query(
    `SELECT name, value, updated_at FROM store_settings WHERE store_pk=$1 AND name = ANY($2::text[])`,
    [storePk, [R.SETTING_NAME, R.RECALC_SETTING]],
  );
  return new Map(rows.map((r) => [r.name, r]));
}

let historyReady = false;
async function historyRows(storePk) {
  try {
    if (!historyReady) {
      await query(HISTORY_DDL);
      historyReady = true;
    }
    const { rows } = await query(
      `SELECT id, value, effective_at, saved_at FROM ${HISTORY_TABLE} WHERE store_pk=$1 ORDER BY id`, [storePk],
    );
    return rows;
  } catch (err) {
    console.warn('[doctor-margin] rules history not read:', err?.message || err);
    return [];
  }
}

/** {current (the setting row or null), rules (cleaned), versions, runs, recalcRaw}. */
export async function rulesState(storePk) {
  const [kv, history] = await Promise.all([settingRows(storePk), historyRows(storePk)]);
  const current = kv.get(R.SETTING_NAME) || null;
  const recalc = kv.get(R.RECALC_SETTING) || null;
  return {
    current,
    rules: R.safeRules(current?.value ?? ''),
    versions: buildVersions(history, current),
    runs: parseRuns(recalc?.value ?? ''),
    recalcRaw: recalc?.value ?? '',
  };
}

/** Doctors (the doctors list + names on bills) and medicine types, for the rules screen. */
async function doctorsAndTypes(storePk) {
  const [{ rows: docs }, { rows: billDocs }, { rows: types }] = await Promise.all([
    query(`SELECT DISTINCT UPPER(BTRIM(name)) AS name FROM doctors WHERE store_pk=$1 AND NOT deleted AND BTRIM(COALESCE(name,'')) <> ''`, [storePk]),
    query(`SELECT DISTINCT UPPER(BTRIM(doctor_name)) AS name FROM sales WHERE store_pk=$1 AND NOT deleted AND BTRIM(COALESCE(doctor_name,'')) <> ''`, [storePk]),
    query(`SELECT DISTINCT BTRIM(type) AS type FROM medicines WHERE store_pk=$1 AND NOT deleted AND BTRIM(COALESCE(type,'')) <> ''`, [storePk]),
  ]);
  const doctors = [...new Set([...docs, ...billDocs].map((r) => R.normName(r.name)))]
    .filter((d) => d && d !== R.NO_DOCTOR.toUpperCase()).sort();
  const inUse = types.map((r) => String(r.type).trim()).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
  const seen = new Set();
  const all = [];
  for (const t of [...DEFAULT_TYPES, ...inUse]) {
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      all.push(t);
    }
  }
  return { doctors, types: all };
}

export async function rulesPayload(storePk) {
  const [st, opts] = await Promise.all([rulesState(storePk), doctorsAndTypes(storePk)]);
  return {
    rules: st.rules,
    has_rules: R.hasRules(st.rules),
    doctors: opts.doctors,
    types: opts.types,
    versions: st.versions.map((v) => ({ updated: v.updated, from: Number.isFinite(v.from) ? new Date(v.from).toISOString() : null, has_rules: v.has })),
    recalculated: st.runs.slice(-20).map((r) => ({ from: r.from, to: r.to, at: new Date(r.at).toISOString(), rules_updated: r.rules_updated })),
  };
}

/** One shop setting saved the way every web save goes (a sync revision: PCs and phones pull it). */
async function saveSetting(storePk, user, name, value, auditAction) {
  await save(storePk, user, async () => [{ op: 'upsert', collection: 'settings', doc: { name, value } }],
    { action: auditAction, collection: 'settings', localId: 0, refNo: name });
}

/** Replace the rules (checked first). Returns what was kept. */
export async function saveRules(storePk, user, body = {}) {
  let rules;
  try {
    rules = R.cleanRules(body.rules ?? body);
  } catch (err) {
    if (err instanceof R.RulesError) throw new AppError(400, err.message);
    throw err;
  }
  rules.updated = shopNowText();
  await saveSetting(storePk, user, R.SETTING_NAME, JSON.stringify(rules), 'doctor_margin.rules');
  return { rules, has_rules: R.hasRules(rules) };
}

/** The owner's "Recalculate period": the bills of the period follow today's rules from now on
 *  (the same marker the PC's Recalculate writes). Then the report. */
export async function recalculate(storePk, user, q = {}) {
  const fl = parseFilters(q);
  const st = await rulesState(storePk);
  let data = {};
  try { data = st.recalcRaw ? JSON.parse(st.recalcRaw) : {}; } catch { data = {}; }
  const runs = data && typeof data === 'object' && Array.isArray(data.runs) ? data.runs.filter((r) => r && typeof r === 'object') : [];
  runs.push({ from: fl.from, to: fl.to, at: shopNowText(), rules_updated: st.rules.updated });
  await saveSetting(storePk, user, R.RECALC_SETTING, JSON.stringify({ version: R.VERSION, runs: runs.slice(-RECALC_KEEP) }),
    'doctor_margin.recalculate');
  const rep = await report(storePk, q);
  return { ...rep, sync: { ...rep.sync, recalculated: true } };
}

// ── the pick list of the rules screen ───────────────────────────────────────────────────

/** Products of a type: name, stock (sale units), pack, company, contents, batches. */
export async function ruleProducts(storePk, q = {}) {
  const type = String(q.type || '').trim();
  const find = String(q.find || '').trim();
  const where = ['m.store_pk=$1', 'NOT m.deleted', "BTRIM(COALESCE(m.name,''))<>''"];
  const args = [storePk];
  if (type) {
    args.push(R.normType(type));
    where.push(`LOWER(BTRIM(COALESCE(m.type,'')))=$${args.length}`);
  }
  if (find) {
    args.push(`%${find.toUpperCase()}%`);
    where.push(`UPPER(m.name) LIKE $${args.length}`);
  }
  const { rows } = await query(
    `SELECT m.name, COALESCE(m.type,'') AS type, COALESCE(m.batch_no,'') AS batch, COALESCE(m.stock_qty,0)::float AS stock,
            COALESCE(m.unit,'') AS unit, COALESCE(m.manufacturer,'') AS company, COALESCE(m.content_drug,'') AS contents,
            COALESCE(m.expiry_date::text,'') AS expiry, COALESCE(m.mrp,0)::float AS mrp
       FROM medicines m WHERE ${where.join(' AND ')}
      ORDER BY UPPER(m.name), m.batch_no
      LIMIT 20000`,
    args,
  );
  const products = new Map();
  for (const r of rows) {
    const key = R.normName(r.name);
    let p = products.get(key);
    if (!p) {
      p = { product: key, type: r.type, stock: 0, pack: r.unit, company: r.company, contents: r.contents, batches: [] };
      products.set(key, p);
    }
    p.stock += r.stock;
    const b = R.normBatch(r.batch);
    const have = b ? p.batches.find((x) => x.batch === b) : null;
    if (have) have.stock += r.stock;
    else if (b) p.batches.push({ batch: b, stock: r.stock, expiry: String(r.expiry).slice(0, 10), mrp: r.mrp });
    if (!p.company && r.company) p.company = r.company;
    if (!p.contents && r.contents) p.contents = r.contents;
  }
  return { type, products: [...products.values()] };
}

// ── the report ──────────────────────────────────────────────────────────────────────────

/** The period's doctor bills read from the books, in the shape billLines takes, with the
 *  time each was saved and the purchase lines (with the time each purchase was saved). */
async function readBooks(storePk, fl) {
  const { rows: bills } = await query(
    `SELECT s.id, s.local_id, s.bill_no, s.bill_date::text AS d, s.doctor_name,
            COALESCE(NULLIF(BTRIM(COALESCE(s.customer_name,'')),''), c.name, '') AS patient,
            (EXTRACT(EPOCH FROM COALESCE(s.created_at, s.updated_at)) * 1000)::float8 AS saved_ms
       FROM sales s LEFT JOIN customers c ON c.store_pk=s.store_pk AND c.local_id=s.customer_id
      WHERE s.store_pk=$1 AND NOT s.deleted AND NOT COALESCE(s.is_autosave,false)
        AND s.bill_date BETWEEN $2 AND $3 AND BTRIM(COALESCE(s.doctor_name,'')) <> ''
      ORDER BY s.bill_date, s.id`,
    [storePk, fl.from, fl.to],
  );
  const want = new Set(fl.doctors);
  const mine = bills.filter((b) => !want.size || want.has(R.normName(b.doctor_name)));
  if (!mine.length) return { sales: [], purchases: [] };
  const pks = mine.map((b) => Number(b.id));
  const lids = mine.map((b) => Number(b.local_id));
  const [{ rows: items }, { rows: rets }] = await Promise.all([
    query(
      // The batch's own name / type / batch / MRP / rate (the medicine row), as the PC reads
      // them; the line's own copy only when the row is missing on the server.
      `SELECT si.id, si.sale_id, si.medicine_id,
              COALESCE(m.name, si.name, '') AS name, COALESCE(m.type, si.type, '') AS type,
              COALESCE(m.batch_no, si.batch_no, '') AS batch, COALESCE(m.unit, '1') AS unit,
              COALESCE(m.mrp, 0)::float AS mrp, COALESCE(m.rate, 0)::float AS rate,
              COALESCE(si.qty, 0)::float AS qty, COALESCE(si.cost_price, 0)::float AS cost_price
         FROM sales_items si LEFT JOIN medicines m ON m.store_pk=$1 AND m.local_id=si.medicine_id
        WHERE si.sale_id = ANY($2::bigint[]) ORDER BY si.sale_id, si.id`,
      [storePk, pks],
    ),
    query(
      `SELECT sr.sale_id, sri.medicine_id, SUM(COALESCE(sri.qty,0))::float AS qty
         FROM sales_returns sr JOIN sales_return_items sri ON sri.return_id = sr.id
        WHERE sr.store_pk=$1 AND NOT sr.deleted AND sr.sale_id = ANY($2::bigint[])
        GROUP BY sr.sale_id, sri.medicine_id ORDER BY sr.sale_id, sri.medicine_id`,
      [storePk, lids],
    ),
  ]);
  const mids = [...new Set(items.map((i) => Number(i.medicine_id)).filter((v) => v > 0))];
  const { rows: plines } = mids.length ? await query(
    `SELECT pi.medicine_id, COALESCE(pi.qty,0)::float AS qty, COALESCE(pi.free_qty,0)::float AS free_qty,
            COALESCE(pi.rate,0)::float AS rate, COALESCE(NULLIF(BTRIM(pi.type),''), m.type, '') AS type,
            COALESCE(m.unit,'1') AS unit, COALESCE(pi.tablets_per_stripe,0) AS tps,
            (EXTRACT(EPOCH FROM p.created_at) * 1000)::float8 AS saved_ms
       FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
       LEFT JOIN medicines m ON m.store_pk=$1 AND m.local_id=pi.medicine_id
      WHERE p.store_pk=$1 AND NOT p.deleted AND NOT COALESCE(p.is_autosave,false) AND pi.medicine_id = ANY($2::bigint[])
      ORDER BY pi.id`,
    [storePk, mids],
  ) : { rows: [] };
  return shapeBooks(mine, items, rets, plines);
}

/**
 * The rows read above in the shape billLines takes (the PC's read_bills): bills
 * [{id, local_id, bill_no, d, doctor_name, patient, saved_ms}], items [{id, sale_id (the
 * bill's server id), medicine_id, name, type, batch, unit, mrp, rate, qty, cost_price}] in
 * bill-line order, returns [{sale_id (local), medicine_id, qty}], purchase lines
 * [{medicine_id, qty, free_qty, rate, type, unit, tps, saved_ms}] in line order.
 */
export function shapeBooks(bills, items, rets, plines) {
  const byPk = new Map(bills.map((b) => [Number(b.id), {
    id: Number(b.local_id), bill_no: displaySalesBillNo(b.bill_no), date: String(b.d).slice(0, 10),
    patient: String(b.patient || ''), doctor: String(b.doctor_name || ''),
    saved_ms: b.saved_ms === null || b.saved_ms === undefined ? NaN : Number(b.saved_ms),
    items: [], returns: [],
  }]));
  const byLid = new Map([...byPk.values()].map((s) => [s.id, s]));
  const divs = new Map();
  for (const it of items) {
    const sale = byPk.get(Number(it.sale_id));
    if (!sale) continue;
    const dk = JSON.stringify([it.type, it.unit, it.name]);
    if (!divs.has(dk)) divs.set(dk, R.saleUnitDivisor(it.type, it.unit, it.name));
    const d = divs.get(dk);
    sale.items.push({
      id: Number(it.id), medicine_id: Number(it.medicine_id || 0), name: String(it.name ?? ''), type: String(it.type ?? ''),
      batch: String(it.batch ?? ''), qty: Number(it.qty) || 0, mrp_unit: (Number(it.mrp) || 0) / d,
      med_rate_unit: (Number(it.rate) || 0) / d, cost_price: Number(it.cost_price) || 0,
    });
  }
  for (const r of rets) byLid.get(Number(r.sale_id))?.returns.push({ medicine_id: Number(r.medicine_id || 0), qty: Number(r.qty) || 0 });
  const purchases = plines.map((p) => ({
    medicine_id: Number(p.medicine_id), qty: Number(p.qty) || 0, free_qty: Number(p.free_qty) || 0, rate: Number(p.rate) || 0,
    units: R.purchaseUnitsPerPack(p.type, p.unit, p.qty, p.free_qty, p.tps),
    saved_ms: p.saved_ms === null || p.saved_ms === undefined ? null : Number(p.saved_ms),
  }));
  return { sales: [...byPk.values()], purchases };
}

/** medicine_id -> rates from the purchase lines saved by `cutoff` (ms), cached per medicine
 *  and per set of lines (the set only grows with the cutoff, so its size names it). */
function rateBook(purchases) {
  const byMid = new Map();
  for (const p of purchases) {
    if (!byMid.has(p.medicine_id)) byMid.set(p.medicine_id, []);
    byMid.get(p.medicine_id).push(p);
  }
  const cache = new Map();
  return (mids, cutoff) => {
    const out = new Map();
    for (const mid of mids) {
      const lines = byMid.get(mid);
      if (!lines) continue;
      const take = lines.filter((p) => p.saved_ms === null || !Number.isFinite(cutoff) || p.saved_ms <= cutoff);
      const key = `${mid}|${take.length}`;
      if (!cache.has(key)) cache.set(key, R.batchRates(take).get(mid) || null);
      const r = cache.get(key);
      if (r) out.set(mid, r);
    }
    return out;
  };
}

/** The report (the PC's build_report): the books read, then computeReport. */
export async function report(storePk, q = {}) {
  const fl = parseFilters(q);
  const [st, books] = await Promise.all([rulesState(storePk), readBooks(storePk, fl)]);
  return computeReport(st, books, fl);
}

/**
 * The figures, without the database: st = {rules, versions, runs} (rulesState), books =
 * shapeBooks(..), fl = parseFilters(..). Each bill with the rules version and the purchase
 * lines of its own time (doctorMarginHistory.pickVersion), then the PC's report steps.
 */
export function computeReport(st, books, fl) {
  const resolvers = new Map();
  const ratesFor = rateBook(books.purchases);
  const lines = [];
  const via = { saved: 0, recalculated: 0, first_rules: 0, none: 0 };
  for (const sale of books.sales) {
    const pick = pickVersion(st.versions, st.runs, sale.date, sale.saved_ms);
    if (!pick) { via.none += 1; continue; }
    via[pick.via] += 1;
    if (!resolvers.has(pick.version.n)) resolvers.set(pick.version.n, new R.Resolver(pick.version.rules));
    const mids = [...new Set(sale.items.map((it) => it.medicine_id))];
    for (const ln of R.billLines(resolvers.get(pick.version.n), sale, ratesFor(mids, pick.at))) {
      if (ln.qty > 0) lines.push(ln);
    }
  }
  // The PC's saved-lines read order (doctor, name, batch, date, bill no, line), then its
  // report's rate choice over those lines.
  const key = (r) => [r.doctor, r.name, r.batch, r.date, r.bill_no, r.line_no];
  lines.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
  const shown = fl.rate_basis ? lines.map((r) => R.withBasis(r, fl.rate_basis)) : lines;
  const rep = R.assemble(shown);
  return {
    mode: 'rules',
    filters: fl,
    has_rules: R.hasRules(st.rules),
    rules_rate_basis: st.rules.rate_basis,
    rules_updated: st.rules.updated,
    rate_basis_text: R.RATE_BASIS_TEXT[fl.rate_basis] || 'As saved with each bill (rules)',
    flag_counts: R.flagCounts(rep.rows),
    products: R.byProduct(rep.rows),
    sync: { bills: books.sales.length, versions: st.versions.length, by: via },
    ...rep,
  };
}

export { parseShopTime };
