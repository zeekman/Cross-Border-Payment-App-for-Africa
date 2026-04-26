const { isIPv4 } = require('net');
const logger = require('../utils/logger');

/**
 * Parse CIDR string into { networkInt, mask } for IPv4.
 */
function parseCidr(cidr) {
  const [ip, bits] = cidr.trim().split('/');
  if (!isIPv4(ip)) return null;
  const prefix = bits !== undefined ? parseInt(bits, 10) : 32;
  if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const networkInt = ipToInt(ip) & mask;
  return { networkInt, mask };
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function ipInCidr(ip, { networkInt, mask }) {
  return (ipToInt(ip) & mask) === networkInt;
}

/**
 * Build the IP allowlist middleware.
 * Reads ADMIN_IP_ALLOWLIST from env (comma-separated CIDRs).
 * If unset, logs a warning and allows all traffic (backward compatible).
 */
function buildIpAllowlist() {
  const raw = process.env.ADMIN_IP_ALLOWLIST;

  if (!raw || !raw.trim()) {
    logger.warn('ADMIN_IP_ALLOWLIST is not set — admin routes are accessible from any IP');
    return (_req, _res, next) => next();
  }

  const ranges = raw
    .split(',')
    .map(parseCidr)
    .filter(Boolean);

  if (ranges.length === 0) {
    logger.warn('ADMIN_IP_ALLOWLIST is set but contains no valid CIDR ranges — blocking all IPs');
  }

  return function ipAllowlist(req, res, next) {
    const ip = (req.ip || '').replace(/^::ffff:/, ''); // normalise IPv4-mapped IPv6

    const allowed = isIPv4(ip) && ranges.some(r => ipInCidr(ip, r));

    if (!allowed) {
      logger.warn('Admin access blocked by IP allowlist', { ip, path: req.path });
      return res.status(403).end();
    }

    next();
  };
}

module.exports = buildIpAllowlist();
