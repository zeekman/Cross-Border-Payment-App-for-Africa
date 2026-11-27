/**
 * XLM price oracle.
 *
 * - SDEX XLM/USDC price refreshed every SDEX_REFRESH_SECS (60), fiat FX rates
 *   every FIAT_RATES_REFRESH_SECS (3600); cached separately in Redis (BE-201).
 * - Refresh guarded by a distributed lock (one replica per interval) and
 *   in-process single-flight on cache miss (BE-201).
 * - Depth-weighted mid, spread and jump guards, staleness limit (BE-202).
 * - Config-driven currency list with ISO 4217 metadata (BE-203).
 */
const StellarSdk = require('@stellar/stellar-sdk');
const { withFallback } = require('./stellar');
const cache = require('../utils/cache');
const logger = require('../utils/logger');
const { withLock } = require('../utils/distributedLock');
const { priceOracleFetchTotal } = require('../utils/metrics');

const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);
const SDEX_REFRESH_SECS = num(process.env.SDEX_REFRESH_SECS, 60);
const FIAT_RATES_REFRESH_SECS = num(process.env.FIAT_RATES_REFRESH_SECS, 3600);
const PRICE_MAX_STALENESS_SECS = num(process.env.PRICE_MAX_STALENESS_SECS, 900);
const PRICE_MAX_SPREAD_PCT = num(process.env.PRICE_MAX_SPREAD_PCT, 5);
const PRICE_MAX_JUMP_PCT = num(process.env.PRICE_MAX_JUMP_PCT, 20);
const PRICE_MIN_DEPTH_USD = num(process.env.PRICE_MIN_DEPTH_USD, 1000);

const SDEX_KEY = 'price:sdex:XLMUSD';
const FIAT_KEY = 'price:fiat:USD';

// ISO 4217 metadata (decimals = minor units)
const CURRENCY_META = {
  USD: { name: 'US Dollar', symbol: '$', decimals: 2 },
  NGN: { name: 'Nigerian Naira', symbol: '₦', decimals: 2 },
  GHS: { name: 'Ghanaian Cedi', symbol: 'GH₵', decimals: 2 },
  KES: { name: 'Kenyan Shilling', symbol: 'KSh', decimals: 2 },
  ZAR: { name: 'South African Rand', symbol: 'R', decimals: 2 },
  UGX: { name: 'Ugandan Shilling', symbol: 'USh', decimals: 0 },
  TZS: { name: 'Tanzanian Shilling', symbol: 'TSh', decimals: 2 },
  XOF: { name: 'West African CFA Franc', symbol: 'CFA', decimals: 0 },
  XAF: { name: 'Central African CFA Franc', symbol: 'FCFA', decimals: 0 },
  EGP: { name: 'Egyptian Pound', symbol: 'E£', decimals: 2 },
  RWF: { name: 'Rwandan Franc', symbol: 'FRw', decimals: 0 },
  ZMW: { name: 'Zambian Kwacha', symbol: 'ZK', decimals: 2 },
  ETB: { name: 'Ethiopian Birr', symbol: 'Br', decimals: 2 },
};

function supportedFiat() {
  return (process.env.SUPPORTED_FIAT || 'NGN,GHS,KES,ZAR,UGX,TZS,XOF,XAF,EGP,RWF,ZMW,ETB')
    .split(',').map(c => c.trim().toUpperCase()).filter(c => CURRENCY_META[c]);
}

function getCurrencies() {
  return ['USD', ...supportedFiat()].map(code => ({ code, ...CURRENCY_META[code] }));
}

// Last accepted values per process (never served past PRICE_MAX_STALENESS_SECS)
const mem = { sdex: null, fiat: null };
const inflight = new Map();

/** In-process single-flight: concurrent callers share one upstream fetch. */
function singleFlight(key, fn) {
  if (!inflight.has(key)) inflight.set(key, Promise.resolve().then(fn).finally(() => inflight.delete(key)));
  return inflight.get(key);
}

/**
 * Depth-weighted average price of one side of the book over PRICE_MIN_DEPTH_USD.
 * Offers' `price` is counter (USDC) per base (XLM); `amount` is in selling units.
 * A tiny outlier offer contributes proportionally to its size, not 50%.
 */
function weightedSide(levels, side) {
  let usd = 0, xlm = 0;
  for (const l of levels || []) {
    const price = parseFloat(l.price);
    const amount = parseFloat(l.amount);
    if (!(price > 0) || !(amount > 0)) continue;
    // bids sell USDC (amount in USDC); asks sell XLM (amount in XLM)
    const lvlUsd = side === 'bid' ? amount : amount * price;
    const take = Math.min(lvlUsd, PRICE_MIN_DEPTH_USD - usd);
    usd += take;
    xlm += take / price;
    if (usd >= PRICE_MIN_DEPTH_USD) break;
  }
  return xlm > 0 ? { price: usd / xlm, depth: usd } : null;
}

function computeMidPrice(book, previous = null) {
  const bid = weightedSide(book.bids, 'bid');
  const ask = weightedSide(book.asks, 'ask');
  if (!bid || !ask) throw new Error('Insufficient SDEX liquidity');
  if (bid.depth < PRICE_MIN_DEPTH_USD || ask.depth < PRICE_MIN_DEPTH_USD) {
    throw new Error('SDEX depth below PRICE_MIN_DEPTH_USD');
  }
  const mid = (bid.price + ask.price) / 2;
  const spreadPct = (Math.abs(ask.price - bid.price) / mid) * 100;
  if (spreadPct > PRICE_MAX_SPREAD_PCT) throw new Error(`SDEX spread ${spreadPct.toFixed(2)}% exceeds limit`);
  if (previous && (Math.abs(mid - previous) / previous) * 100 > PRICE_MAX_JUMP_PCT) {
    throw new Error('SDEX price moved beyond PRICE_MAX_JUMP_PCT; rejecting without second source');
  }
  return mid;
}

