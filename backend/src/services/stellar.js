const StellarSdk = require('@stellar/stellar-sdk');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const { withTimeout } = require('../utils/withTimeout');
const { enqueue } = require('../utils/txQueue');

const isTestnet = process.env.STELLAR_NETWORK !== 'mainnet';
const server = new StellarSdk.Horizon.Server(
  process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
);
const networkPassphrase = isTestnet
  ? StellarSdk.Networks.TESTNET
  : StellarSdk.Networks.PUBLIC;

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
    const account = await withRetry(() => server.loadAccount(publicKey), { label: 'loadAccount' });
    return account.balances.map(b => ({
      asset: b.asset_type === 'native' ? 'XLM' : b.asset_code,
      balance: b.balance
    }));
  } catch (e) {
    if (e.response?.status === 404) return [];
    throw e;
  }
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
    recipientAccount = await withRetry(() => server.loadAccount(recipientPublicKey), { label: 'loadAccount(recipient)' });
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
  memoType = 'text'
}) {
  const assetObj = resolveAsset(asset);
  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const senderKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  const senderAccount = await withRetry(() => server.loadAccount(senderPublicKey), { label: 'loadAccount(sender)' });

  const txBuilder = new StellarSdk.TransactionBuilder(senderAccount, {
    fee: await withRetry(() => server.fetchBaseFee(), { label: 'fetchBaseFee' }),
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

  const result = await withRetry(() => server.submitTransaction(transaction), { label: 'submitTransaction' });
  return { transactionHash: result.hash, ledger: result.ledger };
}

// ---------------------------------------------------------------------------
// Send payment — per-wallet queue + tx_bad_seq retry
// ---------------------------------------------------------------------------

const MAX_SEQ_RETRIES = 3;

function isBadSeq(err) {
  return err.response?.data?.extras?.result_codes?.transaction === 'tx_bad_seq';
}

async function sendPayment(params) {
  return enqueue(params.senderPublicKey, () => _sendPaymentOnce(params));
}

async function _sendPaymentOnce({
  senderPublicKey,
  encryptedSecretKey,
  recipientPublicKey,
  amount,
  asset = 'XLM',
  memo,
  memoType = 'text'
}) {
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
      const senderAccount = await server.loadAccount(senderPublicKey);

      const txBuilder = new StellarSdk.TransactionBuilder(senderAccount, {
        fee: await server.fetchBaseFee(),
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

      const result = await server.submitTransaction(transaction);
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
          senderPublicKey, encryptedSecretKey, recipientPublicKey, amount, asset, memo, memoType
        });
        return { ...result, type: 'claimable_balance' };
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
    const records = await server
      .transactions()
      .forAccount(publicKey)
      .limit(limit)
      .order('desc')
      .call();
    return records.records.map(tx => ({
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

// ---------------------------------------------------------------------------
// Fee estimate
// ---------------------------------------------------------------------------

async function fetchFee() {
  return withRetry(() => server.fetchBaseFee(), { label: 'fetchBaseFee' });
}

// ---------------------------------------------------------------------------
// Horizon health check
// ---------------------------------------------------------------------------

async function checkHorizonHealth() {
  try {
    await withTimeout(server.ledgers().order('desc').limit(1).call());
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

  const result = await server
    .strictSendPaths(srcAsset, String(sourceAmount), [dstAsset])
    .call();

  if (!result.records || result.records.length === 0) return null;

  const best = result.records.reduce((a, b) =>
    parseFloat(a.destination_amount) >= parseFloat(b.destination_amount) ? a : b
  );

  return { destinationAmount: best.destination_amount, path: best.path };
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
}) {
  const srcAsset = resolveAsset(sourceAsset);
  const dstAsset = resolveAsset(destinationAsset);

  if (destinationAsset !== 'XLM') {
    await checkTrustline(recipientPublicKey, dstAsset);
  }

  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const senderKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  const senderAccount = await server.loadAccount(senderPublicKey);

  const sdkPath = path.map(p =>
    p.asset_type === 'native'
      ? StellarSdk.Asset.native()
      : new StellarSdk.Asset(p.asset_code, p.asset_issuer)
  );

  const txBuilder = new StellarSdk.TransactionBuilder(senderAccount, {
    fee: await server.fetchBaseFee(),
    networkPassphrase
  })
    .addOperation(StellarSdk.Operation.pathPaymentStrictSend({
      sendAsset: srcAsset,
      sendAmount: String(sourceAmount),
      destination: recipientPublicKey,
      destAsset: dstAsset,
      destMin: String(destinationMinAmount),
      path: sdkPath
    }))
    .setTimeout(30);

  if (memo) txBuilder.addMemo(StellarSdk.Memo.text(memo.slice(0, 28)));

  const transaction = txBuilder.build();
  transaction.sign(senderKeypair);

  const result = await server.submitTransaction(transaction);
  return { transactionHash: result.hash, ledger: result.ledger };
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
  const account = await withRetry(() => server.loadAccount(ownerPublicKey), { label: 'loadAccount(multisig)' });

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

  tx.sign(ownerKeypair);
  const result = await withRetry(() => server.submitTransaction(tx), { label: 'submitTransaction(addSigner)' });
  return { transactionHash: result.hash };
}

/**
 * Remove a signer (weight=0) and reset thresholds to 1 if no signers remain.
 */
async function removeAccountSigner({ ownerPublicKey, encryptedSecretKey, signerPublicKey, remainingSigners = 0 }) {
  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const ownerKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  const account = await withRetry(() => server.loadAccount(ownerPublicKey), { label: 'loadAccount(removeSigner)' });

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
  const result = await withRetry(() => server.submitTransaction(tx), { label: 'submitTransaction(removeSigner)' });
  return { transactionHash: result.hash };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createWallet,
  getBalance,
  sendPayment,
  getTransactions,
  encryptPrivateKey,
  decryptPrivateKey,
  fetchFee,
  checkHorizonHealth,
  findPaymentPath,
  sendPathPayment,
  resolveFederationAddress,
  createClaimableBalance,
  addAccountSigner,
  removeAccountSigner,
};
