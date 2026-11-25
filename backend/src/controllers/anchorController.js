const { body, param, validationResult } = require('express-validator');
const { initiateDeposit, initiateWithdrawal, getTransactionStatus } = require('../services/anchor');
const db = require('../db');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validates that a URL returned by the anchor belongs to an allowed domain.
 * ANCHOR_DOMAIN is a comma-separated list of allowed hostnames, e.g.:
 *   ANCHOR_DOMAIN=anchor.example.com,testanchor.stellar.org
 *
 * Returns true if the URL is allowed, false otherwise.
 */
function isAllowedAnchorUrl(urlString) {
  const allowlist = (process.env.ANCHOR_DOMAIN || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  // If no allowlist is configured, reject everything to fail safe
  if (allowlist.length === 0) return false;

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return false;
  }

  return allowlist.includes(parsed.hostname.toLowerCase());
}

/**
 * Extract the SEP-10 JWT from the request.
 * Clients should send it as:  X-Sep10-Token: <jwt>
 * Falls back to the app-level Bearer token if the dedicated header is absent
 * (useful during development / testing).
 */
function extractSep10Jwt(req) {
  const dedicated = req.headers['x-sep10-token'];
  if (dedicated) return dedicated;

  // In production, never fall back to the app-level Bearer token
  if (process.env.NODE_ENV === 'production') return null;

  // Fallback: reuse the app JWT so the anchor at least gets *something*.
  // Only active outside production (development / testing).
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);

  return null;
}

// ---------------------------------------------------------------------------
// Validation chains (exported so routes can use them)
// ---------------------------------------------------------------------------

const depositValidation = [
  body('asset')
    .trim()
    .notEmpty().withMessage('asset is required')
    .isAlphanumeric().withMessage('asset must be alphanumeric')
    .isLength({ max: 12 }).withMessage('asset code too long'),
  body('amount')
    .optional()
    .isFloat({ gt: 0 }).withMessage('amount must be a positive number'),
  body('memo')
    .optional()
    .isString()
    .isLength({ max: 64 }).withMessage('memo too long'),
];

const withdrawValidation = [
  body('asset')
    .trim()
    .notEmpty().withMessage('asset is required')
    .isAlphanumeric().withMessage('asset must be alphanumeric')
    .isLength({ max: 12 }).withMessage('asset code too long'),
  body('amount')
    .optional()
    .isFloat({ gt: 0 }).withMessage('amount must be a positive number'),
  body('dest')
    .optional()
    .isString()
    .isLength({ max: 256 }).withMessage('dest too long'),
  body('dest_extra')
    .optional()
    .isString()
    .isLength({ max: 256 }).withMessage('dest_extra too long'),
];

const transactionIdValidation = [
  param('id')
    .trim()
    .notEmpty().withMessage('transaction id is required')
    .isLength({ max: 128 }).withMessage('transaction id too long'),
];

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/**
 * POST /api/anchor/deposit
 *
 * Initiates a SEP-24 interactive deposit.
 * Returns { url, id } — the frontend must open `url` in a popup/iframe so the
 * user can complete the anchor's KYC / payment form.
 */
