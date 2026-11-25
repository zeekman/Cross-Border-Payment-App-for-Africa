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
      `SELECT id, requester_wallet, amount, asset, memo, expires_at, claimed, claimed_tx_hash, status
       FROM payment_requests
       WHERE id = $1`,
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Payment request not found' });
    }
    if (result.rows[0].status === 'cancelled') {
      return res.status(410).json({ error: 'Payment request was cancelled' });
    }
    if (new Date(result.rows[0].expires_at) <= new Date()) {
      return res.status(410).json({ error: 'Payment request has expired' });
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
      `SELECT requester_id, requester_wallet, amount, asset, claimed, expires_at, status
       FROM payment_requests WHERE id = $1`,
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Payment request not found' });
    }
    if (new Date(result.rows[0].expires_at) <= new Date()) {
      return res.status(410).json({ error: 'Payment request has expired' });
    }

    const paymentRequest = result.rows[0];

    if (paymentRequest.requester_id !== userId) {
      return res.status(403).json({ error: 'Only the intended recipient can claim this payment request' });
    }

    if (paymentRequest.status === 'cancelled') {
      return res.status(410).json({ error: 'Payment request was cancelled' });
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

const STATUS_SQL = `CASE
  WHEN claimed THEN 'paid'
  WHEN status = 'cancelled' THEN 'cancelled'
  WHEN expires_at <= NOW() THEN 'expired'
  ELSE 'pending' END`;

async function listMine(req, res, next) {
  try {
    const { status } = req.query;
    if (status && !['pending', 'paid', 'expired', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status filter' });
    }
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
    const params = [req.user.userId];
    let where = 'requester_id = $1';
    if (status) {
      params.push(status);
      where += ` AND (${STATUS_SQL}) = $2`;
    }
    const total = await db.query(`SELECT COUNT(*)::int AS count FROM payment_requests WHERE ${where}`, params);
    const rows = await db.query(
      `SELECT id, amount, asset, memo, expires_at, created_at, claimed_tx_hash, (${STATUS_SQL}) AS status
       FROM payment_requests WHERE ${where}
       ORDER BY created_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params
    );
    res.json({ requests: rows.rows, page, limit, total: total.rows[0].count });
  } catch (err) {
    next(err);
  }
}

async function cancel(req, res, next) {
  try {
    const result = await db.query(
      'SELECT requester_id, claimed, status FROM payment_requests WHERE id = $1',
      [req.params.id]
    );
    const row = result.rows[0];
    if (!row || row.requester_id !== req.user.userId) {
      return res.status(404).json({ error: 'Payment request not found' });
    }
    if (row.claimed) {
      return res.status(409).json({ error: 'Payment request already paid' });
    }
    await db.query("UPDATE payment_requests SET status = 'cancelled' WHERE id = $1", [req.params.id]);
    res.json({ message: 'Payment request cancelled' });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, getById, markClaimed, listMine, cancel };
