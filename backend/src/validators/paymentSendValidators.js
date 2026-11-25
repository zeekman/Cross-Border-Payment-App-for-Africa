const { body } = require('express-validator');
const StellarSdk = require('@stellar/stellar-sdk');
const { openApiSchemaFromSpec } = require('../utils/openApiSchemaFromValidator');

const MEMO_ID_MAX = 2n ** 64n - 1n;

/**
 * Declarative field spec for POST /payments/send.
 *
 * This is the single source of truth for both:
 *  - the express-validator chains used at runtime (below), and
 *  - the OpenAPI/Swagger request schema (PaymentSendRequest, exported from
 *    this module and wired into backend/src/app.js's swagger components).
 *
 * Keeping both derived from the same list prevents the docs from silently
 * drifting away from what the API actually accepts/rejects.
 */
const paymentSendFieldSpec = [
  {
    name: 'recipient_address',
    type: 'string',
    required: true,
    description: 'Recipient Stellar wallet address (Ed25519 public key, G...)',
  },
  {
    name: 'amount',
    type: 'number',
    format: 'float',
    required: true,
    description: 'Amount to send. Must be greater than 0.',
  },
  {
    name: 'asset',
    type: 'string',
    required: false,
    enum: ['XLM', 'USDC', 'NGN', 'GHS', 'KES'],
    description: 'Asset code to send. Defaults to XLM when omitted.',
  },
  {
    name: 'memo',
    type: 'string',
    required: false,
    description: 'Optional payment memo. Constraints depend on memo_type.',
  },
  {
    name: 'memo_type',
    type: 'string',
    required: false,
    enum: ['text', 'id', 'hash', 'return'],
    description: 'Memo type. Defaults to "text" when a memo is present.',
  },
];

/**
 * Shared validators for POST /payments/send (used by routes and integration tests).
 */
const paymentSendValidators = [
  body('recipient_address')
    .notEmpty().withMessage('Recipient address is required')
    .custom((value) => {
      if (!StellarSdk.StrKey.isValidEd25519PublicKey(value)) {
        throw new Error('Invalid Stellar wallet address');
      }
      return true;
    }),
  body('amount').isFloat({ gt: 0 }).withMessage('Amount must be greater than 0'),
  body('asset').optional().isIn(['XLM', 'USDC', 'NGN', 'GHS', 'KES']),
  body('memo').optional().trim(),
  body('memo_type')
    .optional()
    .isIn(['text', 'id', 'hash', 'return'])
    .withMessage('memo_type must be text, id, hash, or return'),
  body().custom((_, { req }) => {
    const raw = req.body.memo;
    const memo = typeof raw === 'string' ? raw.trim() : '';
    const memoTypeRaw = req.body.memo_type;
    const mt = (memoTypeRaw || 'text').toLowerCase();

    if (!memo) {
      if (memoTypeRaw && String(memoTypeRaw).toLowerCase() !== 'text') {
        throw new Error('memo is required when memo_type is id, hash, or return');
      }
      return true;
    }

    if (mt === 'text' && Buffer.byteLength(memo, 'utf8') > 28) {
      throw new Error('Text memo must be at most 28 bytes');
    }
    if (mt === 'id') {
      if (!/^\d+$/.test(memo)) throw new Error('Memo ID must be a numeric string');
      try {
        const n = BigInt(memo);
        if (n < 0n || n > MEMO_ID_MAX) throw new Error('Memo ID is out of range');
      } catch (e) {
        if (e.message === 'Memo ID is out of range') throw e;
        throw new Error('Memo ID is invalid');
      }
    }
    if (mt === 'hash' || mt === 'return') {
      const hex = memo.replace(/^0x/i, '');
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error('Memo must be exactly 64 hexadecimal characters');
      }
    }
    return true;
  })
];

// OpenAPI request schema derived from the same field spec above. Consumed by
// backend/src/app.js and referenced from the /send route's @openapi block as
// '#/components/schemas/PaymentSendRequest'.
paymentSendValidators.openApiSchema = openApiSchemaFromSpec(paymentSendFieldSpec, {
  title: 'PaymentSendRequest',
});
paymentSendValidators.fieldSpec = paymentSendFieldSpec;

module.exports = paymentSendValidators;
