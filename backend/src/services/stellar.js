const StellarSdk = require('@stellar/stellar-sdk');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const { withTimeout } = require('../utils/withTimeout');
const { enqueue } = require('../utils/txQueue');
const {
  AccountResponseSchema,
  TransactionSubmitResponseSchema,
  TransactionPageSchema,
  PathPageSchema,
  validateHorizonResponse,
} = require('../utils/horizonSchemas');
const { horizonRequestDuration } = require('../utils/metrics');

const isTestnet = process.env.STELLAR_NETWORK !== 'mainnet';
const networkPassphrase = isTestnet
  ? StellarSdk.Networks.TESTNET
  : StellarSdk.Networks.PUBLIC;

/**
 * Validate that a transaction's network passphrase matches the configured network.
 * Throws if there is a mismatch — prevents testnet-signed XDRs from being
 * broadcast against mainnet Horizon and vice-versa.
 *
 * @param {string} txPassphrase - The passphrase embedded in the transaction XDR
 */
function validateNetworkPassphrase(txPassphrase) {
  if (txPassphrase && txPassphrase !== networkPassphrase) {
    const err = new Error(
      `Network passphrase mismatch. Transaction was signed for "${txPassphrase}" ` +
      `but server is configured for "${networkPassphrase}". ` +
      `Check STELLAR_NETWORK environment variable.`
    );
    err.status = 400;
    logger.error('Network passphrase mismatch detected', {
      expected: networkPassphrase,
      received: txPassphrase,
    });
    throw err;
  }
}

const primaryUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const fallbackUrl = process.env.STELLAR_HORIZON_FALLBACK_URL || null;

const server = new StellarSdk.Horizon.Server(primaryUrl);
const fallbackServer = fallbackUrl ? new StellarSdk.Horizon.Server(fallbackUrl) : null;

/**
 * Returns true if the error is a network-level failure (connection refused,
 * timeout, DNS) rather than a Stellar protocol error (bad sequence, no trust,
 * HTTP 400 from Horizon, etc.).
 */
function isNetworkError(err) {
  // Stellar protocol errors always carry an HTTP response
  if (err.response) return false;
  // Node.js network error codes
  const networkCodes = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED'];
  if (err.code && networkCodes.includes(err.code)) return true;
  // Fetch/axios timeout or network failure with no response
  if (err.name === 'NetworkError' || err.message?.toLowerCase().includes('network')) return true;
  return false;
}

/**
 * Execute fn(server) with automatic failover to the fallback node on network errors only.
 * Records Horizon call duration via Prometheus.
 */
