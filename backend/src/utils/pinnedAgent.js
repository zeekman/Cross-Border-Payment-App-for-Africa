/**
 * DNS-pinned HTTP/HTTPS agent for SSRF protection.
 *
 * Resolves a hostname once, validates the IP, and forces all subsequent
 * connections to that exact IP while preserving the Host header and TLS SNI.
 */

const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns').promises;

/**
 * Resolve all IP addresses for a hostname.
 * @param {string} hostname
 * @returns {Promise<string[]>} Array of IP address strings
 */
async function resolveAllIps(hostname) {
  const results = [];
  try {
    const v4 = await dns.resolve4(hostname);
    results.push(...v4);
  } catch {}
  try {
    const v6 = await dns.resolve6(hostname);
    results.push(...v6);
  } catch {}
  return results;
}

/**
 * Create an HTTP(S) agent pinned to a specific resolved IP.
 *
 * @param {string} hostname - Original hostname (for Host header and SNI)
 * @param {string} ip - Validated IP address to connect to
 * @param {'http'|'https'} protocol - Connection protocol
 * @returns {http.Agent|https.Agent}
 */
function createPinnedAgent(hostname, ip, protocol = 'https') {
  const isHttps = protocol === 'https';
  const AgentClass = isHttps ? https.Agent : http.Agent;

  return new AgentClass({
    // Force DNS resolution to our validated IP
    lookup: (_hostname, _opts, callback) => {
      callback(null, [{ address: ip, family: net.isIP(ip) }]);
    },
    // Ensure TLS SNI uses the original hostname
    ...(isHttps && {
      servername: hostname,
    }),
  });
}

module.exports = { resolveAllIps, createPinnedAgent };
