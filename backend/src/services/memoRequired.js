const cache = require('../utils/cache');
const logger = require('../utils/logger');

const DIRECTORY_URL = 'https://api.stellar.expert/explorer/directory';
const DIRECTORY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (in-process fallback)
const PER_ADDRESS_TTL_S = 60 * 60;              // 1 hour in Redis per AC
const CACHE_KEY_PREFIX = 'memo_required:';
const STELLAR_TOML_TIMEOUT_MS = 3000;

// Hardcoded fallback list for exchanges that don't publish stellar.toml
// Source: well-known exchange deposit addresses that require memos
const KNOWN_EXCHANGE_ADDRESSES = new Set(
  (process.env.MEMO_REQUIRED_ADDRESSES || '').split(',').filter(Boolean)
);

let directoryCache = { addresses: null, expiresAt: 0 };

async function fetchMemoRequiredAddresses() {
  if (directoryCache.addresses && Date.now() < directoryCache.expiresAt) {
    return directoryCache.addresses;
  }

  try {
    const res = await fetch(`${DIRECTORY_URL}?limit=5000`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const addresses = new Set(
      (data._embedded?.records || [])
        .filter(r => Array.isArray(r.tags) && r.tags.includes('memo_required'))
        .map(r => r.address)
    );

    directoryCache = { addresses, expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS };
    return addresses;
  } catch (err) {
    logger.error('[memoRequired] Failed to fetch Stellar Expert directory:', { error: err.message });
    return directoryCache.addresses || new Set();
  }
}

/**
 * Check the destination account's stellar.toml for memo_required flag.
 * Times out after 3 seconds and defaults to false on failure.
 */
async function checkStellarToml(address) {
  try {
    // Load account to get home_domain
    const horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
    const accountRes = await Promise.race([
      fetch(`${horizonUrl}/accounts/${address}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), STELLAR_TOML_TIMEOUT_MS)),
    ]);
    if (!accountRes.ok) return false;
    const account = await accountRes.json();
    const homeDomain = account.home_domain;
    if (!homeDomain) return false;

    const tomlRes = await Promise.race([
      fetch(`https://${homeDomain}/.well-known/stellar.toml`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), STELLAR_TOML_TIMEOUT_MS)),
    ]);
    if (!tomlRes.ok) return false;
    const tomlText = await tomlRes.text();
    return /MEMO_REQUIRED\s*=\s*true/i.test(tomlText);
  } catch (err) {
    logger.warn('[memoRequired] stellar.toml fetch timed out or failed, defaulting to false', { address, error: err.message });
    return false;
  }
}

/**
 * Check whether a Stellar address requires a memo.
 * Checks: (1) hardcoded exchange list, (2) Stellar Expert directory, (3) stellar.toml.
 * Results are cached in Redis for 1 hour per destination address.
 */
async function isMemoRequired(address) {
  const key = `${CACHE_KEY_PREFIX}${address}`;

  const cached = await cache.get(key);
  if (cached !== null) {
    return cached.required === true;
  }

  logger.debug('[memoRequired] cache miss', { address });

  // 1. Hardcoded fallback list
  if (KNOWN_EXCHANGE_ADDRESSES.has(address)) {
    await cache.set(key, { required: true }, PER_ADDRESS_TTL_S);
    return true;
  }

  // 2. Stellar Expert directory
  const addresses = await fetchMemoRequiredAddresses();
  if (addresses.has(address)) {
    await cache.set(key, { required: true }, PER_ADDRESS_TTL_S);
    return true;
  }

  // 3. stellar.toml check
  const tomlRequired = await checkStellarToml(address);
  await cache.set(key, { required: tomlRequired }, PER_ADDRESS_TTL_S);
  return tomlRequired;
}

/** Alias for use in stellar.js payment flow */
const checkMemoRequired = isMemoRequired;

module.exports = { isMemoRequired, checkMemoRequired };
