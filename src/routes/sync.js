import { Router } from 'express';
import { asyncHandler, ok, AppError } from '../utils/http.js';
import { requireStore, resolveStorePk } from '../middleware/auth.js';
import {
  COLLECTIONS,
  SPECIAL_COLLECTIONS,
  pushDocs,
  pushBundle,
  pullCollection,
  pullAll,
  allocateFySerial,
  softDeleteDoc,
} from '../services/syncService.js';
import { getSyncStatus, getChanges, getChangesFull } from '../services/syncRevision.js';

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

router.post('/bundle', asyncHandler(async (req, res) => {
  ok(res, await pushBundle(await storePk(req), req.body || {}));
}));

router.post('/fy/allocate', asyncHandler(async (req, res) => {
  const { kind, date } = req.body || {};
  if (!['sales', 'purchases'].includes(kind)) throw new AppError(400, 'kind must be sales|purchases');
  ok(res, await allocateFySerial(await storePk(req), kind, date));
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

/** Soft-delete (appends sync_changes with operation=delete) */
router.delete('/:collection/:localId', asyncHandler(async (req, res) => {
  const { collection, localId } = req.params;
  ok(
    res,
    await softDeleteDoc(
      await storePk(req),
      collection,
      Number(localId),
      req.auth.deviceId || null,
    ),
  );
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
