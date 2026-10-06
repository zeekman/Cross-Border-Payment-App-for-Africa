const { BlockList, isIP } = require('net');
const logger = require('../utils/logger');

/**
 * Parse a comma-separated list of IPv4/IPv6 addresses or CIDRs into a BlockList.
 * Returns { list, count } where count is the number of valid entries.
 */
function parseAllowlist(raw) {
  const list = new BlockList();
  let count = 0;
  for (const entry of raw.split(',')) {
    const [ip, bits] = entry.trim().split('/');
    const family = isIP(ip);
    if (!family) continue;
    const type = family === 6 ? 'ipv6' : 'ipv4';
    const max = family === 6 ? 128 : 32;
    const prefix = bits !== undefined ? parseInt(bits, 10) : max;
    if (Number.isNaN(prefix) || prefix < 0 || prefix > max) continue;
    list.addSubnet(ip, prefix, type);
    count++;
  }
  return { list, count };
}

function normaliseIp(ip) {
  return (ip || '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1'); // IPv4-mapped IPv6
}

/**
 * Build the IP allowlist middleware.
 * Reads ADMIN_IP_ALLOWLIST from env (comma-separated IPv4/IPv6 CIDRs).
 * If unset: allows all traffic outside production, but fails closed (403) in production.
 * Relies on req.ip, so `trust proxy` must be configured correctly behind a load balancer.
 */
function buildIpAllowlist(env = process.env) {
  const raw = env.ADMIN_IP_ALLOWLIST;

  if (!raw || !raw.trim()) {
    if (env.NODE_ENV === 'production') {
      logger.error('ADMIN_IP_ALLOWLIST is not set in production — blocking all admin routes');
      return function ipAllowlist(req, res) {
        logger.warn('Admin access blocked: ADMIN_IP_ALLOWLIST not configured', { ip: req.ip, path: req.path });
        return res.status(403).end();
      };
    }
    logger.warn('ADMIN_IP_ALLOWLIST is not set — admin routes are accessible from any IP');
    return (_req, _res, next) => next();
  }

  const { list, count } = parseAllowlist(raw);

  if (count === 0) {
    logger.warn('ADMIN_IP_ALLOWLIST is set but contains no valid CIDR ranges — blocking all IPs');
  }

  return function ipAllowlist(req, res, next) {
    const ip = normaliseIp(req.ip);
    const family = isIP(ip);
    const allowed = family !== 0 && list.check(ip, family === 6 ? 'ipv6' : 'ipv4');

    if (!allowed) {
      logger.warn('Admin access blocked by IP allowlist', { ip, path: req.path });
      return res.status(403).end();
    }

    next();
  };
}

module.exports = buildIpAllowlist();
module.exports.buildIpAllowlist = buildIpAllowlist;
