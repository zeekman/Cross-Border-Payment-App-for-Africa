'use strict';
/**
 * Shared SSRF protection for any feature that fetches a user- or
 * partner-supplied URL (webhooks, SEP-31 callbacks, etc.).
 *
 * Resolve-then-validate: the hostname is DNS-resolved and the *resolved* IP
 * is checked against the private/reserved ranges, not just the hostname
 * string. Callers that hold onto a validated URL for any length of time
 * (retry loops, queued deliveries) MUST re-validate immediately before each
 * outbound request to defend against DNS rebinding.
 */
const dns = require('dns').promises;

const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.internal', 'localhost'];

/**
 * Validates that `url` is https:// and resolves to a public IP address.
 * Returns true only if the URL is safe to fetch *right now* — callers that
 * delay delivery must call this again immediately before the request.
 */
async function validatePublicUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAME_SUFFIXES.some((s) => hostname === s || hostname.endsWith(s))) return false;

  // Reject if hostname is a bare IP in a blocked range
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && isPrivateIp(hostname)) return false;

  // Resolve hostname and check the actually-connected IP (defends against
  // DNS rebinding — a name that only resolves to a private IP at request time).
  try {
    const { address } = await dns.lookup(hostname);
    if (isPrivateIp(address)) return false;
  } catch {
    return false; // unresolvable hostname
  }
  return true;
}

/**
 * SSRF protection utility.
 * Validates outbound URLs to prevent Server-Side Request Forgery attacks.
 *
 * DNS-Rebinding Protection:
 * - Resolves all A/AAAA records for the hostname
 * - Validates every resolved IP against the blocklist
 * - Returns a pinned IP and a custom agent so the actual request
 *   connects to the validated IP (not a fresh DNS lookup)
 *
 * Used by webhook registration, delivery, and SEP-31 callback endpoints.
 */

const { resolveAllIps, createPinnedAgent } = require('./pinnedAgent');
const { isPrivateIp } = require('./ssrfValidator');

// Parse optional trusted CIDR allowlist from environment
function parseAllowedCidrs() {
  const raw = process.env.WEBHOOK_ALLOWED_CIDRS || '';
  return raw.split(',').filter(Boolean).map(cidr => {
    const [ip, bits] = cidr.trim().split('/');
    const prefix = parseInt(bits || '32', 10);
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const net = ip.split('.').reduce((a, o) => (a << 8) + parseInt(o, 10), 0) >>> 0;
    return { net: net & mask, mask };
  });
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
}

function isAllowlisted(ip, allowedCidrs) {
  if (!allowedCidrs.length) return false;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const n = ipToInt(ip);
  return allowedCidrs.some(({ net, mask }) => (n & mask) === net);
}

const ALLOWED_SCHEMES = new Set(['https:', 'http:']);

/**
 * Validate that an outbound URL is safe to request.
 *
 * DNS-Rebinding Protection:
 * - Resolves ALL A/AAAA records for the hostname (not just the first)
 * - Validates EVERY resolved IP against the private-IP blocklist
 * - Returns a pinned IP and agent so callers don't perform a second DNS lookup
 *
 * Rejects:
 * - Non-HTTP(S) schemes (ftp, file, gopher, etc.)
 * - URLs resolving to private/loopback/link-local IPs
 * - Unresolvable hostnames
 * - URLs where ANY resolved IP is private (unless allowlisted)
 *
 * Allows:
 * - Public HTTPS/HTTP URLs where ALL resolved IPs are public
 * - IPs in WEBHOOK_ALLOWED_CIDRS (for self-hosted/test environments)
 *
 * @param {string} url
 * @returns {Promise<{ valid: boolean, error?: string, pinnedIp?: string, agent?: import('https').Agent }>}
 */
async function validateOutboundUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { valid: false, error: `Scheme "${parsed.protocol}" is not allowed. Only http and https are permitted.` };
  }

  const hostname = parsed.hostname;
  const allowedCidrs = parseAllowedCidrs();

  // Bare IP address
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    if (isPrivateIp(hostname) && !isAllowlisted(hostname, allowedCidrs)) {
      return { valid: false, error: 'SSRF_BLOCKED' };
    }
    const protocol = parsed.protocol.replace(':', '');
    return { valid: true, pinnedIp: hostname, agent: createPinnedAgent(hostname, hostname, protocol) };
  }

  // Resolve hostname – get ALL IPs
  let allIps;
  try {
    allIps = await resolveAllIps(hostname);
  } catch {
    return { valid: false, error: 'Hostname could not be resolved' };
  }

  if (!allIps.length) {
    return { valid: false, error: 'Hostname could not be resolved' };
  }

  // Validate EVERY resolved IP
  for (const ip of allIps) {
    if (isPrivateIp(ip) && !isAllowlisted(ip, allowedCidrs)) {
      return { valid: false, error: 'SSRF_BLOCKED' };
    }
  }

  // Pin to the first public IP and create agent
  const pinnedIp = allIps[0];
  const protocol = parsed.protocol.replace(':', '');
  const agent = createPinnedAgent(hostname, pinnedIp, protocol);

  return { valid: true, pinnedIp, agent };
}

module.exports = { validateOutboundUrl, validatePublicUrl };
