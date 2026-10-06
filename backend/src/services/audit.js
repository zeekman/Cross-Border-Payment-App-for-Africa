const db = require('../db');

function anonymizeIp(ip) {
  if (!ip) return null;
  const v4 = ip.match(/^(\d+\.\d+\.\d+)\.\d+$/);
  if (v4) return `${v4[1]}.0`;
  const v6 = ip.match(/^(.*):[\da-fA-F]+$/);
  if (v6) return `${v6[1]}:0`;
  return ip;
}

// Legacy helper — kept for backward compatibility with existing callers.
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

/**
 * Structured audit log entry used by all admin and auth controller actions.
 *
 * @param {object} ctx         - Express request (or object with user, ip, headers)
 * @param {string} action      - Machine-readable action name, e.g. 'kyc_approved'
 * @param {object} [resource]  - { type, id, oldValue, newValue }
 */
async function auditLog(ctx, action, resource = {}) {
  try {
    const userId = ctx.user?.userId || ctx.user?.id || null;
    const role = ctx.user?.role || null;
    const ip = anonymizeIp(ctx.ip || ctx.connection?.remoteAddress || null);
    const userAgent = ctx.headers?.['user-agent'] || null;

    await db.query(
      `INSERT INTO audit_logs
         (user_id, actor_role, action, resource_type, resource_id,
          old_value, new_value, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        role,
        action,
        resource.type || null,
        resource.id != null ? String(resource.id) : null,
        resource.oldValue != null ? JSON.stringify(resource.oldValue) : null,
        resource.newValue != null ? JSON.stringify(resource.newValue) : null,
        ip,
        userAgent,
      ]
    );
  } catch {
    // fail silently
  }
}

/**
 * BE-037: Compliance report summarizing geo-restriction denials over a date
 * range, grouped by country/route/day, for questions like "how many
 * attempts did we see from a newly-sanctioned jurisdiction last month".
 *
 * @param {object} range
 * @param {string|Date} [range.from] - inclusive start (defaults to 30 days ago)
 * @param {string|Date} [range.to]   - inclusive end (defaults to now)
 * @returns {Promise<{ from: string, to: string, total: number, byCountry: Array, rows: Array }>}
 */
async function getGeoDenialReport({ from, to } = {}) {
  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = to ? new Date(to) : new Date();

  const { rows } = await db.query(
    `SELECT
       new_value->>'country' AS country,
       new_value->>'route' AS route,
       date_trunc('day', created_at) AS day,
       COUNT(*) AS count
     FROM audit_logs
     WHERE action = 'geo_restriction_denied'
       AND created_at BETWEEN $1 AND $2
     GROUP BY country, route, day
     ORDER BY day DESC, count DESC`,
    [fromDate.toISOString(), toDate.toISOString()]
  );

  const byCountryMap = new Map();
  let total = 0;
  for (const r of rows) {
    const count = parseInt(r.count, 10);
    total += count;
    const country = r.country || 'unknown';
    byCountryMap.set(country, (byCountryMap.get(country) || 0) + count);
  }

  return {
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    total,
    byCountry: Array.from(byCountryMap.entries()).map(([country, count]) => ({ country, count })),
    rows: rows.map((r) => ({
      country: r.country || 'unknown',
      route: r.route,
      day: r.day,
      count: parseInt(r.count, 10),
    })),
  };
}

module.exports = { log, auditLog, getGeoDenialReport };
