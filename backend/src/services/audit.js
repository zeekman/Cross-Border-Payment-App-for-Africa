const db = require('../db');

function anonymizeIp(ip) {
  if (!ip) return null;
  // IPv4: mask last octet
  const v4 = ip.match(/^(\d+\.\d+\.\d+)\.\d+$/);
  if (v4) return `${v4[1]}.0`;
  // IPv6: mask last group
  const v6 = ip.match(/^(.*):[\da-fA-F]+$/);
  if (v6) return `${v6[1]}:0`;
  return ip;
}

async function log(userId, action, ipAddress, userAgent, metadata = null) {
  try {
    await db.query(
      `INSERT INTO audit_logs (user_id, action, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, action, anonymizeIp(ipAddress), userAgent || null, metadata ? JSON.stringify(metadata) : null]
    );
  } catch {
    // fail silently — audit logging must never break the main request flow
  }
}

module.exports = { log };
