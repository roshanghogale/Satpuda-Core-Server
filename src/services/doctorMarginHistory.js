/**
 * Which doctor margin rules a bill is worked out with (owner, 23 Oct 2026).
 *
 * The PC saves each bill's margin lines when the bill is saved (core/doctor_margin_store.py):
 * a later change of the rules leaves old bills as they were, and only "Recalculate period"
 * works a period out again with the rules of that moment. The server has no saved lines; it
 * keeps every version of the rules instead and works each bill out with the version the PC
 * would have used:
 *
 *   doctor_margin_rules_history  one row per value the store's `doctor_margin_rules` setting
 *                                took, written by upsertSettingsKv (PC push, phone, web --
 *                                every path writes store_settings through it). effective_at =
 *                                the rules' own `updated` (the saving device's clock, IST),
 *                                never later than its arrival and never before the version
 *                                that arrived before it.
 *   doctor_margin_rules_recalc   the PC's (and the web's) Recalculate runs, a shop setting:
 *                                {version: 1, runs: [{from, to, at, rules_updated}]}
 *
 * A bill saved at T (sales.created_at, else updated_at) with bill date D:
 *   1. the latest Recalculate run whose period holds D and that ran after T: its rules
 *      (matched by rules_updated, else the version in force when it ran), at that time;
 *   2. else the version in force at T;
 *   3. a version giving no margin (or none yet): the PC saved nothing for the bill and
 *      worked it out when the report was next opened -- here, the first later version that
 *      gives a margin.
 * The purchase lines that count for the bill's rate are those saved by that same time (the
 * PC froze the rate with the bill). Rules never changed and no Recalculate: every bill gets
 * the one version, exactly as the PC.
 *
 * This file needs no database pool: upsertSettingsKv hands it the push's own client.
 */
import { SETTING_NAME, RECALC_SETTING, safeRules, hasRules } from './doctorMarginRules.js';

export { SETTING_NAME, RECALC_SETTING };
export const HISTORY_TABLE = 'doctor_margin_rules_history';

export const HISTORY_DDL = `
CREATE TABLE IF NOT EXISTS doctor_margin_rules_history (
  id            BIGSERIAL PRIMARY KEY,
  store_pk      INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  value         TEXT NOT NULL DEFAULT '',
  rules_updated TEXT NOT NULL DEFAULT '',
  effective_at  TIMESTAMPTZ NOT NULL,
  saved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dm_rules_history_store ON doctor_margin_rules_history (store_pk, id);
`;

const NAIVE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)$/;

/** A device time as epoch ms: a time without a zone is the shop's (IST), as the PC writes it. */
export function parseShopTime(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(NAIVE);
  const ms = Date.parse(m ? `${m[1]}T${m[2]}+05:30` : s);
  return Number.isFinite(ms) ? ms : null;
}