async function withFallback(fn, logger = require('../utils/logger')) {
async function withFallback(fn, operation = 'unknown') {
  const end = horizonRequestDuration.startTimer({ operation });
  try {
    const result = await fn(server);
    end({ success: 'true' });
    logger.debug('Horizon request succeeded', { node: 'primary', url: primaryUrl });
    return result;
  } catch (primaryErr) {
    if (!isNetworkError(primaryErr) || !fallbackServer) {
      end({ success: 'false' });
      throw primaryErr;
    }
    logger.warn('Primary Horizon node unreachable, trying fallback', {
      primaryUrl,
      fallbackUrl,
      error: primaryErr.message,
    });
    try {
      const result = await fn(fallbackServer);
      end({ success: 'true' });
      logger.info('Horizon request succeeded on fallback node', { url: fallbackUrl });
      return result;
    } catch (fallbackErr) {
      end({ success: 'false' });
      const err = new Error(
        `Both Horizon nodes are unavailable. Primary: ${primaryErr.message}. Fallback: ${fallbackErr.message}`
      );
      err.primaryError = primaryErr;
      err.fallbackError = fallbackErr;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Key encryption helpers
// ---------------------------------------------------------------------------

function encryptPrivateKey(secretKey) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'utf8').slice(0, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(secretKey, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptPrivateKey(encryptedKey) {
  const [ivHex, encryptedHex] = encryptedKey.split(':');
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'utf8').slice(0, 32);
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Wallet creation
// ---------------------------------------------------------------------------

async function createWallet() {
  const keypair = StellarSdk.Keypair.random();
  const publicKey = keypair.publicKey();
  const secretKey = keypair.secret();

  if (isTestnet) {
    try {
      await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
    } catch (e) {
      logger.warn('Friendbot funding failed', { error: e.message });
    }
  }

  return { publicKey, encryptedSecretKey: encryptPrivateKey(secretKey) };
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

async function getBalance(publicKey) {
  try {
    const raw = await withRetry(() => withFallback(s => s.loadAccount(publicKey)), { label: 'loadAccount' });
    const account = validateHorizonResponse(AccountResponseSchema, raw, 'loadAccount');

    // Stellar minimum balance: (2 + num_subentries) * base_reserve (0.5 XLM)
    const BASE_RESERVE = 0.5;
    const numSubentries = account.subentry_count || 0;
    const minBalance = (2 + numSubentries) * BASE_RESERVE;

    return {
      account_exists: true,
      balances: account.balances.map(b => {
        if (b.asset_type === 'native') {
          const total = parseFloat(b.balance);
          const available = Math.max(0, total - minBalance);
          return {
            asset: 'XLM',
            balance: b.balance,
            available_balance: available.toFixed(7),
            min_balance: minBalance.toFixed(7),
          };
        }
        return { asset: b.asset_code, balance: b.balance };
      }),
    };
  } catch (e) {
    if (e.response?.status === 404) return { account_exists: false, balances: [] };
    throw e;
  }
}

/**
 * Return the signers and thresholds for an account directly from Horizon.
 */
async function getAccountSigners(publicKey) {
  const raw = await withRetry(() => withFallback(s => s.loadAccount(publicKey)), { label: 'loadAccount(signers)' });
  const account = validateHorizonResponse(AccountResponseSchema, raw, 'loadAccount(signers)');
  return {
    signers: account.signers.map(s => ({
      key: s.key,
      weight: s.weight,
      type: s.type,
    })),
    thresholds: account.thresholds,
    inflation_destination: account.inflation_destination || null,
  };
}

/**
 * Clear the inflation destination on an account (legacy Protocol <12 setting).
 */
async function clearInflationDestination({ publicKey, encryptedSecretKey }) {
  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const account = await withRetry(() => withFallback(s => s.loadAccount(publicKey)), { label: 'loadAccount(clearInflation)' });

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: await withRetry(() => withFallback(s => s.fetchBaseFee()), { label: 'fetchBaseFee' }),
    networkPassphrase,
  })
    .addOperation(StellarSdk.Operation.setOptions({ inflationDest: null }))
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  const result = await withRetry(() => withFallback(s => s.submitTransaction(tx)), { label: 'submitTransaction(clearInflation)' });
  return { transactionHash: result.hash };
}

// ---------------------------------------------------------------------------
// Asset / trustline helpers
// ---------------------------------------------------------------------------

function resolveAsset(asset) {
  if (asset === 'XLM') return StellarSdk.Asset.native();
  const issuer = process.env[`${asset}_ISSUER`];
  if (!issuer) {
    const err = new Error(`${asset}_ISSUER is not configured. Cannot send ${asset} payments.`);
    err.status = 500;
    throw err;
  }
  return new StellarSdk.Asset(asset, issuer);
}

async function checkTrustline(recipientPublicKey, assetObj) {
  let recipientAccount;
  try {
    const raw = await withRetry(() => withFallback(s => s.loadAccount(recipientPublicKey)), { label: 'loadAccount(recipient)' });
    recipientAccount = validateHorizonResponse(AccountResponseSchema, raw, 'loadAccount(recipient)');
    recipientAccount = await withRetry(() => withFallback(s => s.loadAccount(recipientPublicKey), 'loadAccount'), { label: 'loadAccount(recipient)' });
  } catch (e) {
    if (e.response?.status === 404) {
      const err = new Error('Recipient account does not exist on the Stellar network.');
      err.status = 400;
      throw err;
    }
    throw e;
  }

  const hasTrustline = recipientAccount.balances.some(
    b => b.asset_code === assetObj.code && b.asset_issuer === assetObj.issuer
  );

  if (!hasTrustline) {
    const err = new Error(
      `Recipient has no ${assetObj.code} trustline. They must add a trustline before receiving ${assetObj.code}.`
    );
    err.status = 400;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Memo helpers
// ---------------------------------------------------------------------------

const MEMO_ID_MAX = 2n ** 64n - 1n;

function memoValidationError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function buildStellarMemo(memo, memoType = 'text') {
  if (!memo) return null;
  const type = (memoType || 'text').toLowerCase();

  switch (type) {
    case 'text':
      return StellarSdk.Memo.text(memo.slice(0, 28));
    case 'id': {
      if (!/^\d+$/.test(memo)) throw memoValidationError('Memo ID must be a numeric string');
      try {
        const n = BigInt(memo);
        if (n < 0n || n > MEMO_ID_MAX) throw memoValidationError('Memo ID is out of range');
      } catch (e) {
        if (e.status === 400) throw e;
        throw memoValidationError('Memo ID is invalid');
      }
      return StellarSdk.Memo.id(memo);
    }
    case 'hash':
    case 'return': {
      const hex = memo.replace(/^0x/i, '');
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw memoValidationError('Memo hash must be exactly 64 hexadecimal characters');
      }
      const buf = Buffer.from(hex, 'hex');
      return type === 'hash' ? StellarSdk.Memo.hash(buf) : StellarSdk.Memo.return(buf);
    }
    default:
      throw memoValidationError(`Unsupported memo type: ${memoType}`);
  }
}

// ---------------------------------------------------------------------------
// Federation address resolution
// ---------------------------------------------------------------------------

async function resolveFederationAddress(address) {
  if (!address.includes('*')) return address;
  try {
    const federationServer = new StellarSdk.FederationServer(
      `https://${address.split('*')[1]}/.well-known/stellar.toml`
    );
    const result = await federationServer.resolveAddress(address);
    return result.account_id;
  } catch (e) {
    const err = new Error(`Failed to resolve federation address: ${address}`);
    err.status = 400;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Claimable balance (fallback for non-existent recipient accounts)
// ---------------------------------------------------------------------------

async function createClaimableBalance({
  senderPublicKey,
  encryptedSecretKey,
  recipientPublicKey,
  amount,
  asset = 'XLM',
  memo,
  memoType = 'text',
  logger = require('../utils/logger')
}) {
  const assetObj = resolveAsset(asset);
  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const senderKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  const rawAccount = await withRetry(() => withFallback(s => s.loadAccount(senderPublicKey), logger), { label: 'loadAccount(sender)' });
  const senderAccount = validateHorizonResponse(AccountResponseSchema, rawAccount, 'loadAccount(sender)');

  const txBuilder = new StellarSdk.TransactionBuilder(senderAccount, {
    fee: await withRetry(() => withFallback(s => s.fetchBaseFee(), logger), { label: 'fetchBaseFee' }),
    networkPassphrase
  })
    .addOperation(StellarSdk.Operation.createClaimableBalance({
      asset: assetObj,
      amount: String(amount),
      claimants: [
        new StellarSdk.Claimant(recipientPublicKey, StellarSdk.Claimant.predicateUnconditional())
      ]
    }))
    .setTimeout(30);

  const memoObj = memo ? buildStellarMemo(memo, memoType) : null;
  if (memoObj) txBuilder.addMemo(memoObj);

  const transaction = txBuilder.build();
  transaction.sign(senderKeypair);

  const rawResult = await withRetry(() => withFallback(s => s.submitTransaction(transaction), logger), { label: 'submitTransaction' });
  const result = validateHorizonResponse(TransactionSubmitResponseSchema, rawResult, 'submitTransaction(claimableBalance)');
  return { transactionHash: result.hash, ledger: result.ledger };
}

// ---------------------------------------------------------------------------
// Send payment — per-wallet queue + tx_bad_seq retry
// ---------------------------------------------------------------------------

const MAX_SEQ_RETRIES = 3;
const MAX_BATCH_OPERATIONS = 100;

function isBadSeq(err) {
  return err.response?.data?.extras?.result_codes?.transaction === 'tx_bad_seq';
}

/**
 * Issue a bumpSequence operation to resync an account whose on-chain sequence
 * number has drifted ahead of what the local SDK has loaded.
 *
 * Fetches the current on-chain sequence, then submits a bumpSequence targeting
 * that same value so the next transaction built with a freshly loaded account
 * will use sequence + 1 and succeed.
 */
async function recoverSequence(publicKey, keypair) {
  logger.warn('issuing bumpSequence for account', { publicKey });
  const account = await withFallback(s => s.loadAccount(publicKey), 'loadAccount(bumpSeq)');
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: await withFallback(s => s.fetchBaseFee(), 'fetchBaseFee(bumpSeq)'),
    networkPassphrase,
  })
    .addOperation(StellarSdk.Operation.bumpSequence({
      bumpTo: account.sequenceNumber(),
    }))
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  const result = await withFallback(s => s.submitTransaction(tx), 'submitTransaction(bumpSeq)');
  return result;
}

/**
 * Wrap an async function `fn` with automatic bumpSequence recovery.
 *
 * Calls fn(). If it throws a tx_bad_seq error, issues a bumpSequence to resync
 * the account and retries fn() once. All other errors pass through unchanged.
 * If recoverSequence itself fails, the error is propagated with a log message.
 */
async function withSequenceRecovery(fn, publicKey, keypair) {
  try {
    return await fn();
  } catch (err) {
    if (!isBadSeq(err)) throw err;
    logger.warn('tx_bad_seq detected, attempting bumpSequence recovery', { publicKey });
    try {
      await recoverSequence(publicKey, keypair);
    } catch (recoveryErr) {
      logger.error('bumpSequence recovery failed', { publicKey, error: recoveryErr.message });
      throw recoveryErr;
    }
    return await fn();
  }
}

async function sendPayment(params, logger = require('../utils/logger')) {
  return enqueue(params.senderPublicKey, () => _sendPaymentOnce(params, logger));
}

async function sendBatchPayment(params) {
  return enqueue(params.senderPublicKey, () => _sendBatchPaymentOnce(params));
}

async function _sendPaymentOnce({
  senderPublicKey,
  encryptedSecretKey,
  recipientPublicKey,
  amount,
  asset = 'XLM',
  memo,
  memoType = 'text',
  feePriority = 'standard',
}, logger) {
  // Guard against testnet/mainnet mixup
  validateNetworkPassphrase(networkPassphrase);

  const assetObj = resolveAsset(asset);

  if (asset !== 'XLM') {
    await checkTrustline(recipientPublicKey, assetObj);
  }

  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const senderKeypair = StellarSdk.Keypair.fromSecret(secretKey);

  let lastErr;
  for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
    try {
      // Fetch a fresh sequence number on every attempt
      const senderAccount = await withFallback(s => s.loadAccount(senderPublicKey), logger);

      const txBuilder = new StellarSdk.TransactionBuilder(senderAccount, {
        fee: await feeForPriority(feePriority),
        networkPassphrase
      })
        .addOperation(StellarSdk.Operation.payment({
          destination: recipientPublicKey,
          asset: assetObj,
          amount: String(amount)
        }))
        .setTimeout(30);

      const memoObj = memo ? buildStellarMemo(memo, memoType) : null;
      if (memoObj) txBuilder.addMemo(memoObj);

      const transaction = txBuilder.build();
      transaction.sign(senderKeypair);

      const rawResult = await withFallback(s => s.submitTransaction(transaction), logger);
      const result = validateHorizonResponse(TransactionSubmitResponseSchema, rawResult, 'submitTransaction(payment)');
      return { transactionHash: result.hash, ledger: result.ledger, type: 'payment' };
    } catch (err) {
      if (isBadSeq(err) && attempt < MAX_SEQ_RETRIES - 1) {
        logger.warn('tx_bad_seq detected, retrying with fresh sequence number', {
          attempt: attempt + 1,
          senderPublicKey
        });
        lastErr = err;
        continue;
      }

      // Fallback to claimable balance if recipient account doesn't exist
      if (err.response?.status === 400 && err.response?.data?.extras?.result_codes?.transaction === 'tx_failed') {
        logger.info('Account not found, creating claimable balance', { recipient: recipientPublicKey });
        const result = await createClaimableBalance({
          senderPublicKey, encryptedSecretKey, recipientPublicKey, amount, asset, memo, memoType, logger
        });
        return { ...result, type: 'claimable_balance' };
      }

      throw err;
    }
  }

  // All reload-and-retry attempts exhausted — escalate to bumpSequence recovery
  if (isBadSeq(lastErr)) {
    logger.warn('tx_bad_seq persists after MAX_SEQ_RETRIES, escalating to bumpSequence', { senderPublicKey });
    await recoverSequence(senderPublicKey, senderKeypair);
    // One final attempt after sequence resync
    const senderAccount = await withFallback(s => s.loadAccount(senderPublicKey), 'loadAccount(postBump)');
    const txBuilder = new StellarSdk.TransactionBuilder(senderAccount, {
      fee: await feeForPriority(feePriority),
      networkPassphrase,
    })
      .addOperation(StellarSdk.Operation.payment({
        destination: recipientPublicKey,
        asset: assetObj,
        amount: String(amount),
      }))
      .setTimeout(30);
    const memoObj = memo ? buildStellarMemo(memo, memoType) : null;
    if (memoObj) txBuilder.addMemo(memoObj);
    const transaction = txBuilder.build();
    transaction.sign(senderKeypair);
    const result = await withFallback(s => s.submitTransaction(transaction), 'submitTransaction(postBump)');
    return { transactionHash: result.hash, ledger: result.ledger, type: 'payment' };
  }

  throw lastErr;
}

async function validateBatchRecipient({
  recipientPublicKey,
  asset = 'XLM'
}) {
  let recipientAccount;
  try {
    recipientAccount = await withRetry(
      () => withFallback(s => s.loadAccount(recipientPublicKey)),
      { label: 'loadAccount(batchRecipient)' }
    );
  } catch (e) {
    if (e.response?.status === 404) {
      const err = new Error('Recipient account does not exist on the Stellar network.');
      err.status = 400;
      throw err;
    }
    throw e;
  }

  if (asset !== 'XLM') {
    const assetObj = resolveAsset(asset);
    const hasTrustline = recipientAccount.balances.some(
      b => b.asset_code === assetObj.code && b.asset_issuer === assetObj.issuer
    );

    if (!hasTrustline) {
      const err = new Error(
        `Recipient has no ${assetObj.code} trustline. They must add a trustline before receiving ${assetObj.code}.`
      );
      err.status = 400;
      throw err;
    }
  }

  return { recipientPublicKey };
}

async function _sendBatchPaymentOnce({
  senderPublicKey,
  encryptedSecretKey,
  recipients,
  asset = 'XLM',
  memo,
  memoType = 'text'
}) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    const err = new Error('At least one recipient is required.');
    err.status = 400;
    throw err;
  }

  if (recipients.length > MAX_BATCH_OPERATIONS) {
    const err = new Error(`Batch payments support up to ${MAX_BATCH_OPERATIONS} recipients per transaction.`);
    err.status = 400;
    throw err;
  }

  const assetObj = resolveAsset(asset);
  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const senderKeypair = StellarSdk.Keypair.fromSecret(secretKey);

  let lastErr;
  for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
    try {
      const senderAccount = await withFallback(s => s.loadAccount(senderPublicKey));

      const txBuilder = new StellarSdk.TransactionBuilder(senderAccount, {
        fee: await withFallback(s => s.fetchBaseFee()),
        networkPassphrase
      });

      recipients.forEach(({ recipientPublicKey, amount }) => {
        txBuilder.addOperation(StellarSdk.Operation.payment({
          destination: recipientPublicKey,
          asset: assetObj,
          amount: String(amount)
        }));
      });

      const memoObj = memo ? buildStellarMemo(memo, memoType) : null;
      if (memoObj) txBuilder.addMemo(memoObj);

      const transaction = txBuilder
        .setTimeout(30)
        .build();

      transaction.sign(senderKeypair);

      const result = await withFallback(s => s.submitTransaction(transaction));
      return {
        transactionHash: result.hash,
        ledger: result.ledger,
        operationCount: recipients.length
      };
    } catch (err) {
      if (isBadSeq(err) && attempt < MAX_SEQ_RETRIES - 1) {
        logger.warn('tx_bad_seq detected for batch payment, retrying with fresh sequence number', {
          attempt: attempt + 1,
          senderPublicKey
        });
        lastErr = err;
        continue;
      }

      throw err;
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// Transaction history
// ---------------------------------------------------------------------------

async function getTransactions(publicKey, limit = 20) {
  try {
    const raw = await withFallback(s =>
      s.transactions().forAccount(publicKey).limit(limit).order('desc').call()
    );
    const page = validateHorizonResponse(TransactionPageSchema, raw, 'transactions.forAccount');
    return page.records.map(tx => ({
      id: tx.id,
      hash: tx.hash,
      createdAt: tx.created_at,
      memo: tx.memo,
      successful: tx.successful
    }));
  } catch (e) {
    return [];
  }
}

// Issue AFRI asset to a recipient
async function issueAsset(recipientPublicKey, amount) {
  const issuerSecret = decryptPrivateKey(process.env.AFRI_ISSUER_SECRET);
  const distributionSecret = decryptPrivateKey(process.env.AFRI_DISTRIBUTION_SECRET);
  
  const distributionKeypair = StellarSdk.Keypair.fromSecret(distributionSecret);
  const distributionAccount = await server.loadAccount(distributionKeypair.publicKey());

  const afriAsset = new StellarSdk.Asset('AFRI', process.env.AFRI_ISSUER_PUBLIC);

  const transaction = new StellarSdk.TransactionBuilder(distributionAccount, {
    fee: await server.fetchBaseFee(),
    networkPassphrase
  })
    .addOperation(StellarSdk.Operation.payment({
      destination: recipientPublicKey,
      asset: afriAsset,
      amount: String(amount)
    }))
    .setTimeout(30)
    .build();
  transaction.sign(distributionKeypair);
  return await server.submitTransaction(transaction);
}
// ---------------------------------------------------------------------------
// Fee estimate
// ---------------------------------------------------------------------------

async function fetchFee() {
  return withRetry(() => withFallback(s => s.fetchBaseFee(), 'fetchBaseFee'), { label: 'fetchBaseFee' });
}

/**
 * Fetch fee statistics from Horizon and return key percentiles.
 * Returns { min, p10, p50, p90, p99 } in stroops.
 */
async function fetchFeeStats() {
  const stats = await withRetry(() => withFallback(s => s.feeStats()), { label: 'feeStats' });
  const fp = stats.fee_charged;
  return {
    min: parseInt(fp.min, 10),
    p10: parseInt(fp.p10, 10),
    p50: parseInt(fp.p50, 10),
    p90: parseInt(fp.p90, 10),
    p99: parseInt(fp.p99, 10),
  };
}

/**
 * Build a TransactionBuilder fee from a priority string.
 * priority: 'economy' | 'standard' | 'priority'
 * Falls back to base fee if feeStats is unavailable.
 */
async function feeForPriority(priority = 'standard') {
  try {
    const stats = await fetchFeeStats();
    const map = { economy: stats.p10, standard: stats.p50, priority: stats.p90 };
    return map[priority] ?? stats.p50;
  } catch {
    return withRetry(() => withFallback(s => s.fetchBaseFee()), { label: 'fetchBaseFee(fallback)' });
  }
}

// ---------------------------------------------------------------------------
// Horizon health check
// ---------------------------------------------------------------------------

async function checkHorizonHealth() {
  try {
    await withTimeout(withFallback(s => s.ledgers().order('desc').limit(1).call()));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Path payment helpers
// ---------------------------------------------------------------------------

async function findPaymentPath(sourceAsset, sourceAmount, destinationAsset) {
  const srcAsset = resolveAsset(sourceAsset);
  const dstAsset = resolveAsset(destinationAsset);

  const raw = await withFallback(s =>
    s.strictSendPaths(srcAsset, String(sourceAmount), [dstAsset]).call()
  );
  const page = validateHorizonResponse(PathPageSchema, raw, 'strictSendPaths');

  if (!page.records || page.records.length === 0) return null;

  const best = page.records.reduce((a, b) =>
    parseFloat(a.destination_amount) >= parseFloat(b.destination_amount) ? a : b
  );

  return { destinationAmount: best.destination_amount, path: best.path };
}

/**
 * Find the best path for strict receive (recipient gets exact amount).
 * Returns the source amount needed and the path.
 */
async function findReceivePath(sourceAsset, destinationAsset, destinationAmount, recipientAddress) {
  const srcAsset = resolveAsset(sourceAsset);
  const dstAsset = resolveAsset(destinationAsset);

  const raw = await withFallback(s =>
    s.strictReceivePaths([srcAsset], dstAsset, String(destinationAmount)).call()
  );
  const page = validateHorizonResponse(PathPageSchema, raw, 'strictReceivePaths');

  if (!page.records || page.records.length === 0) return null;

  const best = page.records.reduce((a, b) =>
    parseFloat(a.source_amount) <= parseFloat(b.source_amount) ? a : b
  );

  return { sourceAmount: best.source_amount, path: best.path };
}

async function sendPathPayment({
  senderPublicKey,
  encryptedSecretKey,
  recipientPublicKey,
  sourceAsset,
  sourceAmount,
  destinationAsset,
  destinationMinAmount,
  path = [],
  memo,
}, logger = require('../utils/logger')) {
  const srcAsset = resolveAsset(sourceAsset);
  const dstAsset = resolveAsset(destinationAsset);

  if (destinationAsset !== 'XLM') {
    await checkTrustline(recipientPublicKey, dstAsset);
  }

  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const senderKeypair = StellarSdk.Keypair.fromSecret(secretKey);

  const sdkPath = path.map(p =>
    p.asset_type === 'native'
      ? StellarSdk.Asset.native()
      : new StellarSdk.Asset(p.asset_code, p.asset_issuer)
  );

  return withSequenceRecovery(async () => {
    const senderAccount = await withFallback(s => s.loadAccount(senderPublicKey), 'loadAccount');

    const txBuilder = new StellarSdk.TransactionBuilder(senderAccount, {
      fee: await withFallback(s => s.fetchBaseFee(), 'fetchBaseFee'),
      networkPassphrase,
    })
      .addOperation(StellarSdk.Operation.pathPaymentStrictSend({
        sendAsset: srcAsset,
        sendAmount: String(sourceAmount),
        destination: recipientPublicKey,
        destAsset: dstAsset,
        destMin: String(destinationMinAmount),
        path: sdkPath,
      }))
      .setTimeout(30);

    if (memo) txBuilder.addMemo(StellarSdk.Memo.text(memo.slice(0, 28)));

    const transaction = txBuilder.build();
    transaction.sign(senderKeypair);

    const result = await withFallback(s => s.submitTransaction(transaction), 'submitTransaction');
    return { transactionHash: result.hash, ledger: result.ledger };
  }, senderPublicKey, senderKeypair);
}

/**
 * Execute a pathPaymentStrictReceive — recipient gets exact destinationAmount,
 * sender pays at most sourceMaxAmount.
 */
async function sendStrictReceivePathPayment({
  senderPublicKey,
  encryptedSecretKey,
  recipientPublicKey,
  sourceAsset,
  sourceMaxAmount,
  destinationAsset,
  destinationAmount,
  path = [],
  memo,
}) {
  const srcAsset = resolveAsset(sourceAsset);
  const dstAsset = resolveAsset(destinationAsset);

  if (destinationAsset !== 'XLM') {
    await checkTrustline(recipientPublicKey, dstAsset);
  }

  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const senderKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  const senderAccount = await withFallback(s => s.loadAccount(senderPublicKey));

  const sdkPath = path.map(p =>
    p.asset_type === 'native'
      ? StellarSdk.Asset.native()
      : new StellarSdk.Asset(p.asset_code, p.asset_issuer)
  );

  const txBuilder = new StellarSdk.TransactionBuilder(senderAccount, {
    fee: await withFallback(s => s.fetchBaseFee()),
    networkPassphrase,
  })
    .addOperation(StellarSdk.Operation.pathPaymentStrictReceive({
      sendAsset: srcAsset,
      sendMax: String(sourceMaxAmount),
      destination: recipientPublicKey,
      destAsset: dstAsset,
      destAmount: String(destinationAmount),
      path: sdkPath,
    }))
    .setTimeout(30);

  if (memo) txBuilder.addMemo(StellarSdk.Memo.text(memo.slice(0, 28)));

  const transaction = txBuilder.build();
  transaction.sign(senderKeypair);

  const rawResult = await withFallback(s => s.submitTransaction(transaction));
  const result = validateHorizonResponse(TransactionSubmitResponseSchema, rawResult, 'submitTransaction(strictReceive)');
  return { transactionHash: result.hash, ledger: result.ledger };
}

// ---------------------------------------------------------------------------
// Trustline management
// ---------------------------------------------------------------------------

/**
 * Add (or update limit on) a trustline for a non-native asset.
 * limit defaults to the Stellar max if not provided.
 */
async function addTrustline({ publicKey, encryptedSecretKey, asset, limit }) {
  const assetObj = resolveAsset(asset);
  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);

  return withSequenceRecovery(async () => {
    const account = validateHorizonResponse(
      AccountResponseSchema,
      await withRetry(() => server.loadAccount(publicKey), { label: 'loadAccount(trustline)' }),
      'loadAccount(trustline)'
    );

    const op = StellarSdk.Operation.changeTrust({
      asset: assetObj,
      ...(limit !== undefined ? { limit: String(limit) } : {}),
    });

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: await withRetry(() => server.fetchBaseFee(), { label: 'fetchBaseFee' }),
      networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    tx.sign(keypair);
    const rawResult = await withRetry(() => server.submitTransaction(tx), { label: 'submitTransaction(addTrustline)' });
    const result = validateHorizonResponse(TransactionSubmitResponseSchema, rawResult, 'submitTransaction(addTrustline)');
    return { transactionHash: result.hash };
  }, publicKey, keypair);
}

/**
 * Remove a trustline by setting limit=0.
 * Stellar will reject this if the account still holds a balance of that asset.
 */
async function removeTrustline({ publicKey, encryptedSecretKey, asset }) {
  return addTrustline({ publicKey, encryptedSecretKey, asset, limit: '0' });
}

/**
 * List all non-native trustlines on an account directly from Horizon.
 */
async function getTrustlines(publicKey) {
  const raw = await withRetry(() => server.loadAccount(publicKey), { label: 'loadAccount(trustlines)' });
  const account = validateHorizonResponse(AccountResponseSchema, raw, 'loadAccount(trustlines)');
  return account.balances
    .filter(b => b.asset_type !== 'native')
    .map(b => ({
      asset: b.asset_code,
      issuer: b.asset_issuer,
      balance: b.balance,
      limit: b.limit,
    }));
}

// ---------------------------------------------------------------------------
// Multisig helpers
// ---------------------------------------------------------------------------

/**
 * Add a signer to a Stellar account and set medium/high thresholds to 2.
 * low threshold stays 1 so non-payment ops (e.g. trustlines) need only 1 sig.
 */
async function addAccountSigner({ ownerPublicKey, encryptedSecretKey, signerPublicKey, weight = 1 }) {
  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const ownerKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  const account = validateHorizonResponse(
    AccountResponseSchema,
    await withRetry(() => server.loadAccount(ownerPublicKey), { label: 'loadAccount(multisig)' }),
    'loadAccount(multisig)'
  );

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: await withRetry(() => server.fetchBaseFee(), { label: 'fetchBaseFee' }),
    networkPassphrase,
  })
    .addOperation(StellarSdk.Operation.setOptions({
      signer: { ed25519PublicKey: signerPublicKey, weight },
      lowThreshold: 1,
      medThreshold: 2,
      highThreshold: 2,
    }))
    .setTimeout(30)
    .build();

  transaction.sign(distributionKeypair);

  const result = await server.submitTransaction(transaction);
  return {
    transactionHash: result.hash,
    ledger: result.ledger
  };
}

// Get AFRI asset information
async function getAssetInfo() {
  try {
    const issuerPublicKey = process.env.AFRI_ISSUER_PUBLIC;
    const issuerAccount = await server.loadAccount(issuerPublicKey);
    
    // Get asset holders and supply from Horizon
    const assetResponse = await server.assets()
      .forCode('AFRI')
      .forIssuer(issuerPublicKey)
      .call();

    const asset = assetResponse.records[0] || {};

    return {
      code: 'AFRI',
      issuer: issuerPublicKey,
      supply: asset.amount || '0',
      holders: asset.num_accounts || 0,
      description: 'AfriPay Token - Loyalty rewards and governance token for the AfriPay platform',
      decimals: 7
    };
  } catch (err) {
    logger.error('Error fetching AFRI asset info', { error: err.message });
    return {
      code: 'AFRI',
      issuer: process.env.AFRI_ISSUER_PUBLIC,
      supply: '0',
      holders: 0,
      description: 'AfriPay Token - Loyalty rewards and governance token for the AfriPay platform',
      decimals: 7
    };
  }
}

// Get Stellar network statistics
async function getStellarStats() {
  try {
    const ledgerResponse = await server.ledgers().order('desc').limit(1).call();
    const ledger = ledgerResponse.records[0];

    return {
      latestLedger: ledger.sequence,
      baseFee: ledger.base_fee_in_stroops,
      maxFee: ledger.max_tx_set_size,
      transactionCount: ledger.successful_transaction_count,
      operationCount: ledger.operation_count,
      closedAt: ledger.closed_at
    };
  } catch (err) {
    logger.error('Error fetching Stellar stats', { error: err.message });
    throw err;
  }
}


  tx.sign(ownerKeypair);
  const rawResult = await withRetry(() => server.submitTransaction(tx), { label: 'submitTransaction(addSigner)' });
  const result = validateHorizonResponse(TransactionSubmitResponseSchema, rawResult, 'submitTransaction(addSigner)');
  return { transactionHash: result.hash };
}

/**
 * Remove a signer (weight=0) and reset thresholds to 1 if no signers remain.
 */
async function removeAccountSigner({ ownerPublicKey, encryptedSecretKey, signerPublicKey, remainingSigners = 0 }) {
  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const ownerKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  const account = validateHorizonResponse(
    AccountResponseSchema,
    await withRetry(() => server.loadAccount(ownerPublicKey), { label: 'loadAccount(removeSigner)' }),
    'loadAccount(removeSigner)'
  );

  const thresholds = remainingSigners > 0 ? {} : { lowThreshold: 1, medThreshold: 1, highThreshold: 1 };

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: await withRetry(() => server.fetchBaseFee(), { label: 'fetchBaseFee' }),
    networkPassphrase,
  })
    .addOperation(StellarSdk.Operation.setOptions({
      signer: { ed25519PublicKey: signerPublicKey, weight: 0 },
      ...thresholds,
    }))
    .setTimeout(30)
    .build();

  tx.sign(ownerKeypair);
  const rawResult = await withRetry(() => server.submitTransaction(tx), { label: 'submitTransaction(removeSigner)' });
  const result = validateHorizonResponse(TransactionSubmitResponseSchema, rawResult, 'submitTransaction(removeSigner)');
  return { transactionHash: result.hash };
}

