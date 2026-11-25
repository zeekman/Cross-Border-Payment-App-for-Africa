/**
 * Background job: syncOfferEvents
 *
 * Polls Stellar Horizon for trade history for each active wallet and
 * persists new offer fill events into the offer_events table.
 * Uses a per-wallet cursor stored in offer_sync_cursors to avoid re-fetching.
 */

const db = require('../db');
const { getTradeHistory } = require('../services/dex');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

const CONCURRENCY = Math.max(1, parseInt(process.env.OFFER_SYNC_CONCURRENCY || '5', 10));

async function syncOfferEvents() {
  try {
    // Only wallets that have DEX activity are polled
    const { rows: wallets } = await db.query(
      `SELECT DISTINCT w.public_key, w.user_id
       FROM wallets w
       WHERE w.public_key IS NOT NULL AND w.has_dex_activity = TRUE`
    );

    // Bounded concurrency: at most CONCURRENCY Horizon calls in flight, one per wallet
    let next = 0;
    const worker = async () => {
      while (next < wallets.length) {
        const wallet = wallets[next++];
        try {
          await syncWallet(wallet.public_key, wallet.user_id);
        } catch (err) {
          logger.warn('syncOfferEvents: failed for wallet', {
            wallet: wallet.public_key,
            error: err.message,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wallets.length) }, worker));
  } catch (err) {
    logger.error('syncOfferEvents: top-level error', { error: err.message });
  }
}

async function syncWallet(publicKey, userId) {
  // Load last cursor for this wallet
  const cursorResult = await db.query(
    'SELECT last_paging_token FROM offer_sync_cursors WHERE wallet_address = $1',
    [publicKey]
  );
  const cursor = cursorResult.rows[0]?.last_paging_token || null;

  const trades = await getTradeHistory(publicKey, cursor, 50);
  if (!trades.length) return;

  let lastPagingToken = cursor;

  for (const trade of trades) {
    // Determine which side of the trade this wallet is on
    const isSeller = trade.base_account === publicKey;
    const baseAsset = trade.base_asset_type === 'native'
      ? 'XLM'
      : trade.base_asset_code;
    const counterAsset = trade.counter_asset_type === 'native'
      ? 'XLM'
      : trade.counter_asset_code;

    try {
      await db.query(
        `INSERT INTO offer_events
           (id, user_id, wallet_address, offer_id, event_type,
            base_asset, counter_asset, base_amount, counter_amount,
            price, paging_token, ledger_close_time)
         VALUES ($1,$2,$3,$4,'trade',$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (paging_token, wallet_address) DO NOTHING`,
        [
          uuidv4(),
          userId,
          publicKey,
          isSeller ? trade.base_offer_id : trade.counter_offer_id,
          baseAsset,
          counterAsset,
          trade.base_amount,
          trade.counter_amount,
          trade.price?.n && trade.price?.d ? (trade.price.n / trade.price.d).toFixed(7) : null,
          trade.paging_token,
          trade.ledger_close_time || null,
        ]
      );
    } catch (insertErr) {
      logger.warn('syncOfferEvents: insert failed', { error: insertErr.message, paging_token: trade.paging_token });
    }

    lastPagingToken = trade.paging_token;
  }

  // Update cursor
  await db.query(
    `INSERT INTO offer_sync_cursors (wallet_address, last_paging_token, synced_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (wallet_address) DO UPDATE
       SET last_paging_token = EXCLUDED.last_paging_token,
           synced_at = NOW()`,
    [publicKey, lastPagingToken]
  );
}

module.exports = { syncOfferEvents };
