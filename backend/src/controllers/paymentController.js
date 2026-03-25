const { v4: uuidv4 } = require("uuid");
const { stringify } = require("csv-stringify/sync");
const db = require("../db");
const { sendPayment } = require("../services/stellar");

// Configurable KYC transaction threshold in USD equivalent
const KYC_THRESHOLD_USD = parseFloat(process.env.KYC_THRESHOLD_USD || "100");

// Approximate XLM/USD rate — in production replace with a live price feed
const XLM_USD_RATE = parseFloat(process.env.XLM_USD_RATE || "0.11");

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

async function send(req, res, next) {
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
    const txId = uuidv4();
    await db.query(
      `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'completed')`,
      [txId, public_key, recipient_address, amount, asset, memo || null, transactionHash],
    );

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
      return res.status(err.status).json({ error: err.message });
    }
    if (err.response?.data) {
      const extras = err.response.data?.extras;
      return res.status(400).json({ error: "Transaction failed", details: extras });
    }
    next(err);
  }
}

async function history(req, res, next) {
  try {
    const walletResult = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1",
      [req.user.userId],
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: "Wallet not found" });

    const { public_key } = walletResult.rows[0];
    const result = await db.query(
      `SELECT id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status, created_at
       FROM transactions
       WHERE sender_wallet = $1 OR recipient_wallet = $1
       ORDER BY created_at DESC LIMIT 50`,
      [public_key],
    );

    const transactions = result.rows.map((tx) => ({
      ...tx,
      direction: tx.sender_wallet === public_key ? "sent" : "received",
    }));

    res.json({ transactions });
  } catch (err) {
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

module.exports = { send, history, exportCSV };
