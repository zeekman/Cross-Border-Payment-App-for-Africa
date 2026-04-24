const { v4: uuidv4 } = require("uuid");
const { stringify } = require("csv-stringify/sync");
const db = require("../db");
const { sendPayment, sendPathPayment, findPaymentPath, fetchFee } = require("../services/stellar");
const webhook = require("../services/webhook");
const cache = require("../utils/cache");
const { checkFraud, logFraudBlock } = require("../services/fraudDetection");
const { parseHistoryFrom, parseHistoryTo, normalizeAsset } = require("../utils/historyQuery");
const { isMemoRequired } = require("../services/memoRequired");
const { mintPoints } = require("../services/loyaltyToken");
const { depositFee } = require("../services/feeDistributor");

// Configurable KYC transaction threshold in USD equivalent
const KYC_THRESHOLD_USD = parseFloat(process.env.KYC_THRESHOLD_USD || "100");

// Approximate XLM/USD rate — in production replace with a live price feed
const XLM_USD_RATE = parseFloat(process.env.XLM_USD_RATE || "0.11");

// Daily send limit per user
const DAILY_SEND_LIMIT = parseFloat(process.env.DAILY_SEND_LIMIT || "50000");

// Threshold for phone verification check
const PHONE_VERIFICATION_THRESHOLD_USD = parseFloat(process.env.PHONE_VERIFICATION_THRESHOLD_USD || "100");

function estimateUSDValue(amount, asset) {
  if (asset === "USD" || asset === "USDC") return parseFloat(amount);
  if (asset === "XLM") return parseFloat(amount) * XLM_USD_RATE;
  return 0; // unknown assets default to 0 — do not block
}

/**
 * Daily send limit check.
 * Sums all completed/pending transactions sent today (UTC) for this wallet.
 * Returns true if adding `amount` would exceed the limit.
 */
async function dailyLimitExceeded(walletAddress, amount) {
  const result = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE sender_wallet = $1
       AND status != 'failed'
       AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
    [walletAddress],
  );
  const totalToday = parseFloat(result.rows[0].total);
  return totalToday + parseFloat(amount) > DAILY_SEND_LIMIT;
}

async function estimateFee(req, res, next) {
  try {
    const fee = await fetchFee();
    res.json({ fee_stroops: fee, fee_xlm: (fee / 1e7).toFixed(7) });
  } catch (err) {
    next(err);
  }
}

