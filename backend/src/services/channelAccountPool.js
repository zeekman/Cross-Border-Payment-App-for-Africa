const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const StellarSdk = require('@stellar/stellar-sdk');
const db = require('../db');
const logger = require('../utils/logger');
const { registry } = require('../utils/metrics');
const client = require('prom-client');

// ---------------------------------------------------------------------------
// BE-035: Backpressure documentation and metrics.
//
// Behavior under exhaustion: `acquire()` does NOT fail immediately. It
// queues internally via a bounded poll loop — it keeps retrying the
// SELECT ... FOR UPDATE SKIP LOCKED check-out every POLL_INTERVAL_MS, for up
// to CHANNEL_POOL_ACQUIRE_TIMEOUT_MS (default 5000ms), before giving up.
// This means bursts that exceed the pool size do NOT immediately surface as
// user-facing send failures — callers effectively wait in a short queue for
// a channel account to free up. If the burst is sustained long enough that
// no account frees up within the timeout, `acquire()` throws
// CHANNEL_POOL_EXHAUSTED, which callers should map to a 503 with a
// Retry-After hint rather than a generic 500.
// ---------------------------------------------------------------------------
const POLL_INTERVAL_MS = 200;

const channelPoolExhaustionTotal = new client.Counter({
  name: 'afripay_channel_pool_exhaustion_total',
  help: 'Total times channel account pool acquire() timed out without finding a free account',
  registers: [registry],
});

const channelPoolWaitSeconds = new client.Histogram({
  name: 'afripay_channel_pool_wait_seconds',
  help: 'Time spent waiting to acquire a channel account from the pool',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8],
  registers: [registry],
});

const channelPoolAvailable = new client.Gauge({
  name: 'afripay_channel_pool_available',
  help: 'Number of currently available (unchecked-out) channel accounts',
  registers: [registry],
});

const channelPoolTotal = new client.Gauge({
  name: 'afripay_channel_pool_total',
  help: 'Total number of channel accounts configured in the pool',
  registers: [registry],
});

const ALGORITHM = 'aes-256-cbc';

