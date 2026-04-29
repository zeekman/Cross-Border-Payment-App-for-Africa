const { initiateDeposit, initiateWithdrawal, getTransactionStatus } = require('../services/anchor');
const db = require('../db');
const logger = require('../utils/logger');

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

async function deposit(req, res, next) {
  try {
    const { asset } = req.body;
    const userId = req.user.userId;

    // Get user's wallet
    const walletResult = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [userId]
    );
    if (!walletResult.rows[0]) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const publicKey = walletResult.rows[0].public_key;
    const depositInfo = await initiateDeposit(publicKey, asset);

    if (!isAllowedAnchorUrl(depositInfo.url)) {
      logger.warn('Anchor deposit URL rejected: domain not in ANCHOR_DOMAIN allowlist', {
        url: depositInfo.url,
        userId,
      });
      return res.status(502).json({ error: 'Invalid anchor URL: domain not permitted' });
    }

    res.json({
      url: depositInfo.url,
      id: depositInfo.id,
      message: 'Open the URL in a new window to complete deposit'
    });
  } catch (err) {
    next(err);
  }
}

async function withdraw(req, res, next) {
  try {
    const { asset } = req.body;
    const userId = req.user.userId;

    // Get user's wallet
    const walletResult = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [userId]
    );
    if (!walletResult.rows[0]) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const publicKey = walletResult.rows[0].public_key;
    const withdrawInfo = await initiateWithdrawal(publicKey, asset);

    if (!isAllowedAnchorUrl(withdrawInfo.url)) {
      logger.warn('Anchor withdraw URL rejected: domain not in ANCHOR_DOMAIN allowlist', {
        url: withdrawInfo.url,
        userId,
      });
      return res.status(502).json({ error: 'Invalid anchor URL: domain not permitted' });
    }

    res.json({
      url: withdrawInfo.url,
      id: withdrawInfo.id,
      message: 'Open the URL in a new window to complete withdrawal'
    });
  } catch (err) {
    next(err);
  }
}

async function status(req, res, next) {
  try {
    const { id } = req.params;
    const txStatus = await getTransactionStatus(id);
    res.json(txStatus);
  } catch (err) {
    next(err);
  }
}

module.exports = { deposit, withdraw, status };
