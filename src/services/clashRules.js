/**
 * Clashes between devices that only the server can see (sync v2 push, services/syncV2.js).
 *
 * Every device is right about what IT recorded; these rules are about two devices that were
 * both offline and recorded something about the same bill. Nothing here ever blocks a device's
 * queue: an event is always taken (applied or flagged), and a flag shows in the shop's
 * "Sync: N to check". A money record is never dropped -- the event is kept whole in
 * device_events whatever happens to it.
 *
 *   1. Two edits of one sales bill. The later push wins (as before) and the server now also
 *      puts the stock straight: the replaced copy's lines had moved stock that the winning
 *      device never knew about. A device that sends `base_lines` (the bill's lines as it saw
 *      them before its edit, [[medicine_id, qty], ...]) lets the server put back exactly what
 *      the replaced copy moved since then: stock += replaced lines - base lines. The fix is a
 *      server stock operation inside the same event, so server stock ends equal to the
 *      winning bill's lines. A device without `base_lines` (older builds): as before.
 *
 *   2. Returns that add up to more than the bill sold / bought. The return is a real refund
 *      (cash may have been paid out), so it is never refused, cut down or dropped: it is
 *      applied as the device sent it and flagged `over_return`, naming the medicine and the
 *      quantities, so the owner can delete the duplicate return on any device.
 *
 *   3. A sales return against a bill another device deleted (or a return another device
 *      deleted, edited here before the delete reached this device). The delete wins: the
 *      return is kept on the server as a DELETED record (nothing is lost; it can be looked at
 *      and the flag says why) and its stock is put back by a server stock operation, so the
 *      returned units are not counted twice. The device pulls the deleted copy on its next
 *      pull and its stock is set from the server's figure. Purchase returns are flagged only:
 *      their stock is moved in packs the server cannot work out from the document.
 *
 *   4. One supplier bill (same supplier, same bill number -- the PC's find_saved_supplier_bill
 *      rule) saved as two purchases on two devices that were both offline: the second is
 *      applied and flagged `duplicate_supplier_bill`, never dropped.
 */

const EPS = 1e-6;
const MAX_BASE_LINES = 2000;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 't';
}

/**
 * `base_lines` of an event: [[medicine_id, qty], ...] (or [{medicine_id, qty}, ...]) ->
 * Map(medicine_id -> qty). null when absent or not readable: then the event is treated
 * exactly as an older device's.
 */
export function parseBaseLines(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_BASE_LINES) return null;
  const out = new Map();
  for (const it of raw) {
    let mid;
    let qty;
    if (Array.isArray(it)) [mid, qty] = it;
    else if (it && typeof it === 'object') ({ medicine_id: mid, qty } = it);
    else return null;
    mid = Number(mid);
    qty = Number(qty);
    if (!Number.isInteger(mid) || mid <= 0 || !Number.isFinite(qty)) return null;
    out.set(mid, (out.get(mid) || 0) + qty);
  }
  return out;
}

/** A document's lines per medicine: Map(medicine_id -> qty). */
export function linesOf(items) {
  const out = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object') continue;
    const mid = Number(it.medicine_id ?? it.medicineId ?? 0);
    if (!Number.isInteger(mid) || mid <= 0) continue;
    out.set(mid, (out.get(mid) || 0) + num(it.qty));
  }
  return out;
}

/** a - b per medicine, as whole stock units (the stock ledger keeps integers), zeros left out. */
export function linesMinus(a, b) {
  const out = [];
  for (const mid of new Set([...a.keys(), ...b.keys()])) {
    const d = Math.round((a.get(mid) || 0) - (b.get(mid) || 0));
    if (d !== 0) out.push({ medicine_id: mid, qty_delta: d });
  }
  return out.sort((x, y) => x.medicine_id - y.medicine_id);
}

function negate(fix) {
  return fix.map((f) => ({ medicine_id: f.medicine_id, qty_delta: -f.qty_delta }));
}

/** Server stock operations for a fix, one per medicine. The op ids carry the event's own id,
 *  so a replay of the event can never move the stock twice. */
export function fixOps(fix, { eventUuid, tag, refCollection, refId, deviceId }) {
  return fix.map((f) => ({
    op_uuid: `${eventUuid}:${tag}:${f.medicine_id}`,
    medicine_id: f.medicine_id,
    op: 'adjust',
    qty_delta: f.qty_delta,
    ref_collection: refCollection,
    ref_id: refId,
    device_id: deviceId,
  }));
}

async function lineSums(client, sql, params) {
  const { rows } = await client.query(sql, params);
  const out = new Map();
  for (const r of rows) {
    const mid = Number(r.medicine_id);
    if (Number.isInteger(mid) && mid > 0) out.set(mid, (out.get(mid) || 0) + num(r.q));
  }
  return out;
}

