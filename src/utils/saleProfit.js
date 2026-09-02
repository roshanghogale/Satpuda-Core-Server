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

export function parseTabletsPerStripe(unitStr) {
  const s = String(unitStr ?? '').trim();
  if (!s) return 1;
  if (isStripCountUnit(s)) return 1;
  const lower = s.toLowerCase();
  if (/\b(ml|mg|g|gm|kg|l)\b/.test(lower) && !/^\d+(\.\d+)?$/.test(s)) {
    // volume/weight pack labels → treat as 1 (same spirit as Offline)
    if (!/^\d/.test(s)) return 1;
  }
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
