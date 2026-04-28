const { v4: uuidv4 } = require("uuid");
const { stringify } = require("csv-stringify/sync");
const db = require("../db");
const StellarSdk = require("@stellar/stellar-sdk");
const {
  sendPayment,
  sendBatchPayment,
  sendPathPayment,
  findPaymentPath,
  fetchFee,
  fetchFeeStats,
  validateBatchRecipient,
  findReceivePath,
  sendStrictReceivePathPayment,
  getBalance,
} = require("../services/stellar");
const webhook = require("../services/webhook");
const cache = require("../utils/cache");
const { checkFraud, logFraudBlock } = require("../services/fraudDetection");
const { parseHistoryFrom, parseHistoryTo, normalizeAsset } = require("../utils/historyQuery");
const { isMemoRequired } = require("../services/memoRequired");
const { awardReferralCredit } = require("./referralController");
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

const horizonUrl = process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org";
const horizonServer = new StellarSdk.Horizon.Server(horizonUrl);

/**
 * Fetch the authoritative ledger close time from Horizon for a given ledger sequence.
 * Returns an ISO string or null if unavailable.
 */
async function fetchLedgerCloseTime(ledgerSequence) {
  if (!ledgerSequence) return null;
  try {
    const ledger = await horizonServer.ledgers().ledger(ledgerSequence).call();
    return ledger.closed_at || null;
  } catch {
    return null;
  }
}


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

/**
 * Check that the sender has sufficient balance (cached or live) for amount + estimated fee.
 * Throws a structured 400 error if underfunded.
 */
async function checkSufficientBalance(publicKey, amount, asset) {
  const FEE_XLM = 0.00001; // conservative single-op fee estimate
  const required = parseFloat(amount) + (asset === 'XLM' ? FEE_XLM : 0);

  let balances = await cache.get(`balance:${publicKey}`);
  if (!balances) {
    balances = await getBalance(publicKey);
    await cache.set(`balance:${publicKey}`, balances);
  }

  const entry = balances.find(b => b.asset === asset);
  const available = parseFloat(entry?.available_balance ?? entry?.balance ?? '0');

  if (available < required) {
    const err = new Error('Insufficient balance');
    err.status = 400;
    err.payload = {
      code: 'INSUFFICIENT_BALANCE',
      available: (entry?.available_balance ?? entry?.balance ?? '0').toString(),
      required: required.toFixed(7),
    };
    throw err;
  }
}

async function ensureKycIfNeeded(userId, amount, asset) {
  const estimatedUSD = estimateUSDValue(amount, asset);
  if (estimatedUSD < KYC_THRESHOLD_USD) {
    return null;
  }

  const kycResult = await db.query("SELECT kyc_status FROM users WHERE id = $1", [userId]);
  const kycStatus = kycResult.rows[0]?.kyc_status || "unverified";
  if (kycStatus !== "verified") {
    const err = new Error(
      `KYC verification required for transactions above $${KYC_THRESHOLD_USD} USD equivalent.`,
    );
    err.status = 403;
    err.payload = { kyc_status: kycStatus, code: "KYC_REQUIRED" };
    throw err;
  }

  return kycStatus;
}

async function getWalletForUser(userId) {
  const walletResult = await db.query(
    "SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1",
    [userId],
  );

  return walletResult.rows[0] || null;
}

