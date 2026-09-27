import { Router } from 'express';
import { asyncHandler, ok, AppError } from '../utils/http.js';
import { requireStore, resolveStorePk } from '../middleware/auth.js';
import {
  COLLECTIONS,
  SPECIAL_COLLECTIONS,
  pushDocs,
  pushBundle,
  pullCollection,
  pullDoc,
  pullAll,
  allocateFySerial,
  peekFySerial,
  softDeleteDoc,
  hardDeleteDoc,
  allocateLocalIds,
} from '../services/syncService.js';
// Optional exports (added after the named ones above) are read off the namespace, so an
// older syncService.js without them still links; see the by-ref route below.
import * as syncServiceModule from '../services/syncService.js';
import {
  getSyncStatus,
  getChanges,
  getChangesFull,
  ackDeviceRevision,
} from '../services/syncRevision.js';

const router = Router();
router.use(requireStore);

const ALL = new Set([...COLLECTIONS, ...SPECIAL_COLLECTIONS]);

async function storePk(req) {
  return resolveStorePk(req);
}

function assertCollection(name) {
  if (!ALL.has(name) && !COLLECTIONS.includes(name)) {
    throw new AppError(400, `Unknown collection: ${name}`);
  }
}

/** Full pull */
router.get('/', asyncHandler(async (req, res) => {
  ok(res, await pullAll(await storePk(req), { since: req.query.since }), {
    since: req.query.since || null,
    server_time: new Date().toISOString(),
  });
}));

/** Option B: safety-poll head revision (WebSocket backup) */
router.get('/status', asyncHandler(async (req, res) => {
  ok(res, await getSyncStatus(await storePk(req)));
}));

/** Option B: pull changelog rows after a revision */
router.get('/changes', asyncHandler(async (req, res) => {
  const full = req.query.full === '1' || req.query.full === 'true';
  const opts = { after: req.query.after, limit: req.query.limit };
  const pk = await storePk(req);
  ok(res, full ? await getChangesFull(pk, opts) : await getChanges(pk, opts));
}));

/** Option B: primary client endpoint — changelog + entity docs */
router.get('/changes/full', asyncHandler(async (req, res) => {
  ok(
    res,
    await getChangesFull(await storePk(req), {
      after: req.query.after,
      limit: req.query.limit,
    }),
  );
}));

/** B4.3: device acknowledges applied head revision (admin lag) */
router.post('/ack', asyncHandler(async (req, res) => {
  const pk = await storePk(req);
  const deviceId = req.auth?.deviceId || req.body?.device_id || null;
  const revision = req.body?.revision ?? req.body?.head_revision;
  ok(res, await ackDeviceRevision(pk, deviceId, revision));
}));

router.post('/bundle', asyncHandler(async (req, res) => {
  ok(res, await pushBundle(await storePk(req), req.body || {}));
}));

/** Allocate next local_id(s) for server-only clients */
router.post('/allocate-ids', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const requests = Array.isArray(body.requests)
    ? body.requests
    : body.collection
      ? [{ collection: body.collection, count: body.count || 1 }]
      : [];
  ok(res, await allocateLocalIds(await storePk(req), requests));
}));

/** A bill date the FY series can use: YYYY-MM-DD with a year from 2000 to 2100, or none.
 *  A PC typing a year into its Bill Date box sent "0020-07-21" and Postgres threw a 500
 *  (118 times in the log, 2026-09-27): that is a bad request, said as one. */
function fyDate(date) {
  if (date == null || date === '') return date;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date).trim().slice(0, 10));
  const year = m ? Number(m[1]) : 0;
  if (!m || year < 2000 || year > 2100) {
    throw new AppError(400, 'date must be YYYY-MM-DD with a year from 2000 to 2100');
  }
  return m[0];
}

router.post('/fy/allocate', asyncHandler(async (req, res) => {
  const { kind, date } = req.body || {};
  if (!['sales', 'purchases'].includes(kind)) throw new AppError(400, 'kind must be sales|purchases');
  ok(res, await allocateFySerial(await storePk(req), kind, fyDate(date)));
}));

router.get('/fy/peek', asyncHandler(async (req, res) => {
  const kind = req.query.kind;
  const date = req.query.date;
  if (!['sales', 'purchases'].includes(kind)) throw new AppError(400, 'kind must be sales|purchases');
  ok(res, await peekFySerial(await storePk(req), kind, fyDate(date)));
}));

