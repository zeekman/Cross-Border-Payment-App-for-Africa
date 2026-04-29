const { v4: uuidv4 } = require('uuid');
const db = require('../db');

async function create(req, res, next) {
  try {
    const { amount, asset = 'XLM', memo } = req.body;
    const userId = req.user.userId;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }

    // Get requester's wallet
    const walletResult = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [userId]
    );
    if (!walletResult.rows[0]) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    const requesterWallet = walletResult.rows[0].public_key;

    // Create payment request with 7-day expiry
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const requestId = uuidv4();

    await db.query(
      `INSERT INTO payment_requests (id, requester_id, requester_wallet, amount, asset, memo, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [requestId, userId, requesterWallet, amount, asset, memo || null, expiresAt]
    );

    const domain = process.env.FRONTEND_URL || 'http://localhost:3000';
    const paymentLink = `${domain}/send?to=${requesterWallet}&amount=${amount}&asset=${asset}${memo ? `&memo=${encodeURIComponent(memo)}` : ''}&request=${requestId}`;

    res.json({
      id: requestId,
      amount,
      asset,
      memo,
      expiresAt,
      paymentLink
    });
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const { id } = req.params;

    const result = await db.query(
      `SELECT id, requester_wallet, amount, asset, memo, expires_at, claimed, claimed_tx_hash
       FROM payment_requests
       WHERE id = $1 AND expires_at > NOW()`,
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Payment request not found or expired' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
}

async function markClaimed(req, res, next) {
  try {
    const { id } = req.params;
    const { txHash } = req.body;

    await db.query(
      `UPDATE payment_requests
       SET claimed = true, claimed_tx_hash = $1
       WHERE id = $2`,
      [txHash, id]
    );

    res.json({ message: 'Payment request marked as claimed' });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, getById, markClaimed };
