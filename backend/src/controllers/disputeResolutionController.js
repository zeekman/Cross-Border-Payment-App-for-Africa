/**
 * Dispute Resolution Controller
 *
 * Handles on-chain three-party dispute arbitration via the Soroban
 * dispute-resolution contract.
 *
 * Routes:
 *   POST /api/disputes                    — open a dispute
 *   POST /api/disputes/:id/evidence       — submit evidence
 *   POST /api/disputes/:id/resolve        — arbitrator resolves (admin only)
 *   GET  /api/disputes/:id                — fetch dispute record
 *   GET  /api/disputes                    — list user's disputes
 */

const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const {
  openDispute,
  submitEvidence,
  resolveDispute,
} = require("../services/disputeResolution");

/**
 * POST /api/disputes
 * Body: { recipient_wallet, amount, asset?, support_ticket_id?, escrow_id? }
 */
async function open(req, res, next) {
  const disputeDbId = uuidv4();
  try {
    const {
      recipient_wallet,
      amount,
      asset = "USDC",
      support_ticket_id,
      escrow_id,
    } = req.body;

    const walletResult = await db.query(
      "SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1",
      [req.user.userId]
    );
    if (!walletResult.rows[0]) {
      return res.status(404).json({ error: "Wallet not found" });
    }
    const { public_key, encrypted_secret_key } = walletResult.rows[0];

    // Validate support ticket ownership if provided
    if (support_ticket_id) {
      const ticketCheck = await db.query(
        "SELECT id FROM support_tickets WHERE id = $1 AND user_id = $2",
        [support_ticket_id, req.user.userId]
      );
      if (!ticketCheck.rows[0]) {
        return res
          .status(404)
          .json({ error: "Support ticket not found or does not belong to you" });
      }
    }

    const amountStroops = Math.round(parseFloat(amount) * 1e7);

    const { disputeId, txHash, deadline } = await openDispute({
      encryptedSecretKey: encrypted_secret_key,
      sender: public_key,
      recipient: recipient_wallet,
      amount: amountStroops,
    });

    await db.query(
      `INSERT INTO disputes
         (id, contract_dispute_id, sender_wallet, recipient_wallet, amount,
          asset, status, support_ticket_id, escrow_id, open_tx_hash, deadline_at)
       VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10)`,
      [
        disputeDbId,
        disputeId,
        public_key,
        recipient_wallet,
        amount,
        asset,
        support_ticket_id || null,
        escrow_id || null,
        txHash,
        deadline,
      ]
    );

    // Update linked support ticket status to 'in_dispute' if provided
    if (support_ticket_id) {
      await db.query(
        "UPDATE support_tickets SET status = 'in_dispute' WHERE id = $1",
        [support_ticket_id]
      );
    }

    res.status(201).json({
      message: "Dispute opened",
      dispute: {
        id: disputeDbId,
        contract_dispute_id: disputeId,
        tx_hash: txHash,
        status: "open",
        deadline_at: deadline,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/disputes/:id/evidence
 * Body: { evidence }  — IPFS CID or content hash (max 256 chars)
 */
async function submitEvidenceHandler(req, res, next) {
  try {
    const { id } = req.params;
    const { evidence } = req.body;

    const disputeResult = await db.query(
      "SELECT * FROM disputes WHERE id = $1",
      [id]
    );
    if (!disputeResult.rows[0]) {
      return res.status(404).json({ error: "Dispute not found" });
    }
    const dispute = disputeResult.rows[0];

    if (dispute.status !== "open") {
      return res.status(400).json({ error: "Dispute is not open" });
    }

    const walletResult = await db.query(
      "SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1",
      [req.user.userId]
    );
    if (!walletResult.rows[0]) {
      return res.status(404).json({ error: "Wallet not found" });
    }
    const { public_key, encrypted_secret_key } = walletResult.rows[0];

    // Verify caller is a party to the dispute
    if (
      public_key !== dispute.sender_wallet &&
      public_key !== dispute.recipient_wallet
    ) {
      return res
        .status(403)
        .json({ error: "You are not a party to this dispute" });
    }

    const { txHash } = await submitEvidence({
      encryptedSecretKey: encrypted_secret_key,
      disputeId: dispute.contract_dispute_id,
      evidence,
    });

    res.json({ message: "Evidence submitted", tx_hash: txHash });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/disputes/:id/resolve
 * Body: { release_to_recipient: boolean }
 * Admin only — uses the platform arbitrator key from env.
 */
async function resolve(req, res, next) {
  try {
    const { id } = req.params;
    const { release_to_recipient } = req.body;

    const disputeResult = await db.query(
      "SELECT * FROM disputes WHERE id = $1",
      [id]
    );
    if (!disputeResult.rows[0]) {
      return res.status(404).json({ error: "Dispute not found" });
    }
    const dispute = disputeResult.rows[0];

    if (dispute.status !== "open") {
      return res.status(400).json({ error: "Dispute is not open" });
    }

    const encryptedArbitratorKey = process.env.ARBITRATOR_ENCRYPTED_KEY;
    if (!encryptedArbitratorKey) {
      return res
        .status(500)
        .json({ error: "Arbitrator key is not configured" });
    }

    const { txHash } = await resolveDispute({
      encryptedArbitratorKey,
      disputeId: dispute.contract_dispute_id,
      releaseToRecipient: release_to_recipient,
    });

    const newStatus = release_to_recipient
      ? "resolved_for_recipient"
      : "resolved_for_sender";

    await db.query(
      `UPDATE disputes
       SET status = $1, resolve_tx_hash = $2, updated_at = NOW()
       WHERE id = $3`,
      [newStatus, txHash, id]
    );

    // Close linked support ticket if present
    if (dispute.support_ticket_id) {
      await db.query(
        "UPDATE support_tickets SET status = 'closed' WHERE id = $1",
        [dispute.support_ticket_id]
      );
    }

    res.json({
      message: "Dispute resolved",
      status: newStatus,
      tx_hash: txHash,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/disputes/:id
 */
async function getDispute(req, res, next) {
  try {
    const result = await db.query("SELECT * FROM disputes WHERE id = $1", [
      req.params.id,
    ]);
    if (!result.rows[0]) {
      return res.status(404).json({ error: "Dispute not found" });
    }
    res.json({ dispute: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/disputes
 * Returns disputes where the authenticated user is sender or recipient.
 */
async function listDisputes(req, res, next) {
  try {
    const walletResult = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1",
      [req.user.userId]
    );
    if (!walletResult.rows[0]) {
      return res.json({ disputes: [] });
    }
    const { public_key } = walletResult.rows[0];

    const result = await db.query(
      `SELECT * FROM disputes
       WHERE sender_wallet = $1 OR recipient_wallet = $1
       ORDER BY created_at DESC`,
      [public_key]
    );
    res.json({ disputes: result.rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { open, submitEvidenceHandler, resolve, getDispute, listDisputes };
