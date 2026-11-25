const StellarSdk = require('@stellar/stellar-sdk');
const { withRetry } = require('../utils/retry');
const { resolveAsset, decryptPrivateKey, sendPathPayment } = require('./stellar');

// Re-use the same Horizon server instance
const server = new StellarSdk.Horizon.Server(
  process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
);

/**
 * Parse an asset parameter that is either:
 *   "XLM"                  — native
 *   "CODE"                 — uses env CODE_ISSUER
 *   "CODE:GISSUER..."      — fully qualified issued asset
 *
 * Throws a 400-status error for malformed input.
 */
function parseAssetParam(param) {
  if (!param || typeof param !== 'string') {
    throw Object.assign(new Error('Asset parameter is required'), { status: 400 });
  }
  const upper = param.trim().toUpperCase();
  if (upper === 'XLM') return StellarSdk.Asset.native();

  if (upper.includes(':')) {
    const [code, issuer] = upper.split(':');
    if (!code || !/^[A-Z0-9]{1,12}$/.test(code)) {
      throw Object.assign(new Error(`Invalid asset code: ${code}`), { status: 400 });
    }
    if (!issuer || !/^G[A-Z2-7]{55}$/.test(issuer)) {
      throw Object.assign(new Error(`Invalid issuer address: ${issuer}`), { status: 400 });
    }
    return new StellarSdk.Asset(code, issuer);
  }

  // Plain code — fall back to env issuer
  return resolveAsset(upper);
}

/**
 * Simulate filling `amount` of the selling asset against the asks,
 * returning { estimatedPrice, filledAmount, insufficientLiquidity, maxFillableAmount }.
 */
function simulateFill(asks, amount) {
  let remaining = parseFloat(amount);
  let totalCost = 0;
  let maxFillable = 0;

  for (const level of asks) {
    const levelAmount = parseFloat(level.amount);
    const levelPrice  = parseFloat(level.price);
    maxFillable += levelAmount;
    if (remaining <= 0) break;
    const filled = Math.min(remaining, levelAmount);
    totalCost += filled * levelPrice;
    remaining -= filled;
  }

  const insufficientLiquidity = remaining > 0;
  const filledAmount = parseFloat(amount) - remaining;
  const estimatedPrice = filledAmount > 0 ? totalCost / filledAmount : null;

  return {
    estimatedPrice: estimatedPrice !== null ? parseFloat(estimatedPrice.toFixed(7)) : null,
    filledAmount: parseFloat(filledAmount.toFixed(7)),
    insufficientLiquidity,
    maxFillableAmount: parseFloat(maxFillable.toFixed(7)),
  };
}

/**
 * Add cumulative totals to a side of the order book.
 */
function addCumulative(levels) {
  let cumAmount = 0;
  let cumTotal = 0;
  return levels.map((lvl) => {
    const amount = parseFloat(lvl.amount);
    const price  = parseFloat(lvl.price);
    cumAmount += amount;
    cumTotal  += amount * price;
    return {
      price: lvl.price,
      amount: lvl.amount,
      cumulative_amount: parseFloat(cumAmount.toFixed(7)),
      cumulative_total: parseFloat(cumTotal.toFixed(7)),
    };
  });
}

/**
 * Fetch the current DEX orderbook for a selling/buying pair.
 * Returns bids and asks with cumulative depth, mid-price, and optional
 * estimated execution price for a given input amount.
 *
 * @param {string} sellingAsset  e.g. "XLM" | "USDC:GA5Z..."
 * @param {string} buyingAsset
 * @param {number} limit         number of levels (default 10)
 * @param {number|null} amount   input amount for estimated_price simulation
 */
async function getOrderbook(sellingAsset, buyingAsset, limit = 10, amount = null) {
  const selling = parseAssetParam(sellingAsset);
  const buying  = parseAssetParam(buyingAsset);

  const book = await withRetry(
    () => server.orderbook(selling, buying).limit(limit).call(),
    { label: 'orderbook' }
  );

  const bids = addCumulative(book.bids);
  const asks = addCumulative(book.asks);

  const bestAsk = book.asks[0] ? parseFloat(book.asks[0].price) : null;
  const bestBid = book.bids[0] ? parseFloat(book.bids[0].price) : null;
  const midPrice = bestAsk && bestBid ? parseFloat(((bestAsk + bestBid) / 2).toFixed(7)) : bestAsk ?? bestBid;

  const response = { bids, asks, midPrice };

  if (amount !== null && parseFloat(amount) > 0) {
    const sim = simulateFill(book.asks, amount);
    response.estimated_price      = sim.estimatedPrice;
    response.filled_amount        = sim.filledAmount;
    response.insufficient_liquidity = sim.insufficientLiquidity;
    response.max_fillable_amount  = sim.maxFillableAmount;
  }

  return response;
}

/**
 * Execute a swap using pathPaymentStrictSend (market order).
 * slippagePct: allowed slippage percentage, default 1%.
 * Returns the transaction hash and estimated destination amount.
 */
async function executeSwap({
  publicKey,
  encryptedSecretKey,
  sellAsset,
  sellAmount,
  buyAsset,
  slippagePct = 1,
  minReceived,
}) {
  // Find best path and quoted destination amount
  const { findPaymentPath } = require('./stellar');
  const quote = await findPaymentPath(sellAsset, sellAmount, buyAsset);
  if (!quote) throw Object.assign(new Error('No DEX path found for this pair'), { status: 400 });

  let destMin;
  if (minReceived !== undefined && minReceived !== null && minReceived !== '') {
    // Client-supplied minimum is binding, but must be achievable against the current quote
    if (parseFloat(minReceived) > parseFloat(quote.destinationAmount)) {
      throw Object.assign(
        new Error('min_received exceeds the current quoted amount; please refresh the quote'),
        { status: 400 }
      );
    }
    destMin = String(minReceived);
  } else {
    destMin = (parseFloat(quote.destinationAmount) * (1 - slippagePct / 100)).toFixed(7);
  }

  const result = await sendPathPayment({
    senderPublicKey: publicKey,
    encryptedSecretKey,
    recipientPublicKey: publicKey, // self-swap
    sourceAsset: sellAsset,
    sourceAmount: sellAmount,
    destinationAsset: buyAsset,
    destinationMinAmount: destMin,
    path: quote.path,
  });

  return {
    transactionHash: result.transactionHash,
    soldAmount: sellAmount,
    soldAsset: sellAsset,
    estimatedReceived: quote.destinationAmount,
    minReceived: destMin,
    buyAsset,
  };
}

/**
 * Fetch trade history for an account from Horizon.
 * Returns raw trade records for syncing into offer_events.
 */
async function getTradeHistory(publicKey, cursor = null, limit = 50) {
  let call = server.trades().forAccount(publicKey).limit(limit).order('asc');
  if (cursor) call = call.cursor(cursor);
  const result = await withRetry(() => call.call(), { label: 'trades.forAccount' });
  return result.records || [];
}

module.exports = { parseAssetParam, simulateFill, getOrderbook, executeSwap, getTradeHistory };