async function fetchSdexPrice() {
  const usdcIssuer = process.env.USDC_ISSUER;
  if (!usdcIssuer) throw new Error('USDC_ISSUER is not configured');
  try {
    const book = await withFallback(s =>
      s.orderbook(StellarSdk.Asset.native(), new StellarSdk.Asset('USDC', usdcIssuer)).limit(50).call());
    const price = computeMidPrice(book, mem.sdex?.value);
    priceOracleFetchTotal.inc({ source: 'sdex', status: 'success' });
    return price;
  } catch (err) {
    priceOracleFetchTotal.inc({ source: 'sdex', status: 'error' });
    throw err;
  }
}

async function fetchFiatRates() {
  const key = process.env.EXCHANGE_RATE_API_KEY;
  const url = key
    ? `https://v6.exchangerate-api.com/v6/${key}/latest/USD`
    : 'https://open.er-api.com/v6/latest/USD';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`FX API HTTP ${res.status}`);
    const body = await res.json();
    const rates = body.rates || body.conversion_rates;
    if (!rates || typeof rates !== 'object') throw new Error('FX API returned no rates');
    priceOracleFetchTotal.inc({ source: 'fx', status: 'success' });
    return rates;
  } catch (err) {
    priceOracleFetchTotal.inc({ source: 'fx', status: 'error' });
    throw err;
  }
}

async function refresh(kind, force = false) {
  const [key, ttl, fetcher] = kind === 'sdex'
    ? [SDEX_KEY, SDEX_REFRESH_SECS, fetchSdexPrice]
    : [FIAT_KEY, FIAT_RATES_REFRESH_SECS, fetchFiatRates];
  return singleFlight(kind, async () => {
    if (!force) {
      const cached = await cache.get(key);
      if (cached && Date.now() - cached.fetchedAt < ttl * 1000) return (mem[kind] = cached);
    }
    let result = null;
    const acquired = await withLock(`lock:price:${kind}`, Math.max(ttl - 5, 5), async () => {
      result = { value: await fetcher(), fetchedAt: Date.now() };
      // keep in Redis long enough to serve as stale fallback up to the limit
      await cache.set(key, result, ttl + PRICE_MAX_STALENESS_SECS);
    });
    if (acquired && result) return (mem[kind] = result);
    // another replica is refreshing — use whatever is cached
    const cached = await cache.get(key);
    if (cached) return (mem[kind] = cached);
    if (mem[kind]) return mem[kind];
    throw new Error(`Price ${kind} unavailable`);
  }).catch(async (err) => {
    logger.warn(`Price ${kind} refresh failed`, { error: err.message });
    return (await cache.get(key)) || mem[kind] || null;
  });
}

const isStale = e => !e || Date.now() - e.fetchedAt > PRICE_MAX_STALENESS_SECS * 1000;

class StalePriceError extends Error {
  constructor() { super('Price data is stale or unavailable'); this.status = 503; }
}

/**
 * Returns { rates, currencies, unavailable, stale, partial, fetchedAt }.
 * Throws StalePriceError (503) when the XLM price is older than PRICE_MAX_STALENESS_SECS.
 */
async function getXlmRates() {
  const [sdex, fiat] = await Promise.all([refresh('sdex'), refresh('fiat')]);
  if (isStale(sdex)) throw new StalePriceError();

  const usd = sdex.value;
  const rates = { USD: usd };
  const unavailable = [];
  const fiatUsable = fiat && Date.now() - fiat.fetchedAt <= (FIAT_RATES_REFRESH_SECS + PRICE_MAX_STALENESS_SECS) * 1000;
  for (const code of supportedFiat()) {
    const r = fiatUsable ? Number(fiat.value[code]) : NaN;
    if (r > 0) rates[code] = parseFloat((usd * r).toFixed(CURRENCY_META[code].decimals + 4));
    else unavailable.push(code);
  }
  return {
    rates,
    currencies: getCurrencies().filter(c => !unavailable.includes(c.code)),
    unavailable,
    partial: unavailable.length > 0,
    stale: false,
    fetchedAt: new Date(sdex.fetchedAt).toISOString(),
  };
}

/**
 * USD value of an XLM amount for compliance (KYC/AML/limits).
 * If the price is stale/unavailable returns Infinity so callers treat the
 * payment as above any threshold (conservative policy, BE-202).
 */
async function estimateUSDValue(xlmAmount) {
  try {
    const { rates } = await getXlmRates();
    return parseFloat(xlmAmount) * rates.USD;
  } catch (err) {
    logger.warn('estimateUSDValue: price unavailable, applying conservative policy', { error: err.message });
    return Infinity;
  }
}

let timers = [];
function startPriceRefreshJob() {
  if (timers.length || !process.env.USDC_ISSUER) return;
  const tick = kind => refresh(kind, true).catch(() => {});
  tick('sdex');
  tick('fiat');
  timers = [
    setInterval(() => tick('sdex'), SDEX_REFRESH_SECS * 1000),
    setInterval(() => tick('fiat'), FIAT_RATES_REFRESH_SECS * 1000),
  ];
  timers.forEach(t => t.unref());
}

function stopPriceRefreshJob() {
  timers.forEach(clearInterval);
  timers = [];
}

module.exports = {
  getXlmRates,
  getCurrencies,
  estimateUSDValue,
  computeMidPrice,
  startPriceRefreshJob,
  stopPriceRefreshJob,
  StalePriceError,
  CURRENCY_META,
};
