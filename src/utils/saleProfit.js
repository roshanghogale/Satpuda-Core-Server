/**
 * Mirrors Offline mac2/core/stock_utils.effective_cost_per_unit + sale_line_profit.
 * Strip Tablet/Capsule/Bolus: medicines.rate is strip cost; qty is tablets.
 */

const STRIP_UNIT_CODES = new Set(['d', 'tab', 'tabs', 'tablet', 'tablets']);
const LEGACY_STRIP_TYPES = new Set(['tablet', 'bolus', 'capsule']);

function isStripCountUnit(unit) {
  const u = String(unit || '').trim().toLowerCase();
  if (u === 'g' || u === 'gm' || u === 'gram' || u === 'grams') return false;
  if (u === 'ml' || u === 'milliliter' || u === 'milliliters') return false;
  return STRIP_UNIT_CODES.has(u);
}

export function isStripCountType(medType, unit) {
  const t = String(medType || '').trim().toLowerCase();
  if (t === 'tablet pack' || t === 'bolus pack') return false;
  if (LEGACY_STRIP_TYPES.has(t)) return true;
  return isStripCountUnit(unit);
}

/**
 * A liquid/powder pack size (500ML, 100GM, 1LTR) — never a strip count.
 *
 * This is `pack_is_volume_or_weight` from the desktop
 * (`mac2/core/bill_import_normalize.py:35-38, 143-148`), regex for regex:
 *   ^\d+(?:\.\d+)?\s*(GM|G|MG|ML|MD|KG|L|LI|LTR|LT)$   case-insensitive,
 * matched after whitespace is stripped.
 */
const VOLUME_PACK_RE = /^\d+(?:\.\d+)?(GM|G|MG|ML|MD|KG|L|LI|LTR|LT)$/i;

export function packIsVolumeOrWeight(pack) {
  const text = String(pack ?? '').trim().replace(/\s+/g, '');
  if (!text) return false;
  return VOLUME_PACK_RE.test(text);
}

export function parseTabletsPerStripe(unitStr) {
  const s = String(unitStr ?? '').trim();
  if (!s) return 1;
  if (isStripCountUnit(s)) return 1;
  // The guard this replaces was `/\b(ml|mg|g|gm|kg|l)\b/` — and there is NO word
  // boundary between the `0` of "30" and the `m` of "ml", because both are word
  // characters. So "30ML" never matched, fell through to "first digit group", and
  // came back as tps = 30 where the desktop says 1.
  //
  // Live Roshan, medicine 900038 STECLIN INJ 30ML (type Bolus, so isStripCountType is
  // true), stock 2 at MRP 315: the desktop values it at 630.00 and this valued it at
  // 21.00, and the store's Stock Value tile therefore read 344,854.86 here against
  // 345,463.86 on the desktop — a Rs 609 gap on the owner's headline tile, with both
  // clients showing THIS number because online reads the server. The same divergence
  // feeds effectiveCostPerUnit, so every profit figure inherited it.
  //
  // Any <digits>ML / <digits>GM / <digits>LTR unit on a Tablet, Bolus or Capsule row
  // hits this; STECLIN is just the one row in Roshan that does today.
  if (packIsVolumeOrWeight(s)) return 1;
  const xMatch = s.match(/^1\s*[Xx×*]\s*(\d+)$/);
  if (xMatch) return Math.max(1, parseInt(xMatch[1], 10));
  const asFloat = Number(s);
  if (Number.isFinite(asFloat) && asFloat > 0) return Math.max(1, Math.trunc(asFloat));
  const nums = s.match(/\d+/g);
  return nums && nums.length ? Math.max(1, parseInt(nums[0], 10)) : 1;
}

/** Per-unit purchase cost for profit (handles legacy strip-rate snapshots). */
export function effectiveCostPerUnit(costPrice, purchaseRate, medType, unit) {
  const cp = Number(costPrice) || 0;
  const pr = Number(purchaseRate) || 0;
  if (isStripCountType(medType, unit)) {
    const tps = Math.max(1, parseTabletsPerStripe(unit));
    if (cp > 0) {
      if (pr > 0 && Math.abs(cp - pr) < 0.02) return cp / tps;
      return cp;
    }
    return pr > 0 ? pr / tps : 0;
  }
  return cp > 0 ? cp : pr;
}

export function saleLineProfit(amount, qty, costPrice, purchaseRate, medType, unit) {
  const q = Number(qty) || 0;
  if (q <= 0) return 0;
  const cpu = effectiveCostPerUnit(costPrice, purchaseRate, medType, unit);
  return Math.round((Number(amount || 0) - q * cpu) * 100) / 100;
}

/** Offline stock_utils.stock_value_at_mrp — strip MRP is per-strip, stock is tablets. */
export function stockValueAtMrp(stockQty, mrp, medType, unit) {
  const qty = Number(stockQty) || 0;
  if (qty <= 0) return 0;
  let unitMrp = Number(mrp) || 0;
  if (unitMrp <= 0) return 0;
  if (isStripCountType(medType, unit)) {
    const tps = Math.max(1, parseTabletsPerStripe(unit));
    unitMrp /= tps;
  }
  return Math.round(qty * unitMrp * 100) / 100;
}