// ---------------------------------------------------------------------------
// NOTE: Stellar inflation was removed in Protocol 12 (2019).
// The inflation operation is no longer valid and must NOT be used.
// No setOptions calls in this codebase set an inflationDest.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Account merge — transfers all XLM to destination and closes the source account.
// WARNING: This operation is IRREVERSIBLE. The source account is permanently closed.
// ---------------------------------------------------------------------------

async function mergeAccount({ sourcePublicKey, encryptedSecretKey, destinationPublicKey }) {
  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const sourceKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  const rawAccount = await withRetry(() => withFallback(s => s.loadAccount(sourcePublicKey)), { label: 'loadAccount(merge)' });
  const sourceAccount = validateHorizonResponse(AccountResponseSchema, rawAccount, 'loadAccount(merge)');

  const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: await withRetry(() => withFallback(s => s.fetchBaseFee(), 'fetchBaseFee'), { label: 'fetchBaseFee' }),
    networkPassphrase,
  })
    .addOperation(StellarSdk.Operation.accountMerge({ destination: destinationPublicKey }))
    .setTimeout(30)
    .build();

  tx.sign(sourceKeypair);
  const rawResult = await withRetry(
    () => withFallback(s => s.submitTransaction(tx)),
    { label: 'submitTransaction(merge)' }
  );
  const result = validateHorizonResponse(TransactionSubmitResponseSchema, rawResult, 'submitTransaction(merge)');
  return { transactionHash: result.hash, ledger: result.ledger };
}

