const StellarSdk = require('@stellar/stellar-sdk');
const crypto = require('crypto');
const logger = require('../utils/logger');

const isTestnet = process.env.STELLAR_NETWORK !== 'mainnet';
const server = new StellarSdk.Horizon.Server(
  process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
);
const networkPassphrase = isTestnet
  ? StellarSdk.Networks.TESTNET
  : StellarSdk.Networks.PUBLIC;

// Encrypt private key before storing
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

// Generate a new Stellar keypair
async function createWallet() {
  const keypair = StellarSdk.Keypair.random();
  const publicKey = keypair.publicKey();
  const secretKey = keypair.secret();

  // Fund account on testnet via Friendbot
  if (isTestnet) {
    try {
      await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
    } catch (e) {
      logger.warn('Friendbot funding failed', { error: e.message });
    }
  }

  return {
    publicKey,
    encryptedSecretKey: encryptPrivateKey(secretKey)
  };
}

// Get account balance
async function getBalance(publicKey) {
  try {
    const account = await server.loadAccount(publicKey);
    return account.balances.map(b => ({
      asset: b.asset_type === 'native' ? 'XLM' : b.asset_code,
      balance: b.balance
    }));
  } catch (e) {
    if (e.response?.status === 404) return [];
    throw e;
  }
}

// Resolve a Stellar Asset object, validating issuer config for non-XLM assets
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

// Check that the recipient has a trustline for the given asset
async function checkTrustline(recipientPublicKey, assetObj) {
  let recipientAccount;
  try {
    recipientAccount = await server.loadAccount(recipientPublicKey);
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

const MEMO_ID_MAX = 2n ** 64n - 1n;

function memoValidationError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * Build a Stellar memo from user input. Default type is `text` (max 28 chars).
 * @param {string} memo - trimmed memo payload
 * @param {string} [memoType='text'] - text | id | hash | return
 */
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

// Resolve federation address to public key
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

// Send payment
async function sendPayment({
  senderPublicKey,
  encryptedSecretKey,
  recipientPublicKey,
  amount,
  asset = 'XLM',
  memo,
  memoType = 'text'
}) {
  const resolvedRecipient = await resolveFederationAddress(recipientPublicKey);
  const assetObj = resolveAsset(asset);

  // Trustline check is only required for non-native assets
  if (asset !== 'XLM') {
    await checkTrustline(resolvedRecipient, assetObj);
  }

  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const senderKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  const senderAccount = await server.loadAccount(senderPublicKey);

  const txBuilder = new StellarSdk.TransactionBuilder(senderAccount, {
    fee: await server.fetchBaseFee(),
    networkPassphrase
  })
    .addOperation(StellarSdk.Operation.payment({
      destination: resolvedRecipient,
      asset: assetObj,
      amount: String(amount)
    }))
    .setTimeout(30);

  const memoObj = memo ? buildStellarMemo(memo, memoType) : null;
  if (memoObj) txBuilder.addMemo(memoObj);

  const transaction = txBuilder.build();
  transaction.sign(senderKeypair);

  const result = await server.submitTransaction(transaction);
  return {
    transactionHash: result.hash,
    ledger: result.ledger
  };
}

// Fetch recent transactions for an account
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

module.exports = { createWallet, getBalance, sendPayment, getTransactions, decryptPrivateKey, resolveFederationAddress };
