const { v4: uuidv4 } = require("uuid");
const { stringify: stringifySync } = require("csv-stringify/sync");
const { stringify: stringifyStream } = require("csv-stringify");
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
  getAssetContractAddress,
} = require("../services/stellar");
const webhook = require("../services/webhook");
const cache = require("../utils/cache");
const { sendTransactionEmail, enqueueEmail } = require("../services/email");
const { persistAndBroadcast } = require("../services/notificationInbox");
const { checkVelocity, checkDailyLimit, checkFraud, logFraudBlock } = require("../services/fraudDetection");
const { withLock } = require("../utils/distributedLock");
const { parseHistoryFrom, parseHistoryTo, normalizeAsset, validateDateRange } = require("../utils/historyQuery");
const { isMemoRequired } = require("../services/memoRequired");
const { awardReferralCredit } = require("./referralController");
const { enqueueMint } = require("../services/loyaltyMintQueue");
const { creditReferralReward } = require("../services/referralRewardService");
const { depositFee } = require("../services/feeDistributor");
const { getActiveConfig } = require("../services/feeConfigService");
const logger = require("../utils/logger");
const { cancelEscrow } = require("../services/agentEscrow");
const audit = require("../services/audit");
const { amlRescreenForPayment } = require("./kycController");

const KYC_THRESHOLD_USD = parseFloat(process.env.KYC_THRESHOLD_USD || "100");

const FALLBACK_PLATFORM_FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || "250", 10);

/**
 * Build the structured fee breakdown for a payment.
 * @param {string|number} grossAmount  - Amount the sender sent
 * @param {string}        asset        - e.g. "USDC" or "XLM"
 * @param {string|null}   feeCharged   - Stellar fee_charged in stroops (from Horizon result)
 */
async function buildFeeBreakdown(grossAmount, asset, feeCharged) {
  const gross = parseFloat(grossAmount);
  let feeBps = FALLBACK_PLATFORM_FEE_BPS;
  try {
    const cfg = await getActiveConfig('platform', asset);
    if (cfg) feeBps = cfg.fee_bps;
  } catch (_) {
    // fall back to env var if cache/DB is unavailable
  }
  const platformFee = parseFloat((gross * feeBps / 10000).toFixed(7));
  const stellarBaseFeeXlm = feeCharged != null
    ? parseFloat((parseInt(feeCharged, 10) / 1e7).toFixed(7))
    : null;
  const netAmount = parseFloat((gross - platformFee).toFixed(7));

  return {
    gross_amount_usdc: parseFloat(gross.toFixed(7)),
    platform_fee_bps: feeBps,
    platform_fee_usdc: platformFee,
    stellar_base_fee_xlm: stellarBaseFeeXlm,
    net_amount_usdc: parseFloat(netAmount.toFixed(7)),
    asset,
  };
}

// Approximate XLM/USD rate  in production replace with a live price feed
const XLM_USD_RATE = parseFloat(process.env.XLM_USD_RATE || "0.11");

// Daily send limit per user
const DAILY_SEND_LIMIT = parseFloat(process.env.DAILY_SEND_LIMIT || "50000");

// Threshold for phone verification check
const PHONE_VERIFICATION_THRESHOLD_USD = parseFloat(process.env.PHONE_VERIFICATION_THRESHOLD_USD || "100");

const horizonUrl = process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org";
const horizonServer = new StellarSdk.Horizon.Server(horizonUrl);

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
  
  // For any asset not explicitly supported, use a conservative 1:1 USD estimate
  // to ensure KYC/AML/phone verification thresholds are enforced (issue #1148).
  // In production, integrate a live price feed for NGN, GHS, KES, etc.
  logger.warn('estimateUSDValue: unsupported asset, using 1:1 fallback', { asset, amount });
  return parseFloat(amount);
}

