const StellarSdk = require('@stellar/stellar-sdk');
const db = require('../db');
const { decryptPrivateKey } = require('../services/stellar');
const logger = require('../utils/logger');

const isTestnet = process.env.STELLAR_NETWORK !== 'mainnet';
const networkPassphrase = isTestnet
  ? StellarSdk.Networks.TESTNET
  : StellarSdk.Networks.PUBLIC;

const horizonServer = new StellarSdk.Horizon.Server(
  process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
);

// Unsigned XDRs expire after 5 minutes
const XDR_TTL_MS = 5 * 60 * 1000;

/**
 * POST /api/payments/build-transaction
 * Builds an unsigned transaction XDR for Ledger signing.
 * Returns the XDR and an expiry timestamp.
 */
async function buildTransaction(req, res, next) {
  try {
    const { recipient_address, amount, asset = 'XLM', memo, memo_type = 'text', wallet_id } = req.body;
    const userId = req.user.userId;

    // Resolve sender wallet
    const walletQuery = wallet_id
      ? await db.query(
          `SELECT public_key FROM wallets WHERE id = $1 AND user_id = $2`,
          [wallet_id, userId]
        )
      : await db.query(
          `SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC LIMIT 1`,
          [userId]
        );

    if (!walletQuery.rows.length) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const { public_key: senderPublicKey } = walletQuery.rows[0];

    // Validate recipient
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(recipient_address)) {
      return res.status(400).json({ error: 'Invalid recipient address' });
    }

    const senderAccount = await horizonServer.loadAccount(senderPublicKey);
    const fee = await horizonServer.fetchBaseFee();

    let assetObj;
    if (asset === 'XLM') {
      assetObj = StellarSdk.Asset.native();
    } else {
      const issuer = process.env[`${asset}_ISSUER`];
      if (!issuer) return res.status(400).json({ error: `${asset}_ISSUER not configured` });
      assetObj = new StellarSdk.Asset(asset, issuer);
    }

    const txBuilder = new StellarSdk.TransactionBuilder(senderAccount, {
      fee,
      networkPassphrase,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: recipient_address,
          asset: assetObj,
          amount: String(amount),
        })
      )
      .setTimeout(300); // 5-minute window

    if (memo) {
      const type = (memo_type || 'text').toLowerCase();
      if (type === 'text') txBuilder.addMemo(StellarSdk.Memo.text(memo.slice(0, 28)));
      else if (type === 'id') txBuilder.addMemo(StellarSdk.Memo.id(memo));
    }

    const transaction = txBuilder.build();
    const xdr = transaction.toXDR();
    const expiresAt = new Date(Date.now() + XDR_TTL_MS).toISOString();

    logger.info('Built unsigned transaction for Ledger', { senderPublicKey, recipient_address, amount, asset });

    res.json({ xdr, expires_at: expiresAt, network_passphrase: networkPassphrase });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/payments/submit-signed
 * Accepts a signed XDR from the Ledger and broadcasts it to Horizon.
 * Records the transaction in the DB.
 */
async function submitSigned(req, res, next) {
  try {
    const { xdr, recipient_address, amount, asset = 'XLM', wallet_id } = req.body;
    const userId = req.user.userId;

    if (!xdr) return res.status(400).json({ error: 'Signed XDR is required' });

    // Resolve sender wallet
    const walletQuery = wallet_id
      ? await db.query(
          `SELECT public_key FROM wallets WHERE id = $1 AND user_id = $2`,
          [wallet_id, userId]
        )
      : await db.query(
          `SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC LIMIT 1`,
          [userId]
        );

    if (!walletQuery.rows.length) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const { public_key: senderPublicKey } = walletQuery.rows[0];

    // Deserialize and validate the transaction
    let transaction;
    try {
      transaction = StellarSdk.TransactionBuilder.fromXDR(xdr, networkPassphrase);
    } catch {
      return res.status(400).json({ error: 'Invalid or expired XDR' });
    }

    // Verify the transaction is signed (has at least one signature)
    if (!transaction.signatures || transaction.signatures.length === 0) {
      return res.status(400).json({ error: 'Transaction has no signatures' });
    }

    // Submit to Horizon
    const result = await horizonServer.submitTransaction(transaction);

    // Record in DB
    await db.query(
      `INSERT INTO transactions (id, user_id, sender_wallet, recipient_wallet, amount, asset, status, transaction_hash, signing_method)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'completed', $6, 'ledger')
       ON CONFLICT (transaction_hash) DO NOTHING`,
      [userId, senderPublicKey, recipient_address || 'unknown', amount || '0', asset, result.hash]
    );

    logger.info('Ledger-signed transaction submitted', { hash: result.hash, userId });

    res.json({ transaction_hash: result.hash, ledger: result.ledger });
  } catch (err) {
    if (err.response?.data) {
      return res.status(400).json({
        error: 'Transaction failed',
        extras: err.response.data.extras,
      });
    }
    next(err);
  }
}

module.exports = { buildTransaction, submitSigned };
