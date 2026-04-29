const cache = require('../utils/cache');
const logger = require('../utils/logger');

const DIRECTORY_URL = 'https://api.stellar.expert/explorer/directory';
const DIRECTORY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (in-process fallback)
const PER_ADDRESS_TTL_S = 10 * 60;              // 10 minutes in Redis
const CACHE_KEY_PREFIX = 'memo_required:';

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
    // Fail open: return existing cache if available, otherwise empty set
    return directoryCache.addresses || new Set();
  }
}

/**
 * Check whether a Stellar address requires a memo.
 * Results are cached per-address for 10 minutes using the shared Redis cache
 * (cache key: memo_required:{address}). Falls back to the in-process directory
 * cache when Redis is unavailable.
 */
async function isMemoRequired(address) {
  const key = `${CACHE_KEY_PREFIX}${address}`;

  // Check Redis cache first
  const cached = await cache.get(key);
  if (cached !== null) {
    return cached.required === true;
  }

  // Cache miss — fetch from directory
  logger.debug('[memoRequired] cache miss', { address });
  const addresses = await fetchMemoRequiredAddresses();
  const required = addresses.has(address);

  // Store result in Redis for 10 minutes
  await cache.set(key, { required }, PER_ADDRESS_TTL_S);

  return required;
}

module.exports = { isMemoRequired };
