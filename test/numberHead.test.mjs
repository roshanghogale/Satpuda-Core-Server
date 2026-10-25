// Number blocks against bills the server got some other way (live store 154, Oct 2026: a data
// import made SCB1..SCB4607/FY2026-27 and purchases 1..1176 while the PC held blocks 1-200 and
// 1-50, so its next bill took a number already in use and was quarantined).
//   * GET /api/sync/v2/number-head tells a device which numbers left in its blocks are taken;
//   * a new block never overlaps a number that is issued (imported, by code or fy_serial) or
//     promised to another device;
//   * open_blocks (register) carries on after imported bills held only by their code.
// No database: a fake client answers the statements these functions send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveNumberBlockInTx } from '../src/services/syncService.js';
import { deviceFloors, numberHead, takenNumbers } from '../src/services/syncV2.js';

const FY = 2026;
const inFy = (r) => r.fy_start_year === FY || (r.date >= `${FY}-04-01` && r.date <= `${FY + 1}-03-31`);

function fakeDb({ sales = [], purchases = [], blocks = [] } = {}) {
  const tables = { sales, purchases };
  const codeSerial = (kind, code) => {
    const head = String(code || '').toUpperCase().split('/FY')[0];
    const m = head.match(kind === 'sales' ? /^(?:SCB)?([0-9]{1,9})$/ : /^(?:APU)?([0-9]{1,9})$/);
    return m ? Number(m[1]) : null;
  };
  return {
    blocks,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ');
      let m;
      if (/pg_advisory_xact_lock|INSERT INTO fy_serials/.test(s)) return { rows: [] };
      if (/to_regclass/.test(s)) return { rows: [{ ok: true }] };
      if (/AS head/.test(s)) {                                      // takenNumbers
        const kind = /FROM sales /.test(s) ? 'sales' : 'purchases';
        assert.match(s, /split_part\(upper\((bill_no|purchase_no)\), '\/FY', 1\)/);
        const rows = tables[kind].filter((r) => r.store_pk === params[0] && inFy(r));
        const nums = rows.flatMap((r) => [codeSerial(kind, r.code), r.fy_serial].filter((n) => n != null));
        const out = { head: Math.max(0, ...nums) };
        for (let i = 0; 4 + 2 * i < params.length; i++) {
          const [lo, hi] = [params[4 + 2 * i], params[5 + 2 * i]];
          out[`r${i}`] = Math.max(0, ...nums.filter((n) => n >= lo && n <= hi));
        }
        return { rows: [out] };
      }
      if ((m = s.match(/SELECT COALESCE\(MAX\(fy_serial\), 0\) AS m FROM (sales|purchases)/))) {
        const live = tables[m[1]].filter((r) => r.store_pk === params[0] && !r.deleted && inFy(r));
        return { rows: [{ m: Math.max(0, ...live.map((r) => r.fy_serial || 0)) }] };
      }
      if ((m = s.match(/SELECT (bill_no|purchase_no) AS code FROM/))) {
        const kind = m[1] === 'bill_no' ? 'sales' : 'purchases';
        const live = tables[kind].filter((r) => r.store_pk === params[0] && !r.deleted && inFy(r));
        return { rows: live.map((r) => ({ code: r.code })) };
      }
      if (/MAX\(to_serial\)/.test(s)) {
        const mine = blocks.filter((b) => b.store_pk === params[0] && b.kind === params[1] && b.fy_start_year === params[2]);
        return { rows: [{ m: Math.max(0, ...mine.map((b) => b.to_serial)) }] };
      }
      if (/INSERT INTO number_blocks/.test(s)) {
        const [store_pk, kind, fy_start_year, device_no, from_serial, to_serial] = params;
        blocks.push({ store_pk, kind, fy_start_year, device_no, from_serial, to_serial });
        return { rows: [] };
      }
      if (/FROM number_blocks WHERE store_pk=\$1 AND device_no=\$2/.test(s)) {
        return { rows: blocks.filter((b) => b.store_pk === params[0] && b.device_no === params[1]) };
      }
      if (/MAX\(local_id\)|MAX\(NULLIF\(substring/.test(s)) return { rows: [{ m: 0 }] };
      throw new Error(`unexpected sql: ${s.slice(0, 120)}`);
    },
  };
}

/** Bills 1..n of FY 2026-27 as a data import leaves them: code only, no fy_serial. */
const imported = (n, kind = 'sales', store_pk = 154) => Array.from({ length: n }, (_, i) => ({
  store_pk, fy_start_year: null, date: '2026-05-01', fy_serial: null,
  code: kind === 'sales' ? `SCB${i + 1}/FY2026-27` : `${i + 1}/FY2026-27`,
}));

test('the taken numbers inside a range a device still has, from the code or fy_serial', async () => {
  const db = fakeDb({ sales: [
    ...imported(500),
    { store_pk: 154, fy_start_year: FY, date: '2026-06-01', fy_serial: 950, code: 'SCB950/FY2026-27' },
    { store_pk: 154, fy_start_year: FY, date: '2026-06-01', fy_serial: 1203, code: 'odd-code' },
    { store_pk: 9, fy_start_year: FY, date: '2026-06-01', fy_serial: 5000, code: 'SCB5000/FY2026-27' },
  ] });
  const r = await takenNumbers(db, 154, 'sales', FY, [[51, 200], [501, 700], [901, 1000], [1201, 1300]]);
  assert.equal(r.head, 1203);                       // another store's 5000 is not this store's
  assert.deepEqual(r.ranges, [200, 0, 950, 1203]);  // 501-700 is free: the device keeps it
});

test('number-head refuses a bad year or bad ranges before touching the database', async () => {
  await assert.rejects(numberHead(1, { fyStartYear: 'x' }), /fy required/);
  await assert.rejects(numberHead(1, { fyStartYear: 2026, sales: '200-51' }), /ranges must look like/);
  await assert.rejects(numberHead(1, { fyStartYear: 2026, purchases: '0-5' }), /ranges must look like/);
  await assert.rejects(numberHead(1, { fyStartYear: 2026, sales: 'abc' }), /ranges must look like/);
  const many = Array.from({ length: 11 }, (_, i) => `${i * 10 + 1}-${i * 10 + 5}`).join(',');
  await assert.rejects(numberHead(1, { fyStartYear: 2026, sales: many }), /at most 10/);
});

test('a new block starts after imported bills (code only) and after every block promised', async () => {
  // The PC got sales 1-200 at registration; then the import made SCB1..SCB500.
  const db = fakeDb({
    sales: imported(500),
    blocks: [{ store_pk: 154, kind: 'sales', fy_start_year: FY, device_no: 1, from_serial: 1, to_serial: 200 }],
  });
  const pc = await reserveNumberBlockInTx(db, 154, { kind: 'sales', fyStartYear: FY, deviceNo: 1, size: 200 });
  assert.deepEqual([pc.from_serial, pc.to_serial], [501, 700]);
  const phone = await reserveNumberBlockInTx(db, 154, { kind: 'sales', fyStartYear: FY, deviceNo: 2, size: 200 });
  assert.deepEqual([phone.from_serial, phone.to_serial], [701, 900]);
  // Not one number of either block is held by a bill.
  const r = await takenNumbers(db, 154, 'sales', FY, [[501, 700], [701, 900]]);
  assert.deepEqual(r.ranges, [0, 0]);
});

test('a new block starts after bills that carry only fy_serial too', async () => {
  const db = fakeDb({ purchases: Array.from({ length: 1176 }, (_, i) => ({
    store_pk: 154, fy_start_year: FY, date: '2026-05-01', fy_serial: i + 1, code: null,
  })) });
  const blk = await reserveNumberBlockInTx(db, 154, { kind: 'purchases', fyStartYear: FY, deviceNo: 1, size: 50 });
  assert.deepEqual([blk.from_serial, blk.to_serial], [1177, 1226]);
});

test('open_blocks on register carries on after imported bills held only by their code', async () => {
  const blocks = [
    { store_pk: 154, kind: 'sales', fy_start_year: FY, device_no: 1, from_serial: 1, to_serial: 200 },
    { store_pk: 154, kind: 'purchases', fy_start_year: FY, device_no: 1, from_serial: 1, to_serial: 50 },
  ];
  // Sales: an import filled 1..120 of the PC's block (code only). Purchases: 1..1176, the whole block.
  const db = fakeDb({ sales: imported(120), purchases: imported(1176, 'purchases'), blocks });
  const { open_blocks: open } = await deviceFloors(db, 154, 1);
  assert.deepEqual(open, [{ kind: 'sales', fy_start_year: FY, from_serial: 1, to_serial: 200, next_serial: 121 }]);
});