/** The stored lines of a sales bill (by its row id). */
export function saleLinesByPk(client, salePk) {
  return lineSums(
    client,
    `SELECT medicine_id, SUM(qty)::float AS q FROM sales_items
      WHERE sale_id=$1 AND medicine_id IS NOT NULL GROUP BY medicine_id`,
    [salePk],
  );
}

// ── 1. two edits of one sales bill ──────────────────────────────────────────

/**
 * The stock fix for a sales event that replaced another device's copy. `stored` is the row
 * the event overwrote (to_jsonb of the sales row), `base` the device's base_lines.
 * stock += (replaced copy's lines) - (the lines the device edited from). A deleted copy or a
 * draft moves no stock, so its lines count as none.
 */
export async function replacedSaleFix(client, stored, base) {
  if (!stored || !base) return [];
  const live = !truthy(stored.deleted) && !truthy(stored.is_autosave);
  const replaced = live && stored.id != null ? await saleLinesByPk(client, stored.id) : new Map();
  return linesMinus(replaced, base);
}

// ── 2 + 3. returns ──────────────────────────────────────────────────────────

const RETURN_KINDS = {
  sales_returns: {
    parentRef: 'sale_id',
    parent: `SELECT id, deleted, is_autosave, bill_no AS no FROM sales WHERE store_pk=$1 AND local_id=$2`,
    sold: `SELECT medicine_id, SUM(qty)::float AS q FROM sales_items
            WHERE sale_id=$1 AND medicine_id IS NOT NULL GROUP BY medicine_id`,
    returned: `SELECT ri.medicine_id, SUM(ri.qty)::float AS q
                 FROM sales_returns r JOIN sales_return_items ri ON ri.return_id = r.id
                WHERE r.store_pk=$1 AND r.sale_id=$2 AND NOT r.deleted AND r.local_id <> $3
                  AND ri.medicine_id IS NOT NULL
                GROUP BY ri.medicine_id`,
    bill: 'bill',
    soldWord: 'sold',
  },
  purchase_returns: {
    parentRef: 'purchase_id',
    parent: `SELECT id, deleted, is_autosave, purchase_no AS no FROM purchases WHERE store_pk=$1 AND local_id=$2`,
    sold: `SELECT medicine_id, SUM(qty + COALESCE(free_qty, 0))::float AS q FROM purchase_items
            WHERE purchase_id=$1 AND medicine_id IS NOT NULL GROUP BY medicine_id`,
    returned: `SELECT ri.medicine_id, SUM(ri.qty)::float AS q
                 FROM purchase_returns r JOIN purchase_return_items ri ON ri.return_id = r.id
                WHERE r.store_pk=$1 AND r.purchase_id=$2 AND NOT r.deleted AND r.local_id <> $3
                  AND ri.medicine_id IS NOT NULL
                GROUP BY ri.medicine_id`,
    bill: 'purchase',
    soldWord: 'bought',
  },
};

export const RETURN_COLLECTIONS = new Set(Object.keys(RETURN_KINDS));

function fmt(n) {
  return String(Math.round(num(n) * 1000) / 1000);
}

/**
 * What the server does with a sales / purchase return upsert before applying it.
 *
 *   ctx = { storePk, collection, doc, localId, stored (to_jsonb row or null),
 *           concurrent (another device changed it since this device saw it), base (Map|null) }
 *
 * Returns { flags: [[code, detail]], keepDeleted, fix: [{medicine_id, qty_delta}] }.
 * keepDeleted: write the return as deleted; fix: server stock operations to apply with it.
 */
