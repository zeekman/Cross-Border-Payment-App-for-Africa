/**
 * Agent Escrow Controller
 *
 * Handles trustless agent payout escrow via the Soroban agent-escrow contract.
 *
 * Routes:
 *   GET  /api/escrow                 — list escrows for the caller (sender|agent)
 *   POST /api/escrow/create          — sender creates escrow
 *   POST /api/escrow/:id/confirm     — agent confirms payout
 *   POST /api/escrow/:id/cancel      — sender cancels after 48 h
 *   GET  /api/escrow/:id             — fetch escrow record from DB
 */

const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { createEscrow, confirmPayout, cancelEscrow } = require("../services/agentEscrow");
const { sendAgentEscrowDeliveredEmail } = require("../services/email");
const { enqueueEmail, sendEscrowCancelledEmail } = require("../services/email");
const audit = require("../services/audit");
const feeConfigService = require("../services/feeConfigService");
const logger = require("../utils/logger");

const DEFAULT_FEE_BPS = parseInt(process.env.ESCROW_FEE_BPS || "250", 10);

// The agent-escrow contract only ever locks its configured USDC token, so any
// other client-supplied asset would diverge from on-chain state.
const ESCROW_ASSET = "USDC";

const ESCROW_STATUSES = ["pending", "completed", "cancelled"];
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Convert a decimal amount string to stroops (1e7 base units) without
 * floating-point error. Rejects non-decimal strings and more than 7 places.
 * Returns null when the input is not a valid amount.
 */
function amountToStroops(amount) {
  if (typeof amount !== "string") return null;
  const trimmed = amount.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) return null;

  const [whole, fraction = ""] = trimmed.split(".");
  const paddedFraction = (fraction + "0000000").slice(0, 7);
  const stroops = BigInt(whole) * 10000000n + BigInt(paddedFraction);
  if (stroops <= 0n) return null;
  return stroops;
}

/**
 * GET /api/escrow?role=sender|agent&status=…&page=1&limit=20
 *
 * Lists escrows scoped to the authenticated caller's wallets. `role=sender`
 * returns escrows the caller funded; `role=agent` returns escrows assigned to
 * the caller's agent wallet. Results are paginated.
 */
async function listEscrows(req, res, next) {
  try {
    const role = req.query.role === "agent" ? "agent" : "sender";
    const status = req.query.status;

    if (status && !ESCROW_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Invalid status filter" });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE
    );
    const offset = (page - 1) * limit;

    // Resolve the caller's wallets so results stay scoped to their own escrows.
    const walletResult = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1",
      [req.user.userId]
    );
    const walletAddresses = walletResult.rows.map((row) => row.public_key);

    if (walletAddresses.length === 0) {
      return res.json({ escrows: [], page, limit, total: 0 });
    }

    const column = role === "agent" ? "agent_wallet" : "sender_wallet";
    const params = [walletAddresses];
    let where = `WHERE ${column} = ANY($1)`;

    if (status) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM agent_escrows ${where}`,
      params
    );
    const total = countResult.rows[0] ? countResult.rows[0].total : 0;

    params.push(limit, offset);
    const listResult = await db.query(
      `SELECT id, contract_escrow_id, sender_wallet, recipient_wallet, agent_wallet,
              amount, asset, fee_bps, status, tx_hash, confirm_tx_hash,
              created_at, confirmed_at
         FROM agent_escrows
         ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ escrows: listResult.rows, page, limit, total });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/escrow/create
 * Body: { agent_wallet, recipient_wallet, amount, asset }
 */