async function dailyLimitExceeded(walletAddress, amount, asset) {
  const result = await db.query(
    `SELECT amount, asset
     FROM transactions
     WHERE sender_wallet = $1
       AND status != 'failed'
       AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
    [walletAddress],
  );
  // Older test doubles may still return the former aggregate shape.
  const hasAssetRows = result.rows.some((row) => row.amount !== undefined);
  if (!hasAssetRows) {
    // Compatibility path for an older aggregate response; the old query
    // already represented the configured limit's units.
    return parseFloat(result.rows[0]?.total || 0) + parseFloat(amount) > DAILY_SEND_LIMIT;
  }
  const totalToday = result.rows.reduce((total, row) => total + estimateUSDValue(row.amount, row.asset), 0);
  return totalToday + estimateUSDValue(amount, asset) > DAILY_SEND_LIMIT;
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
  if (estimatedUSD < KYC_THRESHOLD_USD) return null;

  const kycResult = await db.query("SELECT kyc_status FROM users WHERE id = $1", [userId]);
  const kycStatus = kycResult.rows[0]?.kyc_status || "unverified";
  if (kycStatus === "expired") {
    const err = new Error("Your identity document has expired. Please re-verify to continue.");
    err.status = 403;
    err.payload = { kyc_status: kycStatus, code: "KYC_EXPIRED" };
    throw err;
  }
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
    "SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1",
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

/**
 * GET /api/payments/estimate-fees?amount=100&asset=USDC
 * Queries fee rate from fee-distributor contract via Horizon simulate (read-only).
 * Falls back to Redis cache, then PLATFORM_FEE_BPS env var.
 */
async function estimateFees(req, res, next) {
  try {
    const { amount, asset = "USDC" } = req.query;
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }
    const VALID = ["XLM", "USDC", "NGN", "GHS", "KES"];
    if (!VALID.includes(asset)) {
      return res.status(400).json({ error: `asset must be one of: ${VALID.join(", ")}` });
    }

    const CACHE_KEY = 'fee_rate_bps_onchain';
    const CACHE_TTL = 60; // 60-second TTL per issue #765
    let feeBps = null;
    let feeRateSource = 'on-chain';
    let lastFetchedAt = new Date().toISOString();

    // 1. Try on-chain via Horizon simulate
    try {
      const contractId = process.env.FEE_DISTRIBUTOR_CONTRACT_ID;
      if (contractId) {
        const axios = require('axios');
        const horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
        const { data } = await axios.post(`${horizonUrl}/simulate_transaction`, {
          contract_id: contractId,
          function_name: 'get_fee_rate',
          args: [],
        }, { timeout: 5000 });
        const onChainBps = data?.result ?? data?.return_value;
        if (onChainBps != null) {
          feeBps = parseInt(onChainBps, 10);
          await cache.set(CACHE_KEY, feeBps, CACHE_TTL);
          lastFetchedAt = new Date().toISOString();
        }
      }
    } catch (_) {
      feeRateSource = 'cached';
    }

    // 2. Fall back to Redis cache
    if (feeBps == null) {
      const cached = await cache.get(CACHE_KEY);
      if (cached != null) {
        feeBps = parseInt(cached, 10);
        feeRateSource = 'cached';
      }
    }

    // 3. Fall back to env var
    if (feeBps == null) {
      feeBps = FALLBACK_PLATFORM_FEE_BPS;
      feeRateSource = 'config_fallback';
      logger.warn('Fee rate falling back to PLATFORM_FEE_BPS env var', { feeBps });
    }

    let stellarFeeStroops = null;
    try { stellarFeeStroops = await fetchFee(); } catch (_) { /* non-fatal */ }
    const breakdown = await buildFeeBreakdown(amount, asset, stellarFeeStroops);
    // Override fee_bps with the on-chain/cached value
    breakdown.platform_fee_bps = feeBps;
    breakdown.platform_fee_usdc = parseFloat((parseFloat(amount) * feeBps / 10000).toFixed(7));
    breakdown.net_amount_usdc = parseFloat((parseFloat(amount) - breakdown.platform_fee_usdc).toFixed(7));

    res.json({
      fee_breakdown: breakdown,
      fee_rate_bps: feeBps,
      fee_rate_source: feeRateSource,
      last_fetched_at: lastFetchedAt,
    });
  } catch (err) {
    next(err);
  }
}

async function getFeeRate(req, res, next) {
  try {
    let feeBps = FALLBACK_PLATFORM_FEE_BPS;
    const asset = req.query.asset || 'USDC';
    try {
      const cfg = await getActiveConfig('platform', asset);
      if (cfg) feeBps = cfg.fee_bps;
    } catch (_) {
      // fall back to env var
    }
    res.json({ fee_bps: feeBps });
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
  // declare these in outer scope so the catch block can reference them safely
  let public_key, encrypted_secret_key, recipient_address, amount, asset, memo, memo_type;

  try {
    ({
      recipient_address,
      amount,
      asset = "XLM",
      memo: rawMemo,
      memo_type: rawMemoType,
      encrypt_memo = false,
      fee_priority = "standard",
    } = req.body);

    memo = typeof rawMemo === "string" ? rawMemo.trim() : "";
    memo_type = memo ? (rawMemoType || "text") : null;

    await ensureKycIfNeeded(req.user.userId, amount, asset);

    const estimatedUSD = estimateUSDValue(amount, asset);

    if (estimatedUSD >= PHONE_VERIFICATION_THRESHOLD_USD) {
      const userResult = await db.query(
        "SELECT kyc_status, phone_verified FROM users WHERE id = $1",
        [req.user.userId],
      );
      const { kyc_status: kycStatus, phone_verified: phoneVerified } = userResult.rows[0] || {};

      if (!phoneVerified) {
        return res.status(403).json({
          error: "Phone verification required for transactions above $" + PHONE_VERIFICATION_THRESHOLD_USD + " USD equivalent.",
          phone_verified: false,
          code: "PHONE_VERIFICATION_REQUIRED",
        });
      }

      if (estimatedUSD >= KYC_THRESHOLD_USD) {
        if (kycStatus === "expired") {
          webhook.deliver("payment.failed", req.user.userId, { code: "KYC_EXPIRED", error: "Your identity document has expired. Please re-verify to continue." }).catch(() => {});
          return res.status(403).json({
            error: "Your identity document has expired. Please re-verify to continue.",
            kyc_status: kycStatus,
            code: "KYC_EXPIRED",
          });
        }
        if (kycStatus !== "verified") {
          webhook.deliver("payment.failed", req.user.userId, { code: "KYC_REQUIRED", error: "KYC verification required for transactions above $" + KYC_THRESHOLD_USD + " USD equivalent." }).catch(() => {});
          return res.status(403).json({
            error: "KYC verification required for transactions above $" + KYC_THRESHOLD_USD + " USD equivalent.",
            kyc_status: kycStatus,
            code: "KYC_REQUIRED",
          });
        }
      }
    }

    let is_encrypted = false;
    let encrypted_memo = null;
    if (encrypt_memo && memo) {
      // Issue #1163: Encrypted memos are base64-encoded and typically exceed
      // the 28-byte text memo limit. For now, reject encrypted memos that are
      // too long with a clear error. Future: store encrypted data off-chain or
      // use memo_type=hash with a content-addressed reference.
      const { encryptMemo } = require("../utils/encryption");
      encrypted_memo = encryptMemo(memo, recipient_address);
      const encryptedBytes = Buffer.byteLength(encrypted_memo, 'utf8');
      if (encryptedBytes > 28) {
        return res.status(400).json({
          error: `Encrypted memo is too long (${encryptedBytes} bytes). Stellar text memos are limited to 28 bytes. ` +
                 `Use a shorter memo or disable encryption.`
        });
      }
      memo = encrypted_memo;
      is_encrypted = true;
    }

    const { wallet_id: sendWalletId } = req.body;
    const walletQuery = sendWalletId
      ? { text: "SELECT public_key, encrypted_secret_key FROM wallets WHERE id = $1 AND user_id = $2", values: [sendWalletId, req.user.userId] }
      : { text: "SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1", values: [req.user.userId] };
    const walletResult = await db.query(walletQuery.text, walletQuery.values);
    if (!walletResult.rows[0]) return res.status(404).json({ error: "Wallet not found" });

    ({ public_key, encrypted_secret_key } = walletResult.rows[0]);

    if (recipient_address === public_key) {
      return res.status(400).json({ error: "Cannot send payment to your own wallet" });
    }

    // AML re-screen for high-value payments — fail closed when screening is unavailable
    await amlRescreenForPayment(req.user.userId, public_key, estimatedUSD);

    // Use a per-wallet distributed lock to prevent concurrent sends from
    // racing past the daily-limit check (issue #888).
    const lockKey = `daily_limit:${public_key}`;
    let txResult;
    const lockAcquired = await withLock(lockKey, 10, async () => {
      const overLimit = await dailyLimitExceeded(public_key, amount, asset);
      if (overLimit) {
        throw Object.assign(new Error(`Daily send limit of ${DAILY_SEND_LIMIT} reached. Try again tomorrow.`), {
          status: 400, payload: { code: "DAILY_LIMIT_EXCEEDED" },
        });
      }

      // Fraud protection — velocity and daily limit (single authoritative check)
      const [isSuspicious, limitExceeded] = await Promise.all([
        checkVelocity(public_key),
        checkDailyLimit(public_key, amount, asset),
      ]);
      if (isSuspicious) {
        throw Object.assign(new Error("Transaction limit reached. Please wait before sending again."), { status: 429 });
      }
      const fraudCheck = await checkFraud(public_key, amount, asset);
      if (fraudCheck.blocked) {
        await logFraudBlock(public_key, fraudCheck.reason, amount, asset);
        throw Object.assign(new Error(fraudCheck.reason), { status: 429 });
      }

      if (await isMemoRequired(recipient_address) && !memo) {
        throw Object.assign(new Error("This address requires a memo to route your payment correctly. Please include a memo."), {
          status: 422, payload: { code: "MEMO_REQUIRED" },
        });
      }
      if (limitExceeded) {
        throw Object.assign(new Error("Daily send limit reached. Try again later."), {
          status: 429, payload: { code: "DAILY_LIMIT_EXCEEDED" },
        });
      }

      // Balance check — fail fast with a clear message before hitting Stellar
      await checkSufficientBalance(public_key, amount, asset);

      // Calculate fee before sending payment
      const fee_breakdown = await buildFeeBreakdown(amount, asset, null); // We'll update with actual stellar fee later
      const netAmount = fee_breakdown.net_amount_usdc;
      const platformFeeAmount = fee_breakdown.platform_fee_usdc;

      // Broadcast to Stellar - send net amount to recipient
      const { transactionHash, ledger, type, claimableBalanceId, feeCharged } = await sendPayment({
        senderPublicKey: public_key,
        encryptedSecretKey: encrypted_secret_key,
        recipientPublicKey: recipient_address,
        amount: netAmount.toString(), // Send net amount, not gross amount
        asset,
        memo: memo || undefined,
        memoType: memo ? memo_type : undefined,
        feePriority: fee_priority,
      }, req.logger);

      const ledger_close_time = await fetchLedgerCloseTime(ledger);

      // Update fee breakdown with actual stellar fee
      const updated_fee_breakdown = await buildFeeBreakdown(amount, asset, feeCharged ?? null);

      // Save to DB
      const txStatus = type === "claimable_balance" ? "pending_claim" : "confirming";
      await db.query(
        `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, memo_type, tx_hash, status, claimable_balance_id, request_id, is_encrypted, encrypted_memo, ledger_close_time, fee_breakdown)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [txId, public_key, recipient_address, amount, asset, memo || null, memo_type, transactionHash, txStatus, claimableBalanceId || null, req.requestId, is_encrypted, encrypted_memo, ledger_close_time, JSON.stringify(updated_fee_breakdown)],
      );

      txResult = { transactionHash, ledger, type, claimableBalanceId, fee_breakdown: updated_fee_breakdown, txStatus };
    });

    if (!lockAcquired) {
      // Lock was held by another request — treat as rate-limited
      return res.status(429).json({
        error: "Too many concurrent payment requests. Please try again.",
        code: "CONCURRENCY_LIMIT",
      });
    }

    if (txResult.type !== "claimable_balance") {
      pollTransactionConfirmation(txId, txResult.transactionHash).catch(() => {});
    }

    await cache.del(`balance:${public_key}`);

    const txCount = await db.query(
      `SELECT COUNT(*) AS cnt FROM transactions WHERE sender_wallet = $1`,
      [public_key],
    );
    if (parseInt(txCount.rows[0].cnt, 10) === 1) {
      creditReferralReward(req.user.userId, txId).catch(() => {});
    }

    enqueueMint({ transactionId: txId, userId: req.user.userId, walletAddress: public_key, amount, asset }).catch((err) => {
      logger.error('Failed to enqueue loyalty mint', { userId: req.user.userId, error: err.message });
    });

    if (asset === "USDC" && txResult.fee_breakdown.platform_fee_bps > 0) {
      const feeStroops = Math.floor(txResult.fee_breakdown.platform_fee_usdc * 1e7);
      if (feeStroops > 0) {
        const usdcContractAddress = getAssetContractAddress("USDC");
        depositFee(feeStroops, usdcContractAddress, public_key).catch((err) =>
          logger.error("Fee deposit failed:", { error: err.message, feeStroops, usdcContractAddress }),
        );
      }
    }

    const txData = { id: txId, tx_hash: txResult.transactionHash, ledger: txResult.ledger, amount, asset, sender: public_key, recipient: recipient_address, type: txResult.type };
    webhook.deliver("payment.sent", req.user.userId, txData).catch(() => {});
    if (txResult.type !== "claimable_balance") {
      webhook.deliver("payment.received", req.user.userId, txData).catch(() => {});
    }

    // Fire-and-forget email notifications
    const emailTxData = { amount, asset, senderAddress: public_key, recipientAddress: recipient_address, memo: memo || null, txHash: txResult.transactionHash };
    db.query("SELECT email FROM users WHERE id = $1", [req.user.userId])
      .then(({ rows }) => rows[0] && sendTransactionEmail(rows[0].email, "sent", emailTxData))
      .catch(() => {});
    db.query(
      "SELECT u.email FROM users u JOIN wallets w ON w.user_id = u.id WHERE w.public_key = $1 LIMIT 1",
      [recipient_address],
    )
      .then(({ rows }) => rows[0] && sendTransactionEmail(rows[0].email, "received", emailTxData))
      .catch(() => {});

    // Persist in-app notifications
    persistAndBroadcast(req.user.userId, 'payment_sent', 'Payment Sent',
      `You sent ${amount} ${asset} to ${recipient_address}`,
      emailTxData
    ).catch(() => {});

    db.query(
      "SELECT u.id AS user_id FROM users u JOIN wallets w ON w.user_id = u.id WHERE w.public_key = $1 LIMIT 1",
      [recipient_address],
    ).then(({ rows }) => {
      if (rows[0]) {
        persistAndBroadcast(rows[0].user_id, 'payment_received', 'Payment Received',
          `You received ${amount} ${asset}`,
          emailTxData
        ).catch(() => {});
      }
    }).catch(() => {});

    res.json({
      message: txResult.type === "claimable_balance" ? "Claimable balance created" : "Payment sent successfully",
      transaction: {
        id: txId,
        tx_hash: txResult.transactionHash,
        ledger: txResult.ledger,
        amount,
        asset,
        recipient: recipient_address,
        type: txResult.type,
        claimableBalanceId: txResult.claimableBalanceId,
        fee_breakdown: txResult.fee_breakdown,
      },
    });
  } catch (err) {
    // Do not persist a failed transaction here; let caller decide and avoid
    // creating records when Stellar submission fails during business logic.
    if (err.status === 400 || err.status === 500) {
      webhook.deliver('payment.failed', req.user.userId, { error: err.message }).catch(() => {});
      return res.status(err.status).json({ error: err.message });
    }
    // Issue #243: Insert a failed transaction record when sendPayment throws
    // and the sender wallet is known, to maintain a full audit trail.
    if (public_key) {
      await db.query(
        `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, tx_hash, status)
         VALUES ($1,$2,$3,$4,$5,$6,'failed')`,
        [txId, public_key, recipient_address || "", amount || "0", asset || "XLM", null],
      ).catch(() => {});
    }

    if (err.status) {
      const failedPayload = { error: err.message };
      if (err.payload?.code) failedPayload.code = err.payload.code;
      webhook.deliver("payment.failed", req.user.userId, failedPayload).catch(() => {});
      return res.status(err.status).json({ error: err.message, ...(err.payload || {}) });
    }
    if (err.response?.data) {
      const extras = err.response.data?.extras;
      webhook.deliver("payment.failed", req.user.userId, { error: "Transaction failed", details: extras }).catch(() => {});
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

    const totalAmount = recipients.reduce((sum, r) => sum + parseFloat(r.amount), 0);

    await ensureKycIfNeeded(req.user.userId, totalAmount, asset);

    const wallet = await getWalletForUser(req.user.userId);
    if (!wallet) return res.status(404).json({ error: "Wallet not found" });

    ({ public_key } = wallet);
    const { encrypted_secret_key } = wallet;

    // AML re-screen for high-value batches — fail closed when screening is unavailable
    await amlRescreenForPayment(req.user.userId, public_key, estimateUSDValue(totalAmount, asset));

    const overLimit = await dailyLimitExceeded(public_key, totalAmount, asset);
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
        results.push({ index, recipient_address: recipientAddress, amount, status: "failed", error: "Cannot send payment to your own wallet" });
        continue;
      }

      if (await isMemoRequired(recipientAddress) && !memo) {
        results.push({ index, recipient_address: recipientAddress, amount, status: "failed", error: "This address requires a memo.", code: "MEMO_REQUIRED" });
        continue;
      }

      try {
        await validateBatchRecipient({ recipientPublicKey: recipientAddress, asset });
        results.push({ index, recipient_address: recipientAddress, amount, status: "pending" });
        validRecipients.push({ index, recipientPublicKey: recipientAddress, amount });
      } catch (err) {
        results.push({ index, recipient_address: recipientAddress, amount, status: "failed", error: err.message });
      }
    }

    if (validRecipients.length === 0) {
      await Promise.all(results.map((result) => insertTransactionRecord({
        sender_wallet: public_key, recipient_wallet: result.recipient_address,
        amount: result.amount, asset, memo: memo || null, memo_type, status: "failed",
      })));
      return res.status(400).json({
        message: "No valid recipients were submitted",
        summary: { total: recipients.length, submitted: 0, successful: 0, failed: results.length },
        results,
      });
    }

    try {
      const { transactionHash, ledger, operationCount } = await sendBatchPayment({
        senderPublicKey: public_key, encryptedSecretKey: encrypted_secret_key,
        recipients: validRecipients, asset, memo: memo || undefined, memoType: memo ? memo_type : undefined,
      });

      await Promise.all(results.map(async (result) => {
        const isSubmitted = result.status === "pending";
        if (isSubmitted) { result.status = "success"; result.tx_hash = transactionHash; result.ledger = ledger; }
        const txId = await insertTransactionRecord({
          sender_wallet: public_key, recipient_wallet: result.recipient_address,
          amount: result.amount, asset, memo: memo || null, memo_type,
          tx_hash: result.tx_hash || null, status: result.status === "success" ? "completed" : "failed",
        });
        result.id = txId;
        if (result.status === "success") {
          const txData = { id: txId, tx_hash: transactionHash, ledger, amount: result.amount, asset, sender: public_key, recipient: result.recipient_address, type: "payment" };
          webhook.deliver("payment.sent", req.user.userId, txData).catch(() => {});
          webhook.deliver("payment.received", req.user.userId, txData).catch(() => {});
        }
      }));

      await cache.del(`balance:${public_key}`);
      return res.json({
        message: "Batch payment submitted successfully",
        transaction: { tx_hash: transactionHash, ledger, asset, operation_count: operationCount },
        summary: { total: recipients.length, submitted: validRecipients.length, successful: validRecipients.length, failed: results.length - validRecipients.length },
        results,
      });
    } catch (err) {
      await Promise.all(results.map(async (result) => {
        if (result.status === "pending") {
          result.status = "failed";
          result.error = err.response?.data ? "Transaction failed" : err.message;
          if (err.response?.data?.extras) result.details = err.response.data.extras;
        }
        const txId = await insertTransactionRecord({
          sender_wallet: public_key, recipient_wallet: result.recipient_address,
          amount: result.amount, asset, memo: memo || null, memo_type, status: "failed",
        });
        result.id = txId;
      }));
      const statusCode = err.status || (err.response?.data ? 400 : 500);
      return res.status(statusCode).json({
        error: err.response?.data ? "Batch transaction failed" : err.message,
        details: err.response?.data?.extras,
        summary: { total: recipients.length, submitted: validRecipients.length, successful: 0, failed: results.length },
        results,
      });
    }
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.payload || {}) });
    next(err);
  }
}

