/**
 * Validators for GET /api/payments/history
 *
 * Issue #244:
 *  - Enforces a maximum date range of 366 days (returns 400 if exceeded).
 *  - Cross-field validation (from <= to, range check) lives here at the
 *    validator layer so it is enforced before the controller runs.
 */
const { query } = require('express-validator');
const { ALLOWED_HISTORY_ASSETS, parseHistoryFrom, parseHistoryTo, MAX_HISTORY_RANGE_DAYS } = require('../utils/historyQuery');

const historyQueryValidators = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('limit must be between 1 and 100'),

  query('from')
    .optional({ values: 'falsy' })
    .trim()
    .isISO8601()
    .withMessage('from must be a valid ISO 8601 date'),

  query('to')
    .optional({ values: 'falsy' })
    .trim()
    .isISO8601()
    .withMessage('to must be a valid ISO 8601 date'),

  query('asset')
    .optional({ values: 'falsy' })
    .trim()
    .isIn(ALLOWED_HISTORY_ASSETS)
    .withMessage(`asset must be one of: ${ALLOWED_HISTORY_ASSETS.join(', ')}`),

  // Cross-field: from must be <= to, and range must not exceed 366 days
  query('to').custom((toVal, { req }) => {
    const fromVal = req.query.from;
    if (!fromVal || !toVal) return true;

    const fromDate = parseHistoryFrom(String(fromVal).trim());
    const toDate = parseHistoryTo(String(toVal).trim());

    if (!fromDate || !toDate) return true; // individual validators will catch bad formats

    if (fromDate.getTime() > toDate.getTime()) {
      throw new Error('from must be before or equal to to');
    }

    const rangeMs = toDate.getTime() - fromDate.getTime();
    const maxMs = MAX_HISTORY_RANGE_DAYS * 24 * 60 * 60 * 1000;
    if (rangeMs > maxMs) {
      throw new Error(`Date range must not exceed ${MAX_HISTORY_RANGE_DAYS} days`);
    }

    return true;
  }),
];

module.exports = historyQueryValidators;
