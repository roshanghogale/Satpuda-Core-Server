// Clashes only the server can see (services/clashRules.js): two offline edits of one bill,
// returns above what was sold, a return of a deleted bill, one supplier bill saved twice.
// No database: a fake client answers the statements the rules send.
//
//   node --test test/clashRules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  duplicateSupplierBill,
  fixOps,
  linesMinus,
  linesOf,
  parseBaseLines,
  replacedSaleFix,
  returnRules,
} from '../src/services/clashRules.js';

const STORE = 7;

function fakeDb(t) {
  const tables = {
    sales: [], sales_items: [], sales_returns: [], sales_return_items: [],
    purchases: [], purchase_items: [], purchase_returns: [], purchase_return_items: [],
    ...t,
  };
  const sum = (rows, qty) => {
    const by = new Map();
    for (const r of rows) {
      if (r.medicine_id == null) continue;
      by.set(r.medicine_id, (by.get(r.medicine_id) || 0) + qty(r));
    }
    return { rows: [...by].map(([medicine_id, q]) => ({ medicine_id, q })) };
  };
  return {
    tables,
    async query(sql, p = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      let m;
      if ((m = s.match(/^SELECT id, deleted, is_autosave, (bill_no|purchase_no) AS no FROM (sales|purchases) WHERE store_pk=\$1 AND local_id=\$2$/))) {
        const row = tables[m[2]].find((r) => r.store_pk === p[0] && r.local_id === p[1]);
        return { rows: row ? [{ id: row.id, deleted: row.deleted || false, is_autosave: row.is_autosave || false, no: row[m[1]] }] : [] };
      }
      if (/^SELECT medicine_id, SUM\(qty\)::float AS q FROM sales_items WHERE sale_id=\$1/.test(s)) {
        return sum(tables.sales_items.filter((r) => r.sale_id === p[0]), (r) => r.qty);
      }
      if (/^SELECT medicine_id, SUM\(qty \+ COALESCE\(free_qty, 0\)\)::float AS q FROM purchase_items WHERE purchase_id=\$1/.test(s)) {
        return sum(tables.purchase_items.filter((r) => r.purchase_id === p[0]), (r) => r.qty + (r.free_qty || 0));
      }
      if ((m = s.match(/FROM (sales|purchase)_returns r JOIN \1_return_items ri ON ri.return_id = r.id WHERE r.store_pk=\$1 AND r.(sale_id|purchase_id)=\$2 AND NOT r.deleted AND r.local_id <> \$3/))) {
        const heads = tables[`${m[1]}_returns`].filter((r) => r.store_pk === p[0] && r[m[2]] === p[1] && !r.deleted && r.local_id !== p[2]);
        const ids = new Set(heads.map((r) => r.id));
        return sum(tables[`${m[1]}_return_items`].filter((r) => ids.has(r.return_id)), (r) => r.qty);
      }
      if (/^SELECT medicine_id, SUM\(qty\)::float AS q FROM sales_return_items WHERE return_id=\$1/.test(s)) {
        return sum(tables.sales_return_items.filter((r) => r.return_id === p[0]), (r) => r.qty);
      }
      if (/^SELECT local_id, purchase_no, purchase_date FROM purchases/.test(s)) {
        const key = (v) => String(v ?? '').trim().toUpperCase();
        const rows = tables.purchases.filter((r) => r.store_pk === p[0] && r.local_id !== p[1] && !r.deleted
          && !r.is_autosave && key(r.bill_number) === p[2]
          && ((p[3] > 0 && r.supplier_id === p[3]) || (p[4] !== '' && key(r.supplier_name) === p[4])));
        return { rows: rows.map((r) => ({ local_id: r.local_id, purchase_no: r.purchase_no, purchase_date: r.purchase_date })) };
      }
      throw new Error(`unexpected statement: ${s}`);
    },
  };
}

test('base_lines: read when well formed, ignored (older device) otherwise', () => {
  assert.deepEqual([...parseBaseLines([[5, 2], [9, 1], [5, 1]])], [[5, 3], [9, 1]]);
  assert.deepEqual([...parseBaseLines([{ medicine_id: 4, qty: 2 }])], [[4, 2]]);
  assert.deepEqual([...parseBaseLines([])], []);
  assert.equal(parseBaseLines(undefined), null);
  assert.equal(parseBaseLines(null), null);
  assert.equal(parseBaseLines('5:2'), null);
  assert.equal(parseBaseLines([[0, 2]]), null);
  assert.equal(parseBaseLines([['x', 2]]), null);
});