async function deposit(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { asset, amount, memo } = req.body;
    const userId = req.user.userId;

    const walletResult = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
      [userId]
    );
    if (!walletResult.rows[0]) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const publicKey = walletResult.rows[0].public_key;
    const sep10Jwt = extractSep10Jwt(req);
    if (!sep10Jwt) {
      return res.status(400).json({ error: 'X-Sep10-Token header is required' });
    }

    // Build optional extra fields
    const extra = {};
    if (amount) extra.amount = String(amount);
    if (memo) extra.memo = memo;

    const depositInfo = await initiateDeposit(publicKey, asset, sep10Jwt, extra);

    if (!isAllowedAnchorUrl(depositInfo.url)) {
      logger.warn('Anchor deposit URL rejected: domain not in ANCHOR_DOMAIN allowlist', {
        url: depositInfo.url,
        userId,
      });
      return res.status(502).json({ error: 'Invalid anchor URL: domain not permitted' });
    }

    // Persist the pending transaction so we can track it later
    await db.query(
      `INSERT INTO anchor_transactions (id, user_id, type, asset, status, created_at)
       VALUES ($1, $2, 'deposit', $3, 'pending', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [depositInfo.id, userId, asset]
    ).catch((dbErr) => {
      // Non-fatal — log but don't fail the request
      logger.warn('Failed to persist anchor deposit transaction', { error: dbErr.message });
    });

    logger.info('Anchor deposit initiated', { userId, asset, transactionId: depositInfo.id });

    res.json({
      url: depositInfo.url,
      id: depositInfo.id,
      message: 'Open the URL to complete the deposit',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/anchor/withdraw
 *
 * Initiates a SEP-24 interactive withdrawal.
 * Returns { url, id } — the frontend must open `url` in a popup/iframe.
 */
async function withdraw(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { asset, amount, dest, dest_extra } = req.body;
    const userId = req.user.userId;

    const walletResult = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
      [userId]
    );
    if (!walletResult.rows[0]) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const publicKey = walletResult.rows[0].public_key;
    const sep10Jwt = extractSep10Jwt(req);
    if (!sep10Jwt) {
      return res.status(400).json({ error: 'X-Sep10-Token header is required' });
    }

    const extra = {};
    if (amount) extra.amount = String(amount);
    if (dest) extra.dest = dest;
    if (dest_extra) extra.dest_extra = dest_extra;

    const withdrawInfo = await initiateWithdrawal(publicKey, asset, sep10Jwt, extra);

    if (!isAllowedAnchorUrl(withdrawInfo.url)) {
      logger.warn('Anchor withdraw URL rejected: domain not in ANCHOR_DOMAIN allowlist', {
        url: withdrawInfo.url,
        userId,
      });
      return res.status(502).json({ error: 'Invalid anchor URL: domain not permitted' });
    }

    await db.query(
      `INSERT INTO anchor_transactions (id, user_id, type, asset, status, created_at)
       VALUES ($1, $2, 'withdrawal', $3, 'pending', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [withdrawInfo.id, userId, asset]
    ).catch((dbErr) => {
      logger.warn('Failed to persist anchor withdrawal transaction', { error: dbErr.message });
    });

    logger.info('Anchor withdrawal initiated', { userId, asset, transactionId: withdrawInfo.id });

    res.json({
      url: withdrawInfo.url,
      id: withdrawInfo.id,
      message: 'Open the URL to complete the withdrawal',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/anchor/transaction/:id
 *
 * Polls the anchor for the current status of a transaction.
 * Auth-gated: users can only query their own transactions.
 */
async function status(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Verify the transaction belongs to this user (if we have a record)
    const record = await db.query(
      'SELECT id, type, asset, status FROM anchor_transactions WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    // If we have no local record, still allow the poll — the anchor is the
    // source of truth. We just won't leak other users' data.
    if (record.rows.length === 0) {
      // Check if the transaction exists at all (owned by someone else)
      const anyRecord = await db.query(
        'SELECT id FROM anchor_transactions WHERE id = $1',
        [id]
      );
      if (anyRecord.rows.length > 0) {
        return res.status(403).json({ error: 'Access denied' });
      }
      // Unknown ID — let the anchor respond (it will 404 if invalid)
    }

    const sep10Jwt = extractSep10Jwt(req);
    if (!sep10Jwt) {
      return res.status(400).json({ error: 'X-Sep10-Token header is required' });
    }
    const txStatus = await getTransactionStatus(id, sep10Jwt);

    // Sync status back to our DB if we have a record
    if (record.rows.length > 0 && txStatus?.status) {
      await db.query(
        'UPDATE anchor_transactions SET status = $1, updated_at = NOW() WHERE id = $2',
        [txStatus.status, id]
      ).catch(() => {});
    }

    res.json(txStatus);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  deposit,
  withdraw,
  status,
  depositValidation,
  withdrawValidation,
  transactionIdValidation,
};
