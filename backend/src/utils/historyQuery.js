/** Allowed assets for history filter (aligned with payment send validators). */
const ALLOWED_HISTORY_ASSETS = ['XLM', 'USDC', 'NGN', 'GHS', 'KES'];

/**
 * Parse `from` bound: plain YYYY-MM-DD → start of that day UTC; else ISO timestamp.
 * @returns {Date|null}
 */
function parseHistoryFrom(value) {
  if (value == null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse `to` bound: plain YYYY-MM-DD → end of that day UTC; else ISO timestamp.
 * @returns {Date|null}
 */
function parseHistoryTo(value) {
  if (value == null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T23:59:59.999Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeAsset(value) {
  if (value == null || String(value).trim() === '') return null;
  const a = String(value).trim().toUpperCase();
  return ALLOWED_HISTORY_ASSETS.includes(a) ? a : null;
}

module.exports = {
  ALLOWED_HISTORY_ASSETS,
  parseHistoryFrom,
  parseHistoryTo,
  normalizeAsset,
};
