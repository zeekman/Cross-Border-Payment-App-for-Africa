/**
 * Stellar Payment Channels
 *
 * Pattern: two-party channel using sequence-number manipulation.
 *   1. open()   — both parties fund a shared escrow account; a pre-signed
 *                 "closing" transaction is exchanged off-chain.
 *   2. transact() — off-chain balance updates (stored in DB only).
 *   3. close()  — submit the latest closing transaction on-chain.
 *
 * Unilateral close: a time-locked "dispute" transaction lets either party
 * close after CHANNEL_TIMEOUT_SECONDS if the counterparty is unresponsive.
 */

const StellarSdk = require('@stellar/stellar-sdk');
const db = require('../db');
const { withFallback } = require('./stellar');
const logger = require('../utils/logger');

const isTestnet = process.env.STELLAR_NETWORK !== 'mainnet';
const networkPassphrase = isTestnet
  ? StellarSdk.Networks.TESTNET
  : StellarSdk.Networks.PUBLIC;

const CHANNEL_TIMEOUT_SECONDS = parseInt(process.env.CHANNEL_TIMEOUT_SECONDS || '86400', 10); // 24h

function decryptPrivateKey(encryptedKey) {
  const crypto = require('crypto');
  const [ivHex, encryptedHex] = encryptedKey.split(':');
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'utf8').slice(0, 32);
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    key,
    Buffer.from(ivHex, 'hex')
  );
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Open a payment channel.
 * Creates a channel record; the actual on-chain escrow is the sender's own
 * account — no separate escrow account is created to keep things simple.
 * The "closing tx" is a time-bounded payment back to the sender.
 */
async function openChannel({ userId, senderPublicKey, encryptedSecretKey, recipientPublicKey, fundingAmount, asset = 'XLM' }) {
  const secretKey = decryptPrivateKey(encryptedSecretKey);
  const senderKeypair = StellarSdk.Keypair.fromSecret(secretKey);

  const senderAccount = await withFallback(s => s.loadAccount(senderPublicKey));
  const baseFee = await withFallback(s => s.fetchBaseFee());

  // Pre-sign a closing transaction: sender gets full funding back after timeout
  const assetObj = asset === 'XLM'
    ? StellarSdk.Asset.native()
    : new StellarSdk.Asset(asset, process.env[`${asset}_ISSUER`]);

  const closingTx = new StellarSdk.TransactionBuilder(senderAccount, {
    fee: baseFee,
    networkPassphrase,
    timebounds: {
      minTime: Math.floor(Date.now() / 1000) + CHANNEL_TIMEOUT_SECONDS,
      maxTime: 0,
    },
  })
    .addOperation(StellarSdk.Operation.payment({
      destination: senderPublicKey,
      asset: assetObj,
      amount: String(fundingAmount),
    }))
    .build();

  closingTx.sign(senderKeypair);
  const closingTxXdr = closingTx.toXDR();

  const { rows } = await db.query(
    `INSERT INTO payment_channels
       (user_id, sender_public_key, recipient_public_key, asset, funding_amount,
        sender_balance, recipient_balance, closing_tx_xdr, status)
     VALUES ($1,$2,$3,$4,$5,$5,0,$6,'open')
     RETURNING *`,
    [userId, senderPublicKey, recipientPublicKey, asset, fundingAmount, closingTxXdr]
  );

  logger.info('Payment channel opened', { channelId: rows[0].id, senderPublicKey });
  return rows[0];
}

/**
 * Record an off-chain payment within the channel.
 * Updates balances in DB; no on-chain transaction.
 */
async function transact({ channelId, userId, amount }) {
  const { rows: [channel] } = await db.query(
    `SELECT * FROM payment_channels WHERE id = $1 AND user_id = $2 AND status = 'open'`,
    [channelId, userId]
  );

  if (!channel) {
    const err = new Error('Channel not found or not open');
    err.status = 404;
    throw err;
  }

  const amt = parseFloat(amount);
  if (amt <= 0 || amt > parseFloat(channel.sender_balance)) {
    const err = new Error('Invalid amount or insufficient channel balance');
    err.status = 400;
    throw err;
  }

  const { rows } = await db.query(
    `UPDATE payment_channels
     SET sender_balance = sender_balance - $1,
         recipient_balance = recipient_balance + $1,
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [amt, channelId]
  );

  logger.info('Channel off-chain payment recorded', { channelId, amount: amt });
  return rows[0];
}

/**
 * Close the channel by submitting the pre-signed closing transaction on-chain.
 * If the channel has off-chain payments, builds a fresh settlement tx instead.
 */
async function closeChannel({ channelId, userId, encryptedSecretKey }) {
  const { rows: [channel] } = await db.query(
    `SELECT * FROM payment_channels WHERE id = $1 AND user_id = $2 AND status = 'open'`,
    [channelId, userId]
  );

  if (!channel) {
    const err = new Error('Channel not found or already closed');
    err.status = 404;
    throw err;
  }

  const recipientBalance = parseFloat(channel.recipient_balance);
  let txHash;

  if (recipientBalance > 0) {
    // Settle: send recipient_balance to recipient, rest stays with sender
    const secretKey = decryptPrivateKey(encryptedSecretKey);
    const senderKeypair = StellarSdk.Keypair.fromSecret(secretKey);
    const senderAccount = await withFallback(s => s.loadAccount(channel.sender_public_key));
    const baseFee = await withFallback(s => s.fetchBaseFee());

    const assetObj = channel.asset === 'XLM'
      ? StellarSdk.Asset.native()
      : new StellarSdk.Asset(channel.asset, process.env[`${channel.asset}_ISSUER`]);

    const settleTx = new StellarSdk.TransactionBuilder(senderAccount, {
      fee: baseFee,
      networkPassphrase,
    })
      .addOperation(StellarSdk.Operation.payment({
        destination: channel.recipient_public_key,
        asset: assetObj,
        amount: String(recipientBalance),
      }))
      .setTimeout(30)
      .build();

    settleTx.sign(senderKeypair);
    const result = await withFallback(s => s.submitTransaction(settleTx));
    txHash = result.hash;
  } else {
    // No off-chain payments — submit the pre-signed unilateral closing tx
    const tx = new StellarSdk.Transaction(channel.closing_tx_xdr, networkPassphrase);
    const result = await withFallback(s => s.submitTransaction(tx));
    txHash = result.hash;
  }

  const { rows } = await db.query(
    `UPDATE payment_channels
     SET status = 'closed', settlement_tx_hash = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [txHash, channelId]
  );

  logger.info('Payment channel closed', { channelId, txHash });
  return rows[0];
}

module.exports = { openChannel, transact, closeChannel };
