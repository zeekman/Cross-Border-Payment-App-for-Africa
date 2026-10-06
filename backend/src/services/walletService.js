const db = require('../config/database');
const { generateWallet } = require('./stellarService');
const { MAX_WALLETS_PER_USER } = require('../config/constants');

/**
 * Create a wallet for a user while enforcing MAX_WALLETS_PER_USER atomically.
 *
 * The Stellar keypair generation/funding is a slow network call, so it is
 * performed OUTSIDE the DB lock. The cap is enforced by taking a per-user
 * advisory lock (pg_advisory_xact_lock) inside a transaction, re-checking the
 * count, and inserting the row before the transaction commits. Concurrent
 * requests for the same user serialize on the lock, so the count can never be
 * observed stale and the cap cannot be exceeded.
 *
 * If the insert fails after the keypair was generated, the transaction rolls
 * back and no wallet row is persisted (the generated keypair is simply
 * discarded), so no compensation is required.
 */
async function createWallet(userId) {
  // Generate the keypair (and fund on testnet) before touching the DB lock.
  const { publicKey, encryptedSecretKey } = await generateWallet();

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Serialize concurrent wallet creation for this user. The advisory lock is
    // released automatically when the transaction ends.
    await client.query('SELECT pg_advisory_xact_lock($1)', [userId]);

    const countResult = await client.query(
      'SELECT COUNT(*) AS count FROM wallets WHERE user_id = $1',
      [userId]
    );
    const currentCount = parseInt(countResult.rows[0].count, 10);

    if (currentCount >= MAX_WALLETS_PER_USER) {
      await client.query('ROLLBACK');
      const err = new Error('Maximum number of wallets reached');
      err.statusCode = 400;
      throw err;
    }

    const insertResult = await client.query(
      `INSERT INTO wallets (user_id, public_key, encrypted_secret_key)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, public_key, created_at`,
      [userId, publicKey, encryptedSecretKey]
    );

    await client.query('COMMIT');
    return insertResult.rows[0];
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // ignore rollback errors; original error is more useful
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createWallet };
