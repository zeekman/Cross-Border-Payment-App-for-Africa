const db = require('../db');
const { clawbackAsset } = require('../services/stellar');
const audit = require('../services/audit');

async function getStats(req, res, next) {
  try {
    const { rows } = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM users)                          AS total_users,
        (SELECT COUNT(*) FROM transactions)                   AS total_transactions,
        (SELECT COALESCE(SUM(amount), 0) FROM transactions
          WHERE status = 'completed')                         AS total_volume,
        (SELECT COALESCE(SUM(fee_amount), 0) FROM transactions
          WHERE status = 'completed')                         AS total_fees
    `);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function getUsers(req, res, next) {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const search = req.query.search ? `%${req.query.search}%` : null;

    const params = search ? [search, search, limit, offset] : [limit, offset];
    const where  = search ? `WHERE u.full_name ILIKE $1 OR u.email ILIKE $2` : '';
    const lIdx   = search ? 3 : 1;

    const { rows } = await db.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.role, u.created_at, w.public_key
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${lIdx} OFFSET $${lIdx + 1}`,
      params
    );

    const countParams = search ? [search, search] : [];
    const countWhere  = search ? `WHERE full_name ILIKE $1 OR email ILIKE $2` : '';
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) FROM users ${countWhere}`,
      countParams
    );

    res.json({ data: rows, total: parseInt(countRows[0].count), page, limit });
  } catch (err) {
    next(err);
  }
}

async function getTransactions(req, res, next) {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const { status, asset, from, to } = req.query;

    const conditions = [];
    const params     = [];

    if (status) { params.push(status);  conditions.push(`status = $${params.length}`); }
    if (asset)  { params.push(asset);   conditions.push(`asset = $${params.length}`); }
    if (from)   { params.push(from);    conditions.push(`created_at >= $${params.length}`); }
    if (to)     { params.push(to);      conditions.push(`created_at <= $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(limit, offset);
    const { rows } = await db.query(
      `SELECT * FROM transactions ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, -2);
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) FROM transactions ${where}`,
      countParams
    );

    res.json({ data: rows, total: parseInt(countRows[0].count), page, limit });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStats, getUsers, getTransactions, clawback };

/**
 * POST /api/admin/clawback
 * Admin-only: clawback an asset from a user's account for regulatory compliance.
 * Requires ISSUER_PUBLIC_KEY and ISSUER_ENCRYPTED_SECRET_KEY env vars.
 * All clawback operations are logged in the audit log.
 */
async function clawback(req, res, next) {
  try {
    const { from, asset, amount, reason } = req.body;

    const issuerPublicKey = process.env.ISSUER_PUBLIC_KEY;
    const encryptedIssuerSecretKey = process.env.ISSUER_ENCRYPTED_SECRET_KEY;

    if (!issuerPublicKey || !encryptedIssuerSecretKey) {
      return res.status(500).json({ error: 'Issuer credentials not configured' });
    }

    const { transactionHash, ledger } = await clawbackAsset({
      issuerPublicKey,
      encryptedIssuerSecretKey,
      fromPublicKey: from,
      asset,
      amount,
    });

    await audit.log(req.user.userId, 'admin_clawback', req.ip, req.headers['user-agent'], {
      from,
      asset,
      amount,
      reason: reason || null,
      transaction_hash: transactionHash,
    });

    res.json({
      message: 'Clawback executed successfully',
      transaction_hash: transactionHash,
      ledger,
    });
  } catch (err) {
    next(err);
  }
}

const { attestKyc, revokeKyc } = require('../services/kycAttestation');

/**
 * POST /api/admin/kyc/:userId/approve
 * Marks user as verified in DB and pushes on-chain attestation.
 */
async function approveKYC(req, res, next) {
  try {
    const { userId } = req.params;

    const userResult = await db.query(
      `SELECT u.id, u.kyc_status, u.kyc_data, w.public_key
       FROM users u JOIN wallets w ON w.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );
    if (!userResult.rows[0]) return res.status(404).json({ error: "User not found" });

    const user = userResult.rows[0];
    if (user.kyc_status === "verified") {
      return res.status(409).json({ error: "User is already verified" });
    }
    if (user.kyc_status !== "pending") {
      return res.status(400).json({ error: "User has no pending KYC submission" });
    }

    const adminWallet = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1",
      [req.user.userId]
    );
    const adminPublicKey = adminWallet.rows[0]?.public_key;

    const idType = user.kyc_data?.id_type || "unknown";
    let txHash = null;

    // Best-effort on-chain attestation — DB update proceeds regardless
    try {
      txHash = await attestKyc(adminPublicKey, user.public_key, userId, idType);
    } catch (attestErr) {
      // Log but don't block the approval
      console.error("On-chain attestation failed:", attestErr.message);
    }

    await db.query(
      `UPDATE users SET kyc_status = 'verified', updated_at = NOW() WHERE id = $1`,
      [userId]
    );

    await audit.log(req.user.userId, "kyc_approved", { target_user: userId, tx_hash: txHash });

    res.json({ message: "KYC approved", tx_hash: txHash });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/kyc/:userId/revoke
 * Revokes KYC in DB and on-chain.
 */
async function revokeKYC(req, res, next) {
  try {
    const { userId } = req.params;

    const userResult = await db.query(
      `SELECT u.id, u.kyc_status, w.public_key
       FROM users u JOIN wallets w ON w.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );
    if (!userResult.rows[0]) return res.status(404).json({ error: "User not found" });

    const user = userResult.rows[0];
    if (user.kyc_status !== "verified") {
      return res.status(400).json({ error: "User is not currently verified" });
    }

    const adminWallet = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1",
      [req.user.userId]
    );
    const adminPublicKey = adminWallet.rows[0]?.public_key;

    let txHash = null;
    try {
      txHash = await revokeKyc(adminPublicKey, user.public_key);
    } catch (revokeErr) {
      console.error("On-chain revocation failed:", revokeErr.message);
    }

    await db.query(
      `UPDATE users SET kyc_status = 'unverified', updated_at = NOW() WHERE id = $1`,
      [userId]
    );

    await audit.log(req.user.userId, "kyc_revoked", { target_user: userId, tx_hash: txHash });

    res.json({ message: "KYC revoked", tx_hash: txHash });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStats, getUsers, getTransactions, clawback, approveKYC, revokeKYC };
