const { v4: uuidv4 } = require("uuid");
const { stringify } = require("csv-stringify");
const db = require("../db");
const { sendPayment, sendPathPayment, findPaymentPath } = require("../services/stellar");
const webhook = require("../services/webhook");
const cache = require("../utils/cache");

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
  // Hoist these so the catch block can reference them for the failed-tx INSERT
  let public_key;
  const { recipient_address, amount, asset = "XLM", memo } = req.body;
  try {
    const { recipient_address, amount, asset = "XLM", memo: rawMemo, memo_type: rawMemoType } = req.body;
    const memo = typeof rawMemo === "string" ? rawMemo.trim() : "";
    const memo_type = memo ? (rawMemoType || "text") : null;

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

    ({ public_key } = walletResult.rows[0]);
    const { encrypted_secret_key } = walletResult.rows[0];

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
      memo: memo || undefined,
      memoType: memo ? memo_type : undefined,
    });

    // Save to DB
    await db.query(
      `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, memo_type, tx_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed')`,
      [txId, public_key, recipient_address, amount, asset, memo || null, memo_type, transactionHash],
    );

    // Invalidate sender's cached balance — it changed after this payment
    await cache.del(`balance:${public_key}`);

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
        `SELECT id, sender_wallet, recipient_wallet, amount, asset, memo, memo_type, tx_hash, status, created_at
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
      return res.status(404).json({ error: 'No conversion path found between these assets' });
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
      source_asset = 'XLM',
      source_amount,
      destination_asset,
      destination_min_amount,
      path = [],
      memo,
    } = req.body);

    // KYC check
    const estimatedUSD = estimateUSDValue(source_amount, source_asset);
    if (estimatedUSD >= KYC_THRESHOLD_USD) {
      const kycResult = await db.query('SELECT kyc_status FROM users WHERE id = $1', [req.user.userId]);
      const kycStatus = kycResult.rows[0]?.kyc_status || 'unverified';
      if (kycStatus !== 'verified') {
        return res.status(403).json({
          error: `KYC verification required for transactions above $${KYC_THRESHOLD_USD} USD equivalent.`,
          kyc_status: kycStatus,
          code: 'KYC_REQUIRED',
        });
      }
    }

    const walletResult = await db.query(
      'SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1',
      [req.user.userId],
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    ({ public_key, encrypted_secret_key } = walletResult.rows[0]);

    if (recipient_address === public_key) {
      return res.status(400).json({ error: 'Cannot send payment to your own wallet' });
    }

    const isSuspicious = await fraudCheck(public_key);
    if (isSuspicious) {
      return res.status(429).json({ error: 'Transaction limit reached. Please wait before sending again.' });
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
    webhook.deliver('payment.sent', txData).catch(() => {});
    webhook.deliver('payment.received', txData).catch(() => {});

    res.json({
      message: 'Path payment sent successfully',
      transaction: { id: txId, tx_hash: transactionHash, ledger, source_amount, source_asset, destination_asset, recipient: recipient_address },
    });
  } catch (err) {
    await db.query(
      `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'failed')`,
      [txId, public_key || '', recipient_address || '', source_amount || '0', source_asset || 'XLM', null, null],
    ).catch(() => {});

    if (err.status === 400 || err.status === 500) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.response?.data) {
      return res.status(400).json({ error: 'Path payment failed', details: err.response.data?.extras });
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
    let dateFilter = "";
    if (req.query.from) {
      params.push(req.query.from);
      dateFilter += ` AND created_at >= $${params.length}`;
    }
    if (req.query.to) {
      params.push(req.query.to);
      dateFilter += ` AND created_at <= $${params.length}`;
    }
    if (req.query.status) {
      params.push(req.query.status);
      dateFilter += ` AND status = $${params.length}`;
    }

    const result = await db.query(
      `SELECT created_at, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status
       FROM transactions
       WHERE (sender_wallet = $1 OR recipient_wallet = $1)${dateFilter}
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

    stringify(
      rows,
      { header: true, columns: ["date", "direction", "amount", "asset", "recipient_or_sender", "memo", "tx_hash", "status"] },
      (err, output) => {
        if (err) return next(err);
        res.send(output);
      },
    );
  } catch (err) {
    next(err);
  }
}

module.exports = { send, history, findPath, sendPath };
module.exports = { send, history, exportCSV };