async function insertTransactionRecord({
  id = uuidv4(),
  sender_wallet,
  recipient_wallet,
  amount,
  asset,
  memo = null,
  memo_type = null,
  tx_hash = null,
  status,
  ledger_close_time = null,
}) {
  await db.query(
    `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, memo_type, tx_hash, status, ledger_close_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, sender_wallet, recipient_wallet, amount, asset, memo, memo_type, tx_hash, status, ledger_close_time],
  );

  return id;
}

async function estimateFee(req, res, next) {
  try {
    const fee = await fetchFee();
    res.json({ fee_stroops: fee, fee_xlm: (fee / 1e7).toFixed(7) });
  } catch (err) {
    next(err);
  }
}

async function getFeeStats(req, res, next) {
  try {
    const stats = await fetchFeeStats();
    res.json({
      min: stats.min,
      p10: stats.p10,
      p50: stats.p50,
      p90: stats.p90,
      p99: stats.p99,
      priorities: {
        economy: stats.p10,
        standard: stats.p50,
        priority: stats.p90,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function send(req, res, next) {
  const txId = uuidv4();
  // Hoist these so the catch block can reference them for the failed-tx INSERT
  let public_key;
  try {
    const { recipient_address, amount, asset = "XLM", memo: rawMemo, memo_type: rawMemoType, encrypt_memo = false, fee_priority = "standard" } = req.body;
    let memo = typeof rawMemo === "string" ? rawMemo.trim() : "";
    const memo_type = memo ? (rawMemoType || "text") : null;

    await ensureKycIfNeeded(req.user.userId, amount, asset);

    // Get sender wallet
    const wallet = await getWalletForUser(req.user.userId);
    if (!wallet) return res.status(404).json({ error: "Wallet not found" });
    let is_encrypted = false;
    let encrypted_memo = null;

    if (encrypt_memo && memo) {
      const { encryptMemo } = require('../utils/encryption');
      encrypted_memo = encryptMemo(memo, recipient_address);
      memo = encrypted_memo; // Use ciphertext as memo
      is_encrypted = true;
    }

    // KYC check for high-value transactions
    const estimatedUSD = estimateUSDValue(amount, asset);
    if (estimatedUSD >= KYC_THRESHOLD_USD) {
      const kycResult = await db.query("SELECT kyc_status FROM users WHERE id = $1", [
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

    // Get sender wallet — caller may specify a wallet_id to send from a non-default wallet
    const { wallet_id: sendWalletId } = req.body;
    const walletQuery = sendWalletId
      ? { text: "SELECT public_key, encrypted_secret_key FROM wallets WHERE id = $1 AND user_id = $2", values: [sendWalletId, req.user.userId] }
      : { text: "SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1", values: [req.user.userId] };
    const walletResult = await db.query(walletQuery.text, walletQuery.values);
    if (!walletResult.rows[0]) return res.status(404).json({ error: "Wallet not found" });

    ({ public_key } = wallet);
    const { encrypted_secret_key } = wallet;

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

    // Balance check — fail fast with a clear message before hitting Stellar
    await checkSufficientBalance(public_key, amount, asset);

    // Broadcast to Stellar
    const { transactionHash, ledger, type, claimableBalanceId } = await sendPayment({
      senderPublicKey: public_key,
      encryptedSecretKey: encrypted_secret_key,
      recipientPublicKey: recipient_address,
      amount,
      asset,
      memo: memo || undefined,
      memoType: memo ? memo_type : undefined,
      feePriority: fee_priority,
    }, req.logger);

    // Fetch authoritative ledger close time from Horizon (issue #139)
    const ledger_close_time = await fetchLedgerCloseTime(ledger);

    // Save to DB
    const txStatus = type === "claimable_balance" ? "pending_claim" : "confirming";
    await db.query(
      `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, memo_type, tx_hash, status, claimable_balance_id, request_id, is_encrypted, encrypted_memo, ledger_close_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [txId, public_key, recipient_address, amount, asset, memo || null, memo_type, transactionHash, txStatus, claimableBalanceId || null, req.requestId, is_encrypted, encrypted_memo, ledger_close_time],
    );

    // Start async confirmation polling for non-claimable-balance transactions
    if (type !== "claimable_balance") {
      pollTransactionConfirmation(txId, transactionHash).catch(() => {});
    }

    // Invalidate sender's cached balance — it changed after this payment
    await cache.del(`balance:${public_key}`);

    // Award referral credit to referrer if this is the sender's first transaction
    const txCount = await db.query(
      `SELECT COUNT(*) AS cnt FROM transactions WHERE sender_wallet = $1`,
      [public_key]
    );
    if (parseInt(txCount.rows[0].cnt, 10) === 1) {
      awardReferralCredit(req.user.userId).catch(() => {});
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

    // Fire transaction receipt emails asynchronously — do not block the response
    const emailTxData = {
      amount,
      asset,
      senderAddress: public_key,
      recipientAddress: recipient_address,
      memo: memo || null,
      txHash: transactionHash,
    };

    // Email the sender
    db.query('SELECT email FROM users WHERE id = $1', [req.user.userId])
      .then(({ rows }) => {
        if (rows[0]?.email) {
          return sendTransactionEmail(rows[0].email, 'sent', emailTxData);
        }
      })
      .catch((err) => logger.warn('Failed to send payment-sent email', { error: err.message }));

    // Email the recipient if they are a registered AfriPay user
    db.query(
      'SELECT u.email FROM users u JOIN wallets w ON w.user_id = u.id WHERE w.public_key = $1',
      [recipient_address]
    )
      .then(({ rows }) => {
        if (rows[0]?.email) {
          return sendTransactionEmail(rows[0].email, 'received', emailTxData);
        }
      })
      .catch((err) => logger.warn('Failed to send payment-received email', { error: err.message }));

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
    if (err.status) {
      webhook.deliver("payment.failed", { error: err.message }).catch(() => {});
      return res.status(err.status).json({ error: err.message, ...(err.payload || {}) });
    }
    if (err.response?.data) {
      const extras = err.response.data?.extras;
      webhook.deliver("payment.failed", { error: "Transaction failed", details: extras }).catch(() => {});
      return res.status(400).json({ error: "Transaction failed", details: extras });
    }
    next(err);
  }
}

