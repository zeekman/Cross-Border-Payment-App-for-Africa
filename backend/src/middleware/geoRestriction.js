const geoip = require('geoip-lite');
const { redactUrl } = require('../utils/redactUrl');
const logger = require('../utils/logger');
const { auditLog } = require('../services/audit');
const { geoDenialsTotal } = require('../utils/metrics');

/**
 * Geo-restriction middleware for OFAC / UN sanctions compliance.
 *
 * BE-037: Central configurability — the restricted-country list is sourced
 * from the BLOCKED_COUNTRIES env var (ISO 3166-1 alpha-2, comma-separated),
 * not a hardcoded array. It can be updated by changing the env var/config
 * and restarting the process (or, if the deployment platform supports
 * hot-reloaded env vars, without a code deploy at all) — no source change
 * is required to add or remove a restricted jurisdiction. resolves the
 * caller's IP via geoip-lite, and returns HTTP 451 when the request
 * originates from a sanctioned jurisdiction.
 *
 * Every blocked attempt is logged at WARN level AND written to the
 * compliance audit log (services/audit.js -> audit_logs table) with the
 * country, route, timestamp, and a hashed/anonymized IP, so compliance can
 * report "how many attempts did we see from jurisdiction X last month" via
 * GET /api/admin/compliance/geo-denials.
 */

// Parse blocked countries once at startup for O(1) lookups. Re-read this
// getter (rather than inlining `blockedCountries` at every call site) so a
// future move to a DB-backed / hot-reloadable config source only needs to
// change this function, not every caller.
function loadBlockedCountries() {
  return new Set(
    (process.env.BLOCKED_COUNTRIES || '')
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean)
  );
}

let blockedCountries = loadBlockedCountries();

// Exposed for tests / ops tooling that need to force a re-read after
// mutating BLOCKED_COUNTRIES at runtime without restarting the process.
function reloadBlockedCountries() {
  blockedCountries = loadBlockedCountries();
  return blockedCountries;
}

// Whether the X-Forwarded-For header may be trusted.
// Express only honors X-Forwarded-For when `trust proxy` is explicitly
// configured. Without it, the header is attacker-controlled and must never
// be used for geo-location decisions.
function isTrustProxyConfigured(req) {
  return Boolean(req.app && req.app.get('trust proxy'));
}

function geoRestriction(req, res, next) {
  const blocked = () =>
    res.status(451).json({ error: 'Service unavailable in your jurisdiction' });

  // BE-037: write every geo-denied request to the compliance audit log
  // (country, route, timestamp, hashed/anonymized IP via auditLog's IP
  // anonymization). Fire-and-forget — audit.js already fails silently so
  // this never breaks the denial response.
  const recordDenial = (country) => {
    geoDenialsTotal.inc({ country: country || 'unknown', route: req.baseUrl || req.originalUrl });
    auditLog(req, 'geo_restriction_denied', {
      type: 'request',
      newValue: {
        country: country || null,
        route: req.baseUrl || req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString(),
      },
    }).catch(() => {});
  };

  // Determine the client IP. When `trust proxy` is configured Express has
  // already resolved req.ip from X-Forwarded-For using the configured hop
  // count, so req.ip is authoritative and no direct header access is needed.
  let ip = req.ip;
  let ipFromHeader = false;

  if (!ip && isTrustProxyConfigured(req)) {
    // Express could not resolve the address but the header is safe to parse
    // because trust proxy is explicitly enabled. Prefer req.ips (the chain
    // Express resolved) so the hop count is honored.
    ip =
      (Array.isArray(req.ips) && req.ips.length > 0 && req.ips[0]) ||
      (typeof req.headers['x-forwarded-for'] === 'string'
        ? req.headers['x-forwarded-for'].split(',')[0].trim()
        : undefined);

    if (ip) {
      ipFromHeader = true;
      logger.warn(
        'Geo-restriction: resolved client IP from X-Forwarded-For header - verify proxy configuration',
        {
          requestId: req.requestId,
          ip,
          trustProxy: String(req.app.get('trust proxy')),
          method: req.method,
          path: req.originalUrl,
        }
      );
    }
  }

  if (!ip) {
    // Cannot reliably determine the client jurisdiction. Fail closed rather
    // than trusting a client-supplied header.
    logger.warn('Geo-restriction: unable to determine client IP - request blocked (fail closed)', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      forwarded: typeof req.headers['x-forwarded-for'] === 'string'
        ? req.headers['x-forwarded-for']
        : undefined,
    });

    recordDenial(null);
    return blocked();
  }

  const geo = geoip.lookup(ip);
  const country = geo && geo.country ? geo.country.toUpperCase() : null;

  if (country && blockedCountries.has(country)) {
    logger.warn('Blocked request from sanctioned country', {
      requestId: req.requestId,
      ip,
      ipFromHeader,
      country,
      method: req.method,
      path: redactUrl(req.originalUrl),
    });

    recordDenial(country);
    return blocked();
  }

  next();
}

module.exports = geoRestriction;
module.exports.reloadBlockedCountries = reloadBlockedCountries;
