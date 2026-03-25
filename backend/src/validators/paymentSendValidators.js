const { body } = require('express-validator');

const MEMO_ID_MAX = 2n ** 64n - 1n;

/**
 * Shared validators for POST /payments/send (used by routes and integration tests).
 */
module.exports = [
  body('recipient_address').notEmpty().withMessage('Recipient address is required'),
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

    if (mt === 'text' && memo.length > 28) {
      throw new Error('Text memo must be at most 28 characters');
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
