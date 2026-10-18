/**
 * Wholesale-mode fields that ride along on synced documents (owner, 18 Oct 2026).
 *
 * The sync upserts map every document into fixed columns, so a field the server
 * does not name is dropped on push and never reaches another device. The wholesale
 * build of the PC (mac2 core/wholesale_schema.py, D:\projects\WHOLESALE_DESIGN.md)
 * adds the fields below. Each table keeps them in one JSONB column, `extra_fields`:
 *
 *  - push: only the keys a document CARRIES are written, merged over what is stored
 *    (`stored || incoming`). A client that has never heard of wholesale (Android,
 *    web, an older PC) sends none of them and so cannot blank them; a client that
 *    sends `null` clears that one key.
 *  - pull: the stored keys are spread back onto the document as ordinary fields, so a
 *    device reads `doc.rate_a` exactly as if it were a column. A real column of the
 *    same name always wins.
 *
 * Line items (sales_items, purchase_items) are rewritten whole on every push, so
 * their extras are written with the line, not merged.
 */

const TEXT = 'text';
const NUM = 'num';

/** Table -> { field: kind }. Fields that already have a real column are not here. */
export const DOC_EXTRA_FIELDS = Object.freeze({
  customers: Object.freeze({
    party_type: TEXT, dl_numbers: TEXT, state_code: TEXT, rate_tier: TEXT,
    credit_limit: NUM, credit_days: NUM,
  }),
  medicines: Object.freeze({
    purchase_rate: NUM, rate_a: NUM, rate_b: NUM, rate_c: NUM,
  }),
  sales: Object.freeze({
    invoice_mode: TEXT, buyer_gstin: TEXT, buyer_dl: TEXT, place_of_supply: TEXT,
    taxable_total: NUM, cgst_total: NUM, sgst_total: NUM, igst_total: NUM,
    due_date: TEXT, transport: TEXT, lr_no: TEXT, eway_bill_no: TEXT,
  }),
  // batch_no, expiry_date and hsn_code are real sales_items columns already.
  sales_items: Object.freeze({
    rate_tier: TEXT, free_qty: NUM, scheme_pct: NUM, taxable: NUM, gst_amt: NUM,
  }),
  purchase_items: Object.freeze({
    rate_a: NUM, rate_b: NUM, rate_c: NUM,
  }),
  customer_payments: Object.freeze({ receipt_no: TEXT }),
  supplier_payments: Object.freeze({ receipt_no: TEXT }),
});

/** Tables that have the extra_fields column. */
export const DOC_EXTRA_TABLES = Object.freeze(Object.keys(DOC_EXTRA_FIELDS));

function clean(kind, value) {
  if (value === null || value === undefined) return null;
  if (kind === NUM) {
    if (value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * The extra fields `doc` carries for `table`, cleaned: only keys present on the
 * document (an absent key is "not sent", never "blank"). {} when none.
 */
export function docExtras(table, doc) {
  const fields = DOC_EXTRA_FIELDS[table];
  const out = {};
  if (!fields || !doc || typeof doc !== 'object') return out;
  for (const [key, kind] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(doc, key) || doc[key] === undefined) continue;
    out[key] = clean(kind, doc[key]);
  }
  return out;
}

/** docExtras as a JSON string for a jsonb parameter, or null when the doc carries none. */
export function docExtrasJson(table, doc) {
  const ext = docExtras(table, doc);
  return Object.keys(ext).length ? JSON.stringify(ext) : null;
}

/**
 * Merge the extra fields `doc` carries into the stored row (store_pk, local_id).
 * No query at all when the document carries none (every retail / older client).
 */
export async function mergeDocExtras(client, table, storePk, localId, doc) {
  const json = docExtrasJson(table, doc);
  if (!json) return false;
  if (!DOC_EXTRA_TABLES.includes(table)) return false;
  await client.query(
    `UPDATE ${table} SET extra_fields = COALESCE(extra_fields, '{}'::jsonb) || $3::jsonb
      WHERE store_pk=$1 AND local_id=$2`,
    [storePk, localId, json],
  );
  return true;
}

/**
 * A pulled row as a document: `extra_fields` spread onto it as plain fields (a real
 * column of the same name wins) and removed; the same for each of its `items`.
 */
export function withDocExtras(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  if (!Object.prototype.hasOwnProperty.call(row, 'extra_fields') && !Array.isArray(row.items)) return row;
  const { extra_fields: ext, ...out } = row;
  if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
    for (const [k, v] of Object.entries(ext)) {
      if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = v;
    }
  }
  if (Array.isArray(out.items)) out.items = out.items.map(withDocExtras);
  return out;
}

/** withDocExtras over a pull answer (an array of rows, one row, or null). */
export function withDocExtrasAll(rows) {
  if (Array.isArray(rows)) return rows.map(withDocExtras);
  return withDocExtras(rows);
}
