/**
 * SSRF (Server-Side Request Forgery) validation utilities
 * Shared between webhook controller and service to prevent private IP access
 */

const dns = require('dns').promises;

// RFC 1918, loopback, link-local, and cloud metadata ranges
const BLOCKED_CIDRS = [
  [0x0a000000, 0xff000000],   // 10.0.0.0/8
  [0xac100000, 0xfff00000],   // 172.16.0.0/12
  [0xc0a80000, 0xffff0000],   // 192.168.0.0/16
  [0x7f000000, 0xff000000],   // 127.0.0.0/8  (loopback)
  [0xa9fe0000, 0xffff0000],   // 169.254.0.0/16 (link-local / metadata)
  [0x64400000, 0xffc00000],   // 100.64.0.0/10 (shared address space)
  [0x00000000, 0xff000000],   // 0.0.0.0/8
  [0xe0000000, 0xf0000000],   // 224.0.0.0/4  (multicast)
  [0xf0000000, 0xf0000000],   // 240.0.0.0/4  (reserved)
];

/**
 * Convert IPv4 string to 32-bit integer
 * @param {string} ip - IPv4 address (e.g., "192.168.1.1")
 * @returns {number} 32-bit unsigned integer
 */
function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

/**
 * Check if an IP address is private/reserved
 * Blocks RFC-1918, loopback, link-local, metadata, multicast, and reserved ranges
 * @param {string} ip - IPv4 or IPv6 address
 * @returns {boolean} true if IP is private/reserved, false if public
 */
function isPrivateIp(ip) {
  // IPv6 loopback / link-local / private
  if (ip === '::1' || ip.startsWith('fe80') || ip.startsWith('fc') || ip.startsWith('fd')) {
    return true;
  }

  // Only check IPv4 if it matches IPv4 format
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return false;
  }

  const n = ipToInt(ip);
  return BLOCKED_CIDRS.some(([net, mask]) => (n & mask) === (net & mask));
}

/**
 * Validate that a URL points to a public HTTPS endpoint
 * Rejects private IPs, non-HTTPS protocols, and unresolvable hostnames
 * @param {string} url - Full URL to validate
 * @returns {Promise<boolean>} true if URL is valid public HTTPS, false otherwise
 */
async function validatePublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Only allow HTTPS
  if (parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname;

  // Reject if hostname is a bare private IP
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    if (isPrivateIp(hostname)) {
      return false;
    }
  }

  // Resolve hostname and check all returned IPs
  try {
    const { address } = await dns.lookup(hostname);
    if (isPrivateIp(address)) {
      return false;
    }
  } catch {
    return false; // unresolvable hostname
  }

  return true;
}

module.exports = {
  isPrivateIp,
  validatePublicUrl,
  BLOCKED_CIDRS,
  ipToInt,
};