// ---------------------------------------------------------------------------
// Asset clawback — admin-only operation to reclaim an asset from an account.
// Requires the asset issuer account to have AUTH_CLAWBACK_ENABLED_FLAG set.
// Used for regulatory compliance (fraud, court orders).
// ---------------------------------------------------------------------------

async function clawbackAsset({ issuerPublicKey, encryptedIssuerSecretKey, fromPublicKey, asset, amount }) {
  const assetObj = resolveAsset(asset);
  const secretKey = decryptPrivateKey(encryptedIssuerSecretKey);
  const issuerKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  const rawAccount = await withRetry(() => withFallback(s => s.loadAccount(issuerPublicKey)), { label: 'loadAccount(clawback)' });
  const issuerAccount = validateHorizonResponse(AccountResponseSchema, rawAccount, 'loadAccount(clawback)');

  const tx = new StellarSdk.TransactionBuilder(issuerAccount, {
    fee: await withRetry(() => withFallback(s => s.fetchBaseFee(), 'fetchBaseFee'), { label: 'fetchBaseFee' }),
    networkPassphrase,
  })
    .addOperation(StellarSdk.Operation.clawback({
      asset: assetObj,
      from: fromPublicKey,
      amount: String(amount),
    }))
    .setTimeout(30)
    .build();

  tx.sign(issuerKeypair);
  const rawResult = await withRetry(
    () => withFallback(s => s.submitTransaction(tx)),
    { label: 'submitTransaction(clawback)' }
  );
  const result = validateHorizonResponse(TransactionSubmitResponseSchema, rawResult, 'submitTransaction(clawback)');
  return { transactionHash: result.hash, ledger: result.ledger };
}

