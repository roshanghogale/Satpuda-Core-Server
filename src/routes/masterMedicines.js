import { Router } from 'express';
import { asyncHandler, ok, AppError } from '../utils/http.js';
import { requireStore } from '../middleware/auth.js';
import * as master from '../services/masterMedicineService.js';

const router = Router();
router.use(requireStore);

/** Incremental pull of global master catalog */
router.get('/', asyncHandler(async (req, res) => {
  const docs = await master.pullGlobalMaster({
    since: req.query.since || null,
    limit: req.query.limit,
    afterId: req.query.after_id || req.query.afterId || 0,
    includeDeleted: String(req.query.include_deleted || '1') !== '0',
  });
  ok(res, { docs, count: docs.length }, {
    server_time: new Date().toISOString(),
    since: req.query.since || null,
  });
}));

/** Full export for offline replace / build packaging */
router.get('/export', asyncHandler(async (req, res) => {
  const docs = await master.exportGlobalMaster({
    q: req.query.q || '',
    limit: req.query.limit || 0,
  });
  ok(res, {
    docs,
    count: docs.length,
    total: await master.countGlobalMaster(),
  }, { server_time: new Date().toISOString() });
}));

/** Purchase dropdown search (prefix then contains) */
router.get('/search', asyncHandler(async (req, res) => {
  const rows = await master.searchGlobalMaster({
    q: req.query.q || '',
    limit: req.query.limit || 50,
  });
  ok(res, {
    medicines: rows.map((r) => ({
      name: r.name,
      type: r.med_type || '',
      med_type: r.med_type || '',
      pack_size: r.pack_size || '',
      manufacturer: r.manufacturer || '',
      mrp: r.mrp ?? 0,
      schedule: r.schedule || '',
      hsn_code: r.hsn_code || '',
      gst_percent: r.gst_percent ?? 0,
      content_drug: r.content_drug || '',
      source: 'master',
    })),
    count: rows.length,
  });
}));

/** Alphabetical chunk for progressive cache (A–Z / #) */
router.get('/chunk', asyncHandler(async (req, res) => {
  const chunk = await master.chunkGlobalMaster({
    letter: req.query.letter || req.query.prefix || '',
    afterName: req.query.after || req.query.after_name || '',
    limit: req.query.limit || 500,
  });
  ok(res, chunk, { server_time: new Date().toISOString() });
}));

/** Batch upsert / enrich into global catalog */
router.post('/upsert', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const docs = Array.isArray(body.docs)
    ? body.docs
    : Array.isArray(body.medicines)
      ? body.medicines
      : Array.isArray(body)
        ? body
        : null;
  if (!docs) throw new AppError(400, 'docs array required');
  const enrich = !!(body.enrich || body._enrich);
  // Stamp device_id from auth when missing
  const deviceId = req.auth?.deviceId || null;
  const stamped = docs.map((d) => ({
    ...d,
    device_id: d.device_id || deviceId,
  }));
  ok(res, await master.upsertGlobalMasterBatch(stamped, { enrich }));
}));

router.get('/stats', asyncHandler(async (_req, res) => {
  ok(res, { total: await master.countGlobalMaster() });
}));

export default router;
