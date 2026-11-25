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

/**
 * Public display name: first name + last initial, never the full legal name
 * or email (BE-224).
 */
function toDisplayName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'AfriPay user';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

async function getById(req, res, next) {
  try {
    const { id } = req.params;

    const result = await db.query(
      `SELECT pr.id, pr.requester_wallet, pr.amount, pr.asset, pr.memo, pr.expires_at,
              pr.claimed, pr.claimed_tx_hash,
              u.full_name, u.avatar_url, u.kyc_status, u.created_at AS member_since,
              COALESCE(u.show_profile_on_requests, TRUE) AS show_profile
       FROM payment_requests pr
       LEFT JOIN users u ON u.id = pr.requester_id
       WHERE pr.id = $1 AND pr.expires_at > NOW()`,
      [id]
    );

    // Expired, cancelled and unknown requests all return the same 404 so
    // signed-out viewers can't enumerate request states.
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'Payment request not found or expired' });
    }

    const { full_name, avatar_url, kyc_status, member_since, show_profile, ...request } = row;
    request.requester = {
      display_name: show_profile ? toDisplayName(full_name) : 'AfriPay user',
      avatar_url: show_profile ? avatar_url || null : null,
      kyc_verified: kyc_status === 'verified',
      member_since: member_since ? new Date(member_since).toISOString().slice(0, 7) : null,
    };

    res.json(request);
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

module.exports = { create, getById, markClaimed, toDisplayName };