// ---------------------------------------------------------------------------
// Account flags management (setOptions)
// ---------------------------------------------------------------------------

/**
 * Stellar account authorization flags.
 * https://developers.stellar.org/docs/learn/glossary#flags
 */
const FLAG_DESCRIPTIONS = {
  AUTH_REQUIRED: 'Requires the issuer to authorize trustlines before assets can be held.',
  AUTH_REVOCABLE: 'Allows the issuer to revoke a trustline, freezing the asset.',
  AUTH_IMMUTABLE: 'Prevents any further changes to authorization flags (irreversible).',
  AUTH_CLAWBACK_ENABLED: 'Allows the issuer to clawback assets from any holder.',
};

/**
 * Return the current authorization flags for an account.
 */
async function getAccountFlags(publicKey) {
  const account = await withRetry(
    () => withFallback(s => s.loadAccount(publicKey)),
    { label: 'loadAccount(flags)' }
  );
  const flags = account.flags || {};
  return {
    auth_required: !!flags.auth_required,
    auth_revocable: !!flags.auth_revocable,
    auth_immutable: !!flags.auth_immutable,
    auth_clawback_enabled: !!flags.auth_clawback_enabled,
    descriptions: FLAG_DESCRIPTIONS,
  };
}

/**
 * Set or clear authorization flags on an account using setOptions.
 * setFlags / clearFlags are bitmasks of StellarSdk.AuthRequiredFlag etc.
 */
