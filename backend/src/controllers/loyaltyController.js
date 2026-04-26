/**
 * Loyalty Controller
 *
 * Handles loyalty point queries and redemption.
 *
 * Routes:
 *   GET  /api/loyalty/balance        — on-chain point balance for the user
 *   POST /api/loyalty/redeem         — redeem 100 points for a 50 % fee discount
 *   GET  /api/loyalty/history        — off-chain mint/burn ledger from DB
 */

const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { redeemPoints, getBalance } = require("../services/loyaltyToken");

/**
 * GET /api/loyalty/balance
 * Returns the on-chain ALP balance for the authenticated user's wallet.
 */
async function balance(req, res, next) {
  try {
    const walletResult = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1",
      [req.user.userId]
    );
    if (!walletResult.rows[0]) {
      return res.status(404).json({ error: "Wallet not found" });
    }
    const { public_key } = walletResult.rows[0];

    const points = await getBalance({ walletAddress: public_key });
    res.json({ wallet: public_key, points });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/loyalty/redeem
 * Burns 100 points on-chain and records the discount entitlement in the DB.
 * Returns { redeemed, discount_pct, tx_hash }.
 */
async function redeem(req, res, next) {
  try {
    const walletResult = await db.query(
      "SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1",
      [req.user.userId]
    );
    if (!walletResult.rows[0]) {
      return res.status(404).json({ error: "Wallet not found" });
    }
    const { public_key, encrypted_secret_key } = walletResult.rows[0];

    const { redeemed, txHash } = await redeemPoints({
      encryptedSecretKey: encrypted_secret_key,
      walletAddress: public_key,
    });

    if (!redeemed) {
      return res.status(400).json({
        error: "Insufficient loyalty points. You need at least 100 points to redeem.",
        redeemed: false,
      });
    }

    // Record the burn in the off-chain ledger
    await db.query(
      `INSERT INTO loyalty_points (id, user_id, wallet_address, event_type, points, tx_hash)
       VALUES ($1, $2, $3, 'burn', $4, $5)`,
      [uuidv4(), req.user.userId, public_key, 100, txHash]
    );

    res.json({
      redeemed: true,
      discount_pct: 50,
      tx_hash: txHash,
      message: "50 % fee discount applied to your next transaction.",
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/loyalty/history
 * Returns the off-chain mint/burn ledger for the authenticated user.
 */
async function history(req, res, next) {
  try {
    const result = await db.query(
      `SELECT id, event_type, points, transaction_id, tx_hash, created_at
       FROM loyalty_points
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.userId]
    );
    res.json({ history: result.rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { balance, redeem, history };
