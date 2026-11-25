'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');
const { amlScreeningsTotal, amlScreeningCoverageGauge } = require('../utils/metrics');

const PROVIDER_BASE_URLS = {
  complyadvantage: 'https://api.complyadvantage.com',
  elliptic: 'https://aml-api.elliptic.co',
};

const FLAGGED_MATCH_STATUSES = ['true_positive', 'potential_match'];
const HIGH_SEVERITIES = ['high', 'critical', 'severe'];

// In-memory tallies backing the coverage gauge (resets on process restart, as with all gauges).
let amlAttempts = 0;
let amlScreened = 0;

/**
 * Read AML configuration from the environment at call time so tests and
 * container restarts can change it without a module re-load.
 *
 * Env contract:
 *  - AML_PROVIDER        'complyadvantage' | 'elliptic'
 *  - AML_API_KEY         API key/token
 *  - AML_API_SECRET      Elliptic secret (base64) used to HMAC-sign requests
 *  - AML_API_URL         Optional base URL override (proxy / tests)
 *  - AML_HIGH_RISK_SCORE Elliptic score >= this is treated as flagged (default 70)
 *  - AML_API_TIMEOUT_MS  Provider request timeout in ms (default 5000)
 */
function getConfig() {
  const provider = (process.env.AML_PROVIDER || '').trim().toLowerCase();
  return {
    provider,
    apiKey: process.env.AML_API_KEY || '',
    apiSecret: process.env.AML_API_SECRET || '',
    apiUrl: (process.env.AML_API_URL || '').trim(),
    highRiskScore: parseInt(process.env.AML_HIGH_RISK_SCORE || '70', 10),
    timeoutMs: parseInt(process.env.AML_API_TIMEOUT_MS || '5000', 10),
  };
}

/**
 * @returns {boolean} true when a real provider is fully configured.
 */
function isAmlConfigured() {
  const { provider, apiKey, apiSecret } = getConfig();
  if (!apiKey) return false;
  if (provider === 'complyadvantage') return true;
  if (provider === 'elliptic') return !!apiSecret;
  return false;
}

function notScreenedResult(provider = null) {
  return {
    screened: false,
    status: 'not_screened',
    risk_level: null,
    provider,
    reference_id: null,
    screened_at: new Date().toISOString(),
  };
}

function recordAmlMetric(result) {
  amlAttempts += 1;
  amlScreeningsTotal.inc({ status: result.status });
  if (result.screened) amlScreened += 1;
  amlScreeningCoverageGauge.set(amlAttempts > 0 ? amlScreened / amlAttempts : 0);
}

/**
 * Internal — resets the in-memory coverage tallies. Used by tests so each case
 * starts from a clean coverage ratio.
 */
function resetAmlMetricCounters() {
  amlAttempts = 0;
  amlScreened = 0;
}

/**
 * POST a JSON body with a timeout. Throws on non-2xx or network/timeout errors.
 */
async function postJson(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `AML provider returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`
      );
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

function ellipticSignature(apiSecret, timestamp, httpPath, body) {
  const key = Buffer.from(apiSecret, 'base64');
  const requestText = `${timestamp}POST${httpPath.toLowerCase()}${body}`;
  return crypto.createHmac('sha256', key).update(requestText).digest('base64');
}

/**
 * ComplyAdvantage — Case Management Searches API.
 * POST https://api.complyadvantage.com/searches with `Authorization: Token <key>`.
 * Flagged when sanctions hits exist (match_status true_positive/potential_match or total_hits > 0).
 */
function parseComplyAdvantageResponse(payload) {
  const data = (payload && payload.content && payload.content.data) || payload || {};
  const totalHits = Number(data.total_hits || 0);
  const flagged = totalHits > 0 || FLAGGED_MATCH_STATUSES.includes(data.match_status);
  return {
    status: flagged ? 'flagged' : 'clear',
    risk_level: flagged ? data.risk_level || 'high' : data.risk_level || 'low',
    reference_id: data.id != null ? String(data.id) : data.ref || null,
  };
}

async function screenComplyAdvantage(walletAddress, userDetails, config) {
  const baseUrl = config.apiUrl || PROVIDER_BASE_URLS.complyadvantage;
  const searchTerm =
    userDetails && userDetails.full_name && userDetails.full_name.trim()
      ? userDetails.full_name.trim()
      : walletAddress;
  const payload = await postJson(
    `${baseUrl}/searches`,
    { Authorization: `Token ${config.apiKey}`, 'Content-Type': 'application/json' },
    {
      search_term: searchTerm,
      client_ref:
        userDetails && userDetails.userId ? `afripay-${userDetails.userId}` : walletAddress,
      exact_match: true,
      fuzziness: 0.0,
      filters: { types: ['sanction'] },
    },
    config.timeoutMs
  );
  return parseComplyAdvantageResponse(payload);
}