async function send(req, res, next) {
  const txId = uuidv4();
  // Hoist these so the catch block can reference them for the failed-tx INSERT
  let public_key;
  try {
    const { recipient_address, amount, asset = "XLM", memo: rawMemo, memo_type: rawMemoType } = req.body;
    const memo = typeof rawMemo === "string" ? rawMemo.trim() : "";
    const memo_type = memo ? (rawMemoType || "text") : null;

    // Phone verification check for high-value transactions
    if (estimatedUSD >= PHONE_VERIFICATION_THRESHOLD_USD) {
      const userResult = await db.query("SELECT kyc_status, phone_verified FROM users WHERE id = $1", [
        req.user.userId,
      ]);
      const { kyc_status: kycStatus, phone_verified: phoneVerified } = userResult.rows[0] || {};
      
      if (!phoneVerified) {
        return res.status(403).json({
          error: "Phone verification required for transactions above $" + PHONE_VERIFICATION_THRESHOLD_USD + " USD equivalent.",
          phone_verified: false,
          code: "PHONE_VERIFICATION_REQUIRED",
        });
      }

      if (kycStatus !== "verified" && estimatedUSD >= KYC_THRESHOLD_USD) {
        return res.status(403).json({
          error:
            "KYC verification required for transactions above $" +
            KYC_THRESHOLD_USD +
            " USD equivalent.",
          kyc_status: kycStatus,
          code: "KYC_REQUIRED",
        });
      }
    }

    // Get sender wallet
    const walletResult = await db.query(
      "SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1",
      [req.user.userId],
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: "Wallet not found" });

    ({ public_key } = walletResult.rows[0]);
    const { encrypted_secret_key } = walletResult.rows[0];

    // Prevent self-payment
    if (recipient_address === public_key) {
      return res.status(400).json({ error: "Cannot send payment to your own wallet" });
    }

    // Daily send limit check
    const overLimit = await dailyLimitExceeded(public_key, amount);
    if (overLimit) {
      return res.status(400).json({
        error: `Daily send limit of ${DAILY_SEND_LIMIT} reached. Try again tomorrow.`,
        code: "DAILY_LIMIT_EXCEEDED",
      });
    }

    // Fraud protection
    const fraudCheck = await checkFraud(public_key, amount, asset);
    if (fraudCheck.blocked) {
      await logFraudBlock(public_key, fraudCheck.reason, amount, asset);
      return res.status(429).json({ error: fraudCheck.reason });
    }

    // Memo requirement check
    if (await isMemoRequired(recipient_address) && !memo) {
      return res.status(422).json({
        error: "This address requires a memo to route your payment correctly. Please include a memo.",
        code: "MEMO_REQUIRED",
      });
    }

    // Broadcast to Stellar
    const { transactionHash, ledger, type, claimableBalanceId } = await sendPayment({
      senderPublicKey: public_key,
      encryptedSecretKey: encrypted_secret_key,
      recipientPublicKey: recipient_address,
      amount,
      asset,
      memo: memo || undefined,
      memoType: memo ? memo_type : undefined,
    });

    // Save to DB
    const txStatus = type === "claimable_balance" ? "pending_claim" : "completed";
    await db.query(
      `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, memo_type, tx_hash, status, claimable_balance_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [txId, public_key, recipient_address, amount, asset, memo || null, memo_type, transactionHash, txStatus, claimableBalanceId || null],
    );

    // Invalidate sender's cached balance — it changed after this payment
    await cache.del(`balance:${public_key}`);

    // Mint loyalty points: 1 point per 1 XLM (or XLM-equivalent) of volume
    const loyaltyPoints = Math.max(1, Math.floor(parseFloat(amount)));
    mintPoints({ recipientWallet: public_key, points: loyaltyPoints }).catch(() => {});
    // Deposit platform fee on-chain (fire-and-forget — never blocks the response)
    const FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || "250", 10);
    if (asset === "USDC" && FEE_BPS > 0) {
      const feeStroops = Math.floor(parseFloat(amount) * 1e7 * FEE_BPS / 10000);
      if (feeStroops > 0) {
        depositFee(feeStroops).catch((err) =>
          console.error("Fee deposit failed (non-critical):", err.message)
        );
      }
    }

    const txData = { id: txId, tx_hash: transactionHash, ledger, amount, asset, sender: public_key, recipient: recipient_address, type };
    webhook.deliver("payment.sent", txData).catch(() => {});
    if (type !== "claimable_balance") {
      webhook.deliver("payment.received", txData).catch(() => {});
    }

    res.json({
      message: type === "claimable_balance" ? "Claimable balance created" : "Payment sent successfully",
      transaction: {
        id: txId,
        tx_hash: transactionHash,
        ledger,
        amount,
        asset,
        recipient: recipient_address,
        type,
        claimableBalanceId,
      },
    });
  } catch (err) {
    if (err.status === 400 || err.status === 500) {
      webhook.deliver("payment.failed", { error: err.message }).catch(() => {});
      return res.status(err.status).json({ error: err.message });
    }
    if (err.response?.data) {
      const extras = err.response.data?.extras;
      webhook.deliver("payment.failed", { error: "Transaction failed", details: extras }).catch(() => {});
      return res.status(400).json({ error: "Transaction failed", details: extras });
    }
    next(err);
  }
}

async function history(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    let fromBound = null;
    let toBound = null;
    if (req.query.from != null && String(req.query.from).trim() !== "") {
      fromBound = parseHistoryFrom(req.query.from);
      if (!fromBound) return res.status(400).json({ error: "Invalid from date; use ISO 8601 (e.g. YYYY-MM-DD)" });
    }
    if (req.query.to != null && String(req.query.to).trim() !== "") {
      toBound = parseHistoryTo(req.query.to);
      if (!toBound) return res.status(400).json({ error: "Invalid to date; use ISO 8601 (e.g. YYYY-MM-DD)" });
    }
    if (fromBound && toBound && fromBound.getTime() > toBound.getTime()) {
      return res.status(400).json({ error: "from must be before or equal to to" });
    }

    let assetFilter = null;
    if (req.query.asset != null && String(req.query.asset).trim() !== "") {
      assetFilter = normalizeAsset(req.query.asset);
      if (!assetFilter) {
        return res.status(400).json({ error: "Invalid asset filter" });
      }
    }

    const walletResult = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1",
      [req.user.userId],
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: "Wallet not found" });

    const { public_key } = walletResult.rows[0];

    const conditions = ["(sender_wallet = $1 OR recipient_wallet = $1)"];
    const baseParams = [public_key];
    if (fromBound) {
      conditions.push(`created_at >= $${baseParams.length + 1}`);
      baseParams.push(fromBound);
    }
    if (toBound) {
      conditions.push(`created_at <= $${baseParams.length + 1}`);
      baseParams.push(toBound);
    }
    if (assetFilter) {
      conditions.push(`asset = $${baseParams.length + 1}`);
      baseParams.push(assetFilter);
    }
    const whereClause = conditions.join(" AND ");

    const countSql = `SELECT COUNT(*)::text AS count FROM transactions WHERE ${whereClause}`;
    const listSql = `SELECT id, sender_wallet, recipient_wallet, amount, asset, memo, memo_type, tx_hash, status, created_at
         FROM transactions
         WHERE ${whereClause}
         ORDER BY created_at DESC LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`;

    const dataParams = [...baseParams, limit, offset];

    const [countResult, result] = await Promise.all([
      db.query(countSql, baseParams),
      db.query(listSql, dataParams),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);
    const transactions = result.rows.map((tx) => ({
      ...tx,
      direction: tx.sender_wallet === public_key ? "sent" : "received",
    }));

    res.json({
      transactions,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 0,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/payments/find-path
 * Body: { source_asset, source_amount, destination_asset, recipient_address }
 * Returns the best conversion path and estimated destination amount.
 */
async function findPath(req, res, next) {
  try {
    const { source_asset, source_amount, destination_asset, recipient_address } = req.body;
    const result = await findPaymentPath(source_asset, source_amount, destination_asset, recipient_address);
    if (!result) {
      return res.status(404).json({ error: "No conversion path found between these assets" });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/payments/send-path
 * Executes a strict-send path payment.
 * Body: { recipient_address, source_asset, source_amount, destination_asset,
 *         destination_min_amount, path, memo }
 */
async function sendPath(req, res, next) {
  const txId = uuidv4();
  let public_key, recipient_address, source_amount, source_asset;
  try {
    ({
      recipient_address,
      source_asset = "XLM",
      source_amount,
      destination_asset,
      destination_min_amount,
      path = [],
      memo,
    } = req.body);

    // Phone verification check
    if (estimatedUSD >= PHONE_VERIFICATION_THRESHOLD_USD) {
      const userResult = await db.query("SELECT kyc_status, phone_verified FROM users WHERE id = $1", [req.user.userId]);
      const { kyc_status: kycStatus, phone_verified: phoneVerified } = userResult.rows[0] || {};
      
      if (!phoneVerified) {
        return res.status(403).json({
          error: `Phone verification required for transactions above $${PHONE_VERIFICATION_THRESHOLD_USD} USD equivalent.`,
          phone_verified: false,
          code: "PHONE_VERIFICATION_REQUIRED",
        });
      }

      if (kycStatus !== "verified" && estimatedUSD >= KYC_THRESHOLD_USD) {
        return res.status(403).json({
          error: `KYC verification required for transactions above $${KYC_THRESHOLD_USD} USD equivalent.`,
          kyc_status: kycStatus,
          code: "KYC_REQUIRED",
        });
      }
    }

    const walletResult = await db.query(
      "SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1",
      [req.user.userId],
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: "Wallet not found" });

    ({ public_key } = walletResult.rows[0]);
    const { encrypted_secret_key } = walletResult.rows[0];

    if (recipient_address === public_key) {
      return res.status(400).json({ error: "Cannot send payment to your own wallet" });
    }

    const fraudCheck = await checkFraud(public_key, source_amount, source_asset);
    if (fraudCheck.blocked) {
      await logFraudBlock(public_key, fraudCheck.reason, source_amount, source_asset);
      return res.status(429).json({ error: fraudCheck.reason });
    }

    const { transactionHash, ledger } = await sendPathPayment({
      senderPublicKey: public_key,
      encryptedSecretKey: encrypted_secret_key,
      recipientPublicKey: recipient_address,
      sourceAsset: source_asset,
      sourceAmount: source_amount,
      destinationAsset: destination_asset,
      destinationMinAmount: destination_min_amount,
      path,
      memo,
    });

    await db.query(
      `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'completed')`,
      [txId, public_key, recipient_address, source_amount, source_asset, memo || null, transactionHash],
    );

    const txData = { id: txId, tx_hash: transactionHash, ledger, source_amount, source_asset, destination_asset, sender: public_key, recipient: recipient_address };
    webhook.deliver("payment.sent", txData).catch(() => {});
    webhook.deliver("payment.received", txData).catch(() => {});

    res.json({
      message: "Path payment sent successfully",
      transaction: { id: txId, tx_hash: transactionHash, ledger, source_amount, source_asset, destination_asset, recipient: recipient_address },
    });
  } catch (err) {
    await db.query(
      `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'failed')`,
      [txId, public_key || "", recipient_address || "", source_amount || "0", source_asset || "XLM", null, null],
    ).catch(() => {});

    if (err.status === 400 || err.status === 500) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.response?.data) {
      return res.status(400).json({ error: "Path payment failed", details: err.response.data?.extras });
    }
    next(err);
  }
}

async function exportCSV(req, res, next) {
  try {
    const walletResult = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1",
      [req.user.userId],
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: "Wallet not found" });

    const { public_key } = walletResult.rows[0];

    const params = [public_key];
    let filters = "";
    if (req.query.from) {
      params.push(req.query.from);
      filters += ` AND created_at >= $${params.length}`;
    }
    if (req.query.to) {
      params.push(req.query.to);
      filters += ` AND created_at <= $${params.length}`;
    }
    if (req.query.status) {
      params.push(req.query.status);
      filters += ` AND status = $${params.length}`;
    }
    if (req.query.direction === "sent") {
      filters += " AND sender_wallet = $1";
    } else if (req.query.direction === "received") {
      filters += " AND recipient_wallet = $1";
    }

    const result = await db.query(
      `SELECT created_at, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status
       FROM transactions
       WHERE (sender_wallet = $1 OR recipient_wallet = $1)${filters}
       ORDER BY created_at DESC`,
      params,
    );

    const rows = result.rows.map((tx) => ({
      date: new Date(tx.created_at).toISOString(),
      direction: tx.sender_wallet === public_key ? "sent" : "received",
      amount: tx.amount,
      asset: tx.asset,
      recipient_or_sender: tx.sender_wallet === public_key ? tx.recipient_wallet : tx.sender_wallet,
      memo: tx.memo || "",
      tx_hash: tx.tx_hash || "",
      status: tx.status,
    }));

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="transactions.csv"');

    const output = stringify(rows, {
      header: true,
      columns: ["date", "direction", "amount", "asset", "recipient_or_sender", "memo", "tx_hash", "status"],
    });
    res.send(output);
  } catch (err) {
    next(err);
  }
}

module.exports = { send, history, findPath, sendPath, exportCSV, estimateFee };
