const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { verifyIncomingPayment } = require('../services/stellar');

async function create(req, res, next) {
  try {
    const { amount, asset = 'XLM', memo } = req.body;
    const userId = req.user.userId;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }

    // Get requester's wallet
    const walletResult = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
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
    // Only the request ID is embedded in the link. The canonical requester
    // wallet, amount, asset and memo are always loaded server-side from the
    // stored request, so tampering with URL params cannot redirect funds.
    const paymentLink = `${domain}/send?request=${requestId}`;

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
    const userId = req.user.userId;

    const result = await db.query(
      `SELECT requester_id, requester_wallet, amount, asset, claimed
       FROM payment_requests WHERE id = $1 AND expires_at > NOW()`,
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Payment request not found or expired' });
    }

    const paymentRequest = result.rows[0];

    if (paymentRequest.requester_id !== userId) {
      return res.status(403).json({ error: 'Only the intended recipient can claim this payment request' });
    }

    if (paymentRequest.claimed) {
      return res.status(409).json({ error: 'Payment request already claimed' });
    }

    const verification = await verifyIncomingPayment({
      txHash,
      destination: paymentRequest.requester_wallet,
      asset: paymentRequest.asset,
      minAmount: paymentRequest.amount,
    });

    if (!verification.verified) {
      return res.status(422).json({ error: verification.reason || 'Unable to verify transaction' });
    }

    await db.query(
      `UPDATE payment_requests SET claimed = true, claimed_tx_hash = $1 WHERE id = $2`,
      [txHash, id]
    );

    res.json({ message: 'Payment request marked as claimed' });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, getById, markClaimed };
