const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const {
  getBalance,
  getAccountSigners,
  clearInflationDestination,
  getTransactions,
  decryptPrivateKey,
  addAccountSigner,
  removeAccountSigner,
  addTrustline,
  removeTrustline,
  getTrustlines,
  mergeAccount,
  createWallet: generateWallet,
  setDataEntry,
  getDataEntries,
  getAccountFlags,
  setAccountFlags,
} = require('../services/stellar');
const QRCode = require('qrcode');
const cache = require('../utils/cache');
const audit = require('../services/audit');


const MAX_WALLETS_PER_USER = 5;

/**
 * Resolve which wallet to use for the authenticated user.
 * If wallet_id is provided (query or body), verify it belongs to the user.
 * Otherwise fall back to the user's default wallet.
 */
async function resolveWallet(userId, walletId) {
  if (walletId) {
    const result = await db.query(
      'SELECT id, public_key, encrypted_secret_key, label, is_default FROM wallets WHERE id = $1 AND user_id = $2',
      [walletId, userId],
    );
    if (!result.rows[0]) return null;
    return result.rows[0];
  }

  // Default wallet
  const result = await db.query(
    'SELECT id, public_key, encrypted_secret_key, label, is_default FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
    [userId],
  );
  return result.rows[0] || null;
}

// ---------------------------------------------------------------------------
// GET /wallet/balance  (optionally ?wallet_id=<uuid>)
// ---------------------------------------------------------------------------
async function getWallet(req, res, next) {
  try {
    const walletId = req.query.wallet_id || null;
    const wallet = await resolveWallet(req.user.userId, walletId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const { public_key } = wallet;
    const cacheKey = `balance:${public_key}`;

    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({ id: wallet.id, public_key, label: wallet.label, is_default: wallet.is_default, ...cached, cached: true });
    }

    const balanceData = await getBalance(public_key);
    await cache.set(cacheKey, balanceData, cache.BALANCE_TTL);

    res.json({ id: wallet.id, public_key, label: wallet.label, is_default: wallet.is_default, ...balanceData, cached: false });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /wallet/list  — all wallets for the user with balances
// ---------------------------------------------------------------------------
async function listWallets(req, res, next) {
  try {
    const result = await db.query(
      'SELECT id, public_key, label, is_default, created_at FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC',
      [req.user.userId],
    );

    // Fetch balances in parallel (cache-aware)
    const wallets = await Promise.all(
      result.rows.map(async (w) => {
        const cacheKey = `balance:${w.public_key}`;
        let balanceData = await cache.get(cacheKey);
        if (!balanceData) {
          try {
            balanceData = await getBalance(w.public_key);
            await cache.set(cacheKey, balanceData, cache.BALANCE_TTL);
          } catch {
            balanceData = { account_exists: false, balances: [] };
          }
        }
        return { ...w, ...balanceData };
      }),
    );

    res.json({ wallets });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /wallet/create
// Body: { label?: string }
// ---------------------------------------------------------------------------
async function createWalletHandler(req, res, next) {
  try {
    const { label } = req.body;
    const walletLabel = (label || '').trim() || 'Wallet';

    // Enforce per-user limit
    const countResult = await db.query(
      'SELECT COUNT(*) AS count FROM wallets WHERE user_id = $1',
      [req.user.userId],
    );
    const currentCount = parseInt(countResult.rows[0].count, 10);
    if (currentCount >= MAX_WALLETS_PER_USER) {
      return res.status(400).json({
        error: `You can have at most ${MAX_WALLETS_PER_USER} wallets per account.`,
        code: 'WALLET_LIMIT_REACHED',
      });
    }

    // Generate a new Stellar keypair and fund on testnet
    const { publicKey, encryptedSecretKey } = await generateWallet();

    const walletId = uuidv4();
    await db.query(
      `INSERT INTO wallets (id, user_id, public_key, encrypted_secret_key, label, is_default)
       VALUES ($1, $2, $3, $4, $5, false)`,
      [walletId, req.user.userId, publicKey, encryptedSecretKey, walletLabel],
    );

    audit.log(req.user.userId, 'wallet_created', req.ip, req.headers['user-agent'], { wallet_id: walletId });

    res.status(201).json({
      message: 'Wallet created successfully',
      wallet: { id: walletId, public_key: publicKey, label: walletLabel, is_default: false },
    });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /wallet/qr  (optionally ?wallet_id=<uuid>)
// ---------------------------------------------------------------------------
async function getQRCode(req, res, next) {
  try {
    const wallet = await resolveWallet(req.user.userId, req.query.wallet_id || null);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const qrDataUrl = await QRCode.toDataURL(wallet.public_key);
    res.json({ qr_code: qrDataUrl, public_key: wallet.public_key });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /wallet/transactions  (optionally ?wallet_id=<uuid>)
// DEPRECATED — use GET /api/payments/history instead
// ---------------------------------------------------------------------------
async function getWalletTransactions(req, res, next) {
  try {
    res.set('Deprecation', 'true');
    res.set('Link', '</api/payments/history>; rel="successor-version"');
    res.set('Sunset', 'Sat, 01 Jan 2026 00:00:00 GMT');

    const wallet = await resolveWallet(req.user.userId, req.query.wallet_id || null);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const txResult = await db.query(
      `SELECT * FROM transactions
       WHERE sender_wallet = $1 OR recipient_wallet = $1
       ORDER BY created_at DESC LIMIT 50`,
      [wallet.public_key],
    );

    res.json({ transactions: txResult.rows });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /wallet/export-key
// ---------------------------------------------------------------------------
async function exportKey(req, res, next) {
  try {
    const { password, wallet_id } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required' });

    const userResult = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.userId]);
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(password, userResult.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    const wallet = await resolveWallet(req.user.userId, wallet_id || null);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const secretKey = decryptPrivateKey(wallet.encrypted_secret_key);
    audit.log(req.user.userId, 'wallet_export', req.ip, req.headers['user-agent'], { wallet_id: wallet.id });
    res.json({ secret_key: secretKey });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Business account / multisig (unchanged — operates on default wallet)
// ---------------------------------------------------------------------------
async function upgradeToBusinessAccount(req, res, next) {
  try {
    await db.query(`UPDATE users SET account_type = 'business' WHERE id = $1`, [req.user.userId]);
    res.json({ message: 'Account upgraded to business' });
  } catch (err) {
    next(err);
  }
}

async function addSigner(req, res, next) {
  try {
    const { signer_public_key, label } = req.body;

    const walletResult = await db.query(
      'SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1 AND is_default = true',
      [req.user.userId],
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
      [req.user.userId, signer_public_key, label || null],
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
      'SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1 AND is_default = true',
      [req.user.userId],
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    const { public_key, encrypted_secret_key } = walletResult.rows[0];

    const countResult = await db.query(
      `SELECT COUNT(*) FROM wallet_signers WHERE user_id = $1 AND signer_public_key != $2`,
      [req.user.userId, signer_public_key],
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
      [req.user.userId, signer_public_key],
    );

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
      [req.user.userId],
    );
    res.json({ signers: result.rows });
  } catch (err) {
    next(err);
  }
}

async function listTrustlines(req, res, next) {
  try {
    const wallet = await resolveWallet(req.user.userId, req.query.wallet_id || null);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    const trustlines = await getTrustlines(wallet.public_key);
    res.json({ trustlines });
  } catch (err) {
    next(err);
  }
}

async function addTrustlineHandler(req, res, next) {
  try {
    const { asset, limit, wallet_id } = req.body;
    const wallet = await resolveWallet(req.user.userId, wallet_id || null);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    const { transactionHash } = await addTrustline({
      publicKey: wallet.public_key,
      encryptedSecretKey: wallet.encrypted_secret_key,
      asset,
      limit,
    });
    res.status(201).json({ message: 'Trustline added', transaction_hash: transactionHash });
  } catch (err) {
    next(err);
  }
}

async function removeTrustlineHandler(req, res, next) {
  try {
    const { asset } = req.params;
    const wallet = await resolveWallet(req.user.userId, req.query.wallet_id || null);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    const { transactionHash } = await removeTrustline({
      publicKey: wallet.public_key,
      encryptedSecretKey: wallet.encrypted_secret_key,
      asset,
    });
    res.json({ message: 'Trustline removed', transaction_hash: transactionHash });
  } catch (err) {
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

/**
 * GET /api/wallet/flags
 * Returns the current Stellar authorization flags for the user's wallet.
 */
async function getWalletFlags(req, res, next) {
  try {
    const wallet = await resolveWallet(req.user.userId, req.query.wallet_id || null);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    const flags = await getAccountFlags(wallet.public_key);
    res.json({ public_key: wallet.public_key, flags });
  } catch (err) {
    next(err);
  }
}

module.exports = { getWallet, getQRCode, getWalletTransactions, exportKey, upgradeToBusinessAccount, addSigner, removeSigner, listSigners, listTrustlines, addTrustlineHandler, removeTrustlineHandler, mergeWallet, listDataEntries, setEntry, deleteEntry, ALLOWED_KEYS };

async function mergeWallet(req, res, next) {
  try {
    const { destination, password, wallet_id } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required' });
    if (!destination) return res.status(400).json({ error: 'Destination address is required' });

    const userResult = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.userId]);
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(password, userResult.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    const wallet = await resolveWallet(req.user.userId, wallet_id || null);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    if (wallet.is_default) {
      return res.status(400).json({ error: 'Cannot merge your default wallet. Set another wallet as default first.' });
    }

    if (wallet.public_key === destination) {
      return res.status(400).json({ error: 'Destination cannot be the same as the source account' });
    }

    const { transactionHash, ledger } = await mergeAccount({
      sourcePublicKey: wallet.public_key,
      encryptedSecretKey: wallet.encrypted_secret_key,
      destinationPublicKey: destination,
    });

    await db.query('DELETE FROM wallets WHERE id = $1', [wallet.id]);

    audit.log(req.user.userId, 'account_merge', req.ip, req.headers['user-agent'], {
      wallet_id: wallet.id,
      destination,
      transaction_hash: transactionHash,
    });

    res.json({
      message: 'Account merged successfully. The wallet has been permanently closed.',
      transaction_hash: transactionHash,
      ledger,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/wallet/signers — returns signers and thresholds directly from Horizon.
 * Issue #142: display live signer data including weight and type.
 */
async function getSignersFromHorizon(req, res, next) {
  try {
    const wallet = await resolveWallet(req.user.userId, req.query.wallet_id || null);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    const data = await getAccountSigners(wallet.public_key);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/wallet/clear-inflation-destination — clears legacy inflation_destination.
 * Issue #141: detect and clear legacy Stellar inflation destinations.
 */
async function clearInflationDestinationHandler(req, res, next) {
  try {
    const wallet = await resolveWallet(req.user.userId, req.query.wallet_id || null);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const { transactionHash } = await clearInflationDestination({
      publicKey: wallet.public_key,
      encryptedSecretKey: wallet.encrypted_secret_key,
    });

    audit.log(req.user.userId, 'clear_inflation_destination', req.ip, req.headers['user-agent'], {
      wallet_id: wallet.id,
      transaction_hash: transactionHash,
    });

    res.json({ message: 'Inflation destination cleared', transaction_hash: transactionHash });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /wallet/import-history
// Fetches complete payment history from Horizon and stores it idempotently.
// ---------------------------------------------------------------------------
const { importWalletHistory } = require('../services/horizonService');

async function importTransactionHistory(req, res, next) {
  try {
    const walletId = req.body.wallet_id || null;
    const wallet = await resolveWallet(req.user.userId, walletId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const imported = await importWalletHistory(wallet.id, wallet.public_key);
    res.json({ message: 'Import complete', imported });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getWallet,
  listWallets,
  createWalletHandler,
  getQRCode,
  getWalletTransactions,
  exportKey,
  upgradeToBusinessAccount,
  addSigner,
  removeSigner,
  listSigners,
  getSignersFromHorizon,
  clearInflationDestinationHandler,
  listTrustlines,
  addTrustlineHandler,
  removeTrustlineHandler,
  mergeWallet,
  listDataEntries,
  setEntry,
  deleteEntry,
  getWalletFlags,
  importTransactionHistory,
};
