/** Allowed assets for history filter (aligned with payment send validators). */
const ALLOWED_HISTORY_ASSETS = ['XLM', 'USDC', 'NGN', 'GHS', 'KES'];

/** Maximum allowed date range for history queries (issue #244). */
const MAX_HISTORY_RANGE_DAYS = 366;
const MAX_HISTORY_RANGE_MS = MAX_HISTORY_RANGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Parse `from` bound: plain YYYY-MM-DD -> start of that day UTC; else ISO timestamp.
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
 * Parse `to` bound: plain YYYY-MM-DD -> end of that day UTC; else ISO timestamp.
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

/**
 * Validate that the date range between `from` and `to` does not exceed
 * MAX_HISTORY_RANGE_DAYS (366). Both arguments must be Date objects.
 * Returns an error message string if invalid, or null if valid.
 *
 * Issue #244: cross-field range validation lives here so it can be reused
 * by both the validator layer and the controller.
 */
function validateDateRange(fromDate, toDate) {
  if (!fromDate || !toDate) return null;
  if (toDate.getTime() - fromDate.getTime() > MAX_HISTORY_RANGE_MS) {
    return `Date range must not exceed ${MAX_HISTORY_RANGE_DAYS} days`;
  }
  return null;
}

module.exports = {
  ALLOWED_HISTORY_ASSETS,
  MAX_HISTORY_RANGE_DAYS,
  parseHistoryFrom,
  parseHistoryTo,
  normalizeAsset,
  validateDateRange,
};