test('two offline edits of one bill: stock ends equal to the winning bill', async () => {
  // Bill sold 5 of medicine 11 and 2 of medicine 12 (server stock already moved for it).
  // PC A (offline) edits it to 3 x 11 and pushes first: stock +2 of 11.
  // PC B (offline, from the same 5 + 2) edits it to 4 x 11 + 2 x 12 + 1 x 13 and pushes later:
  // its own stock event moves +1 of 11 and -1 of 13. B wins.
  const db = fakeDb({
    sales_items: [
      { sale_id: 900, medicine_id: 11, qty: 3 },          // A's copy, the one B replaces
      { sale_id: 900, medicine_id: 12, qty: 2 },
    ],
  });
  const stored = { id: 900, deleted: false, is_autosave: false, version: 4 };
  const base = parseBaseLines([[11, 5], [12, 2]]);
  const fix = await replacedSaleFix(db, stored, base);
  assert.deepEqual(fix, [{ medicine_id: 11, qty_delta: -2 }]);
  // Server sold of medicine 11 for this bill: 5, -2 (A), -1 (B's own event), +2 (the fix) = 4 = B's line.
  const sold11 = 5 - 2 - 1 - fix[0].qty_delta;
  assert.equal(sold11, 4);

  // The replaced copy was deleted on another device (its lines were all put back there):
  // B's edit brings the bill back, so the stock its lines take must leave again.
  const gone = await replacedSaleFix(db, { ...stored, deleted: true }, base);
  assert.deepEqual(gone, [{ medicine_id: 11, qty_delta: -5 }, { medicine_id: 12, qty_delta: -2 }]);
  // A draft moves no stock either.
  assert.deepEqual(await replacedSaleFix(db, { ...stored, is_autosave: true }, base), gone);
  // No base_lines (older device): nothing is done, as before.
  assert.deepEqual(await replacedSaleFix(db, stored, null), []);

  const ops = fixOps(fix, { eventUuid: 'pc-abc', tag: 'clash', refCollection: 'sales', refId: 77, deviceId: 'dev-b' });
  assert.deepEqual(ops, [{
    op_uuid: 'pc-abc:clash:11', medicine_id: 11, op: 'adjust', qty_delta: -2,
    ref_collection: 'sales', ref_id: 77, device_id: 'dev-b',
  }]);
});

test('lines arithmetic', () => {
  assert.deepEqual([...linesOf([{ medicine_id: 3, qty: 2 }, { medicine_id: 3, qty: '1' }, { medicine_id: 0, qty: 9 }, null])], [[3, 3]]);
  assert.deepEqual(linesMinus(new Map([[1, 2]]), new Map([[1, 2], [2, 1]])), [{ medicine_id: 2, qty_delta: -1 }]);
});

function salesShop() {
  return fakeDb({
    sales: [{ id: 50, store_pk: STORE, local_id: 5001, bill_no: 'SCB12', deleted: false }],
    sales_items: [{ sale_id: 50, medicine_id: 11, qty: 4 }, { sale_id: 50, medicine_id: 12, qty: 1 }],
    sales_returns: [{ id: 70, store_pk: STORE, local_id: 7001, sale_id: 5001, deleted: false }],
    sales_return_items: [{ return_id: 70, medicine_id: 11, qty: 3 }],
  });
}

test('two returns of the remaining quantity: applied, flagged over_return, never refused', async () => {
  const db = salesShop();
  const doc = { id: 7002, sale_id: 5001, items: [{ medicine_id: 11, qty: 3 }] };
  const r = await returnRules(db, { storePk: STORE, collection: 'sales_returns', doc, localId: 7002, stored: null, concurrent: false, base: null });
  assert.equal(r.keepDeleted, false);
  assert.deepEqual(r.fix, []);
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0][0], 'over_return');
  assert.match(r.flags[0][1], /SCB12/);
  assert.match(r.flags[0][1], /medicine 11: sold 4, returned before 3, this return 3/);

  // The remaining 1 is fine; an edit of the first return to 4 (its own old lines do not count) is fine.
  const ok1 = await returnRules(db, { storePk: STORE, collection: 'sales_returns', doc: { ...doc, items: [{ medicine_id: 11, qty: 1 }] }, localId: 7002, stored: null, concurrent: false, base: null });
  assert.deepEqual(ok1.flags, []);
  const ok2 = await returnRules(db, { storePk: STORE, collection: 'sales_returns', doc: { id: 7001, sale_id: 5001, items: [{ medicine_id: 11, qty: 4 }] }, localId: 7001, stored: { id: 70, deleted: false }, concurrent: false, base: null });
  assert.deepEqual(ok2.flags, []);
  // A return with no bill, or of a bill the server does not have yet: nothing to compare.
  const none = await returnRules(db, { storePk: STORE, collection: 'sales_returns', doc: { id: 7003, items: [{ medicine_id: 11, qty: 9 }] }, localId: 7003, stored: null, concurrent: false, base: null });
  assert.deepEqual(none.flags, []);
  // A deleted return is never checked.
  const del = await returnRules(db, { storePk: STORE, collection: 'sales_returns', doc: { ...doc, deleted: true }, localId: 7002, stored: null, concurrent: false, base: null });
  assert.deepEqual(del, { flags: [], keepDeleted: false, fix: [] });
});

