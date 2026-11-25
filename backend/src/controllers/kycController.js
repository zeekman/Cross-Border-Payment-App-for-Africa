const db = require("../db");
const { amlScreen } = require("../services/amlScreening");
const audit = require("../services/audit");
const logger = require("../utils/logger");

const ALLOWED_ID_TYPES = ["national_id", "passport", "drivers_license", "voters_card"];
const AML_RESCREEN_THRESHOLD_USD = 1000;

async function submitKYC(req, res, next) {
  try {
    const { id_type, id_number, date_of_birth, document_expiry_date } = req.body;

    if (!ALLOWED_ID_TYPES.includes(id_type)) {
      return res.status(400).json({ error: "Invalid ID type" });
    }
    if (!id_number || typeof id_number !== "string" || id_number.trim().length < 3) {
      return res.status(400).json({ error: "Invalid ID number" });
    }
    if (!date_of_birth || isNaN(Date.parse(date_of_birth))) {
      return res.status(400).json({ error: "Invalid date of birth" });
    }
    if (document_expiry_date && isNaN(Date.parse(document_expiry_date))) {
      return res.status(400).json({ error: "Invalid document expiry date" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "Document file is required" });
    }

    const userResult = await db.query("SELECT kyc_status FROM users WHERE id = $1", [
      req.user.userId,
    ]);
    if (!userResult.rows[0]) return res.status(404).json({ error: "User not found" });

    const currentStatus = userResult.rows[0].kyc_status;
    if (currentStatus === "verified") {
      return res.status(409).json({ error: "KYC already verified" });
    }
    if (currentStatus === "pending") {
      return res.status(409).json({ error: "KYC submission already under review" });
    }
    // 'expired' status explicitly allows re-submission (falls through to update below)

    const kycData = {
      id_type,
      id_number_last4: id_number.trim().slice(-4),
      date_of_birth,
      document_filename: req.file.filename,
      document_mimetype: req.file.mimetype,
      submitted_at: new Date().toISOString(),
    };

    await db.query(
      `UPDATE users
          SET kyc_status              = 'pending',
              kyc_data                = $1,
              kyc_submitted_at        = NOW(),
              kyc_document_expiry_date = $2,
              kyc_reminders_sent      = '{}',
              updated_at              = NOW()
        WHERE id = $3`,
      [JSON.stringify(kycData), document_expiry_date || null, req.user.userId],
    );

    // AML screening hook — runs after successful KYC document submission
    const walletResult = await db.query("SELECT public_key FROM wallets WHERE user_id = $1 LIMIT 1", [req.user.userId]);
    const walletAddress = walletResult.rows[0]?.public_key || null;
    if (walletAddress) {
      const amlResult = await amlScreen(walletAddress, { userId: req.user.userId });
      if (amlResult.status === 'flagged') {
        logger.warn('AML screening flagged user wallet after KYC submission', { userId: req.user.userId, walletAddress, amlResult });
        await audit.log(req.user.userId, 'aml_flagged', req.ip, req.headers['user-agent'], { walletAddress, amlResult });
        return res.status(403).json({ error: 'Payment blocked: wallet flagged by AML screening.' });
      }
      // Explicit compliance decision for a non-cleared screening:
      // KYC document submission is allowed through with a flag so compliance can
      // review it, but the outcome is recorded in the audit trail.
      if (amlResult.status === 'not_screened') {
        logger.warn('AML screening unavailable — KYC submission allowed with flag', { userId: req.user.userId, walletAddress });
        await audit.log(req.user.userId, 'aml_not_screened', req.ip, req.headers['user-agent'], { walletAddress, amlResult });
      } else if (amlResult.status === 'error') {
        logger.warn('AML screening provider error — KYC submission allowed with flag', { userId: req.user.userId, walletAddress, amlResult });
        await audit.log(req.user.userId, 'aml_screening_error', req.ip, req.headers['user-agent'], { walletAddress, amlResult });
      }
    }

    res.status(200).json({
      message: "KYC submitted successfully. Your application is under review.",
      kyc_status: "pending",
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Re-screen a sender wallet for payments over AML_RESCREEN_THRESHOLD_USD.
 * Call this from the payment flow before submitting high-value transactions.
 *
 * Fail-closed compliance gate: a high-value payment is blocked unless the
 * wallet was actually screened and returned a clear result.
 */
async function amlRescreenForPayment(userId, walletAddress, amountUsd) {
  if (amountUsd < AML_RESCREEN_THRESHOLD_USD) return null;
  const amlResult = await amlScreen(walletAddress, { userId });
  if (amlResult.status === 'flagged') {
    logger.warn('AML re-screen flagged wallet for high-value payment', { userId, walletAddress, amountUsd, amlResult });
    await audit.log(userId, 'aml_payment_flagged', null, null, { walletAddress, amountUsd, amlResult });
    const err = new Error('Payment blocked: wallet flagged by AML screening.');
    err.status = 403;
    throw err;
  }
  if (amlResult.status === 'not_screened') {
    logger.warn('AML screening unavailable — blocking high-value payment', { userId, walletAddress, amountUsd });
    await audit.log(userId, 'aml_payment_not_screened', null, null, { walletAddress, amountUsd, amlResult });
    const err = new Error('Payment blocked: AML screening is not configured for high-value transactions.');
    err.status = 403;
    err.payload = { code: 'AML_SCREENING_UNAVAILABLE' };
    throw err;
  }
  if (amlResult.status === 'error') {
    logger.error('AML screening provider error — blocking high-value payment', { userId, walletAddress, amountUsd, amlResult });
    await audit.log(userId, 'aml_payment_screening_error', null, null, { walletAddress, amountUsd, amlResult });
    const err = new Error('Payment blocked: AML screening provider error. Please try again later.');
    err.status = 503;
    err.payload = { code: 'AML_SCREENING_ERROR' };
    throw err;
  }
  return amlResult;
}

async function getKYCStatus(req, res, next) {
  try {
    const result = await db.query(
      `SELECT kyc_status, kyc_submitted_at, kyc_document_expiry_date FROM users WHERE id = $1`,
      [req.user.userId],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "User not found" });

    const { kyc_status, kyc_submitted_at, kyc_document_expiry_date } = result.rows[0];

    let days_until_expiry = null;
    if (kyc_document_expiry_date) {
      days_until_expiry = Math.ceil(
        (new Date(kyc_document_expiry_date) - Date.now()) / (1000 * 60 * 60 * 24),
      );
    }

    res.json({
      kyc_status,
      kyc_submitted_at,
      document_expiry_date: kyc_document_expiry_date,
      days_until_expiry,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { submitKYC, getKYCStatus, amlRescreenForPayment };
