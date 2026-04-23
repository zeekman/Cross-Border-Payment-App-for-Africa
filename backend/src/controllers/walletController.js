const bcrypt = require('bcryptjs');
const db = require('../db');
const { getBalance, getTransactions, decryptPrivateKey, addAccountSigner, removeAccountSigner, addTrustline, removeTrustline, getTrustlines, mergeAccount, setDataEntry, getDataEntries } = require('../services/stellar');
const QRCode = require('qrcode');
const cache = require('../utils/cache');
const audit = require('../services/audit');

async function getWallet(req, res, next) {
  try {
    const result = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [req.user.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    const { public_key } = result.rows[0];
    const cacheKey = `balance:${public_key}`;

    // Try cache first
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({ public_key, balances: cached, cached: true });
    }

    // Cache miss — hit Horizon
    const balances = await getBalance(public_key);
    await cache.set(cacheKey, balances, cache.BALANCE_TTL);

    res.json({ public_key, balances, cached: false });
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

async function exportKey(req, res, next) {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required' });

    const userResult = await db.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(password, userResult.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    const walletResult = await db.query(
      'SELECT encrypted_secret_key FROM wallets WHERE user_id = $1',
      [req.user.userId]
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    const secretKey = decryptPrivateKey(walletResult.rows[0].encrypted_secret_key);
    audit.log(req.user.userId, 'wallet_export', req.ip, req.headers['user-agent']);
    res.json({ secret_key: secretKey });
  } catch (err) {
    next(err);
  }
}

async function upgradeToBusinessAccount(req, res, next) {
  try {
    await db.query(
      `UPDATE users SET account_type = 'business' WHERE id = $1`,
      [req.user.userId]
    );
    res.json({ message: 'Account upgraded to business' });
  } catch (err) {
    next(err);
  }
}

async function addSigner(req, res, next) {
  try {
    const { signer_public_key, label } = req.body;

    const walletResult = await db.query(
      'SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1',
      [req.user.userId]
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    const { public_key, encrypted_secret_key } = walletResult.rows[0];

    const { transactionHash } = await addAccountSigner({
      ownerPublicKey: public_key,
      encryptedSecretKey: encrypted_secret_key,
      signerPublicKey: signer_public_key,
    });

    await db.query(
      `INSERT INTO wallet_signers (user_id, signer_public_key, label)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, signer_public_key) DO NOTHING`,
      [req.user.userId, signer_public_key, label || null]
    );

    res.status(201).json({ message: 'Signer added', transaction_hash: transactionHash });
  } catch (err) {
    next(err);
  }
}

async function removeSigner(req, res, next) {
  try {
    const { signer_public_key } = req.params;

    const walletResult = await db.query(
      'SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1',
      [req.user.userId]
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    const { public_key, encrypted_secret_key } = walletResult.rows[0];

    // Count remaining signers after removal
    const countResult = await db.query(
      `SELECT COUNT(*) FROM wallet_signers WHERE user_id = $1 AND signer_public_key != $2`,
      [req.user.userId, signer_public_key]
    );
    const remainingSigners = parseInt(countResult.rows[0].count, 10);

    const { transactionHash } = await removeAccountSigner({
      ownerPublicKey: public_key,
      encryptedSecretKey: encrypted_secret_key,
      signerPublicKey: signer_public_key,
      remainingSigners,
    });

    await db.query(
      `DELETE FROM wallet_signers WHERE user_id = $1 AND signer_public_key = $2`,
      [req.user.userId, signer_public_key]
    );

    // Downgrade to personal if no signers left
    if (remainingSigners === 0) {
      await db.query(`UPDATE users SET account_type = 'personal' WHERE id = $1`, [req.user.userId]);
    }

    res.json({ message: 'Signer removed', transaction_hash: transactionHash });
  } catch (err) {
    next(err);
  }
}

async function listSigners(req, res, next) {
  try {
    const result = await db.query(
      `SELECT signer_public_key, label, added_at FROM wallet_signers WHERE user_id = $1 ORDER BY added_at ASC`,
      [req.user.userId]
    );
    res.json({ signers: result.rows });
  } catch (err) {
    next(err);
  }
}

async function listTrustlines(req, res, next) {
  try {
    const result = await db.query('SELECT public_key FROM wallets WHERE user_id = $1', [req.user.userId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Wallet not found' });
    const trustlines = await getTrustlines(result.rows[0].public_key);
    res.json({ trustlines });
  } catch (err) {
    next(err);
  }
}

async function addTrustlineHandler(req, res, next) {
  try {
    const { asset, limit } = req.body;
    const result = await db.query('SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1', [req.user.userId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Wallet not found' });
    const { public_key, encrypted_secret_key } = result.rows[0];
    const { transactionHash } = await addTrustline({ publicKey: public_key, encryptedSecretKey: encrypted_secret_key, asset, limit });
    res.status(201).json({ message: 'Trustline added', transaction_hash: transactionHash });
  } catch (err) {
    next(err);
  }
}

async function removeTrustlineHandler(req, res, next) {
  try {
    const { asset } = req.params;
    const result = await db.query('SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1', [req.user.userId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Wallet not found' });
    const { public_key, encrypted_secret_key } = result.rows[0];
    const { transactionHash } = await removeTrustline({ publicKey: public_key, encryptedSecretKey: encrypted_secret_key, asset });
    res.json({ message: 'Trustline removed', transaction_hash: transactionHash });
  } catch (err) {
    // Stellar returns tx_failed / op_invalid_limit when balance > 0
    if (err.response?.data?.extras?.result_codes?.operations?.includes('op_invalid_limit')) {
      return res.status(400).json({ error: 'Cannot remove trustline: account still holds a balance of this asset' });
    }
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

module.exports = { getWallet, getQRCode, getWalletTransactions, exportKey, upgradeToBusinessAccount, addSigner, removeSigner, listSigners, listTrustlines, addTrustlineHandler, removeTrustlineHandler, mergeWallet, listDataEntries, setEntry, deleteEntry, ALLOWED_KEYS };

async function mergeWallet(req, res, next) {
  try {
    const { destination, password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required' });
    if (!destination) return res.status(400).json({ error: 'Destination address is required' });

    // Re-verify password
    const userResult = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.userId]);
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(password, userResult.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    const walletResult = await db.query(
      'SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1',
      [req.user.userId]
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: 'Wallet not found' });
    const { public_key, encrypted_secret_key } = walletResult.rows[0];

    if (public_key === destination) {
      return res.status(400).json({ error: 'Destination cannot be the same as the source account' });
    }

    const { transactionHash, ledger } = await mergeAccount({
      sourcePublicKey: public_key,
      encryptedSecretKey: encrypted_secret_key,
      destinationPublicKey: destination,
    });

    // Remove wallet record — account is now closed on-chain
    await db.query('DELETE FROM wallets WHERE user_id = $1', [req.user.userId]);

    audit.log(req.user.userId, 'account_merge', req.ip, req.headers['user-agent'], {
      destination,
      transaction_hash: transactionHash,
    });

    res.json({
      message: 'Account merged successfully. Your account has been permanently closed.',
      transaction_hash: transactionHash,
      ledger,
    });
  } catch (err) {
    next(err);
  }
}
