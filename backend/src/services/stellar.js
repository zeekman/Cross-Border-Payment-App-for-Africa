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

// Send payment
async function sendPayment({ senderPublicKey, encryptedSecretKey, recipientPublicKey, amount, asset = 'XLM', memo }) {
  const assetObj = resolveAsset(asset);

  // Trustline check is only required for non-native assets
  if (asset !== 'XLM') {
    await checkTrustline(recipientPublicKey, assetObj);
  }

  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const senderKeypair = StellarSdk.Keypair.fromSecret(secretKey);
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

  if (memo) txBuilder.addMemo(StellarSdk.Memo.text(memo.slice(0, 28)));

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

module.exports = { 
  createWallet, 
  getBalance, 
  sendPayment, 
  getTransactions, 
  decryptPrivateKey,
  issueAsset,
  getAssetInfo,
  getStellarStats
};