export async function returnRules(client, ctx) {
  const kind = RETURN_KINDS[ctx.collection];
  const out = { flags: [], keepDeleted: false, fix: [] };
  if (!kind || !ctx.doc || truthy(ctx.doc.deleted)) return out;
  const docLines = linesOf(ctx.doc.items);
  const stored = ctx.stored || null;
  const storedLive = Boolean(stored) && !truthy(stored.deleted);
  const storedDeletedElsewhere = Boolean(stored) && truthy(stored.deleted) && ctx.concurrent;

  const parentId = Number(ctx.doc[kind.parentRef] ?? 0);
  let parent = null;
  if (Number.isInteger(parentId) && parentId > 0) {
    const { rows } = await client.query(kind.parent, [ctx.storePk, parentId]);
    parent = rows[0] || null;
  }
  const parentDeleted = Boolean(parent) && truthy(parent.deleted);

  if (parentDeleted || storedDeletedElsewhere) {
    const why = parentDeleted
      ? `${kind.bill} ${parent.no || parentId} was deleted on another device before this return reached the server`
      : 'this return was deleted on another device before this edit reached the server';
    if (ctx.collection !== 'sales_returns') {
      // A purchase return's stock is moved in packs the document does not carry: flagged only.
      out.flags.push([parentDeleted ? 'bill_deleted' : 'deleted_elsewhere', `${why}; check this purchase return`]);
      return out;
    }
    // The server's stock now holds: the stored return's lines (when it was live) plus what
    // this device moved for it (its lines minus the lines it edited from). Kept deleted, the
    // return must move nothing, so all of that goes back.
    if (!ctx.base && stored && !storedLive) {
      // Deleted here, edited there, and the device does not say what it edited from: the
      // stock it moved is not known. Left as before (applied, flagged as a clash).
      return out;
    }
    const held = storedLive ? await returnLinesByPk(client, stored.id) : new Map();
    // Without base_lines (an older device) an edit is taken to start from the stored copy.
    const base = ctx.base || held;
    // put back = held + (doc - base)
    const moved = new Map(held);
    for (const [mid, q] of docLines) moved.set(mid, (moved.get(mid) || 0) + q);
    for (const [mid, q] of base) moved.set(mid, (moved.get(mid) || 0) - q);
    out.keepDeleted = true;
    out.fix = negate(linesMinus(moved, new Map()));
    out.flags.push([parentDeleted ? 'bill_deleted' : 'deleted_elsewhere', `${why}; the return is kept deleted and its stock put back`]);
    return out;
  }

  if (!parent || truthy(parent.is_autosave) || !docLines.size) return out;
  const sold = await lineSums(client, kind.sold, [parent.id]);
  const before = await lineSums(client, kind.returned, [ctx.storePk, parentId, ctx.localId]);
  const over = [];
  for (const [mid, q] of docLines) {
    const had = before.get(mid) || 0;
    const cap = sold.get(mid) || 0;
    if (q > EPS && had + q > cap + EPS) {
      over.push(`medicine ${mid}: ${kind.soldWord} ${fmt(cap)}, returned before ${fmt(had)}, this return ${fmt(q)}`);
    }
  }
  if (over.length) {
    out.flags.push([
      'over_return',
      `returns of ${kind.bill} ${parent.no || parentId} add up to more than was ${kind.soldWord} (${over.join('; ')})`.slice(0, 480),
    ]);
  }
  return out;
}

async function returnLinesByPk(client, retPk) {
  if (retPk == null) return new Map();
  return lineSums(
    client,
    `SELECT medicine_id, SUM(qty)::float AS q FROM sales_return_items
      WHERE return_id=$1 AND medicine_id IS NOT NULL GROUP BY medicine_id`,
    [retPk],
  );
}

// ── 4. one supplier bill saved twice ────────────────────────────────────────

function billKey(v) {
  return String(v ?? '').trim().toUpperCase();
}

/**
 * A live purchase another device already saved for this supplier's bill number, or null.
 * Asked only when this event makes the purchase live under that supplier + bill number (a new
 * purchase, a draft finished, or the number / supplier changed), so editing a flagged
 * purchase again does not flag it again.
 */
export async function duplicateSupplierBill(client, { storePk, doc, localId, stored }) {
  if (!doc || truthy(doc.deleted) || truthy(doc.is_autosave)) return null;
  const key = billKey(doc.bill_number);
  if (!key) return null;
  const sid = Number(doc.supplier_id ?? 0);
  const sname = billKey(doc.supplier_name);
  if (!(Number.isInteger(sid) && sid > 0) && !sname) return null;
  if (stored && !truthy(stored.deleted) && !truthy(stored.is_autosave)
      && billKey(stored.bill_number) === key
      && ((sid > 0 && Number(stored.supplier_id) === sid) || (sname && billKey(stored.supplier_name) === sname))) {
    return null;
  }
  const { rows } = await client.query(
    `SELECT local_id, purchase_no, purchase_date FROM purchases
      WHERE store_pk=$1 AND local_id <> $2 AND NOT deleted AND NOT COALESCE(is_autosave, FALSE)
        AND UPPER(BTRIM(COALESCE(bill_number, ''))) = $3
        AND (($4::bigint > 0 AND supplier_id = $4::bigint)
             OR ($5::text <> '' AND UPPER(BTRIM(COALESCE(supplier_name, ''))) = $5::text))
      ORDER BY local_id LIMIT 5`,
    [storePk, localId, key, Number.isInteger(sid) && sid > 0 ? sid : 0, sname],
  );
  if (!rows.length) return null;
  const names = rows.map((r) => r.purchase_no || r.local_id).join(', ');
  return [
    'duplicate_supplier_bill',
    `supplier bill ${String(doc.bill_number).trim()} of this supplier is already saved as purchase ${names}; `
      + 'check that the same bill was not entered on two devices',
  ];
}