async function sendBatch(req, res, next) {
  let public_key;
  let memo;
  let memo_type;
  let asset;

  try {
    const { recipients = [], memo: rawMemo, memo_type: rawMemoType } = req.body;
    asset = req.body.asset || "XLM";
    memo = typeof rawMemo === "string" ? rawMemo.trim() : "";
    memo_type = memo ? (rawMemoType || "text") : null;

    const totalAmount = recipients.reduce((sum, recipient) => sum + parseFloat(recipient.amount), 0);

    await ensureKycIfNeeded(req.user.userId, totalAmount, asset);

    const wallet = await getWalletForUser(req.user.userId);
    if (!wallet) return res.status(404).json({ error: "Wallet not found" });

    ({ public_key } = wallet);
    const { encrypted_secret_key } = wallet;

    const overLimit = await dailyLimitExceeded(public_key, totalAmount);
    if (overLimit) {
      return res.status(400).json({
        error: `Daily send limit of ${DAILY_SEND_LIMIT} reached. Try again tomorrow.`,
        code: "DAILY_LIMIT_EXCEEDED",
      });
    }

    const fraudCheck = await checkFraud(public_key, totalAmount, asset);
    if (fraudCheck.blocked) {
      await logFraudBlock(public_key, fraudCheck.reason, totalAmount, asset);
      return res.status(429).json({ error: fraudCheck.reason });
    }

    const results = [];
    const validRecipients = [];

    for (let index = 0; index < recipients.length; index += 1) {
      const recipient = recipients[index];
      const recipientAddress = recipient.recipient_address;
      const amount = recipient.amount;

      if (recipientAddress === public_key) {
        results.push({
          index,
          recipient_address: recipientAddress,
          amount,
          status: "failed",
          error: "Cannot send payment to your own wallet",
        });
        continue;
      }

      if (await isMemoRequired(recipientAddress) && !memo) {
        results.push({
          index,
          recipient_address: recipientAddress,
          amount,
          status: "failed",
          error: "This address requires a memo to route your payment correctly. Please include a memo.",
          code: "MEMO_REQUIRED",
        });
        continue;
      }

      try {
        await validateBatchRecipient({
          recipientPublicKey: recipientAddress,
          asset,
        });
        results.push({
          index,
          recipient_address: recipientAddress,
          amount,
          status: "pending",
        });
        validRecipients.push({
          index,
          recipientPublicKey: recipientAddress,
          amount,
        });
      } catch (err) {
        results.push({
          index,
          recipient_address: recipientAddress,
          amount,
          status: "failed",
          error: err.message,
        });
      }
    }

    if (validRecipients.length === 0) {
      await Promise.all(results.map((result) => insertTransactionRecord({
        sender_wallet: public_key,
        recipient_wallet: result.recipient_address,
        amount: result.amount,
        asset,
        memo: memo || null,
        memo_type,
        status: "failed",
      })));

      return res.status(400).json({
        message: "No valid recipients were submitted",
        summary: {
          total: recipients.length,
          submitted: 0,
          successful: 0,
          failed: results.length,
        },
        results,
      });
    }

    try {
      const { transactionHash, ledger, operationCount } = await sendBatchPayment({
        senderPublicKey: public_key,
        encryptedSecretKey: encrypted_secret_key,
        recipients: validRecipients,
        asset,
        memo: memo || undefined,
        memoType: memo ? memo_type : undefined,
      });

      await Promise.all(results.map(async (result) => {
        const isSubmitted = result.status === "pending";
        const finalResult = isSubmitted
          ? {
              ...result,
              status: "success",
              tx_hash: transactionHash,
              ledger,
            }
          : result;

        Object.assign(result, finalResult);

        const txId = await insertTransactionRecord({
          sender_wallet: public_key,
          recipient_wallet: result.recipient_address,
          amount: result.amount,
          asset,
          memo: memo || null,
          memo_type,
          tx_hash: result.tx_hash || null,
          status: result.status === "success" ? "completed" : "failed",
        });

        result.id = txId;

        if (result.status === "success") {
          const txData = {
            id: txId,
            tx_hash: transactionHash,
            ledger,
            amount: result.amount,
            asset,
            sender: public_key,
            recipient: result.recipient_address,
            type: "payment",
          };
          webhook.deliver("payment.sent", txData).catch(() => {});
          webhook.deliver("payment.received", txData).catch(() => {});
        }
      }));

      await cache.del(`balance:${public_key}`);

      return res.json({
        message: "Batch payment submitted successfully",
        transaction: {
          tx_hash: transactionHash,
          ledger,
          asset,
          operation_count: operationCount,
        },
        summary: {
          total: recipients.length,
          submitted: validRecipients.length,
          successful: validRecipients.length,
          failed: results.length - validRecipients.length,
        },
        results,
      });
    } catch (err) {
      await Promise.all(results.map(async (result) => {
        const isSubmitted = result.status === "pending";
        if (isSubmitted) {
          result.status = "failed";
          result.error = err.response?.data ? "Transaction failed" : err.message;
          if (err.response?.data?.extras) {
            result.details = err.response.data.extras;
          }
        }

        const txId = await insertTransactionRecord({
          sender_wallet: public_key,
          recipient_wallet: result.recipient_address,
          amount: result.amount,
          asset,
          memo: memo || null,
          memo_type,
          status: "failed",
        });
        result.id = txId;
      }));

      const statusCode = err.status || (err.response?.data ? 400 : 500);
      return res.status(statusCode).json({
        error: err.response?.data ? "Batch transaction failed" : err.message,
        details: err.response?.data?.extras,
        summary: {
          total: recipients.length,
          submitted: validRecipients.length,
          successful: 0,
          failed: results.length,
        },
        results,
      });
    }
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.message,
        ...(err.payload || {}),
      });
    }
    next(err);
  }
}

