/**
 * Resolve Express's `trust proxy` setting from TRUSTED_PROXIES.
 *
 * TRUSTED_PROXIES accepts either a hop count (e.g. "1" behind a single load
 * balancer) or a comma-separated list of proxy IPs/CIDRs. Unset means no proxy
 * is trusted, so req.ip is always the socket address. "true" (trust every hop)
 * re-enables X-Forwarded-For spoofing and is rejected in production.
 *
 * The legacy TRUST_PROXY variable is no longer honoured.
 */
function resolveTrustProxy(env = process.env, logger = console) {
  if (env.TRUST_PROXY !== undefined) {
    logger.error(
      'TRUST_PROXY is deprecated and ignored; use TRUSTED_PROXIES (hop count or comma-separated IPs/CIDRs)'
    );
  }

  const raw = (env.TRUSTED_PROXIES || '').trim();
  let setting = false;

  if (/^\d+$/.test(raw)) {
    setting = parseInt(raw, 10);
  } else if (raw === 'true') {
    if (env.NODE_ENV === 'production') {
      throw new Error('TRUSTED_PROXIES=true trusts every hop and is not allowed in production');
    }
    setting = true;
  } else if (raw) {
    const list = raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    setting = list.length ? list : false;
  }

  logger.info(`trust proxy set to ${JSON.stringify(setting)}`);
  return setting;
}

module.exports = { resolveTrustProxy };