async function setAccountFlags({ publicKey, encryptedSecretKey, setFlags, clearFlags }) {
  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const account = await withRetry(
    () => withFallback(s => s.loadAccount(publicKey)),
    { label: 'loadAccount(setFlags)' }
  );

  const opts = {};
  if (setFlags !== undefined) opts.setFlags = setFlags;
  if (clearFlags !== undefined) opts.clearFlags = clearFlags;

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: await withRetry(() => withFallback(s => s.fetchBaseFee()), { label: 'fetchBaseFee' }),
    networkPassphrase,
  })
    .addOperation(StellarSdk.Operation.setOptions(opts))
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  const rawResult = await withRetry(
    () => withFallback(s => s.submitTransaction(tx)),
    { label: 'submitTransaction(setFlags)' }
  );
  const result = validateHorizonResponse(TransactionSubmitResponseSchema, rawResult, 'submitTransaction(setFlags)');
  return { transactionHash: result.hash };
}

// ---------------------------------------------------------------------------
// Account data entries (manageData)
// ---------------------------------------------------------------------------

/**
 * Set or delete a data entry on the account.
 * Pass value=null to delete the entry.
 */
async function setDataEntry({ publicKey, encryptedSecretKey, key, value }) {
  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const account = await withRetry(() => withFallback(s => s.loadAccount(publicKey)), { label: 'loadAccount(dataEntry)' });

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: await withRetry(() => withFallback(s => s.fetchBaseFee()), { label: 'fetchBaseFee' }),
    networkPassphrase,
  })
    .addOperation(StellarSdk.Operation.manageData({
      name: key,
      value: value !== null ? Buffer.from(value, 'utf8') : null,
    }))
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  const result = await withRetry(() => withFallback(s => s.submitTransaction(tx)), { label: 'submitTransaction(manageData)' });
  return { transactionHash: result.hash };
}