router.put('/settings/pharmacy_profile', asyncHandler(async (req, res) => {
  ok(res, await pushBundle(await storePk(req), { pharmacy_profile: req.body }));
}));
router.put('/settings/dropdowns', asyncHandler(async (req, res) => {
  ok(res, await pushBundle(await storePk(req), { dropdowns: req.body }));
}));
router.put('/settings/shelf_settings', asyncHandler(async (req, res) => {
  ok(res, await pushBundle(await storePk(req), { shelf_settings: req.body }));
}));
router.put('/settings/kv', asyncHandler(async (req, res) => {
  const docs = Array.isArray(req.body) ? req.body : (req.body?.settings || [req.body]);
  ok(res, await pushDocs(await storePk(req), 'settings', docs));
}));

router.get('/settings/pharmacy_profile', asyncHandler(async (req, res) => {
  ok(res, await pullCollection(await storePk(req), 'pharmacy_profile'));
}));
router.get('/settings/dropdowns', asyncHandler(async (req, res) => {
  ok(res, await pullCollection(await storePk(req), 'dropdowns'));
}));
router.get('/settings/shelf_settings', asyncHandler(async (req, res) => {
  ok(res, await pullCollection(await storePk(req), 'shelf_settings'));
}));
router.get('/settings/kv', asyncHandler(async (req, res) => {
  ok(res, await pullCollection(await storePk(req), 'settings', { since: req.query.since }));
}));

/**
 * One document's stock ledger, e.g. ?ref_collection=purchases&ref_id=42: the ops that
 * purchase logged, so an edit reverses exactly those. Registered before
 * /:collection/:localId, which would otherwise read "by-ref" as a local id.
 *
 * Only registered when syncService.js has fetchStockOpsByRef. A named import of it would
 * stop the whole server from starting next to an older syncService.js (e.g. when that one
 * file is rolled back on its own). Without it the path answers exactly as before this
 * route existed: the /:collection/:localId handler below.
 */
const fetchStockOpsByRef = typeof syncServiceModule.fetchStockOpsByRef === 'function'
  ? syncServiceModule.fetchStockOpsByRef
  : null;
if (fetchStockOpsByRef) {
  router.get('/stock_operations/by-ref', asyncHandler(async (req, res) => {
    const pk = await storePk(req);
    ok(res, await fetchStockOpsByRef(pk, req.query.ref_collection, req.query.ref_id));
  }));
} else {
  console.warn(
    '[sync] services/syncService.js has no fetchStockOpsByRef: GET /api/sync/stock_operations/by-ref '
    + 'is not served and answers as it did before that route existed',
  );
}

/** Soft-delete masters; permanent hard-delete for sales/purchases */
router.delete('/:collection/:localId', asyncHandler(async (req, res) => {
  const { collection, localId } = req.params;
  const deviceId = req.auth.deviceId || null;
  const pk = await storePk(req);
  if (collection === 'sales' || collection === 'purchases') {
    ok(res, await hardDeleteDoc(pk, collection, Number(localId), deviceId));
    return;
  }
  ok(res, await softDeleteDoc(pk, collection, Number(localId), deviceId));
}));

/** Pull one document by local id (Online edit / refresh) */
router.get('/:collection/:localId', asyncHandler(async (req, res) => {
  assertCollection(req.params.collection);
  ok(res, await pullDoc(await storePk(req), req.params.collection, req.params.localId));
}));

/** Push one collection (create/update) */
router.post('/:collection', asyncHandler(async (req, res) => {
  assertCollection(req.params.collection);
  const docs = Array.isArray(req.body) ? req.body : (req.body?.docs || [req.body]);
  ok(res, await pushDocs(await storePk(req), req.params.collection, docs.filter(Boolean)));
}));

/** Pull one collection */
router.get('/:collection', asyncHandler(async (req, res) => {
  assertCollection(req.params.collection);
  const data = await pullCollection(await storePk(req), req.params.collection, {
    since: req.query.since,
    afterId: req.query.after_id,
    includeDeleted: req.query.include_deleted !== '0',
    limit: req.query.limit,
  });
  ok(res, data, {
    since: req.query.since || null,
    after_id: req.query.after_id || null,
    server_time: new Date().toISOString(),
  });
}));

export default router;