async function history(req, res, next) {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    // cursor is the transaction id (integer PK) to paginate from
    const cursor = req.query.cursor ? parseInt(req.query.cursor, 10) : null;

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
      "SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1",
      [req.user.userId],
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: "Wallet not found" });

    const { public_key } = walletResult.rows[0];

    const conditions = ["(sender_wallet = $1 OR recipient_wallet = $1)"];
    const baseParams = [public_key];

    if (cursor) {
      conditions.push(`id < $${baseParams.length + 1}`);
      baseParams.push(cursor);
    }
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

    const listSql = `SELECT id, sender_wallet, recipient_wallet, amount, asset, memo, memo_type, tx_hash, status, created_at, ledger_close_time
         FROM transactions
         WHERE ${whereClause}
         ORDER BY id DESC LIMIT $${baseParams.length + 1}`;

    const result = await db.query(listSql, [...baseParams, limit + 1]);

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const transactions = rows.slice(0, limit).map((tx) => ({
      ...tx,
      direction: tx.sender_wallet === public_key ? "sent" : "received",
    }));

    const next_cursor = hasMore ? transactions[transactions.length - 1].id : null;

    res.json({ transactions, next_cursor, has_more: hasMore });
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
      encrypt_memo = false,
    } = req.body);

    let memoStr = typeof memo === "string" ? memo.trim() : "";
    let is_encrypted = false;
    let encrypted_memo = null;

    if (encrypt_memo && memoStr) {
      const { encryptMemo } = require('../utils/encryption');
      encrypted_memo = encryptMemo(memoStr, recipient_address);
      memoStr = encrypted_memo; // Use ciphertext as memo
      is_encrypted = true;
    }

    // KYC check
    const estimatedUSD = estimateUSDValue(source_amount, source_asset);
    if (estimatedUSD >= KYC_THRESHOLD_USD) {
      const kycResult = await db.query("SELECT kyc_status FROM users WHERE id = $1", [req.user.userId]);
      const kycStatus = kycResult.rows[0]?.kyc_status || "unverified";
      if (kycStatus !== "verified") {
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

    const { wallet_id: sendWalletId } = req.body;
    const pathWalletQuery = sendWalletId
      ? { text: "SELECT public_key, encrypted_secret_key FROM wallets WHERE id = $1 AND user_id = $2", values: [sendWalletId, req.user.userId] }
      : { text: "SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1", values: [req.user.userId] };
    const walletResult = await db.query(pathWalletQuery.text, pathWalletQuery.values);
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

    // Balance check — fail fast with a clear message before hitting Stellar
    await checkSufficientBalance(public_key, source_amount, source_asset);

    const { transactionHash, ledger } = await sendPathPayment({
      senderPublicKey: public_key,
      encryptedSecretKey: encrypted_secret_key,
      recipientPublicKey: recipient_address,
      sourceAsset: source_asset,
      sourceAmount: source_amount,
      destinationAsset: destination_asset,
      destinationMinAmount: destination_min_amount,
      path,
      memo: memoStr,
    }, req.logger);

    await db.query(
      `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status, request_id, is_encrypted, encrypted_memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'confirming',$8,$9,$10)`,
      [txId, public_key, recipient_address, source_amount, source_asset, memoStr || null, transactionHash, req.requestId, is_encrypted, encrypted_memo],
    );

    // Start async confirmation polling (non-blocking)
    pollTransactionConfirmation(txId, transactionHash).catch(() => {});

    const txData = { id: txId, tx_hash: transactionHash, ledger, source_amount, source_asset, destination_asset, sender: public_key, recipient: recipient_address };
    webhook.deliver("payment.sent", txData).catch(() => {});
    webhook.deliver("payment.received", txData).catch(() => {});

    res.json({
      message: "Path payment sent successfully",
      transaction: { id: txId, tx_hash: transactionHash, ledger, source_amount, source_asset, destination_asset, recipient: recipient_address },
    });
  } catch (err) {
    if (public_key) {
      await db.query(
        `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status, request_id, is_encrypted, encrypted_memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'failed',$8,$9,$10)`,
        [txId, public_key, recipient_address || "", source_amount || "0", source_asset || "XLM", null, null, req.requestId, false, null],
      ).catch(() => {});
    }

    if (err.status === 400 || err.status === 500) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.response?.data) {
      return res.status(400).json({ error: "Path payment failed", details: err.response.data?.extras });
    }
    next(err);
  }
}

