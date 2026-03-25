const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { sendPayment } = require("../services/stellar");
const webhook = require("../services/webhook");

// Configurable KYC transaction threshold in USD equivalent
const KYC_THRESHOLD_USD = parseFloat(process.env.KYC_THRESHOLD_USD || "100");

// Approximate XLM/USD rate — in production replace with a live price feed
const XLM_USD_RATE = parseFloat(process.env.XLM_USD_RATE || "0.11");

// Configurable daily send limit
const DAILY_SEND_LIMIT = parseFloat(process.env.DAILY_SEND_LIMIT || "50000");

function estimateUSDValue(amount, asset) {
  if (asset === "USD" || asset === "USDC") return parseFloat(amount);
  if (asset === "XLM") return parseFloat(amount) * XLM_USD_RATE;
  return 0; // unknown assets default to 0 — do not block
}

// Basic fraud check: block if >5 transactions in last 10 minutes
async function fraudCheck(walletAddress) {
  const result = await db.query(
    `SELECT COUNT(*) FROM transactions
     WHERE sender_wallet = $1 AND created_at > NOW() - INTERVAL '10 minutes'`,
    [walletAddress],
  );
  return parseInt(result.rows[0].count) >= 5;
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

async function send(req, res, next) {
  const txId = uuidv4();
  try {
    const { recipient_address, amount, asset = "XLM", memo } = req.body;

    // KYC check for high-value transactions
    const estimatedUSD = estimateUSDValue(amount, asset);
    if (estimatedUSD >= KYC_THRESHOLD_USD) {
      const kycResult = await db.query("SELECT kyc_status FROM users WHERE id = $1", [
        req.user.userId,
      ]);
      const kycStatus = kycResult.rows[0]?.kyc_status || "unverified";
      if (kycStatus !== "verified") {
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

    const { public_key, encrypted_secret_key } = walletResult.rows[0];

    // Prevent self-payment
    if (recipient_address === public_key) {
      return res.status(400).json({ error: 'Cannot send payment to your own wallet' });
    }

    // Daily send limit check
    const overLimit = await dailyLimitExceeded(public_key, amount);
    if (overLimit) {
      return res.status(400).json({
        error: `Daily send limit of ${DAILY_SEND_LIMIT} reached. Try again tomorrow.`,
        code: 'DAILY_LIMIT_EXCEEDED',
      });
    }

    // Fraud protection
    const isSuspicious = await fraudCheck(public_key);
    if (isSuspicious) {
      return res
        .status(429)
        .json({ error: "Transaction limit reached. Please wait before sending again." });
    }

    // Broadcast to Stellar
    const { transactionHash, ledger } = await sendPayment({
      senderPublicKey: public_key,
      encryptedSecretKey: encrypted_secret_key,
      recipientPublicKey: recipient_address,
      amount,
      asset,
      memo,
    });

    // Save to DB
    await db.query(
      `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'completed')`,
      [txId, public_key, recipient_address, amount, asset, memo || null, transactionHash],
    );

    const txData = { id: txId, tx_hash: transactionHash, ledger, amount, asset, sender: public_key, recipient: recipient_address };
    webhook.deliver('payment.sent', txData).catch(() => {});
    webhook.deliver('payment.received', txData).catch(() => {});

    res.json({
      message: "Payment sent successfully",
      transaction: {
        id: txId,
        tx_hash: transactionHash,
        ledger,
        amount,
        asset,
        recipient: recipient_address,
      },
    });
  } catch (err) {
    // Insert failed transaction
    await db.query(
      `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'failed')`,
      [txId, public_key, recipient_address, amount, asset, memo || null, null],
    );

    if (err.status === 400 || err.status === 500) {
      webhook.deliver('payment.failed', { error: err.message }).catch(() => {});
      return res.status(err.status).json({ error: err.message });
    }
    if (err.response?.data) {
      const extras = err.response.data?.extras;
      webhook.deliver('payment.failed', { error: 'Transaction failed', details: extras }).catch(() => {});
      return res.status(400).json({ error: "Transaction failed", details: extras });
    }
    next(err);
  }
}

async function history(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const walletResult = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1",
      [req.user.userId],
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: "Wallet not found" });

    const { public_key } = walletResult.rows[0];

    const [countResult, result] = await Promise.all([
      db.query(
        `SELECT COUNT(*) FROM transactions WHERE sender_wallet = $1 OR recipient_wallet = $1`,
        [public_key],
      ),
      db.query(
        `SELECT id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status, created_at
         FROM transactions
         WHERE sender_wallet = $1 OR recipient_wallet = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [public_key, limit, offset],
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const transactions = result.rows.map((tx) => ({
      ...tx,
      direction: tx.sender_wallet === public_key ? "sent" : "received",
    }));

    res.json({
      transactions,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { send, history };