// ---------------------------------------------------------------------------
// Encryption and decryption of channel account secret keys using
// SERVER_KEY_ENCRYPTION_SECRET env var.
// We hash the secret key to ensure it is exactly 32 bytes for aes-256-cbc.
// ---------------------------------------------------------------------------
function getEncryptionKey() {
  const secret = process.env.SERVER_KEY_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error('SERVER_KEY_ENCRYPTION_SECRET is not configured');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptSecret(secretText) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(secretText, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptSecret(encryptedText) {
  const key = getEncryptionKey();
  const [ivHex, encryptedHex] = encryptedText.split(':');
  if (!ivHex || !encryptedHex) {
    throw new Error('Invalid encrypted format');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Decryption of system keys (e.g. SERVICE_ENCRYPTED_SECRET_KEY, ADMIN_ENCRYPTED_SECRET_KEY)
// using ENCRYPTION_KEY env var (slipped to 32 bytes).
// ---------------------------------------------------------------------------
function decryptSystemSecret(encryptedKey) {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY environment variable is not configured');
  }
  const key = Buffer.from(encryptionKey, 'utf8').slice(0, 32);
  const [ivHex, encryptedHex] = encryptedKey.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Acquire a free channel account from the pool.
 * Uses SELECT FOR UPDATE SKIP LOCKED to atomically check out a free account.
 *
 * Backpressure (BE-035): under exhaustion this does NOT fail immediately —
 * it polls/waits up to CHANNEL_POOL_ACQUIRE_TIMEOUT_MS (default 5000ms,
 * configurable) before throwing CHANNEL_POOL_EXHAUSTED. Callers should map
 * that error to an HTTP 503 with a Retry-After hint.
 *
 * @returns {Promise<{ id: string, address: string, secret: string }>}
 */
async function acquire() {
  const start = Date.now();
  const timeoutMs = parseInt(process.env.CHANNEL_POOL_ACQUIRE_TIMEOUT_MS || '5000', 10);

  while (Date.now() - start < timeoutMs) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, stellar_address, stellar_secret_encrypted 
         FROM channel_accounts 
         WHERE is_available = true 
         LIMIT 1 
         FOR UPDATE SKIP LOCKED`
      );

      if (rows.length > 0) {
        const account = rows[0];
        await client.query(
          `UPDATE channel_accounts 
           SET is_available = false, last_used_at = NOW() 
           WHERE id = $1`,
          [account.id]
        );
        await client.query('COMMIT');

        channelPoolWaitSeconds.observe((Date.now() - start) / 1000);
        const secret = decryptSecret(account.stellar_secret_encrypted);
        return {
          id: account.id,
          address: account.stellar_address,
          secret,
        };
      }
      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Error attempting to acquire channel account', { error: err.message });
    } finally {
      client.release();
    }

    // Wait before retrying (bounded queue-with-timeout backpressure)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  channelPoolExhaustionTotal.inc();
  channelPoolWaitSeconds.observe((Date.now() - start) / 1000);
  logger.error('Channel account pool exhausted - no account freed up within timeout', {
    waitedMs: Date.now() - start,
  });
  const err = new Error('CHANNEL_POOL_EXHAUSTED');
  err.status = 503;
  err.retryAfterSeconds = 5;
  throw err;
}

/**
 * Report current pool utilization (available vs total). Intended to be
 * polled periodically (e.g. from a metrics-refresh interval) to keep the
 * channelPoolAvailable/channelPoolTotal gauges current for alerting on
 * sustained exhaustion.
 *
 * @returns {Promise<{ available: number, total: number }>}
 */
async function getPoolStats() {
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE is_available = true) AS available,
       COUNT(*) AS total
     FROM channel_accounts`
  );
  const available = parseInt(rows[0].available, 10);
  const total = parseInt(rows[0].total, 10);
  channelPoolAvailable.set(available);
  channelPoolTotal.set(total);
  return { available, total };
}

/**
 * Release a channel account back to the pool.
 *
 * @param {string} address - Stellar public key of the channel account
 * @returns {Promise<void>}
 */
async function release(address) {
  try {
    await db.query(
      `UPDATE channel_accounts 
       SET is_available = true 
       WHERE stellar_address = $1`,
      [address]
    );
    logger.debug('Channel account released back to the pool', { address });
  } catch (err) {
    logger.error('Failed to release channel account', { address, error: err.message });
  }
}

/**
 * Automated funding of channel accounts from the master service account.
 * Checks how many channel accounts are in the DB. If fewer than configured pool size,
 * generates new accounts, funds them, encrypts secret keys, and saves to DB.
 *
 * Config:
 * - CHANNEL_ACCOUNT_POOL_SIZE: defaults to 10
 *
 * @returns {Promise<{ created: number, accounts: string[] }>}
 */
async function fundChannelPool() {
  const poolSize = parseInt(process.env.CHANNEL_ACCOUNT_POOL_SIZE || '10', 10);
  
  // Count current accounts
  const { rows: [{ count }] } = await db.query('SELECT COUNT(*) FROM channel_accounts');
  const currentCount = parseInt(count, 10);
  const needed = poolSize - currentCount;

  if (needed <= 0) {
    return { created: 0, accounts: [] };
  }

  // Decrypt master service secret key
  const masterEncrypted = process.env.SERVICE_ENCRYPTED_SECRET_KEY || process.env.ADMIN_ENCRYPTED_SECRET_KEY;
  if (!masterEncrypted) {
    throw new Error('Neither SERVICE_ENCRYPTED_SECRET_KEY nor ADMIN_ENCRYPTED_SECRET_KEY is configured');
  }

  const masterSecret = decryptSystemSecret(masterEncrypted);
  const masterKeypair = StellarSdk.Keypair.fromSecret(masterSecret);
  const masterAddress = masterKeypair.publicKey();

  const isTestnet = process.env.STELLAR_NETWORK !== 'mainnet';
  const networkPassphrase = isTestnet ? StellarSdk.Networks.TESTNET : StellarSdk.Networks.PUBLIC;
  const horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new StellarSdk.Horizon.Server(horizonUrl);

  logger.info(`Funding pool: ${needed} new channel accounts needed. Master account: ${masterAddress}`);

  // Generate the required new keypairs
  const newAccounts = [];
  for (let i = 0; i < needed; i++) {
    const kp = StellarSdk.Keypair.random();
    newAccounts.push({
      keypair: kp,
      address: kp.publicKey(),
      secret: kp.secret(),
    });
  }

  // Load master account info
  const masterAccount = await server.loadAccount(masterAddress);
  const baseFee = await server.fetchBaseFee();

  // Create a transaction to fund all needed accounts (each with 10 XLM)
  // 10 XLM provides plenty of reserves for transaction fees/minimum balances
  const txBuilder = new StellarSdk.TransactionBuilder(masterAccount, {
    fee: baseFee,
    networkPassphrase,
  });

  for (const acc of newAccounts) {
    txBuilder.addOperation(
      StellarSdk.Operation.createAccount({
        destination: acc.address,
        startingBalance: '10.0',
      })
    );
  }

  const tx = txBuilder.setTimeout(30).build();
  tx.sign(masterKeypair);

  logger.info('Submitting channel pool funding transaction...');
  const result = await server.submitTransaction(tx);
  logger.info('Channel accounts funded on-chain successfully', { txHash: result.hash });

  // Store in database
  const createdAddresses = [];
  for (const acc of newAccounts) {
    const encryptedSecret = encryptSecret(acc.secret);
    await db.query(
      `INSERT INTO channel_accounts (id, stellar_address, stellar_secret_encrypted, is_available)
       VALUES ($1, $2, $3, true)`,
      [uuidv4(), acc.address, encryptedSecret]
    );
    createdAddresses.push(acc.address);
  }

  return {
    created: needed,
    accounts: createdAddresses,
  };
}

module.exports = {
  acquire,
  release,
  fundChannelPool,
  getPoolStats,
  encryptSecret,
  decryptSecret,
};