async function create(req, res, next) {
  const escrowDbId = uuidv4();
  try {
    const { agent_wallet, recipient_wallet, amount, asset = ESCROW_ASSET } = req.body;

    // The contract only locks its configured USDC token; reject anything else
    // so the DB record cannot diverge from on-chain state.
    if (asset !== ESCROW_ASSET) {
      return res.status(400).json({
        error: `Unsupported asset. Only ${ESCROW_ASSET} is accepted.`,
        code: "UNSUPPORTED_ASSET",
      });
    }

    // Validate the amount as a decimal string with at most 7 places and convert
    // to stroops without floating-point error.
    const amountStroops = amountToStroops(amount);
    if (amountStroops === null) {
      return res.status(400).json({
        error: "Invalid amount. Provide a positive decimal string with at most 7 decimal places.",
        code: "INVALID_AMOUNT",
      });
    }

    // Validate that the agent is a registered, approved AfriPay agent
    const agentResult = await db.query(
      "SELECT id FROM agents WHERE wallet_address = $1 AND status = 'approved'",
      [agent_wallet]
    );
    if (!agentResult.rows[0]) {
      return res.status(400).json({ error: "Agent is not registered in the AfriPay network" });
    }

    const walletResult = await db.query(
      "SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1",
      [req.user.userId]
    );
    if (!walletResult.rows[0]) {
      return res.status(404).json({ error: "Wallet not found" });
    }
    const { public_key, encrypted_secret_key } = walletResult.rows[0];

    // The fee is server-authoritative: any client-supplied fee_bps is ignored.
    const feeConfig = await feeConfigService.getActiveConfig("escrow", "USDC");
    const feeBps = feeConfig ? Number(feeConfig.fee_bps) : DEFAULT_FEE_BPS;
    // Issue #1156: Apply compliance checks to escrow creation (value-moving endpoint)
    const { ensureKycIfNeeded, amlRescreenForPayment, dailyLimitExceeded, checkFraud, logFraudBlock } = require("./paymentController");
    const { estimateUSDValue } = require("./paymentController");
    
    await ensureKycIfNeeded(req.user.userId, amount, asset);
    
    const estimatedUSD = estimateUSDValue(amount, asset);
    await amlRescreenForPayment(req.user.userId, public_key, estimatedUSD);
    
    const overLimit = await dailyLimitExceeded(public_key, amount);
    if (overLimit) {
      return res.status(400).json({
        error: 'Daily send limit reached. Try again tomorrow.',
        code: 'DAILY_LIMIT_EXCEEDED',
      });
    }
    
    const fraudCheck = await checkFraud(public_key, amount, asset);
    if (fraudCheck.blocked) {
      await logFraudBlock(public_key, fraudCheck.reason, amount, asset);
      return res.status(429).json({ error: fraudCheck.reason });
    }

    const { escrowId, txHash } = await createEscrow({
      encryptedSecretKey: encrypted_secret_key,
      recipient: recipient_wallet,
      agent: agent_wallet,
      amount: Math.round(parseFloat(amount) * 1e7), // convert to stroops
      feeBps,
      amount: amountStroops.toString(), // stroops, converted without float error
      feeBps: DEFAULT_FEE_BPS,
    });

    await db.query(
      `INSERT INTO agent_escrows
         (id, contract_escrow_id, sender_wallet, recipient_wallet, agent_wallet,
          amount, asset, fee_bps, status, tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)`,
      [
        escrowDbId,
        escrowId,
        public_key,
        recipient_wallet,
        agent_wallet,
        amount,
        asset,
        feeBps,
        txHash,
      ]
    );

    res.status(201).json({
      message: "Escrow created",
      escrow: { id: escrowDbId, contract_escrow_id: escrowId, tx_hash: txHash, fee_bps: feeBps, status: "pending" },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/agent-escrow/:id/confirm-payout
 * Agent confirms off-chain fiat delivery. Requires role: 'agent'.
 */
async function confirm(req, res, next) {
  try {
    if (req.user.role !== "agent") {
      return res.status(403).json({ error: "Only agents can confirm payouts" });
    }

    const { id } = req.params;

    const escrowResult = await db.query(
      "SELECT * FROM agent_escrows WHERE id = $1",
      [id]
    );
    if (!escrowResult.rows[0]) {
      return res.status(404).json({ error: "Escrow not found" });
    }
    const escrow = escrowResult.rows[0];

    if (escrow.status !== "pending") {
      return res.status(400).json({ error: "Escrow is not pending" });
    }

    // Verify the authenticated agent is the assigned agent for this escrow
    const agentWalletResult = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1",
      [req.user.userId]
    );
    if (!agentWalletResult.rows[0] || agentWalletResult.rows[0].public_key !== escrow.agent_wallet) {
      return res.status(403).json({ error: "You are not the assigned agent for this escrow" });
    }

    // Fetch the service account key — the backend signs the on-chain tx
    const walletResult = await db.query(
      "SELECT encrypted_secret_key FROM wallets WHERE public_key = $1",
      [escrow.agent_wallet]
    );
    if (!walletResult.rows[0]) {
      return res.status(403).json({ error: "Agent wallet not registered on this platform" });
    }

    // Call Soroban confirm_payout — only update DB if this succeeds
    let txHash;
    try {
      ({ txHash } = await confirmPayout({
        encryptedSecretKey: walletResult.rows[0].encrypted_secret_key,
        escrowId: escrow.contract_escrow_id,
      }));
    } catch (stellarErr) {
      return res.status(502).json({ error: "On-chain confirmation failed", detail: stellarErr.message });
    }

    await db.query(
      "UPDATE agent_escrows SET status = 'completed', confirm_tx_hash = $1, confirmed_at = NOW() WHERE id = $2",
      [txHash, id]
    );

    // Notify sender
    const senderResult = await db.query(
      "SELECT u.email, u.full_name, a.full_name AS agent_name FROM users u JOIN wallets w ON w.user_id = u.id LEFT JOIN agents a ON a.wallet_address = $2 WHERE w.public_key = $1 LIMIT 1",
      [escrow.sender_wallet, escrow.agent_wallet]
    );
    if (senderResult.rows[0]) {
      const { email, full_name, agent_name } = senderResult.rows[0];
      sendAgentEscrowDeliveredEmail(email, full_name, escrow.amount, escrow.asset, escrow.recipient_wallet, agent_name || escrow.agent_wallet).catch(() => {});
    }

    await audit.log(
      req.user.userId,
      "agent_escrow_confirmed",
      req.ip,
      req.headers["user-agent"],
      { escrow_id: id, agent_id: req.user.userId, tx_hash: txHash }
    );

    res.json({ message: "Payout confirmed", tx_hash: txHash });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/escrow/:id/cancel  (also served by POST /api/payments/:id/cancel)
 * Sender cancels after the 48-hour window. DB is updated only after the
 * on-chain cancel_escrow succeeds.
 */
async function cancel(req, res, next) {
  try {
    const { id } = req.params;

    const escrowResult = await db.query(
      "SELECT * FROM agent_escrows WHERE id = $1",
      [id]
    );
    if (!escrowResult.rows[0]) {
      return res.status(404).json({ error: "Escrow not found" });
    }
    const escrow = escrowResult.rows[0];

    if (escrow.status !== "pending") {
      return res.status(400).json({ error: "Only pending escrows can be cancelled" });
    }

    // The sender wallet may be any of the caller's wallets, not just the default.
    const walletResult = await db.query(
      "SELECT encrypted_secret_key FROM wallets WHERE user_id = $1 AND public_key = $2",
      [req.user.userId, escrow.sender_wallet]
    );
    if (!walletResult.rows[0]) {
      return res.status(403).json({ error: "Only the sender can cancel this escrow" });
    }

    const expiresAt = escrow.expires_at
      ? new Date(escrow.expires_at)
      : new Date(new Date(escrow.created_at).getTime() + 48 * 60 * 60 * 1000);
    if (new Date() < expiresAt) {
      return res.status(403).json({
        error: "CANCEL_TOO_EARLY",
        message: "You cannot cancel this payment until 48 hours after creation.",
        cancel_available_at: expiresAt.toISOString(),
      });
    }

    let txHash;
    try {
      ({ txHash } = await cancelEscrow({
        encryptedSecretKey: walletResult.rows[0].encrypted_secret_key,
        escrowId: escrow.contract_escrow_id,
      }));
    } catch (stellarErr) {
      logger.error("On-chain cancel_escrow failed", {
        escrowId: escrow.contract_escrow_id,
        error: stellarErr.message,
      });
      return res.status(502).json({
        error: "On-chain cancellation failed. Please try again later.",
      });
    }

    await db.query(
      "UPDATE agent_escrows SET status = 'cancelled', cancelled_at = NOW(), confirm_tx_hash = $1 WHERE id = $2",
      [txHash, id]
    );

    db.query(
      "SELECT u.email, u.full_name FROM users u JOIN wallets w ON w.user_id = u.id WHERE w.public_key = $1 LIMIT 1",
      [escrow.sender_wallet]
    )
      .then(({ rows }) => {
        if (!rows[0]) return;
        return sendEscrowCancelledEmail(rows[0].email, rows[0].full_name, escrow.amount, escrow.asset, txHash);
      })
      .catch(() => {});

    await audit.auditLog(req, "escrow_cancelled", {
      type: "agent_escrow",
      id,
      newValue: {
        escrow_id: id,
        contract_escrow_id: escrow.contract_escrow_id,
        stellar_tx_hash: txHash,
        cancelled_at: new Date().toISOString(),
      },
    });

    webhook.deliver("escrow.cancelled", req.user.userId, {
      escrow_id: id,
      contract_escrow_id: escrow.contract_escrow_id,
      tx_hash: txHash,
      amount: escrow.amount,
      asset: escrow.asset,
      sender: escrow.sender_wallet,
    }).catch(() => {});

    res.json({
      message: "Escrow cancelled and funds refunded to your wallet",
      escrow_id: id,
      contract_escrow_id: escrow.contract_escrow_id,
      tx_hash: txHash,
      status: "cancelled",
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/contracts/escrow/:id/partial-release
 * Body: { amount }
 *
 * Sender releases part of a pending escrow to the agent (issue #657).
 * Validates the amount against the remaining balance, applies the platform fee,
 * records the cumulative released amount, and returns the new remaining balance.
 */
async function partialRelease(req, res, next) {
  const { id } = req.params;
  const amount = parseFloat(req.body.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Amount must be greater than 0" });
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the escrow row for the duration of the transaction so concurrent
    // partial-release requests serialize instead of racing on a stale read.
    const escrowResult = await client.query(
      "SELECT * FROM agent_escrows WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!escrowResult.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Escrow not found" });
    }

    const escrow = escrowResult.rows[0];

    if (escrow.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Escrow is not pending" });
    }

    if (escrow.sender_wallet !== req.user.walletAddress) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only the sender can release funds" });
    }

    const total = parseFloat(escrow.amount);
    const released = parseFloat(escrow.released_amount || 0);
    const remaining = total - released;

    if (amount > remaining) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Amount exceeds remaining escrow balance" });
    }

    const fee = (amount * escrow.fee_bps) / 10000;
    const netAmount = amount - fee;
    const newReleased = released + amount;

    await client.query(
      "UPDATE agent_escrows SET released_amount = $1 WHERE id = $2",
      [newReleased, id]
    );

    await client.query("COMMIT");

    res.json({
      message: "Partial release recorded",
      released_amount: newReleased,
      remaining: total - newReleased,
      fee,
      net_amount: netAmount,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
}

/**
 * GET /api/escrow/:id
 *
 * Fetches a single escrow by DB id. The caller must be a party to the
 * escrow (sender, recipient, or assigned agent); otherwise 404 is returned
 * to avoid leaking other users' escrow details (IDOR protection).
 */
async function getEscrow(req, res, next) {
  try {
    const { id } = req.params;

    const escrowResult = await db.query(
      "SELECT * FROM agent_escrows WHERE id = $1",
      [id]
    );
    if (!escrowResult.rows[0]) {
      return res.status(404).json({ error: "Escrow not found" });
    }
    const escrow = escrowResult.rows[0];

    // Resolve the caller's wallets to verify ownership.
    const walletResult = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1",
      [req.user.userId]
    );
    const callerWallets = walletResult.rows.map((row) => row.public_key);

    const isParty =
      callerWallets.includes(escrow.sender_wallet) ||
      callerWallets.includes(escrow.agent_wallet) ||
      callerWallets.includes(escrow.recipient_wallet);

    if (!isParty) {
      return res.status(404).json({ error: "Escrow not found" });
    }

    res.json({ escrow });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, confirm, cancel, partialRelease, getEscrow, listEscrows };
