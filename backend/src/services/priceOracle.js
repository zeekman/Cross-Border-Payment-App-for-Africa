const StellarSdk = require('@stellar/stellar-sdk');
const { withFallback } = require('./stellar');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 60_000;

// Fiat multipliers relative to USD (static — SDEX only gives XLM/USDC)
const USD_TO_FIAT = {
  NGN: 1550,
  GHS: 15.5,
  KES: 130,
};

let cache = { price: null, fetchedAt: 0 };

/**
 * Fetch XLM/USDC mid-price from the SDEX order book.
 * Returns price in USD (1 XLM = X USD).
 */
async function fetchSdexPrice() {
  const usdcIssuer = process.env.USDC_ISSUER;
  if (!usdcIssuer) throw new Error('USDC_ISSUER is not configured');

  const xlm = StellarSdk.Asset.native();
  const usdc = new StellarSdk.Asset('USDC', usdcIssuer);

  const book = await withFallback(s => s.orderbook(xlm, usdc).call());

  const bestBid = parseFloat(book.bids?.[0]?.price ?? '0');
  const bestAsk = parseFloat(book.asks?.[0]?.price ?? '0');

  if (!bestBid && !bestAsk) throw new Error('Empty SDEX order book');

  // mid-price; fall back to whichever side is available
  if (bestBid && bestAsk) return (bestBid + bestAsk) / 2;
  return bestBid || bestAsk;
}

/**
 * Returns cached XLM/USD price, refreshing if stale.
 * Falls back to last known price on SDEX failure.
 */
async function getXlmPrice() {
  const now = Date.now();
  if (cache.price !== null && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.price;
  }

  try {
    const price = await fetchSdexPrice();
    cache = { price, fetchedAt: now };
    return price;
  } catch (err) {
    logger.warn('SDEX price fetch failed, using last known price', { error: err.message });
    if (cache.price !== null) return cache.price;
    throw err;
  }
}

/**
 * Returns XLM price in USD, NGN, GHS, KES.
 */
async function getXlmRates() {
  const usd = await getXlmPrice();
  return {
    USD: usd,
    NGN: parseFloat((usd * USD_TO_FIAT.NGN).toFixed(4)),
    GHS: parseFloat((usd * USD_TO_FIAT.GHS).toFixed(4)),
    KES: parseFloat((usd * USD_TO_FIAT.KES).toFixed(4)),
  };
}

module.exports = { getXlmRates };