/**
 * POST /api/payments/find-receive-path
 * Body: { source_asset, destination_asset, destination_amount, recipient_address }
 * Returns the best conversion path and estimated source amount needed.
 */
async function findReceivePathHandler(req, res, next) {
  try {
    const { source_asset, destination_asset, destination_amount, recipient_address } = req.body;
    const result = await findReceivePath(source_asset, destination_asset, destination_amount, recipient_address);
    if (!result) {
      return res.status(404).json({ error: "No conversion path found between these assets" });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/payments/send-strict-receive
 * Executes a strict-receive path payment (recipient gets exact amount).
 * Body: { recipient_address, source_asset, source_max_amount, destination_asset,
 *         destination_amount, path, memo }
 */
async function sendStrictReceivePath(req, res, next) {
  const txId = uuidv4();
  let public_key, recipient_address, source_max_amount, source_asset;
  try {
    ({
      recipient_address,
      source_asset = "XLM",
      source_max_amount,
      destination_asset,
      destination_amount,
      path = [],
      memo,
      encrypt_memo = false,
    } = req.body);

    let memoStr = typeof memo === "string" ? memo.trim() : "";
    let is_encrypted = false;
    let encrypted_memo = null;

    if (encrypt_memo && memoStr) {
      const { encryptMemo } = require('../utils/encryption');
      encrypted_memo = encryptMemo(memoStr, recipient_address);
      memoStr = encrypted_memo;
      is_encrypted = true;
    }

    const estimatedUSD = estimateUSDValue(source_max_amount, source_asset);
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
          error: `KYC verification required for transactions above ${KYC_THRESHOLD_USD} USD equivalent.`,
          kyc_status: kycStatus,
          code: "KYC_REQUIRED",
        });
      }
    }

    const { wallet_id: sendWalletId } = req.body;
    const walletQuery = sendWalletId
      ? { text: "SELECT public_key, encrypted_secret_key FROM wallets WHERE id = $1 AND user_id = $2", values: [sendWalletId, req.user.userId] }
      : { text: "SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1", values: [req.user.userId] };
    const walletResult = await db.query(walletQuery.text, walletQuery.values);
    if (!walletResult.rows[0]) return res.status(404).json({ error: "Wallet not found" });

    ({ public_key } = walletResult.rows[0]);
    const { encrypted_secret_key } = walletResult.rows[0];

    if (recipient_address === public_key) {
      return res.status(400).json({ error: "Cannot send payment to your own wallet" });
    }

    const fraudCheck = await checkFraud(public_key, source_max_amount, source_asset);
    if (fraudCheck.blocked) {
      await logFraudBlock(public_key, fraudCheck.reason, source_max_amount, source_asset);
      return res.status(429).json({ error: fraudCheck.reason });
    }

    const { transactionHash, ledger } = await sendStrictReceivePathPayment({
      senderPublicKey: public_key,
      encryptedSecretKey: encrypted_secret_key,
      recipientPublicKey: recipient_address,
      sourceAsset: source_asset,
      sourceMaxAmount: source_max_amount,
      destinationAsset: destination_asset,
      destinationAmount: destination_amount,
      path,
      memo: memoStr,
    });

    // Insert with 'confirming' status initially
    await db.query(
      `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status, request_id, is_encrypted, encrypted_memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'confirming',$8,$9,$10)`,
      [txId, public_key, recipient_address, destination_amount, destination_asset, memoStr || null, transactionHash, req.requestId, is_encrypted, encrypted_memo],
    );

    // Start async confirmation polling (non-blocking)
    pollTransactionConfirmation(txId, transactionHash).catch(() => {});

    const txData = { id: txId, tx_hash: transactionHash, ledger, destination_amount, destination_asset, sender: public_key, recipient: recipient_address };
    webhook.deliver("payment.sent", txData).catch(() => {});
    webhook.deliver("payment.received", txData).catch(() => {});

    res.json({
      message: "Strict receive path payment sent successfully",
      transaction: { id: txId, tx_hash: transactionHash, ledger, destination_amount, destination_asset, recipient: recipient_address, status: 'confirming' },
    });
  } catch (err) {
    if (public_key) {
      await db.query(
        `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status, request_id, is_encrypted, encrypted_memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'failed',$8,$9,$10)`,
        [txId, public_key, recipient_address || "", "0", source_asset || "XLM", null, null, req.requestId, false, null],
      ).catch(() => {});
    }

    if (err.status === 400 || err.status === 500) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.response?.data) {
      return res.status(400).json({ error: "Strict receive path payment failed", details: err.response.data?.extras });
    }
    next(err);
  }
}

