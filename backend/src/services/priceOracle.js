const StellarSdk = require('@stellar/stellar-sdk');
const { withFallback } = require('./stellar');
const logger = require('../utils/logger');
const cache = require('../utils/cache');

const PRICE_CACHE_TTL_SECS = parseInt(process.env.PRICE_CACHE_TTL_SECS || '60', 10);
// Retain stale keys for 10× the TTL so fallback reads can still find them
const STALE_RETAIN_SECS = PRICE_CACHE_TTL_SECS * 10;

const FALLBACK_USD_TO_FIAT = { NGN: 1600, GHS: 15.5, KES: 129 };

// In-memory fallback used only when Redis is unavailable
let memCache = { rates: null, fetchedAt: 0 };

// ---------------------------------------------------------------------------
// XLM/USD — Stellar SDEX order book
// ---------------------------------------------------------------------------

async function fetchSdexPrice() {
  const usdcIssuer = process.env.USDC_ISSUER;
  if (!usdcIssuer) throw new Error('USDC_ISSUER is not configured');

  const xlm = StellarSdk.Asset.native();
  const usdc = new StellarSdk.Asset('USDC', usdcIssuer);
  const book = await withFallback((s) => s.orderbook(xlm, usdc).call());

  const bestBid = parseFloat(book.bids?.[0]?.price ?? '0');
  const bestAsk = parseFloat(book.asks?.[0]?.price ?? '0');

  if (!bestBid && !bestAsk) throw new Error('Empty SDEX order book');
  if (bestBid && bestAsk) return (bestBid + bestAsk) / 2;
  return bestBid || bestAsk;
}

// ---------------------------------------------------------------------------
// USD → fiat — open.er-api.com
// ---------------------------------------------------------------------------

async function fetchFiatRates() {
  const apiKey = process.env.EXCHANGE_RATE_API_KEY;
  const url = apiKey
    ? `https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`
    : 'https://open.er-api.com/v6/latest/USD';

  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Exchange rate API HTTP ${res.status}`);

  const data = await res.json();
  const r = data?.rates;
  if (!r || typeof r.NGN !== 'number') throw new Error('Invalid exchange rate payload');

  return {
    NGN: r.NGN,
    GHS: r.GHS ?? FALLBACK_USD_TO_FIAT.GHS,
    KES: r.KES ?? FALLBACK_USD_TO_FIAT.KES,
  };
}

// ---------------------------------------------------------------------------
// Redis-backed cache helpers
// ---------------------------------------------------------------------------

async function getCachedRates() {
  const cached = await cache.get('price:XLM:rates');
  return cached; // { usd, fiat: {NGN,GHS,KES}, cachedAt } or null
}

async function setCachedRates(usd, fiat) {
  const payload = { usd, fiat, cachedAt: new Date().toISOString() };
  // Write with normal TTL for live cache
  await cache.set('price:XLM:rates', payload, PRICE_CACHE_TTL_SECS);
  // Write a stale-fallback key that lives much longer
  await cache.set('price:XLM:rates:stale', payload, STALE_RETAIN_SECS);
  // Update in-memory fallback too
  memCache = { rates: payload, fetchedAt: Date.now() };
  return payload;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns XLM prices in USD, NGN, GHS, KES with cache metadata.
 *
 * Response shape:
 *   { USD, NGN, GHS, KES, rate_source: 'live'|'cached', cached_at, stale? }
 */
async function getXlmRates() {
  // 1. Try live cache (within TTL)
  const cached = await getCachedRates();
  if (cached) {
    return {
      USD: parseFloat(cached.usd.toFixed(6)),
      NGN: parseFloat((cached.usd * cached.fiat.NGN).toFixed(4)),
      GHS: parseFloat((cached.usd * cached.fiat.GHS).toFixed(4)),
      KES: parseFloat((cached.usd * cached.fiat.KES).toFixed(4)),
      rate_source: 'cached',
      cached_at: cached.cachedAt,
    };
  }

  // 2. Fetch live data
  try {
    const [usd, fiat] = await Promise.all([fetchSdexPrice(), fetchFiatRates()]);
    const payload = await setCachedRates(usd, fiat);
    logger.info('Price oracle refreshed', { USD: usd, ...fiat });
    return {
      USD: parseFloat(usd.toFixed(6)),
      NGN: parseFloat((usd * fiat.NGN).toFixed(4)),
      GHS: parseFloat((usd * fiat.GHS).toFixed(4)),
      KES: parseFloat((usd * fiat.KES).toFixed(4)),
      rate_source: 'live',
      cached_at: payload.cachedAt,
    };
  } catch (liveErr) {
    logger.warn('Price oracle live fetch failed', { error: liveErr.message });

    // 3. Stale fallback
    const stale = await cache.get('price:XLM:rates:stale') ?? memCache.rates;
    if (stale) {
      logger.warn('Serving stale exchange rate', { cachedAt: stale.cachedAt });
      return {
        USD: parseFloat(stale.usd.toFixed(6)),
        NGN: parseFloat((stale.usd * stale.fiat.NGN).toFixed(4)),
        GHS: parseFloat((stale.usd * stale.fiat.GHS).toFixed(4)),
        KES: parseFloat((stale.usd * stale.fiat.KES).toFixed(4)),
        rate_source: 'cached',
        cached_at: stale.cachedAt,
        stale: true,
      };
    }

    // 4. Nothing available
    const err = new Error('PRICE_UNAVAILABLE');
    err.status = 503;
    err.body = { error: 'PRICE_UNAVAILABLE', message: 'Exchange rate temporarily unavailable.' };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Background pre-warm job — runs every (TTL - 5) seconds
// ---------------------------------------------------------------------------

let _refreshTimer = null;

function startPriceRefreshJob() {
  if (_refreshTimer) return;
  const intervalMs = Math.max((PRICE_CACHE_TTL_SECS - 5) * 1000, 5_000);
  _refreshTimer = setInterval(async () => {
    try {
      const [usd, fiat] = await Promise.all([fetchSdexPrice(), fetchFiatRates()]);
      await setCachedRates(usd, fiat);
      logger.debug('Price cache pre-warmed');
    } catch (err) {
      logger.warn('Price pre-warm failed', { error: err.message });
    }
  }, intervalMs);
  _refreshTimer.unref();
}

function stopPriceRefreshJob() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}

module.exports = { getXlmRates, startPriceRefreshJob, stopPriceRefreshJob };
