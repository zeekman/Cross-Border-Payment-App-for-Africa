const { body } = require("express-validator");
const StellarSdk = require("@stellar/stellar-sdk");

const MEMO_ID_MAX = 2n ** 64n - 1n;
const STELLAR_MIN_AMOUNT = 0.0000001;
const MAX_TRANSACTION_AMOUNT = parseFloat(process.env.MAX_TRANSACTION_AMOUNT || "1000000");

module.exports = [
  body("asset").optional().isIn(["XLM", "USDC", "NGN", "GHS", "KES"]),
  body("memo").optional().trim(),
  body("memo_type")
    .optional()
    .isIn(["text", "id", "hash", "return"])
    .withMessage("memo_type must be text, id, hash, or return"),
  body("recipients")
    .isArray({ min: 1, max: 100 })
    .withMessage("recipients must be an array with between 1 and 100 items"),
  body("recipients.*.recipient_address")
    .notEmpty()
    .withMessage("Recipient address is required")
    .custom((value) => {
      if (!StellarSdk.StrKey.isValidEd25519PublicKey(value)) {
        throw new Error("Invalid Stellar wallet address");
      }
      return true;
    }),
  body("recipients.*.amount")
    .isFloat({ gt: 0 })
    .withMessage("Amount must be greater than 0")
    .custom((value) => {
      const amount = parseFloat(value);
      if (amount < STELLAR_MIN_AMOUNT) {
        throw new Error(`Amount must be at least ${STELLAR_MIN_AMOUNT} XLM (1 stroop)`);
      }
      if (amount > MAX_TRANSACTION_AMOUNT) {
        throw new Error(`Amount exceeds maximum transaction limit of ${MAX_TRANSACTION_AMOUNT}`);
      }
      return true;
    }),
  body().custom((_, { req }) => {
    const raw = req.body.memo;
    const memo = typeof raw === "string" ? raw.trim() : "";
    const memoTypeRaw = req.body.memo_type;
    const memoType = (memoTypeRaw || "text").toLowerCase();

    if (!memo) {
      if (memoTypeRaw && memoType !== "text") {
        throw new Error("memo is required when memo_type is id, hash, or return");
      }
      return true;
    }

    if (memoType === "text" && memo.length > 28) {
      throw new Error("Text memo must be at most 28 characters");
    }
    if (memoType === "id") {
      if (!/^\d+$/.test(memo)) throw new Error("Memo ID must be a numeric string");
      try {
        const n = BigInt(memo);
        if (n < 0n || n > MEMO_ID_MAX) throw new Error("Memo ID is out of range");
      } catch (e) {
        if (e.message === "Memo ID is out of range") throw e;
        throw new Error("Memo ID is invalid");
      }
    }
    if (memoType === "hash" || memoType === "return") {
      const hex = memo.replace(/^0x/i, "");
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error("Memo must be exactly 64 hexadecimal characters");
      }
    }

    return true;
  }),
];