/**
 * Return all data entries for an account, decoded from base64.
 */
async function getDataEntries(publicKey) {
  const account = await withRetry(() => withFallback(s => s.loadAccount(publicKey)), { label: 'loadAccount(dataEntries)' });
  return Object.entries(account.data_attr || {}).map(([key, valueB64]) => ({
    key,
    value: Buffer.from(valueB64, 'base64').toString('utf8'),
  }));
}

// ---------------------------------------------------------------------------
// Testnet reset detection
// ---------------------------------------------------------------------------

/**
 * Detect whether the configured Horizon is a freshly-reset testnet by checking
 * whether a known "canary" account still exists.  If the account is gone the
 * testnet was reset and all local data is stale.
 *
 * @param {string} canaryPublicKey - A public key that should exist on a live testnet.
 *   Defaults to the Stellar Foundation's well-known testnet account.
 * @returns {Promise<boolean>} true if a reset is detected
 */
async function detectTestnetReset(canaryPublicKey) {
  if (!isTestnet) return false;
  const key = canaryPublicKey || process.env.TESTNET_CANARY_ACCOUNT || 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
  try {
    await withFallback(s => s.loadAccount(key));
    return false; // account exists — no reset
  } catch (e) {
    if (e.response?.status === 404) {
      logger.warn('Testnet reset detected: canary account not found', { canaryPublicKey: key });
      return true;
    }
    throw e;
  }
}

