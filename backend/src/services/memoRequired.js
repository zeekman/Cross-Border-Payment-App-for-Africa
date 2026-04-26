const DIRECTORY_URL = 'https://api.stellar.expert/explorer/directory';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cache = { addresses: null, expiresAt: 0 };

async function fetchMemoRequiredAddresses() {
  if (cache.addresses && Date.now() < cache.expiresAt) {
    return cache.addresses;
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

    cache = { addresses, expiresAt: Date.now() + CACHE_TTL_MS };
    return addresses;
  } catch (err) {
    console.error('[memoRequired] Failed to fetch Stellar Expert directory:', err.message);
    // Fail open: return existing cache if available, otherwise empty set
    return cache.addresses || new Set();
  }
}

async function isMemoRequired(address) {
  const addresses = await fetchMemoRequiredAddresses();
  return addresses.has(address);
}

module.exports = { isMemoRequired };