/**
 * Poll Horizon for transaction confirmation and update DB when confirmed.
 * Runs asynchronously in the background.
 */
async function pollTransactionConfirmation(txId, txHash) {
  const StellarSdk = require('@stellar/stellar-sdk');
  const server = new StellarSdk.Horizon.Server(process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org');
  const maxAttempts = 10;
  const pollInterval = 2000; // 2 seconds

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const tx = await server.transactions().transaction(txHash).call();
      if (tx.successful) {
        await db.query(
          `UPDATE transactions SET status = 'completed', confirmed_at = NOW() WHERE id = $1`,
          [txId]
        );
        return;
      } else {
        await db.query(
          `UPDATE transactions SET status = 'failed', confirmed_at = NOW() WHERE id = $1`,
          [txId]
        );
        return;
      }
    } catch (err) {
      if (err.response?.status === 404) {
        // Transaction not yet in ledger, wait and retry
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }
      // Other error — mark as failed
      await db.query(
        `UPDATE transactions SET status = 'failed', confirmed_at = NOW() WHERE id = $1`,
        [txId]
      );
      return;
    }
  }

  // Timeout — mark as failed
  await db.query(
    `UPDATE transactions SET status = 'failed', confirmed_at = NOW() WHERE id = $1`,
    [txId]
  );
}

async function exportCSV(req, res, next) {
  try {
    const walletResult = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1",
      [req.user.userId],
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: "Wallet not found" });

    const { public_key } = walletResult.rows[0];

    // Validate status parameter against allowed enum values
    const ALLOWED_STATUSES = ['pending', 'completed', 'cancelled', 'failed'];
    if (req.query.status && !ALLOWED_STATUSES.includes(req.query.status)) {
      return res.status(400).json({ 
        error: `Invalid status value. Must be one of: ${ALLOWED_STATUSES.join(', ')}` 
      });
    }

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
    // Direction filter: uses the public_key ($1) parameter to filter sender_wallet or recipient_wallet.
    // This maintains the existing parameterization without reusing or conflicting with other $N parameters.
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

module.exports = { send, sendBatch, history, findPath, sendPath, exportCSV, estimateFee, getFeeStats };
module.exports = { send, sendBatch, history, findPath, sendPath, exportCSV, estimateFee, findReceivePathHandler, sendStrictReceivePath };