async function history(req, res, next) {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
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

    // Issue #244: enforce maximum date range of 366 days
    const rangeError = validateDateRange(fromBound, toBound);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
    }

    let assetFilter = null;
    if (req.query.asset != null && String(req.query.asset).trim() !== "") {
      assetFilter = normalizeAsset(req.query.asset);
      if (!assetFilter) return res.status(400).json({ error: "Invalid asset filter" });
    }

    const walletResult = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1",
      [req.user.userId],
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: "Wallet not found" });

    const { public_key } = walletResult.rows[0];

    const direction = req.query.direction || "all";
    let directionCondition;
    if (direction === "sent") {
      directionCondition = "sender_wallet = $1";
    } else if (direction === "received") {
      directionCondition = "recipient_wallet = $1";
    } else {
      directionCondition = "(sender_wallet = $1 OR recipient_wallet = $1)";
    }

    const conditions = [directionCondition];
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

    const listSql = `SELECT id, sender_wallet, recipient_wallet, amount, asset, memo, memo_type, tx_hash, status, created_at, ledger_close_time, fee_breakdown
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

async function findPath(req, res, next) {
  try {
    const { source_asset, source_amount, destination_asset, recipient_address } = req.body;
    const result = await findPaymentPath(source_asset, source_amount, destination_asset, recipient_address);
    if (!result) return res.status(404).json({ error: "No conversion path found between these assets" });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

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
      // Issue #1163: Validate encrypted memo length
      const { encryptMemo } = require("../utils/encryption");
      encrypted_memo = encryptMemo(memoStr, recipient_address);
      const encryptedBytes = Buffer.byteLength(encrypted_memo, 'utf8');
      if (encryptedBytes > 28) {
        return res.status(400).json({
          error: `Encrypted memo is too long (${encryptedBytes} bytes). Stellar text memos are limited to 28 bytes. ` +
                 `Use a shorter memo or disable encryption.`
        });
      }
      memoStr = encrypted_memo;
      is_encrypted = true;
    }

    const estimatedUSD = estimateUSDValue(source_amount, source_asset);
    if (estimatedUSD >= PHONE_VERIFICATION_THRESHOLD_USD) {
      const userResult = await db.query("SELECT kyc_status, phone_verified FROM users WHERE id = $1", [req.user.userId]);
      const { kyc_status: kycStatus, phone_verified: phoneVerified } = userResult.rows[0] || {};
      if (!phoneVerified) {
        return res.status(403).json({ error: `Phone verification required for transactions above $${PHONE_VERIFICATION_THRESHOLD_USD} USD equivalent.`, phone_verified: false, code: "PHONE_VERIFICATION_REQUIRED" });
      }
      if (estimatedUSD >= KYC_THRESHOLD_USD) {
        if (kycStatus === "expired") {
          return res.status(403).json({ error: "Your identity document has expired. Please re-verify to continue.", kyc_status: kycStatus, code: "KYC_EXPIRED" });
        }
        if (kycStatus !== "verified") {
          return res.status(403).json({ error: `KYC verification required for transactions above $${KYC_THRESHOLD_USD} USD equivalent.`, kyc_status: kycStatus, code: "KYC_REQUIRED" });
        }
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

    if (recipient_address === public_key) return res.status(400).json({ error: "Cannot send payment to your own wallet" });

    // AML re-screen for high-value payments — fail closed when screening is unavailable
    await amlRescreenForPayment(req.user.userId, public_key, estimatedUSD);

    const fraudCheck = await checkFraud(public_key, source_amount, source_asset);
    if (fraudCheck.blocked) {
      await logFraudBlock(public_key, fraudCheck.reason, source_amount, source_asset);
      return res.status(429).json({ error: fraudCheck.reason });
    }

    // Balance check — fail fast with a clear message before hitting Stellar
    await checkSufficientBalance(public_key, source_amount, source_asset);

    const { transactionHash, ledger } = await sendPathPayment({
      senderPublicKey: public_key, encryptedSecretKey: encrypted_secret_key,
      recipientPublicKey: recipient_address, sourceAsset: source_asset, sourceAmount: source_amount,
      destinationAsset: destination_asset, destinationMinAmount: destination_min_amount, path, memo: memoStr,
    }, req.logger);

    await db.query(
      `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status, request_id, is_encrypted, encrypted_memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'confirming',$8,$9,$10)`,
      [txId, public_key, recipient_address, source_amount, source_asset, memoStr || null, transactionHash, req.requestId, is_encrypted, encrypted_memo],
    );

    pollTransactionConfirmation(txId, transactionHash).catch(() => {});

    // Invalidate sender's cached balance after successful path payment
    await cache.del(`balance:${public_key}`);

    const txData = { id: txId, tx_hash: transactionHash, ledger, source_amount, source_asset, destination_asset, sender: public_key, recipient: recipient_address };
    webhook.deliver("payment.sent", req.user.userId, txData).catch(() => {});
    webhook.deliver("payment.received", req.user.userId, txData).catch(() => {});

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
    if (err.status === 400 || err.status === 500) return res.status(err.status).json({ error: err.message });
    if (err.response?.data) return res.status(400).json({ error: "Path payment failed", details: err.response.data?.extras });
    next(err);
  }
}

async function findReceivePathHandler(req, res, next) {
  try {
    const { source_asset, destination_asset, destination_amount, recipient_address } = req.body;
    const result = await findReceivePath(source_asset, destination_asset, destination_amount, recipient_address);
    if (!result) return res.status(404).json({ error: "No conversion path found between these assets" });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function sendStrictReceivePath(req, res, next) {
  const txId = uuidv4();
  let public_key, recipient_address, source_max_amount, source_asset;
  try {
    ({
      recipient_address, source_asset = "XLM", source_max_amount,
      destination_asset, destination_amount, path = [], memo, encrypt_memo = false,
    } = req.body);

    let memoStr = typeof memo === "string" ? memo.trim() : "";
    let is_encrypted = false;
    let encrypted_memo = null;

    if (encrypt_memo && memoStr) {
      // Issue #1163: Validate encrypted memo length
      const { encryptMemo } = require("../utils/encryption");
      encrypted_memo = encryptMemo(memoStr, recipient_address);
      const encryptedBytes = Buffer.byteLength(encrypted_memo, 'utf8');
      if (encryptedBytes > 28) {
        return res.status(400).json({
          error: `Encrypted memo is too long (${encryptedBytes} bytes). Stellar text memos are limited to 28 bytes. ` +
                 `Use a shorter memo or disable encryption.`
        });
      }
      memoStr = encrypted_memo;
      is_encrypted = true;
    }

    const estimatedUSD = estimateUSDValue(source_max_amount, source_asset);
    if (estimatedUSD >= PHONE_VERIFICATION_THRESHOLD_USD) {
      const userResult = await db.query("SELECT kyc_status, phone_verified FROM users WHERE id = $1", [req.user.userId]);
      const { kyc_status: kycStatus, phone_verified: phoneVerified } = userResult.rows[0] || {};
      if (!phoneVerified) {
        return res.status(403).json({ error: `Phone verification required for transactions above $${PHONE_VERIFICATION_THRESHOLD_USD} USD equivalent.`, phone_verified: false, code: "PHONE_VERIFICATION_REQUIRED" });
      }
      if (estimatedUSD >= KYC_THRESHOLD_USD) {
        if (kycStatus === "expired") {
          return res.status(403).json({ error: "Your identity document has expired. Please re-verify to continue.", kyc_status: kycStatus, code: "KYC_EXPIRED" });
        }
        if (kycStatus !== "verified") {
          return res.status(403).json({ error: `KYC verification required for transactions above ${KYC_THRESHOLD_USD} USD equivalent.`, kyc_status: kycStatus, code: "KYC_REQUIRED" });
        }
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

    if (recipient_address === public_key) return res.status(400).json({ error: "Cannot send payment to your own wallet" });

    // AML re-screen for high-value payments — fail closed when screening is unavailable
    await amlRescreenForPayment(req.user.userId, public_key, estimatedUSD);

    const fraudCheck = await checkFraud(public_key, source_max_amount, source_asset);
    if (fraudCheck.blocked) {
      await logFraudBlock(public_key, fraudCheck.reason, source_max_amount, source_asset);
      return res.status(429).json({ error: fraudCheck.reason });
    }

    const { transactionHash, ledger } = await sendStrictReceivePathPayment({
      senderPublicKey: public_key, encryptedSecretKey: encrypted_secret_key,
      recipientPublicKey: recipient_address, sourceAsset: source_asset, sourceMaxAmount: source_max_amount,
      destinationAsset: destination_asset, destinationAmount: destination_amount, path, memo: memoStr,
    });

    await db.query(
      `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status, request_id, is_encrypted, encrypted_memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'confirming',$8,$9,$10)`,
      [txId, public_key, recipient_address, destination_amount, destination_asset, memoStr || null, transactionHash, req.requestId, is_encrypted, encrypted_memo],
    );

    pollTransactionConfirmation(txId, transactionHash).catch(() => {});

    const txData = { id: txId, tx_hash: transactionHash, ledger, destination_amount, destination_asset, sender: public_key, recipient: recipient_address };
    webhook.deliver("payment.sent", req.user.userId, txData).catch(() => {});
    webhook.deliver("payment.received", req.user.userId, txData).catch(() => {});

    res.json({
      message: "Strict receive path payment sent successfully",
      transaction: { id: txId, tx_hash: transactionHash, ledger, destination_amount, destination_asset, recipient: recipient_address, status: "confirming" },
    });
  } catch (err) {
    if (public_key) {
      await db.query(
        `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status, request_id, is_encrypted, encrypted_memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'failed',$8,$9,$10)`,
        [txId, public_key, recipient_address || "", "0", source_asset || "XLM", null, null, req.requestId, false, null],
      ).catch(() => {});
    }
    if (err.status === 400 || err.status === 500) return res.status(err.status).json({ error: err.message });
    if (err.response?.data) return res.status(400).json({ error: "Strict receive path payment failed", details: err.response.data?.extras });
    next(err);
  }
}

async function pollTransactionConfirmation(txId, txHash) {
  const StellarSdk = require("@stellar/stellar-sdk");
  const pollServer = new StellarSdk.Horizon.Server(process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org");
  const maxAttempts = 10;
  const pollInterval = 2000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const tx = await pollServer.transactions().transaction(txHash).call();
      if (tx.successful) {
        await db.query(`UPDATE transactions SET status = 'completed', confirmed_at = NOW() WHERE id = $1`, [txId]);
        return;
      } else {
        await db.query(`UPDATE transactions SET status = 'failed', confirmed_at = NOW() WHERE id = $1`, [txId]);
        return;
      }
    } catch (err) {
      if (err.response?.status === 404) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        continue;
      }
      await db.query(`UPDATE transactions SET status = 'failed', confirmed_at = NOW() WHERE id = $1`, [txId]);
      return;
    }
  }
  await db.query(`UPDATE transactions SET status = 'failed', confirmed_at = NOW() WHERE id = $1`, [txId]);
}

const EXPORT_ROW_LIMIT = parseInt(process.env.EXPORT_ROW_LIMIT || "1000000", 10);
const EXPORT_BATCH_SIZE = 500;

async function exportCSV(req, res, next) {
  let client;
  try {
    const walletResult = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1",
      [req.user.userId],
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: "Wallet not found" });

    const { public_key } = walletResult.rows[0];

    const ALLOWED_STATUSES = ["pending", "completed", "cancelled", "failed"];
    if (req.query.status && !ALLOWED_STATUSES.includes(req.query.status)) {
      return res.status(400).json({ error: `Invalid status value. Must be one of: ${ALLOWED_STATUSES.join(", ")}` });
    }

    const sanitize = (s) => s.replace(/[^0-9a-zA-Z_\-]/g, "");
    let filename;
    if (req.query.from || req.query.to) {
      const from = sanitize((req.query.from || "").slice(0, 10));
      const to = sanitize((req.query.to || "").slice(0, 10));
      filename = `transactions_${from}_to_${to}.csv`;
    } else {
      const today = new Date().toISOString().slice(0, 10);
      filename = `transactions_exported_${today}.csv`;
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const stringifier = stringifyStream({
      header: true,
      columns: ["date", "direction", "amount", "asset", "recipient_or_sender", "memo", "tx_hash", "status"],
    });
    stringifier.pipe(res);

    client = await db.pool.connect();
    const cursorName = `export_cursor_${Date.now()}`;

    const params = [public_key];
    let filters = "";
    if (req.query.from)      { params.push(req.query.from);   filters += ` AND created_at >= $${params.length}`; }
    if (req.query.to)        { params.push(req.query.to);     filters += ` AND created_at <= $${params.length}`; }
    if (req.query.status)    { params.push(req.query.status); filters += ` AND status = $${params.length}`; }
    if (req.query.direction === "sent")     filters += " AND sender_wallet = $1";
    else if (req.query.direction === "received") filters += " AND recipient_wallet = $1";

    await client.query("BEGIN");
    await client.query(
      `DECLARE ${cursorName} CURSOR FOR
       SELECT created_at, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status
       FROM transactions
       WHERE (sender_wallet = $1 OR recipient_wallet = $1)${filters}
       ORDER BY created_at DESC
       LIMIT ${EXPORT_ROW_LIMIT}`,
      params,
    );

    while (true) {
      const batch = await client.query(`FETCH ${EXPORT_BATCH_SIZE} FROM ${cursorName}`);
      if (batch.rows.length === 0) break;
      for (const tx of batch.rows) {
        const ok = stringifier.write({
          date: new Date(tx.created_at).toISOString(),
          direction: tx.sender_wallet === public_key ? "sent" : "received",
          amount: tx.amount,
          asset: tx.asset,
          recipient_or_sender: tx.sender_wallet === public_key ? tx.recipient_wallet : tx.sender_wallet,
          memo: tx.memo || "",
          tx_hash: tx.tx_hash || "",
          status: tx.status,
        });
        if (!ok) await new Promise((resolve) => stringifier.once("drain", resolve));
      }
    }

    await client.query(`CLOSE ${cursorName}`);
    await client.query("COMMIT");
  } catch (err) {
    logger.error("CSV export cursor error", { error: err.message });
    try { if (client) await client.query("ROLLBACK"); } catch (_) {}
    // Append error sentinel row if headers already sent, otherwise pass to next()
    if (res.headersSent) {
      try {
        // stringifier may already be ended; ignore errors
        res.write('\n"' + new Date().toISOString() + '","ERROR","","","","ERROR: Export interrupted. Please retry.","","error"\n');
        res.end();
      } catch (_) {}
    } else {
      next(err);
    }
  } finally {
    if (client) { client.release(); }
  }
}

/**
 * GET /api/payments/:id
 * Returns a single payment record for the authenticated user, including fee_breakdown.
 */
async function getPaymentById(req, res, next) {
  try {
    const walletResult = await db.query(
      "SELECT public_key FROM wallets WHERE user_id = $1",
      [req.user.userId],
    );
    const publicKeys = walletResult.rows.map((r) => r.public_key);
    if (publicKeys.length === 0) return res.status(404).json({ error: "Wallet not found" });

    const result = await db.query(
      `SELECT id, sender_wallet, recipient_wallet, amount, asset, memo, memo_type,
              tx_hash, status, created_at, ledger_close_time, fee_breakdown
       FROM transactions
       WHERE id = $1 AND (sender_wallet = ANY($2) OR recipient_wallet = ANY($2))`,
      [req.params.id, publicKeys],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Payment not found" });

    const tx = result.rows[0];
    res.json({
      ...tx,
      direction: publicKeys.includes(tx.sender_wallet) ? "sent" : "received",
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/payments/:id/cancel
 *
 * Cancel a pending escrow payment and trigger the on-chain Soroban cancel_escrow
 * function to release funds back to the sender.
 *
 * Acceptance criteria:
 *  - status must be 'pending' and expires_at < NOW() (48-hour lock elapsed).
 *  - Returns 403 CANCEL_TOO_EARLY if the window has not elapsed.
 *  - Calls Soroban cancel_escrow(escrow_id), signed by the backend service account.
 *  - DB is updated to status:'cancelled', cancelled_at:NOW() ONLY after on-chain confirmation.
 *  - If on-chain fails, DB is NOT updated.
 *  - Sender is notified via email.
 *  - Event is written to the audit log.
 */
async function cancelPendingEscrow(req, res, next) {
  try {
    const { id } = req.params;

    // 1. Load the escrow record from agent_escrows
    const escrowResult = await db.query(
      "SELECT * FROM agent_escrows WHERE id = $1",
      [id]
    );
    if (!escrowResult.rows[0]) {
      return res.status(404).json({ error: "Escrow not found" });
    }
    const escrow = escrowResult.rows[0];

    // 2. Validate status
    if (escrow.status !== "pending") {
      return res.status(400).json({ error: "Only pending escrows can be cancelled" });
    }

    // 3. Verify the caller is the sender
    const walletResult = await db.query(
      "SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1",
      [req.user.userId]
    );
    if (!walletResult.rows[0]) {
      return res.status(404).json({ error: "Wallet not found" });
    }
    const { public_key, encrypted_secret_key } = walletResult.rows[0];

    if (escrow.sender_wallet !== public_key) {
      return res.status(403).json({ error: "Only the sender can cancel this escrow" });
    }

    // 4. Enforce 48-hour cancellation window: expires_at must be in the past
    //    If expires_at is null, fall back to created_at + 48h
    const expiresAt = escrow.expires_at
      ? new Date(escrow.expires_at)
      : new Date(new Date(escrow.created_at).getTime() + 48 * 60 * 60 * 1000);

    const now = new Date();
    if (now < expiresAt) {
      return res.status(403).json({
        error: "CANCEL_TOO_EARLY",
        message: "You cannot cancel this payment until 48 hours after creation.",
        cancel_available_at: expiresAt.toISOString(),
      });
    }

    // 5. Call Soroban cancel_escrow on-chain — DB is NOT updated if this fails
    let cancelTxHash;
    try {
      ({ txHash: cancelTxHash } = await cancelEscrow({
        encryptedSecretKey: encrypted_secret_key,
        escrowId: escrow.contract_escrow_id,
      }));
    } catch (stellarErr) {
      logger.error("On-chain cancel_escrow failed", {
        escrowId: escrow.contract_escrow_id,
        error: stellarErr.message,
      });
      return res.status(502).json({
        error: "On-chain cancellation failed. DB record has NOT been updated.",
        detail: stellarErr.message,
      });
    }

    // 6. On-chain confirmed — now update the database record
    await db.query(
      "UPDATE agent_escrows SET status = 'cancelled', cancelled_at = NOW(), confirm_tx_hash = $1 WHERE id = $2",
      [cancelTxHash, id]
    );

    // 7. Notify sender via email (fire-and-forget)
    db.query(
      "SELECT u.email, u.full_name FROM users u JOIN wallets w ON w.user_id = u.id WHERE w.public_key = $1 LIMIT 1",
      [escrow.sender_wallet]
    )
      .then(({ rows }) => {
        if (!rows[0]) return;
        const { email, full_name } = rows[0];
        enqueueEmail({
          to: email,
          subject: "AfriPay: Your payment has been cancelled and refunded",
          html: `<p>Hi ${full_name},</p>