test('purchase returns count free quantity and are flagged the same way', async () => {
  const db = fakeDb({
    purchases: [{ id: 60, store_pk: STORE, local_id: 6001, purchase_no: 'APU9', deleted: false }],
    purchase_items: [{ purchase_id: 60, medicine_id: 21, qty: 10, free_qty: 2 }],
    purchase_returns: [{ id: 80, store_pk: STORE, local_id: 8001, purchase_id: 6001, deleted: false }],
    purchase_return_items: [{ return_id: 80, medicine_id: 21, qty: 8 }],
  });
  const ok = await returnRules(db, { storePk: STORE, collection: 'purchase_returns', doc: { id: 8002, purchase_id: 6001, items: [{ medicine_id: 21, qty: 4 }] }, localId: 8002, stored: null, concurrent: false, base: null });
  assert.deepEqual(ok.flags, []);
  const over = await returnRules(db, { storePk: STORE, collection: 'purchase_returns', doc: { id: 8002, purchase_id: 6001, items: [{ medicine_id: 21, qty: 5 }] }, localId: 8002, stored: null, concurrent: false, base: null });
  assert.equal(over.flags[0][0], 'over_return');
  assert.match(over.flags[0][1], /purchase APU9.*bought 12, returned before 8, this return 5/);
});

test('a sales return of a bill another device deleted: kept deleted, its stock put back', async () => {
  const db = salesShop();
  db.tables.sales[0].deleted = true;
  // A new return (this device added +2 of 11 and +1 of 12 to its stock): all of it goes back.
  const doc = { id: 7002, sale_id: 5001, items: [{ medicine_id: 11, qty: 2 }, { medicine_id: 12, qty: 1 }] };
  const r = await returnRules(db, { storePk: STORE, collection: 'sales_returns', doc, localId: 7002, stored: null, concurrent: false, base: null });
  assert.equal(r.keepDeleted, true);
  assert.deepEqual(r.fix, [{ medicine_id: 11, qty_delta: -2 }, { medicine_id: 12, qty_delta: -1 }]);
  assert.equal(r.flags[0][0], 'bill_deleted');
  assert.match(r.flags[0][1], /bill SCB12 was deleted on another device/);

  // An edit of a return the server holds live (3 x 11), from 3 to 2: the server's stock holds the
  // 3 plus the device's -1, all of it goes back.
  const edit = await returnRules(db, {
    storePk: STORE, collection: 'sales_returns', doc: { id: 7001, sale_id: 5001, items: [{ medicine_id: 11, qty: 2 }] },
    localId: 7001, stored: { id: 70, deleted: false }, concurrent: false, base: parseBaseLines([[11, 3]]),
  });
  assert.deepEqual(edit.fix, [{ medicine_id: 11, qty_delta: -2 }]);
  // Same edit from an older device (no base_lines): it is taken to start from the stored copy.
  const old = await returnRules(db, {
    storePk: STORE, collection: 'sales_returns', doc: { id: 7001, sale_id: 5001, items: [{ medicine_id: 11, qty: 2 }] },
    localId: 7001, stored: { id: 70, deleted: false }, concurrent: false, base: null,
  });
  assert.deepEqual(old.fix, [{ medicine_id: 11, qty_delta: -2 }]);

  // A purchase return of a deleted purchase: flagged only (packs), nothing changed.
  const pdb = fakeDb({ purchases: [{ id: 60, store_pk: STORE, local_id: 6001, purchase_no: 'APU9', deleted: true }] });
  const pr = await returnRules(pdb, { storePk: STORE, collection: 'purchase_returns', doc: { id: 8002, purchase_id: 6001, items: [{ medicine_id: 21, qty: 4 }] }, localId: 8002, stored: null, concurrent: false, base: null });
  assert.equal(pr.keepDeleted, false);
  assert.deepEqual(pr.fix, []);
  assert.equal(pr.flags[0][0], 'bill_deleted');
});

