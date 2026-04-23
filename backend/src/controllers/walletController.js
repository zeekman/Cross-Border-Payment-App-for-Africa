const db = require('../db');
const { getBalance, getTransactions, setDataEntry, getDataEntries } = require('../services/stellar');
const QRCode = require('qrcode');

async function getWallet(req, res, next) {
  try {
    const result = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [req.user.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    const { public_key } = result.rows[0];
    const balances = await getBalance(public_key);

    res.json({ public_key, balances });
  } catch (err) {
    next(err);
  }
}

async function getQRCode(req, res, next) {
  try {
    const result = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [req.user.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    const qrDataUrl = await QRCode.toDataURL(result.rows[0].public_key);
    res.json({ qr_code: qrDataUrl, public_key: result.rows[0].public_key });
  } catch (err) {
    next(err);
  }
}

async function getWalletTransactions(req, res, next) {
  try {
    const result = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [req.user.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    // Get from local DB first
    const txResult = await db.query(
      `SELECT * FROM transactions
       WHERE sender_wallet = $1 OR recipient_wallet = $1
       ORDER BY created_at DESC LIMIT 50`,
      [result.rows[0].public_key]
    );

    res.json({ transactions: txResult.rows });
  } catch (err) {
    next(err);
  }
}

// Keys users are permitted to manage on their Stellar account
const ALLOWED_KEYS = new Set([
  'kyc_hash',
  'federation_address',
  'afripay_verified',
  'contact_email_hash',
  'profile_hash',
]);

async function getWalletRow(userId) {
  const result = await db.query(
    'SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

async function listDataEntries(req, res, next) {
  try {
    const wallet = await getWalletRow(req.user.userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    const entries = await getDataEntries(wallet.public_key);
    res.json({ entries });
  } catch (err) {
    next(err);
  }
}

async function setEntry(req, res, next) {
  try {
    const { key, value } = req.body;
    if (!ALLOWED_KEYS.has(key)) {
      return res.status(400).json({ error: `Key '${key}' is not allowed. Permitted keys: ${[...ALLOWED_KEYS].join(', ')}` });
    }
    const wallet = await getWalletRow(req.user.userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    const result = await setDataEntry({ publicKey: wallet.public_key, encryptedSecretKey: wallet.encrypted_secret_key, key, value });
    res.json({ message: 'Data entry set', transactionHash: result.transactionHash });
  } catch (err) {
    next(err);
  }
}

async function deleteEntry(req, res, next) {
  try {
    const { key } = req.params;
    if (!ALLOWED_KEYS.has(key)) {
      return res.status(400).json({ error: `Key '${key}' is not allowed.` });
    }
    const wallet = await getWalletRow(req.user.userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    const result = await setDataEntry({ publicKey: wallet.public_key, encryptedSecretKey: wallet.encrypted_secret_key, key, value: null });
    res.json({ message: 'Data entry deleted', transactionHash: result.transactionHash });
  } catch (err) {
    next(err);
  }
}

module.exports = { getWallet, getQRCode, getWalletTransactions, listDataEntries, setEntry, deleteEntry, ALLOWED_KEYS };