/**
 * Elliptic — Wallet Analyses API (synchronous endpoint).
 * POST https://aml-api.elliptic.co/v2/wallet/synchronous with HMAC-signed headers.
 * Flagged when risk_score >= AML_HIGH_RISK_SCORE or a high/critical/severe risk rule fires.
 */
function parseEllipticResponse(payload, config) {
  const riskScore = Number(payload && payload.risk_score);
  const riskRules = Array.isArray(payload && payload.risk_rules) ? payload.risk_rules : [];
  const highSeverity = riskRules.some((rule) =>
    HIGH_SEVERITIES.includes(String(rule && rule.severity).toLowerCase())
  );
  const flagged = (Number.isFinite(riskScore) && riskScore >= config.highRiskScore) || highSeverity;
  return {
    status: flagged ? 'flagged' : 'clear',
    risk_level: flagged ? 'high' : 'low',
    reference_id: payload && payload.id ? String(payload.id) : null,
  };
}

async function screenElliptic(walletAddress, userDetails, config) {
  const baseUrl = config.apiUrl || PROVIDER_BASE_URLS.elliptic;
  const httpPath = '/v2/wallet/synchronous';
  const timestamp = String(Date.now());
  const body = {
    subject: { asset: 'holistic', blockchain: 'holistic', type: 'address', hash: walletAddress },
    type: 'wallet_exposure',
    customer_reference:
      userDetails && userDetails.userId ? `afripay-${userDetails.userId}` : walletAddress,
  };
  const payload = await postJson(
    `${baseUrl}${httpPath}`,
    {
      'Content-Type': 'application/json',
      'x-access-key': config.apiKey,
      'x-access-timestamp': timestamp,
      'x-access-sign': ellipticSignature(
        config.apiSecret,
        timestamp,
        httpPath,
        JSON.stringify(body)
      ),
    },
    body,
    config.timeoutMs
  );
  return parseEllipticResponse(payload, config);
}

/**
 * Screen a wallet address against AML/sanctions lists.
 *
 * Result statuses:
 *  - 'clear'        screened by a provider, no match
 *  - 'flagged'      screened by a provider, sanctions/high-risk match — callers MUST block
 *  - 'error'        provider configured but the call failed — callers must make a compliance decision
 *  - 'not_screened' no provider configured — passthrough, callers must make a compliance decision
 *
 * @param {string} walletAddress - Stellar public key to screen
 * @param {object} [userDetails] - { userId, full_name, ... } used for provider references
 * @returns {Promise<{screened: boolean, status: string, risk_level: string|null, provider: string|null, reference_id: string|null, screened_at: string}>}
 */
async function amlScreen(walletAddress, userDetails = {}) {
  if (!isAmlConfigured()) {
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('AML screening not configured — returning not_screened passthrough', {
        walletAddress,
      });
    }
    const result = notScreenedResult();
    recordAmlMetric(result);
    return result;
  }

  if (typeof walletAddress !== 'string' || !walletAddress.trim()) {
    logger.warn('AML screening skipped — missing wallet address');
    const result = {
      ...notScreenedResult(getConfig().provider),
      status: 'error',
      error: 'missing_wallet_address',
    };
    recordAmlMetric(result);
    return result;
  }

  const config = getConfig();
  try {
    const outcome =
      config.provider === 'elliptic'
        ? await screenElliptic(walletAddress.trim(), userDetails, config)
        : await screenComplyAdvantage(walletAddress.trim(), userDetails, config);

    const result = {
      screened: true,
      status: outcome.status,
      risk_level: outcome.risk_level,
      provider: config.provider,
      reference_id: outcome.reference_id || null,
      screened_at: new Date().toISOString(),
    };
    recordAmlMetric(result);
    return result;
  } catch (err) {
    logger.error('AML screening error', {
      walletAddress,
      provider: config.provider,
      error: err.message,
    });
    const result = {
      screened: false,
      status: 'error',
      risk_level: null,
      provider: config.provider,
      reference_id: null,
      screened_at: new Date().toISOString(),
      error: err.message,
    };
    recordAmlMetric(result);
    return result;
  }
}

module.exports = { amlScreen, isAmlConfigured, recordAmlMetric, resetAmlMetricCounters };
