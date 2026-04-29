const StellarSdk = require('@stellar/stellar-sdk');
const { withRetry } = require('../utils/retry');
const { resolveAsset, decryptPrivateKey, sendPathPayment } = require('./stellar');

// Re-use the same Horizon server instance
const server = new StellarSdk.Horizon.Server(
  process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
);

/**
 * Fetch the current DEX orderbook for a selling/buying pair.
 * Returns bids, asks, and a derived mid-price.
 */
async function getOrderbook(sellingAsset, buyingAsset) {
  const selling = resolveAsset(sellingAsset);
  const buying = resolveAsset(buyingAsset);

  const book = await withRetry(
    () => server.orderbook(selling, buying).limit(10).call(),
    { label: 'orderbook' }
  );

  const bestAsk = book.asks[0] ? parseFloat(book.asks[0].price) : null;
  const bestBid = book.bids[0] ? parseFloat(book.bids[0].price) : null;
  const midPrice = bestAsk && bestBid ? (bestAsk + bestBid) / 2 : bestAsk ?? bestBid;

  return { bids: book.bids, asks: book.asks, midPrice };
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
}) {
  // Find best path and quoted destination amount
  const { findPaymentPath } = require('./stellar');
  const quote = await findPaymentPath(sellAsset, sellAmount, buyAsset);
  if (!quote) throw Object.assign(new Error('No DEX path found for this pair'), { status: 400 });

  const destMin = (parseFloat(quote.destinationAmount) * (1 - slippagePct / 100)).toFixed(7);

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

module.exports = { getOrderbook, executeSwap, getTradeHistory };