/** Now in the shop's time, as the PC writes `updated` ('2026-10-23T14:05:09'). */
export function shopNowText(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

function rulesUpdated(value) {
  return safeRules(value).updated;
}

/** When a value of the rules took effect: its own `updated` (whole seconds, so the end of
 *  that second: a bill saved in the same second before the change keeps the old rules), never
 *  after it arrived. */
export function effectiveFrom(value, arrivedMs) {
  const stamp = parseShopTime(rulesUpdated(value));
  if (stamp === null) return arrivedMs;
  const own = stamp + 999;
  return arrivedMs === null || arrivedMs === undefined ? own : Math.min(own, arrivedMs);
}

let tableReady = false;

/**
 * After upsertSettingsKv changed the rules row: keep the new value in the history (and, the
 * first time, the value it replaced). Never fails the push: a savepoint undoes only this.
 * prev = {value, updated_at} of the row before the write, or null.
 */
export async function recordRulesHistory(client, storePk, prev, value) {
  let sp = false;
  try {
    await client.query('SAVEPOINT dm_rules_history');
    sp = true;
    if (!tableReady) {
      await client.query(HISTORY_DDL);
      tableReady = true;
    }
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM ${HISTORY_TABLE} WHERE store_pk=$1`, [storePk],
    );
    const now = Date.now();
    const insert = (v, eff, savedAt) => client.query(
      `INSERT INTO ${HISTORY_TABLE} (store_pk, value, rules_updated, effective_at, saved_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0))`,
      [storePk, v, rulesUpdated(v), eff, savedAt],
    );
    const prevValue = prev?.value == null ? '' : String(prev.value);
    if (!Number(rows[0]?.n) && prevValue.trim()) {
      const prevAt = parseShopTime(prev.updated_at) ?? now;
      await insert(prevValue, effectiveFrom(prevValue, prevAt), prevAt);
    }
    const v = value == null ? '' : String(value);
    await insert(v, effectiveFrom(v, now), now);
    await client.query('RELEASE SAVEPOINT dm_rules_history');
  } catch (err) {
    if (sp) {
      try {
        await client.query('ROLLBACK TO SAVEPOINT dm_rules_history');
        await client.query('RELEASE SAVEPOINT dm_rules_history');
      } catch { /* the push's own error handling takes over */ }
    }
    tableReady = false;
    console.warn('[doctor-margin] rules history not kept:', err?.message || err);
  }
}

// ── picking the version (pure) ──────────────────────────────────────────────────────────

/**
 * The versions in the order they arrived, each in force from `from` (ms) -- never before the
 * one that arrived before it, so the last to arrive (= the store's setting now) is in force
 * at the end. history: [{id, value, effective_at, saved_at}] (any order); current: the
 * setting row now ({value, updated_at}) or null -- added when the history does not end with it
 * (rules saved before the history existed, or a history write that failed).
 */
export function buildVersions(history, current) {
  const rows = [...(history || [])].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  const curValue = current?.value == null ? '' : String(current.value);
  if (curValue.trim() && (!rows.length || String(rows[rows.length - 1].value ?? '') !== curValue)) {
    const at = parseShopTime(current.updated_at) ?? Date.now();
    rows.push({ id: Infinity, value: curValue, effective_at: effectiveFrom(curValue, at), saved_at: at });
  }
  const out = [];
  let floor = -Infinity;
  rows.forEach((r, i) => {
    const rules = safeRules(r.value);
    const own = parseShopTime(r.effective_at);
    const from = Math.max(own ?? floor, floor);
    floor = from;
    out.push({ n: i, from, updated: rules.updated, rules, has: hasRules(rules) });
  });
  return out;
}

/** The Recalculate runs from the setting's value: [{from, to, at (ms), rules_updated}]. */
export function parseRuns(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = raw.trim() ? JSON.parse(raw) : {}; } catch { data = {}; }
  }
  const runs = data && typeof data === 'object' && Array.isArray(data.runs) ? data.runs : [];
  const out = [];
  for (const r of runs) {
    if (!r || typeof r !== 'object') continue;
    const from = String(r.from || '').slice(0, 10);
    const to = String(r.to || '').slice(0, 10);
    const at = parseShopTime(r.at);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || at === null) continue;
    // `at` is whole seconds: the end of that second (a bill saved just before it is covered).
    out.push({ from, to, at: at + 999, rules_updated: String(r.rules_updated || '') });
  }
  return out;
}

function inForce(versions, t) {
  let v = null;
  for (const x of versions) if (x.from <= t) v = x;
  return v;
}

/**
 * {version, at, via} for a bill of date `billDate` (YYYY-MM-DD) saved at `savedMs`, or null
 * when no version gives a margin. via: 'saved' | 'recalculated' | 'first_rules'.
 */
export function pickVersion(versions, runs, billDate, savedMs) {
  if (!versions.length) return null;
  const saved = Number.isFinite(savedMs) ? savedMs : Infinity;
  let run = null;
  for (const r of runs || []) {
    if (r.from <= billDate && billDate <= r.to && r.at > saved && (!run || r.at >= run.at)) run = r;
  }
  let at = saved;
  let version;
  let via = 'saved';
  if (run) {
    at = run.at;
    via = 'recalculated';
    // The rules that run used, by their `updated` stamp (the PC's clock and the server's
    // may disagree by minutes); a run naming no known version: the one in force then.
    version = (run.rules_updated && [...versions].reverse().find((x) => x.updated === run.rules_updated))
      || inForce(versions, run.at);
  } else {
    version = inForce(versions, saved === Infinity ? versions[versions.length - 1].from : saved);
  }
  if (!version || !version.has) {
    const start = version ? version.n + 1 : 0;
    const later = versions.slice(start).find((x) => x.has);
    if (!later) return null;
    return { version: later, at: Math.max(at === Infinity ? later.from : at, later.from), via: 'first_rules' };
  }
  return { version, at, via };
}