/**
 * Re-fund a list of testnet wallets via Friendbot.
 * @param {string[]} publicKeys
 */
async function refundTestnetWallets(publicKeys) {
  if (!isTestnet) throw new Error('refundTestnetWallets is only available on testnet');
  const results = await Promise.allSettled(
    publicKeys.map(async (pk) => {
      const res = await fetch(`https://friendbot.stellar.org?addr=${pk}`);
      if (!res.ok) throw new Error(`Friendbot failed for ${pk}: ${await res.text()}`);
      return pk;
    })
  );
  return results.map((r, i) => ({
    publicKey: publicKeys[i],
    success: r.status === 'fulfilled',
    error: r.reason?.message || null,
  }));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  detectTestnetReset,
  refundTestnetWallets,
  createWallet,
  getBalance,
  getAccountSigners,
  clearInflationDestination,
  sendPayment,
  sendBatchPayment,
  getTransactions,
  encryptPrivateKey,
  decryptPrivateKey,
  fetchFee,
  fetchFeeStats,
  feeForPriority,
  checkHorizonHealth,
  findPaymentPath,
  sendPathPayment,
  validateBatchRecipient,
  resolveFederationAddress,
  createClaimableBalance,
  addTrustline,
  removeTrustline,
  getTrustlines,
  addAccountSigner,
  removeAccountSigner,
  mergeAccount,
  clawbackAsset,
  setDataEntry,
  getDataEntries,
  server,
  isTestnet,
  getAccountFlags,
  setAccountFlags,
  findReceivePath,
  sendStrictReceivePathPayment,
  isBadSeq,
  recoverSequence,
  withSequenceRecovery,
  validateNetworkPassphrase,
};
