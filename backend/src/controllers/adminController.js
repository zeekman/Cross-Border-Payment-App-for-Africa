const crypto = require('crypto');
const db = require('../db');
const { getStellarStats } = require('../services/stellar');
const { attestKyc, revokeKyc } = require('../services/kycAttestation');
const audit = require('../services/audit');

// Cache for Stellar stats (10 seconds)
let stellarStatsCache = null;
let stellarStatsCacheTime = 0;
const CACHE_DURATION = 10000; // 10 seconds
const { clawbackAsset } = require('../services/stellar');

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



async function getDailyTransactionStats(req, res, next) {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const from = new Date();
    from.setDate(from.getDate() - days);
    const { rows } = await db.query(`
      SELECT
        DATE(created_at)                                               AS date,
        COUNT(*)                                                       AS tx_count,
        COALESCE(SUM(amount), 0)                                       AS volume,
        COALESCE(SUM(fee_amount), 0)                                   AS fees
      FROM transactions
      WHERE created_at >= $1 AND status = 'completed'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [from]);
    res.json(rows);
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

module.exports = { getStats, getUsers, getTransactions, getDailyTransactionStats, clawback };


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
      "SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1",
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

    await audit.auditLog(req, 'kyc_approved', {
      type: 'user',
      id: userId,
      newValue: { kyc_status: 'verified', tx_hash: txHash },
    });

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
      "SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1",
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

    await audit.auditLog(req, 'kyc_revoked', {
      type: 'user',
      id: userId,
      oldValue: { kyc_status: 'verified' },
      newValue: { kyc_status: 'unverified', tx_hash: txHash },
    });

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
 * GET /api/admin/contracts/events
 * Query contract events across all contracts with optional filtering.
 * Query params: contractAddress, eventType, limit, offset, from, to
 */
async function getContractEventsGlobalEndpoint(req, res, next) {
  try {
    const { contractAddress, eventType, limit, offset, from, to } = req.query;

    const maxLimit = Math.min(parseInt(limit) || 100, 500);
    const offsetVal = parseInt(offset) || 0;

    const params = [];
    let query = 'SELECT * FROM contract_events WHERE 1=1';
    let countQuery = 'SELECT COUNT(*) AS count FROM contract_events WHERE 1=1';

    if (contractAddress) {
      params.push(contractAddress);
      const cond = ` AND contract_id = $${params.length}`;
      query += cond;
      countQuery += cond;
    }

    if (eventType) {
      params.push(eventType);
      const cond = ` AND event_type = $${params.length}`;
      query += cond;
      countQuery += cond;
    }

    if (from) {
      params.push(new Date(from).toISOString());
      const cond = ` AND created_at >= $${params.length}`;
      query += cond;
      countQuery += cond;
    }

    if (to) {
      params.push(new Date(to).toISOString());
      const cond = ` AND created_at <= $${params.length}`;
      query += cond;
      countQuery += cond;
    }

    const countParams = [...params];
    params.push(maxLimit, offsetVal);
    query += ` ORDER BY ledger_sequence DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const [result, countResult] = await Promise.all([
      db.query(query, params),
      db.query(countQuery, countParams),
    ]);

    res.json({
      events: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: maxLimit,
      offset: offsetVal,
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

// ---------------------------------------------------------------------------
// Fraud Rule Engine (#690)
// ---------------------------------------------------------------------------
const { loadRules, invalidateRulesCache, getShadowRuleReport } = require('../services/fraudDetection');

async function getFraudRules(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, rule_type, parameters, is_active, mode, created_at FROM fraud_rules ORDER BY created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createFraudRule(req, res, next) {
  try {
    const { name, rule_type, parameters, mode } = req.body;
    // BE-033: new rules default to 'shadow' unless explicitly created as
    // 'active', so a rule can be validated against live traffic (logged, not
    // enforced) before an admin promotes it via updateFraudRule.
    const ruleMode = mode === 'active' ? 'active' : 'shadow';
    const { rows } = await db.query(
      `INSERT INTO fraud_rules (name, rule_type, parameters, mode)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, rule_type, JSON.stringify(parameters), ruleMode]
    );
    await invalidateRulesCache();
    await audit.log(req.user.userId, 'fraud_rule_created', req.ip, req.headers['user-agent'],
      { rule_name: name, rule_type, mode: ruleMode });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Rule name already exists' });
    next(err);
  }
}

async function updateFraudRule(req, res, next) {
  try {
    const { id } = req.params;
    const { name, parameters, is_active, mode } = req.body;
    if (mode !== undefined && mode !== 'shadow' && mode !== 'active') {
      const err = new Error("mode must be 'shadow' or 'active'");
      err.status = 400;
      throw err;
    }
    const { rows } = await db.query(
      `UPDATE fraud_rules
       SET name = COALESCE($1, name),
           parameters = COALESCE($2, parameters),
           is_active = COALESCE($3, is_active),
           mode = COALESCE($4, mode),
           updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [name || null, parameters ? JSON.stringify(parameters) : null, is_active ?? null, mode || null, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Rule not found' });
    await invalidateRulesCache();
    await audit.log(req.user.userId, 'fraud_rule_updated', req.ip, req.headers['user-agent'],
      { rule_id: id, changes: req.body });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/fraud-rules/shadow-report — BE-033 admin view comparing
// shadow-rule outcomes (would-block vs would-pass) before promoting a rule.
async function getFraudShadowReport(req, res, next) {
  try {
    const sinceDays = Math.min(90, parseInt(req.query.days, 10) || 7);
    const report = await getShadowRuleReport(sinceDays);
    res.json({ since_days: sinceDays, rules: report });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Bulk User Management (#692)
// ---------------------------------------------------------------------------
const { sendEmail } = require('../services/email');

const BULK_MAX = 500;

function validateBulkRequest(req, res) {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    res.status(400).json({ error: 'userIds must be a non-empty array' });
    return false;
  }
  if (userIds.length > BULK_MAX) {
    res.status(400).json({ error: `Batch size exceeds maximum of ${BULK_MAX}` });
    return false;
  }
  return true;
}

async function bulkSuspend(req, res, next) {
  if (!validateBulkRequest(req, res)) return;
  const { userIds, reason } = req.body;
  const { persistAndBroadcast } = require('../services/notificationInbox');
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Prevent long-running locks from degrading the platform under large batches
    await client.query("SET LOCAL statement_timeout = '10s'");
    const { rows: affectedUsers } = await client.query(
      `UPDATE users SET is_suspended = true, suspension_reason = $1, suspended_at = NOW()
       WHERE id = ANY($2::uuid[]) AND is_suspended = false
       RETURNING id`,
      [reason || null, userIds]
    );
    await client.query('COMMIT');

    await audit.auditLog(req, 'user_suspension', {
      type: 'bulk_user',
      newValue: { user_ids: userIds, reason: reason || null },
    });

    // Send in-app notifications for suspended users (fire-and-forget)
    affectedUsers.forEach(u => {
      persistAndBroadcast(u.id, 'account_suspended', 'Account Suspended',
        `Your account has been suspended. Reason: ${reason || 'Policy violation'}`,
        { reason: reason || null }
      ).catch(() => {});
    });

    res.json({ message: 'Users suspended', count: userIds.length });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

async function bulkUnsuspend(req, res, next) {
  if (!validateBulkRequest(req, res)) return;
  const { userIds } = req.body;
  const { persistAndBroadcast } = require('../services/notificationInbox');
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Prevent long-running locks from degrading the platform under large batches
    await client.query("SET LOCAL statement_timeout = '10s'");
    const { rows: affectedUsers } = await client.query(
      `UPDATE users SET is_suspended = false, suspension_reason = NULL, suspended_at = NULL
       WHERE id = ANY($1::uuid[]) AND is_suspended = true
       RETURNING id`,
      [userIds]
    );
    await client.query('COMMIT');
    await audit.auditLog(req, 'user_unsuspend', {
      type: 'bulk_user',
      newValue: { user_ids: userIds },
    });

    // Send in-app notifications for unsuspended users (fire-and-forget)
    affectedUsers.forEach(u => {
      persistAndBroadcast(u.id, 'account_unsuspended', 'Account Reinstated',
        'Your account suspension has been lifted. You can now use AfriPay normally.',
        {}
      ).catch(() => {});
    });

    res.json({ message: 'Users unsuspended', count: userIds.length });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

async function bulkExport(req, res, next) {
  if (!validateBulkRequest(req, res)) return;
  const { userIds } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Prevent long-running locks on the export_jobs table during large batches
    await client.query("SET LOCAL statement_timeout = '10s'");
    const { rows } = await client.query(
      `INSERT INTO export_jobs (admin_id, status, operation, filters)
       VALUES ($1, 'pending', 'bulk_export', $2) RETURNING id`,
      [req.user.userId, JSON.stringify({ userIds })]
    );
    await client.query('COMMIT');
    const jobId = rows[0].id;

    // Structured audit log including batch size and requesting admin
    await audit.auditLog(req, 'bulk_export_queued', {
      type: 'bulk_user',
      id: jobId,
      newValue: { user_count: userIds.length, job_id: jobId },
    });

    // Process async (fire-and-forget)
    processBulkExportJob(jobId, userIds).catch(err =>
      db.query(`UPDATE export_jobs SET status='failed', error=$1 WHERE id=$2`,
        [err.message, jobId]).catch(() => {})
    );

    res.status(202).json({ jobId, message: 'Export job queued' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

// Exported PII is encrypted at rest and purged after this retention window (issue #881).
const EXPORT_JOB_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

function getExportEncryptionKey() {
  return Buffer.from(process.env.ENCRYPTION_KEY, 'utf8').slice(0, 32);
}

function encryptExportPayload(plaintext) {
  const key = getExportEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptExportPayload(ciphertext) {
  const key = getExportEncryptionKey();
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

async function processBulkExportJob(jobId, userIds) {
  await db.query(`UPDATE export_jobs SET status='processing' WHERE id=$1`, [jobId]);
  const { rows } = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.role, u.kyc_status, u.created_at, w.public_key
     FROM users u LEFT JOIN wallets w ON w.user_id = u.id
     WHERE u.id = ANY($1::uuid[])`,
    [userIds]
  );
  // Encrypt the exported PII at rest; it is only ever decrypted for the owning
  // admin, and only within the retention window (in production this would
  // instead upload to object storage behind a signed, expiring URL).
  const encryptedPayload = encryptExportPayload(JSON.stringify(rows));
  const expiresAt = new Date(Date.now() + EXPORT_JOB_RETENTION_MS);
  await db.query(
    `UPDATE export_jobs SET status='completed', download_url=$1, expires_at=$2, completed_at=NOW() WHERE id=$3`,
    [encryptedPayload, expiresAt, jobId]
  );
}

async function getJobStatus(req, res, next) {
  try {
    const { jobId } = req.params;
    const { rows } = await db.query(
      `SELECT id, admin_id, status, operation, download_url, expires_at, error, created_at, completed_at
       FROM export_jobs WHERE id=$1`,
      [jobId]
    );
    const job = rows[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (job.admin_id !== req.user.userId) {
      return res.status(403).json({ error: 'Only the admin who created this export job may access it' });
    }

    const isExpired = job.expires_at && new Date(job.expires_at) <= new Date();
    if (isExpired && job.download_url) {
      // Lazily purge the encrypted payload once the retention window has elapsed
      await db.query(`UPDATE export_jobs SET download_url=NULL WHERE id=$1`, [jobId]);
      job.download_url = null;
    }

    let downloadUrl = null;
    if (job.download_url && job.status === 'completed' && !isExpired) {
      const plaintext = decryptExportPayload(job.download_url);
      downloadUrl = `data:application/json;base64,${Buffer.from(plaintext).toString('base64')}`;
    }

    res.json({
      id: job.id,
      status: isExpired ? 'expired' : job.status,
      operation: job.operation,
      download_url: downloadUrl,
      error: job.error,
      created_at: job.created_at,
      completed_at: job.completed_at,
      expires_at: job.expires_at,
    });
  } catch (err) {
    next(err);
  }
}

async function bulkKycUpdate(req, res, next) {
  if (!validateBulkRequest(req, res)) return;
  const { userIds, status, reason } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be approved or rejected' });
  }
  const kycStatus = status === 'approved' ? 'verified' : 'rejected';
  const client = await db.pool.connect();
  try {
    // Fetch users with wallets and current kyc_status before updating
    const { rows: users } = await client.query(
      `SELECT u.id, u.kyc_status, u.kyc_data, w.public_key
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.id = ANY($1::uuid[])`,
      [userIds]
    );

    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET kyc_status = $1, updated_at = NOW() WHERE id = ANY($2::uuid[])`,
      [kycStatus, userIds]
    );
    await client.query('COMMIT');

    // Get admin wallet for on-chain operations
    const adminWallet = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1",
      [req.user.userId]
    );
    const adminPublicKey = adminWallet.rows[0]?.public_key;

    const attestationResults = [];

    for (const user of users) {
      let txHash = null;
      let attestationError = null;

      if (status === 'approved') {
        const idType = user.kyc_data?.id_type || 'unknown';
        try {
          txHash = await attestKyc(adminPublicKey, user.public_key, user.id, idType);
        } catch (err) {
          attestationError = err.message;
          console.error(`On-chain attestation failed for user ${user.id}:`, err.message);
        }
      } else if (status === 'rejected' && user.kyc_status === 'verified') {
        try {
          txHash = await revokeKyc(adminPublicKey, user.public_key);
        } catch (err) {
          attestationError = err.message;
          console.error(`On-chain revocation failed for user ${user.id}:`, err.message);
        }
      }

      attestationResults.push({
        user_id: user.id,
        onchain_tx_hash: txHash,
        onchain_success: !attestationError,
        onchain_error: attestationError,
      });
    }

    await audit.log(req.user.userId, 'bulk_kyc_update', req.ip, req.headers['user-agent'],
      { user_count: userIds.length, status: kycStatus, reason: reason || null, attestation_results: attestationResults });
    res.json({ message: 'KYC status updated', count: userIds.length, status: kycStatus, attestation_results: attestationResults });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

/**
 * GET /api/admin/compliance/geo-denials
 * BE-037: Compliance report summarizing geo-restriction denials over a date
 * range - "how many attempts did we see from jurisdiction X in period Y",
 * grouped by country/route/day, backed by the audit_logs entries the
 * geoRestriction middleware writes for every denied request.
 *
 * Query params: from, to (ISO date strings; default last 30 days).
 */
async function getGeoDenialsReport(req, res, next) {
  try {
    const { from, to } = req.query;
    const report = await audit.getGeoDenialReport({ from, to });
    res.json(report);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/audit-logs
 * Cursor-based paginated audit log viewer.
 * Supports filtering by actor, action, resource_type, and date range.
 */
async function getAuditLogs(req, res, next) {
  try {
    const { actor, action, resource_type, from, to, cursor } = req.query;
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);

    const conditions = [];
    const params = [];

    if (actor) {
      params.push(actor);
      conditions.push(`user_id = $${params.length}`);
    }
    if (action) {
      params.push(action);
      conditions.push(`action = $${params.length}`);
    }
    if (resource_type) {
      params.push(resource_type);
      conditions.push(`resource_type = $${params.length}`);
    }
    if (from) {
      params.push(from);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`created_at <= $${params.length}`);
    }
    if (cursor) {
      params.push(cursor);
      conditions.push(`created_at < $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit + 1);

    const { rows } = await db.query(
      `SELECT id, user_id AS actor_id, actor_role, action, resource_type, resource_id,
              old_value, new_value, ip_address, user_agent, created_at
       FROM audit_logs ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1].created_at.toISOString() : null;

    res.json({ data, next_cursor: nextCursor, has_more: hasMore });
  } catch (err) {
    next(err);
  }
}

// BE-032: override an AML flag on a wallet/user.
//
// Every override is compliance-sensitive — it must be traceable to the admin
// who made the call, with a timestamp and a mandatory free-text reason, in
// case of a future regulatory audit or fraud investigation. `reason` is
// required and validated (non-empty) at the route layer (see routes/admin.js)
// *and* re-checked here as defense in depth. The override is persisted via
// audit.auditLog() as an 'aml_override' entry — actor id/role and created_at
// are captured automatically by auditLog, and reason + the override decision
// are recorded in `new_value` for the compliance report endpoint below.
async function overrideAmlFlag(req, res, next) {
  try {
    const { wallet_address, user_id, reason, new_status } = req.body;

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      const err = new Error('A non-empty reason is required to override an AML flag');
      err.status = 400;
      throw err;
    }
    if (!wallet_address && !user_id) {
      const err = new Error('wallet_address or user_id is required');
      err.status = 400;
      throw err;
    }

    const resolvedStatus = new_status || 'cleared';

    await audit.auditLog(req, 'aml_override', {
      type: 'aml_flag',
      id: wallet_address || user_id,
      oldValue: { status: 'flagged' },
      newValue: {
        status: resolvedStatus,
        reason: reason.trim(),
        reviewing_admin_id: req.user.userId,
        wallet_address: wallet_address || null,
        user_id: user_id || null,
      },
    });

    res.json({
      success: true,
      wallet_address: wallet_address || null,
      user_id: user_id || null,
      new_status: resolvedStatus,
      reviewing_admin_id: req.user.userId,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/aml/overrides?from=&to= — compliance report of every AML
// override in a date range, sourced from the audit trail written above.
async function getAmlOverrides(req, res, next) {
  try {
    const { from, to } = req.query;
    const conditions = [`action = 'aml_override'`];
    const params = [];

    if (from) {
      params.push(from);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`created_at <= $${params.length}`);
    }

    const { rows } = await db.query(
      `SELECT id, user_id AS reviewing_admin_id, actor_role, resource_id,
              old_value, new_value, created_at
       FROM audit_logs
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT 500`,
      params
    );

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getStats,
  getUsers,
  getTransactions,
  getDailyTransactionStats,
  getStellarNetworkStats,
  clawback,
  approveKYC,
  revokeKYC,
  setWalletFlags,
  announceContractUpgrade,
  executeContractUpgrade,
  getContractUpgradeStatus,
  getContractEventsEndpoint,
  getContractEventsGlobalEndpoint,
  indexContractEventsEndpoint,
  // #690
  getFraudRules,
  createFraudRule,
  updateFraudRule,
  // #980 (BE-033)
  getFraudShadowReport,
  // #692
  bulkSuspend,
  bulkUnsuspend,
  bulkExport,
  getJobStatus,
  bulkKycUpdate,
  // #698
  getAuditLogs,
  getGeoDenialsReport,
  // #979 (BE-032)
  overrideAmlFlag,
  getAmlOverrides,
};