<p>Your payment of <strong>${escrow.amount} ${escrow.asset}</strong> has been cancelled and the funds have been refunded to your wallet.</p>
<p>Transaction Hash: <code>${cancelTxHash}</code></p>
<p><a href="${process.env.FRONTEND_URL}/history">View in AfriPay</a></p>`,
        }).catch(() => {});
      })
      .catch(() => {});

    // 8. Write cancellation event to audit log
    await audit.auditLog(req, "escrow_cancelled", {
      type: "agent_escrow",
      id,
      newValue: {
        escrow_id: id,
        contract_escrow_id: escrow.contract_escrow_id,
        stellar_tx_hash: cancelTxHash,
        cancelled_at: new Date().toISOString(),
      },
    });

    // 9. Fire webhook event (non-blocking)
    webhook.deliver("escrow.cancelled", req.user.userId, {
      escrow_id: id,
      contract_escrow_id: escrow.contract_escrow_id,
      tx_hash: cancelTxHash,
      amount: escrow.amount,
      asset: escrow.asset,
      sender: escrow.sender_wallet,
    }).catch(() => {});

    return res.json({
      message: "Escrow cancelled and funds refunded to your wallet",
      escrow_id: id,
      contract_escrow_id: escrow.contract_escrow_id,
      tx_hash: cancelTxHash,
      status: "cancelled",
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { send, sendBatch, history, findPath, sendPath, exportCSV, estimateFee, estimateFees, getFeeStats, getFeeRate, findReceivePathHandler, sendStrictReceivePath, getPaymentById, cancelPendingEscrow };
