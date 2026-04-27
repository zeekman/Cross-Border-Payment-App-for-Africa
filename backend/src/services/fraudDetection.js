/**
 * Fraud detection service — single source of truth for all send-side checks.
 *
 * Velocity check  : blocks if a wallet sends >= FRAUD_MAX_TX_PER_WINDOW
 *                   transactions within DAILY_LIMIT_WINDOW_HOURS hours.
 *
 * Daily limit     : blocks if the rolling USD-equivalent total sent within
 *                   DAILY_LIMIT_WINDOW_HOURS hours would exceed
 *                   FRAUD_DAILY_LIMIT_USD.
 *
 * Both checks share the same configurable time window so enforcement is
 * consistent and documented in a single place (.env.example).
 */

const db = require('../db');

// ---------------------------------------------------------------------------
// Config — all sourced from env with safe defaults
// ---------------------------------------------------------------------------

/** Rolling window in hours for both velocity and daily-limit checks (default 24 h) */
const WINDOW_HOURS = parseFloat(process.env.DAILY_LIMIT_WINDOW_HOURS || '24');

/** Max transactions allowed within the window before blocking (default 5) */
const MAX_TX_PER_WINDOW = parseInt(process.env.FRAUD_MAX_TX_PER_WINDOW || '5', 10);

/** Max USD-equivalent total sent within the window (default 1000) */
const DAILY_LIMIT_USD = parseFloat(process.env.FRAUD_DAILY_LIMIT_USD || '1000');

/** Approximate XLM/USD rate — mirrors paymentController; replace with live feed in prod */
const XLM_USD_RATE = parseFloat(process.env.XLM_USD_RATE || '0.11');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toUSD(amount, asset) {
  const n = parseFloat(amount);
  if (asset === 'USD' || asset === 'USDC') return n;
  if (asset === 'XLM') return n * XLM_USD_RATE;
  return 0; // unknown assets: don't block
}

// ---------------------------------------------------------------------------
// Exported checks
// ---------------------------------------------------------------------------

/**
 * Velocity check — returns true (suspicious) when the wallet has already
 * sent MAX_TX_PER_WINDOW or more transactions within the rolling window.
 *
 * @param {string} walletAddress
 * @returns {Promise<boolean>}
 */
async function checkVelocity(walletAddress) {
  const { rows } = await db.query(
    `SELECT COUNT(*) FROM transactions
     WHERE sender_wallet = $1
       AND created_at > NOW() - ($2 || ' hours')::INTERVAL`,
    [walletAddress, WINDOW_HOURS]
  );
  return parseInt(rows[0].count, 10) >= MAX_TX_PER_WINDOW;
}

/**
 * Daily limit check — returns true (exceeded) when the rolling USD total
 * already sent within the window plus the new amount would exceed
 * FRAUD_DAILY_LIMIT_USD.
 *
 * @param {string} walletAddress
 * @param {string|number} amount
 * @param {string} asset
 * @returns {Promise<boolean>}
 */
async function checkDailyLimit(walletAddress, amount, asset) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE sender_wallet = $1
       AND status = 'completed'
       AND created_at > NOW() - ($2 || ' hours')::INTERVAL`,
    [walletAddress, WINDOW_HOURS]
  );

  // Sum is in the transaction's native asset — convert to USD for comparison.
  // We store the asset per-row but for simplicity we treat the running total
  // as the same asset as the current payment (conservative approximation).
  const alreadySentUSD = toUSD(rows[0].total, asset);
  const newAmountUSD   = toUSD(amount, asset);

  return (alreadySentUSD + newAmountUSD) > DAILY_LIMIT_USD;
}

module.exports = {
  checkVelocity,
  checkDailyLimit,
  // Exported for tests
  _config: { WINDOW_HOURS, MAX_TX_PER_WINDOW, DAILY_LIMIT_USD },
};