test('a return deleted on another device, edited here before the delete arrived: stays deleted', async () => {
  const db = salesShop();
  db.tables.sales_returns[0].deleted = true;
  // The deleting device put back the 3 it knew; this device edited 3 -> 4 (+1 to its stock).
  const doc = { id: 7001, sale_id: 5001, items: [{ medicine_id: 11, qty: 4 }] };
  const r = await returnRules(db, { storePk: STORE, collection: 'sales_returns', doc, localId: 7001, stored: { id: 70, deleted: true }, concurrent: true, base: parseBaseLines([[11, 3]]) });
  assert.equal(r.keepDeleted, true);
  assert.deepEqual(r.fix, [{ medicine_id: 11, qty_delta: -1 }]);
  assert.equal(r.flags[0][0], 'deleted_elsewhere');
  // An older device that does not say what it edited from: left as before.
  const old = await returnRules(db, { storePk: STORE, collection: 'sales_returns', doc, localId: 7001, stored: { id: 70, deleted: true }, concurrent: true, base: null });
  assert.deepEqual(old, { flags: [], keepDeleted: false, fix: [] });
  // Deleted by this same device (not a clash): not this rule.
  const own = await returnRules(db, { storePk: STORE, collection: 'sales_returns', doc, localId: 7001, stored: { id: 70, deleted: true }, concurrent: false, base: parseBaseLines([[11, 3]]) });
  assert.equal(own.keepDeleted, false);
});

test('one supplier bill saved on two offline PCs: the second is flagged, not dropped', async () => {
  const db = fakeDb({
    purchases: [
      { id: 1, store_pk: STORE, local_id: 1000000001, purchase_no: 'APU5', supplier_id: 3, supplier_name: 'Mahavir Agencies', bill_number: 'inv-42', deleted: false },
      { id: 2, store_pk: STORE, local_id: 1000000002, purchase_no: 'APU6', supplier_id: 4, supplier_name: 'Other', bill_number: 'INV-43', deleted: false },
      { id: 3, store_pk: STORE, local_id: 1000000003, purchase_no: 'APU7', supplier_id: 3, bill_number: 'INV-44', deleted: true },
    ],
  });
  const doc = { id: 2000000001, supplier_id: 3, supplier_name: 'Mahavir Agencies', bill_number: ' INV-42 ' };
  const flag = await duplicateSupplierBill(db, { storePk: STORE, doc, localId: 2000000001, stored: null });
  assert.equal(flag[0], 'duplicate_supplier_bill');
  assert.match(flag[1], /INV-42.*APU5/);
  // By supplier name when the ids differ (each PC made the supplier itself).
  assert.ok(await duplicateSupplierBill(db, { storePk: STORE, doc: { ...doc, supplier_id: 99, supplier_name: 'MAHAVIR AGENCIES ' }, localId: 2000000001, stored: null }));
  // Another supplier, a deleted purchase, a draft, no bill number: no flag.
  assert.equal(await duplicateSupplierBill(db, { storePk: STORE, doc: { ...doc, bill_number: 'INV-43' }, localId: 2000000001, stored: null }), null);
  assert.equal(await duplicateSupplierBill(db, { storePk: STORE, doc: { ...doc, bill_number: 'INV-44', supplier_name: '' }, localId: 2000000001, stored: null }), null);
  assert.equal(await duplicateSupplierBill(db, { storePk: STORE, doc: { ...doc, is_autosave: 1 }, localId: 2000000001, stored: null }), null);
  assert.equal(await duplicateSupplierBill(db, { storePk: STORE, doc: { ...doc, bill_number: '' }, localId: 2000000001, stored: null }), null);
  // An edit of a purchase the server already holds live under this supplier + number: not again.
  assert.equal(await duplicateSupplierBill(db, {
    storePk: STORE, doc, localId: 2000000001,
    stored: { deleted: false, is_autosave: false, bill_number: 'INV-42', supplier_id: 3, supplier_name: 'Mahavir Agencies' },
  }), null);
  // ...but a draft finished, or the number changed to one already saved, is asked.
  assert.ok(await duplicateSupplierBill(db, {
    storePk: STORE, doc, localId: 2000000001,
    stored: { deleted: false, is_autosave: true, bill_number: 'INV-42', supplier_id: 3 },
  }));
});
