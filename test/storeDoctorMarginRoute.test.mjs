// The phone's (paired device's) Doctor Margin Report by rules: GET /api/store/reports/doctor-margin/by-rules
// behind requireStore, answered by the web's own service (doctorMarginRulesStore.report) -- so the
// phone gets the store's full rules history and Recalculate runs. No database: the filters are
// checked before anything is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import router from '../src/routes/storeQuery.js';
import { requireStore } from '../src/middleware/auth.js';

const PATH = '/reports/doctor-margin/by-rules';

function layer() {
  return router.stack.find((l) => l.route && l.route.path === PATH);
}

test('the route is there, GET only, behind the store token', () => {
  const l = layer();
  assert.ok(l, `${PATH} is registered on /api/store`);
  assert.deepEqual(Object.keys(l.route.methods), ['get']);
  const at = router.stack.indexOf(l);
  const guard = router.stack.findIndex((x) => !x.route && x.handle === requireStore);
  assert.ok(guard >= 0 && guard < at, 'requireStore runs before the report');
});

test('it is the web report: same service, same filters (a bad range is a 400 before any read)', async () => {
  const src = fs.readFileSync(new URL('../src/routes/storeQuery.js', import.meta.url), 'utf8');
  assert.match(src, /import \* as dmRules from '\.\.\/services\/doctorMarginRulesStore\.js'/);
  assert.match(src, /dmRules\.report\(await storePk\(req\), req\.query\)/);
  const web = fs.readFileSync(new URL('../src/routes/web.js', import.meta.url), 'utf8');
  assert.match(web, /doctor-margin\/by-rules[\s\S]{0,200}dmRules\.report\(/);

  const handler = layer().route.stack[0].handle;
  for (const q of [{ from: '2026-10-20', to: '2026-10-01' }, { from: 'yesterday', to: '2026-10-01' }]) {
    const err = await new Promise((resolve) => {
      const res = { json: () => resolve(null) };
      handler({ auth: { type: 'store', storePk: 1 }, query: q, params: {}, headers: {} }, res, resolve);
    });
    assert.ok(err, `rejected ${JSON.stringify(q)}`);
    assert.equal(err.status ?? err.statusCode, 400);
  }
});
