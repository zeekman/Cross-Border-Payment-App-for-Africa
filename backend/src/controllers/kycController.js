const db = require("../db");

const ALLOWED_ID_TYPES = ["national_id", "passport", "drivers_license", "voters_card"];

async function submitKYC(req, res, next) {
  try {
    const { id_type, id_number, date_of_birth } = req.body;

    if (!ALLOWED_ID_TYPES.includes(id_type)) {
      return res.status(400).json({ error: "Invalid ID type" });
    }
    if (!id_number || typeof id_number !== "string" || id_number.trim().length < 3) {
      return res.status(400).json({ error: "Invalid ID number" });
    }
    if (!date_of_birth || isNaN(Date.parse(date_of_birth))) {
      return res.status(400).json({ error: "Invalid date of birth" });
    }

    // Check current status — do not allow resubmission if already verified or pending
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

    // Store submission metadata — never store raw document images in the DB
    const kycData = {
      id_type,
      id_number_last4: id_number.trim().slice(-4),
      date_of_birth,
      submitted_at: new Date().toISOString(),
    };

    await db.query(
      `UPDATE users
       SET kyc_status = 'pending',
           kyc_data = $1,
           kyc_submitted_at = NOW(),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(kycData), req.user.userId],
    );

    res.status(200).json({
      message: "KYC submitted successfully. Your application is under review.",
      kyc_status: "pending",
    });
  } catch (err) {
    next(err);
  }
}

async function getKYCStatus(req, res, next) {
  try {
    const result = await db.query(
      "SELECT kyc_status, kyc_submitted_at FROM users WHERE id = $1",
      [req.user.userId],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "User not found" });

    res.json({
      kyc_status: result.rows[0].kyc_status,
      kyc_submitted_at: result.rows[0].kyc_submitted_at,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { submitKYC, getKYCStatus };
