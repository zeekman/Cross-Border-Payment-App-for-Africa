/**
 * Persistent USDC trustline retry (BE-200).
 *
 * State lives in wallets.usdc_trustline_status / _attempts / _next_retry_at,
 * so a restart never loses a pending retry. The encrypted secret is loaded from
 * the DB per attempt — nothing is held in long-lived closures.
 */
const db = require('../db');
const logger = require('../utils/logger');
const { withLock } = require('../utils/distributedLock');

// 6 attempts over ~24h (exponential backoff)
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 15 * 3600_000];
const POLL_INTERVAL_MS = 60_000;
const RECONCILE_INTERVAL_MS = 24 * 3600_000;

async function scheduleTrustlineRetry(publicKey) {
  await db.query(
    `UPDATE wallets SET usdc_trustline_status = 'pending',
       usdc_trustline_next_retry_at = NOW() + ($2 || ' milliseconds')::interval
     WHERE public_key = $1 AND usdc_trustline_status <> 'active'`,
    [publicKey, String(RETRY_DELAYS_MS[0])],
  );
}

async function processDueRetries() {
  const { addTrustline } = require('../services/stellar');
  const { rows } = await db.query(
    `SELECT id, usdc_trustline_attempts AS attempts FROM wallets
     WHERE usdc_trustline_status = 'pending' AND usdc_trustline_next_retry_at <= NOW()
     ORDER BY usdc_trustline_next_retry_at LIMIT 50`,
  );
  for (const { id, attempts } of rows) {
    const w = (await db.query('SELECT public_key, encrypted_secret_key FROM wallets WHERE id = $1', [id])).rows[0];
    if (!w) continue;
    try {
      await addTrustline({ publicKey: w.public_key, encryptedSecretKey: w.encrypted_secret_key, asset: 'USDC' });
      await db.query(`UPDATE wallets SET usdc_trustline_status = 'active', usdc_trustline_next_retry_at = NULL WHERE id = $1`, [id]);
      logger.info('USDC trustline retry succeeded', { walletId: id });
    } catch (err) {
      const next = attempts + 1;
      if (next >= RETRY_DELAYS_MS.length) {
        await db.query(
          `UPDATE wallets SET usdc_trustline_status = 'failed', usdc_trustline_attempts = $2, usdc_trustline_next_retry_at = NULL WHERE id = $1`,
          [id, next],
        );
        logger.error('USDC trustline retry exhausted', { walletId: id, error: err.message });
      } else {
        await db.query(
          `UPDATE wallets SET usdc_trustline_attempts = $2,
             usdc_trustline_next_retry_at = NOW() + ($3 || ' milliseconds')::interval WHERE id = $1`,
          [id, next, String(RETRY_DELAYS_MS[next])],
        );
      }
    }
  }
  return rows.length;
}

/** Daily: re-enqueue pending/failed wallets whose account now exists on Horizon. */
async function reconcile() {
  const { server } = require('../services/stellar');
  const { rows } = await db.query(
    `SELECT id, public_key FROM wallets
     WHERE usdc_trustline_status IN ('pending','failed') AND usdc_trustline_next_retry_at IS NULL LIMIT 500`,
  );
  for (const { id, public_key } of rows) {
    try {
      const account = await server.loadAccount(public_key);
      const hasUsdc = account.balances.some(b => b.asset_code === 'USDC' && b.asset_issuer === process.env.USDC_ISSUER);
      await db.query(
        hasUsdc
          ? `UPDATE wallets SET usdc_trustline_status = 'active' WHERE id = $1`
          : `UPDATE wallets SET usdc_trustline_status = 'pending', usdc_trustline_attempts = 0, usdc_trustline_next_retry_at = NOW() WHERE id = $1`,
        [id],
      );
    } catch {
      // account not funded yet — leave for next reconciliation
    }
  }
}

function startTrustlineRetryJob() {
  if (!process.env.USDC_ISSUER) return;
  const run = (name, ttl, fn) => withLock(name, ttl, fn).catch(err =>
    logger.warn(`${name} failed`, { error: err.message }));
  // withLock(key, ttlSeconds, fn) heartbeats the lock while fn runs
  setInterval(() => run('lock:trustline:retry', 55, processDueRetries), POLL_INTERVAL_MS).unref();
  setInterval(() => run('lock:trustline:reconcile', 3600, reconcile), RECONCILE_INTERVAL_MS).unref();
}

module.exports = { scheduleTrustlineRetry, processDueRetries, reconcile, startTrustlineRetryJob, RETRY_DELAYS_MS };
