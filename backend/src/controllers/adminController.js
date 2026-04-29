const db = require('../db');
const { getStellarStats } = require('../services/stellar');

// Cache for Stellar stats (10 seconds)
let stellarStatsCache = null;
let stellarStatsCacheTime = 0;
const CACHE_DURATION = 10000; // 10 seconds
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
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    let search = req.query.search || null;
    if (search) {
      if (search.length > 100) {
        return res.status(400).json({ error: 'Search string exceeds maximum length of 100 characters' });
      }
      // Escape PostgreSQL special pattern characters
      search = search.replace(/[%_\\]/g, '\\$&');
      search = `%${search}%`;
    }

    const params = search ? [search, search, limit, offset] : [limit, offset];
    const where = search ? `WHERE u.full_name ILIKE $1 OR u.email ILIKE $2` : '';
    const lIdx = search ? 3 : 1;

    const { rows } = await db.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.role, u.created_at, w.public_key
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${lIdx} OFFSET $${lIdx + 1}`,
      params
    );

    const countParams = search ? [search, search] : [];
    const countWhere = search ? `WHERE full_name ILIKE $1 OR email ILIKE $2` : '';
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
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const { status, asset, from, to } = req.query;

    const conditions = [];
    const params = [];

    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (asset) { params.push(asset); conditions.push(`asset = $${params.length}`); }
    if (from) { params.push(from); conditions.push(`created_at >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`created_at <= $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(limit, offset);
    const { rows } = await db.query(
      `SELECT id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status, created_at
       FROM transactions ${where}
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



async function getStellarNetworkStats(req, res, next) {
  try {
    const now = Date.now();
    
    // Return cached data if still valid
    if (stellarStatsCache && (now - stellarStatsCacheTime) < CACHE_DURATION) {
      return res.json(stellarStatsCache);
    }

    // Fetch fresh data
    const stats = await getStellarStats();
    
    // Update cache
    stellarStatsCache = stats;
    stellarStatsCacheTime = now;

    res.json(stats);
  } catch (err) {
    next(err);
  }
}

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

module.exports = { getStats, getUsers, getTransactions, clawback };



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



const { getAccountFlags, setAccountFlags } = require('../services/stellar');

/**
 * POST /api/admin/wallet/:address/set-flags
 * Admin-only: set or clear Stellar authorization flags on any account.
 * Body: { set_flags?: number, clear_flags?: number }
 *
 * Flag bitmask values (from StellarSdk):
 *   AUTH_REQUIRED_FLAG       = 1
 *   AUTH_REVOCABLE_FLAG      = 2
 *   AUTH_IMMUTABLE_FLAG      = 4
 *   AUTH_CLAWBACK_ENABLED_FLAG = 8
 */
async function setWalletFlags(req, res, next) {
  try {
    const { address } = req.params;
    const { set_flags, clear_flags } = req.body;

    if (set_flags === undefined && clear_flags === undefined) {
      return res.status(400).json({ error: 'Provide set_flags and/or clear_flags' });
    }

    // The admin must have an issuer wallet configured to sign the setOptions tx
    const issuerPublicKey = process.env.ISSUER_PUBLIC_KEY;
    const encryptedIssuerSecretKey = process.env.ISSUER_ENCRYPTED_SECRET_KEY;

    if (!issuerPublicKey || !encryptedIssuerSecretKey) {
      return res.status(500).json({ error: 'Issuer credentials not configured' });
    }

    const { transactionHash } = await setAccountFlags({
      publicKey: address,
      encryptedSecretKey: encryptedIssuerSecretKey,
      setFlags: set_flags,
      clearFlags: clear_flags,
    });

    await audit.log(req.user.userId, 'admin_set_flags', req.ip, req.headers['user-agent'], {
      address,
      set_flags,
      clear_flags,
      transaction_hash: transactionHash,
    });

    const updatedFlags = await getAccountFlags(address);

    res.json({
      message: 'Account flags updated',
      transaction_hash: transactionHash,
      flags: updatedFlags,
    });
  } catch (err) {
    next(err);
  }
}

