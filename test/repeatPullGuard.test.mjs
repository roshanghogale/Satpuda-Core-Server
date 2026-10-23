// The same list pull repeated in a tight loop (live log, Oct 2026: GET
// /api/sync/medicines?after_id=... every ~2 s from one PC on an old build) is answered 429
// with Retry-After before auth or the database; paging, polling and other callers are not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepeatPullGuard } from '../src/middleware/repeatPullGuard.js';

function harness(opts = {}) {
  let t = 1_000_000;
  const logs = [];
  const guard = createRepeatPullGuard({ now: () => t, log: (m) => logs.push(m), ...opts });
  const call = (url, { auth = 'Bearer A', method = 'GET' } = {}) => {
    const path = url.replace(/^\/api\/sync/, '').split('?')[0] || '/';
    const req = { method, path, originalUrl: url, headers: { authorization: auth }, ip: '1.2.3.4' };
    const out = { status: 200, headers: {}, body: null, next: false };
    const res = {
      set(k, v) { out.headers[k] = v; return res; },
      status(s) { out.status = s; return res; },
      json(b) { out.body = b; return res; },
    };
    guard(req, res, () => { out.next = true; });
    return out;
  };
  return { call, tick: (ms) => { t += ms; }, logs, guard };
}

const LOOP = '/api/sync/medicines?after_id=48461&include_deleted=0&limit=5000';

test('the 21st identical pull inside a minute is held off with Retry-After', () => {
  const h = harness();
  for (let i = 0; i < 20; i++) {
    assert.equal(h.call(LOOP).next, true, `request ${i + 1}`);
    h.tick(2000);
  }
  const r = h.call(LOOP);
  assert.equal(r.status, 429);
  assert.equal(r.next, false);
  assert.equal(r.headers['Retry-After'], '30');
  assert.equal(r.body.retry_after, 30);
  assert.equal(h.logs.length, 1);
  assert.doesNotMatch(h.logs[0], /after_id|Bearer/);   // no query, no token in the log
  h.tick(10_000);
  assert.equal(h.call(LOOP).headers['Retry-After'], '20');  // still held off, the time left
  h.tick(20_000);
  assert.equal(h.call(LOOP).next, true);                   // then answered again
});

test('a caller that keeps looping is held off longer each time, up to five minutes', () => {
  const h = harness();
  const blocks = [];
  for (let round = 0; round < 6; round++) {
    let r;
    do { r = h.call(LOOP); h.tick(2000); } while (r.next);
    blocks.push(Number(r.headers['Retry-After']));
    h.tick(blocks.at(-1) * 1000);
  }
  assert.deepEqual(blocks, [30, 60, 120, 240, 300, 300]);
});

test('paging, slow polls, other lists and other callers are never held off', () => {
  const h = harness();
  // A pull that pages: since / after_id move every request.
  for (let i = 0; i < 200; i++) {
    assert.equal(h.call(`/api/sync/medicines?since=2026-10-01T00:00:00.${String(i).padStart(3, '0')}Z&after_id=${i * 5000}&limit=5000`).next, true);
  }
  // An idle poll every 6 s for an hour.
  for (let i = 0; i < 600; i++) {
    assert.equal(h.call('/api/sync/sales?since=2026-10-23T00:00:00Z&include_deleted=1&limit=5000').next, true);
    h.tick(6000);
  }
  // Another device of the same store, and the revision feed, at the looping rate.
  for (let i = 0; i < 40; i++) {
    h.call(LOOP);
    assert.equal(h.call(LOOP, { auth: 'Bearer B' }).next, i < 20);
    assert.equal(h.call('/api/sync/changes?after=99').next, true);
    assert.equal(h.call('/api/sync/status').next, true);
    assert.equal(h.call('/api/sync/medicines', { method: 'POST' }).next, true);
    assert.equal(h.call('/api/sync/sales/12').next, true);
    h.tick(1000);
  }
});

test('the key table stays bounded', () => {
  const h = harness({ maxKeys: 100 });
  for (let i = 0; i < 1000; i++) {
    h.call(`/api/sync/sales?since=x${i}`);
    h.tick(61_000);
  }
  assert.ok(h.guard.hits.size <= 101);
});
