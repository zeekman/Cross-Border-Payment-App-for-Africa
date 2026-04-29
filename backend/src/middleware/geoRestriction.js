const geoip = require('geoip-lite');
const logger = require('../utils/logger');

/**
 * Geo-restriction middleware for OFAC / UN sanctions compliance.
 *
 * Reads the comma-separated BLOCKED_COUNTRIES env var (ISO 3166-1 alpha-2),
 * resolves the caller's IP via geoip-lite, and returns HTTP 451 when the
 * request originates from a sanctioned jurisdiction.
 *
 * Every blocked attempt is logged at WARN level for compliance audit.
 */

// Parse blocked countries once at startup for O(1) lookups.
const blockedCountries = new Set(
  (process.env.BLOCKED_COUNTRIES || '')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean)
);

module.exports = function geoRestriction(req, res, next) {
  // Determine the client IP.
  // When behind a reverse proxy with trust-proxy enabled, req.ip already
  // contains the real client address. Fall back to x-forwarded-for header.
  const forwarded = req.headers['x-forwarded-for'];
  const ip =
    req.ip ||
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : undefined);

  if (!ip) {
    // Cannot determine IP – let the request through (fail-open).
    return next();
  }

  const geo = geoip.lookup(ip);
  const country = geo && geo.country ? geo.country.toUpperCase() : null;

  if (country && blockedCountries.has(country)) {
    logger.warn('Blocked request from sanctioned country', {
      requestId: req.requestId,
      ip,
      country,
      method: req.method,
      path: req.originalUrl,
    });

    return res.status(451).json({
      error: 'Service unavailable in your jurisdiction',
    });
  }

  next();
};
