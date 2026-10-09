/**
 * A medicine's details flow into its old bill lines (owner, 9 Oct 2026).
 *
 * Bill lines keep their own copy of the medicine's description (sales_items.schedule and so
 * on), so an edit in Inventory never reached old bills: changing a medicine to Schedule H1 left
 * its old sales out of the Schedule register. When one of the DESCRIPTIVE fields below changes,
 * the same change is written into that medicine's existing lines, one UPDATE per table by
 * medicine id (indexed: idx_*_items_medicine in web_login_schema.sql).
 *
 * Never re-priced: rate, MRP, discount and every amount stay exactly as billed -- they are on
 * printed bills. The owner also chose (9 Oct 2026) that GST %, batch and expiry follow the
 * medicine: the GST % label on old lines changes, so GST reports that split an amount by its
 * rate (sales) follow the new rate; a purchase line keeps the taxable and GST amounts its
 * supplier billed.
 *
 * Only fields that CHANGED in this edit are written, so a device that sends a medicine without
 * (say) its schedule cannot blank the schedule on every old bill.
 *
 * The lines are corrected in place; the bills' version is not bumped, so no device sees a
 * clash and no bill is re-sent. Devices make the same change in their own copy when the
 * medicine arrives by pull (PC: core.medicine_lines, Android: MedicineLinePropagation).
 */

/** medicine column -> which line tables carry it (and under which column). */
const FIELDS = {
  name: { sales_items: 'name', purchase_items: 'name', sales_return_items: 'name', purchase_return_items: 'name' },
  type: { sales_items: 'type', purchase_items: 'type' },
  hsn_code: { sales_items: 'hsn_code', purchase_items: 'hsn_code' },
  schedule: { sales_items: 'schedule', purchase_items: 'schedule' },
  manufacturer: { sales_items: 'manufacturer', purchase_items: 'manufacturer' },
  gst_percent: { sales_items: 'gst_percent', purchase_items: 'gst_pct' },
  batch_no: { sales_items: 'batch_no', purchase_items: 'batch_no', sales_return_items: 'batch_no', purchase_return_items: 'batch_no' },
  expiry_date: { sales_items: 'expiry_date', purchase_items: 'expiry_date' },
  // content_drug: no line table on the server carries it; nothing to update.
};

const PARENT = {
  sales_items: 'sale_id',
  purchase_items: 'purchase_id',
  sales_return_items: 'return_id',
  purchase_return_items: 'return_id',
};

const HEADER = {
  sales_items: 'sales',
  purchase_items: 'purchases',
  sales_return_items: 'sales_returns',
  purchase_return_items: 'purchase_returns',
};

export const PROPAGATED_FIELDS = Object.keys(FIELDS);

function norm(v) {
  const s = v == null ? '' : String(v).trim();
  return s;
}

/** Comparable value of a field: GST % as a number, expiry as YYYY-MM-DD, name upper case. */
function key(f, v) {
  if (f === 'gst_percent') return v === null || v === undefined || v === '' ? '' : String(Number(v));
  if (f === 'expiry_date') return norm(v).slice(0, 10);
  if (f === 'name') return norm(v).toUpperCase();
  return norm(v);
}

/** The value written into the lines. */
function lineValue(f, v) {
  if (f === 'gst_percent') return v === null || v === undefined || v === '' ? null : Number(v);
  if (f === 'expiry_date') return norm(v).slice(0, 10) || null;
  return norm(v) || null;
}

/** The descriptive fields that differ between two medicine rows. */
export function changedFields(before, after) {
  if (!before || !after) return {};
  const out = {};
  for (const f of PROPAGATED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(after, f)) continue;
    // Name: lines keep the shop's own spelling/case; only a real rename flows.
    if (key(f, before[f]) === key(f, after[f])) continue;
    // GST %, batch and expiry are never blanked on old bills: an empty or unreadable new value
    // (e.g. an expiry written in a form the server could not read) leaves the lines as billed.
    if (['gst_percent', 'batch_no', 'expiry_date'].includes(f) && key(f, after[f]) === '') continue;
    out[f] = lineValue(f, after[f]);
  }
  return out;
}

/**
 * Write the changed fields into every line of this medicine. Returns how many bills of each
 * kind were touched, e.g. { sales: 37, purchases: 4, sales_returns: 0, purchase_returns: 0 }.
 */
export async function propagateMedicineLines(client, storePk, medicineId, changes) {
  const counts = { sales: 0, purchases: 0, sales_returns: 0, purchase_returns: 0, fields: Object.keys(changes || {}) };
  if (!changes || !Object.keys(changes).length) return counts;
  const label = {
    sales_items: 'sales', purchase_items: 'purchases',
    sales_return_items: 'sales_returns', purchase_return_items: 'purchase_returns',
  };
  for (const table of Object.keys(PARENT)) {
    const sets = [];
    const differs = [];
    const params = [storePk, Number(medicineId)];
    for (const [field, value] of Object.entries(changes)) {
      const col = FIELDS[field]?.[table];
      if (!col) continue;
      params.push(value);
      // Typed casts: GST is a number, everything else text (expiry too, on the lines).
      const cast = field === 'gst_percent' ? '::double precision' : '::text';
      sets.push(`${col}=$${params.length}${cast}`);
      differs.push(`${col} IS DISTINCT FROM $${params.length}${cast}`);
    }
    if (!sets.length) continue;
    // Deleted bills' lines follow too (harmless), but only live bills are counted for the note.
    const { rows } = await client.query(
      `WITH upd AS (
         UPDATE ${table} SET ${sets.join(', ')}
          WHERE store_pk=$1 AND medicine_id=$2 AND (${differs.join(' OR ')})
          RETURNING ${PARENT[table]} AS parent
       ) SELECT COUNT(DISTINCT upd.parent)::int AS n
           FROM upd JOIN ${HEADER[table]} h ON h.id = upd.parent WHERE NOT h.deleted`,
      params,
    );
    counts[label[table]] = Number(rows[0]?.n || 0);
  }
  return counts;
}

/** A short note for the shop, e.g. "Schedule changed: 37 old sales, 4 purchases updated". */
export function propagationNote(counts) {
  if (!counts || !counts.fields?.length) return '';
  const parts = [];
  if (counts.sales) parts.push(`${counts.sales} old sale${counts.sales === 1 ? '' : 's'}`);
  if (counts.purchases) parts.push(`${counts.purchases} purchase${counts.purchases === 1 ? '' : 's'}`);
  const ret = (counts.sales_returns || 0) + (counts.purchase_returns || 0);
  if (ret) parts.push(`${ret} return${ret === 1 ? '' : 's'}`);
  if (!parts.length) return '';
  const names = {
    name: 'Name', type: 'Type', hsn_code: 'HSN', schedule: 'Schedule', manufacturer: 'Company',
    gst_percent: 'GST %', batch_no: 'Batch', expiry_date: 'Expiry',
  };
  const what = counts.fields.map((f) => names[f] || f).join(', ');
  return `${what} changed: ${parts.join(', ')} updated`;
}
