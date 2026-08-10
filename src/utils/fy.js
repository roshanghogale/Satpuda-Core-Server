import crypto from 'crypto';

/** Indian FY helpers — mirrors mac2/core/fy_serial.py */

export function fyStartYearForDate(value) {
  let d;
  if (!value) d = new Date();
  else if (value instanceof Date) d = value;
  else {
    const raw = String(value).trim().slice(0, 10);
    d = new Date(raw + 'T00:00:00');
    if (Number.isNaN(d.getTime())) d = new Date();
  }
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  return month >= 4 ? year : year - 1;
}

export function fyLabel(fyStartYear) {
  const y2 = fyStartYear + 1;
  return `${fyStartYear}-${String(y2).slice(2)}`;
}

export function fyTag(fyStartYear) {
  return `/FY${fyLabel(fyStartYear)}`;
}

export function fyDateBounds(fyStartYear) {
  return [`${fyStartYear}-04-01`, `${fyStartYear + 1}-03-31`];
}

export function encodeSalesBillNo(serial, fyStartYear, prefix = 'SCB') {
  return `${prefix}${serial}${fyTag(fyStartYear)}`;
}

export function encodePurchaseNo(serial, fyStartYear, prefix = '') {
  const body = prefix ? `${prefix}${serial}` : String(serial);
  return `${body}${fyTag(fyStartYear)}`;
}

export function displaySalesBillNo(billNo) {
  const raw = String(billNo || '').trim();
  if (!raw) return '';
  if (raw.includes('/FY')) return raw.split('/FY')[0];
  return raw;
}

export function displayPurchaseNo(purchaseNo) {
  const raw = String(purchaseNo || '').trim();
  if (!raw) return '';
  if (raw.includes('/FY')) return raw.split('/FY')[0];
  return raw;
}

export function nowIso() {
  return new Date().toISOString();
}

export function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  return false;
}

export function parseTs(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function slugifyStoreId(name) {
  return `store_${String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)}`;
}

export function storeKeyFromName(name) {
  const clean = String(name).trim().replace(/\s+/g, '_');
  return clean.startsWith('Store_') ? clean : `Store_${clean}`;
}

export function generateAndroidKey() {
  return `SC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}
