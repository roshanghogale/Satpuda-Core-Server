// Global master: a field the master list check confirmed (checked_fields) keeps its value when a
// shop pushes its own; the admin panel can still change it; the PCs get checked_fields on a pull.
//   node test/masterLock.test.mjs
import assert from 'node:assert/strict';
import { upsertGlobalMasterDoc } from '../src/services/masterMedicineService.js';

function fakeClient(existing) {
  const writes = [];
  return {
    writes,
    async query(sql, params) {
      if (/SELECT \* FROM medicines_master/.test(sql)) return { rows: existing ? [existing] : [] };
      writes.push({ sql, params });
      return { rows: [{ id: 99 }] };
    },
  };
}

const row = {
  id: 7, name: 'TAXIM 1GM INJ', manufacturer: 'ALKEM LABORATORIES LTD', mrp: 60, content_drug: 'Cefotaxime (1gm)',
  med_type: 'Injection', pack_size: '1 vial', schedule: 'H1', hsn_code: '30042019', gst_percent: 5,
  updated_at: new Date('2026-10-30T00:00:00Z'), version: 3, device_id: 'master-check', deleted: false,
  checked_fields: 'content,schedule,hsn,gst',
};
const shopSends = {
  name: 'Taxim 1gm inj', schedule: 'H', hsn_code: '3004', gst_percent: 12, content_drug: 'CEFOTAXIME',
  manufacturer: 'ALKEM', mrp: 62, _enrich: true,
};

// a shop's push: the checked fields stay, the others (maker, MRP) still take the shop's value
{
  const c = fakeClient(row);
  await upsertGlobalMasterDoc(c, shopSends);
  const p = c.writes[0].params;
  assert.equal(p[8 - 1 + 0], 'H1', 'schedule kept');   // $8
  assert.equal(p[9 - 1], '30042019', 'hsn kept');      // $9
  assert.equal(p[10 - 1], 5, 'gst kept');              // $10
  assert.equal(p[5 - 1], 'Cefotaxime (1gm)', 'content kept');
  assert.equal(p[3 - 1], 'ALKEM', 'an unchecked field follows the shop');
  assert.equal(p[4 - 1], 62);
}

// the admin panel changes a checked field (upsertGlobalMasterBatch sets _admin only for the admin
// route and strips one a shop sent)
{
  const c = fakeClient(row);
  await upsertGlobalMasterDoc(c, { ...shopSends, _admin: true });
  assert.equal(c.writes[0].params[8 - 1], 'H');
}

// no checked fields: everything as before (the shop's non-blank value wins)
{
  const c = fakeClient({ ...row, checked_fields: '' });
  await upsertGlobalMasterDoc(c, shopSends);
  assert.equal(c.writes[0].params[8 - 1], 'H');
}

console.log('master lock: ok');