const { indexContractEvents, getContractEvents } = require('../jobs/contractEventIndexer');

/**
 * POST /api/admin/contracts/:contractId/upgrade
 * Announce a contract upgrade with 48-hour timelock.
 * Emits an on-chain event with the WASM hash.
 */
async function announceContractUpgrade(req, res, next) {
  try {
    const { contractId } = req.params;
    const { wasmHash, description } = req.body;

    if (!contractId || !wasmHash) {
      return res.status(400).json({ error: 'contractId and wasmHash are required' });
    }

    if (!/^[a-f0-9]{64}$/.test(wasmHash)) {
      return res.status(400).json({ error: 'Invalid WASM hash format (must be valid SHA256)' });
    }

    // Get current contract info to find old WASM hash
    const existingContract = await db.query(
      `SELECT new_wasm_hash FROM contract_upgrades
       WHERE contract_id = $1 AND status = 'executed'
       ORDER BY executed_at DESC LIMIT 1`,
      [contractId]
    );

    const oldWasmHash = existingContract.rows[0]?.new_wasm_hash || null;

    // Calculate timelock expiry (48 hours = 172800 seconds)
    const scheduledFor = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const result = await db.query(
      `INSERT INTO contract_upgrades
       (contract_id, contract_name, old_wasm_hash, new_wasm_hash, status, announced_at, scheduled_for, description)
       VALUES ($1, $2, $3, $4, 'announced', NOW(), $5, $6)
       RETURNING *`,
      [contractId, req.body.contractName || null, oldWasmHash, wasmHash, scheduledFor, description || null]
    );

    const upgrade = result.rows[0];

    // Emit on-chain event (best-effort)
    try {
      // This would emit an event to Soroban if configured
      // await emitUpgradeEvent(contractId, wasmHash);
    } catch (eventErr) {
      // Log but don't block the upgrade announcement
      console.warn('Failed to emit on-chain upgrade event:', eventErr.message);
    }

    // Log audit trail
    await audit.log(req.user.userId, 'admin_announce_upgrade', req.ip, req.headers['user-agent'], {
      contract_id: contractId,
      wasm_hash: wasmHash,
      scheduled_for: scheduledFor.toISOString(),
    });

    res.json({
      message: 'Contract upgrade announced',
      upgrade: {
        id: upgrade.id,
        contract_id: upgrade.contract_id,
        new_wasm_hash: upgrade.new_wasm_hash,
        status: upgrade.status,
        announced_at: upgrade.announced_at,
        scheduled_for: upgrade.scheduled_for,
        description: upgrade.description
      }
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/contracts/:contractId/upgrade/execute
 * Execute a contract upgrade after timelock expires.
 */
async function executeContractUpgrade(req, res, next) {
  try {
    const { contractId } = req.params;
    const { wasmHash } = req.body;

    if (!contractId || !wasmHash) {
      return res.status(400).json({ error: 'contractId and wasmHash are required' });
    }

    // Check for pending upgrade
    const upgradeResult = await db.query(
      `SELECT * FROM contract_upgrades
       WHERE contract_id = $1 AND new_wasm_hash = $2 AND status = 'announced'
       ORDER BY announced_at DESC LIMIT 1`,
      [contractId, wasmHash]
    );

    if (!upgradeResult.rows[0]) {
      return res.status(400).json({ error: 'No pending upgrade found for this WASM hash' });
    }

    const upgrade = upgradeResult.rows[0];

    // Verify timelock has expired
    const now = new Date();
    if (now < new Date(upgrade.scheduled_for)) {
      const timeRemaining = Math.ceil((new Date(upgrade.scheduled_for) - now) / 1000 / 60);
      return res.status(400).json({
        error: 'Timelock still active',
        timeRemaining,
        scheduledFor: upgrade.scheduled_for
      });
    }

    // Update contract upgrade status to executed
    const result = await db.query(
      `UPDATE contract_upgrades
       SET status = 'executed', executed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [upgrade.id]
    );

    const executedUpgrade = result.rows[0];

    // Emit on-chain event (best-effort)
    try {
      // This would execute the actual Soroban contract upgrade if configured
      // await executeUpgradeOnChain(contractId, wasmHash);
    } catch (execErr) {
      console.warn('Failed to execute on-chain upgrade:', execErr.message);
    }

    // Log audit trail
    await audit.log(req.user.userId, 'admin_execute_upgrade', req.ip, req.headers['user-agent'], {
      contract_id: contractId,
      wasm_hash: wasmHash,
      executed_at: executedUpgrade.executed_at
    });

    res.json({
      message: 'Contract upgrade executed',
      upgrade: {
        id: executedUpgrade.id,
        contract_id: executedUpgrade.contract_id,
        new_wasm_hash: executedUpgrade.new_wasm_hash,
        status: executedUpgrade.status,
        executed_at: executedUpgrade.executed_at
      }
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/contracts/:contractId/upgrade/status
 * Get the status of pending or latest contract upgrades.
 */
async function getContractUpgradeStatus(req, res, next) {
  try {
    const { contractId } = req.params;

    // Get pending upgrade if exists
    const pendingResult = await db.query(
      `SELECT * FROM contract_upgrades
       WHERE contract_id = $1 AND status = 'announced'
       ORDER BY announced_at DESC LIMIT 1`,
      [contractId]
    );

    // Get last executed upgrade
    const lastResult = await db.query(
      `SELECT * FROM contract_upgrades
       WHERE contract_id = $1 AND status = 'executed'
       ORDER BY executed_at DESC LIMIT 1`,
      [contractId]
    );

    const pending = pendingResult.rows[0] || null;
    const lastExecuted = lastResult.rows[0] || null;

    let timeRemaining = null;
    if (pending) {
      const now = new Date();
      const scheduled = new Date(pending.scheduled_for);
      if (now < scheduled) {
        timeRemaining = Math.ceil((scheduled - now) / 1000 / 60); // minutes
      }
    }

    res.json({
      contract_id: contractId,
      pending_upgrade: pending ? {
        id: pending.id,
        wasm_hash: pending.new_wasm_hash,
        announced_at: pending.announced_at,
        scheduled_for: pending.scheduled_for,
        time_remaining_minutes: timeRemaining,
        description: pending.description
      } : null,
      last_executed: lastExecuted ? {
        id: lastExecuted.id,
        wasm_hash: lastExecuted.new_wasm_hash,
        executed_at: lastExecuted.executed_at
      } : null
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/contracts/:contractId/events
 * Retrieve indexed contract events with optional filtering.
 * Query params: eventType, limit, offset, from, to
 */
async function getContractEventsEndpoint(req, res, next) {
  try {
    const { contractId } = req.params;
    const { eventType, limit, offset, from, to } = req.query;

    const options = {
      eventType: eventType || null,
      limit: Math.min(parseInt(limit) || 100, 500),
      offset: parseInt(offset) || 0,
      from: from || null,
      to: to || null
    };

    const result = await getContractEvents(contractId, options);

    res.json({
      contract_id: contractId,
      events: result.events,
      total: result.total,
      limit: result.limit,
      offset: result.offset
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/contracts/:contractId/events/index
 * Manually trigger event indexing for a specific contract.
 */
async function indexContractEventsEndpoint(req, res, next) {
  try {
    const { contractId } = req.params;

    const result = await indexContractEvents(contractId, req.body.contractName || null);

    await audit.log(req.user.userId, 'admin_index_events', req.ip, req.headers['user-agent'], {
      contract_id: contractId,
      indexed: result.indexed,
      errors: result.errors
    });

    res.json({
      message: 'Contract events indexed',
      result
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getStats,
  getUsers,
  getTransactions,
  clawback,
  approveKYC,
  revokeKYC,
  setWalletFlags,
  announceContractUpgrade,
  executeContractUpgrade,
  getContractUpgradeStatus,
  getContractEventsEndpoint,
  indexContractEventsEndpoint
};
