/**
 * horizonSchemas.js
 *
 * Zod schemas for validating Stellar Horizon API responses.
 * Every schema is strict on the fields we actually consume and uses
 * .passthrough() so we never break when Horizon adds new fields.
 *
 * Typed error: HorizonValidationError (status 502 Bad Gateway)
 * Caught by controllers via the standard err.status pattern already
 * used across the codebase.
 */
'use strict';

const { z } = require('zod');

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

class HorizonValidationError extends Error {
  constructor(message, context) {
    super(message);
    this.name = 'HorizonValidationError';
    this.status = 502; // Bad Gateway — upstream returned unexpected data
    this.context = context;
  }
}

// ---------------------------------------------------------------------------
// Reusable primitives
// ---------------------------------------------------------------------------

/** Stellar transaction hash: 64 lowercase hex characters */
const TxHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Transaction hash must be 64 lowercase hex characters');

/** Ledger sequence number */
const LedgerSchema = z.number().int().positive();

/** Numeric string as returned by Horizon for balances / amounts */
const NumericStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Expected a numeric string (e.g. "100.0000000")');

// ---------------------------------------------------------------------------
// Balance entry inside an account response
// ---------------------------------------------------------------------------

const BalanceEntrySchema = z
  .object({
    asset_type: z.enum(['native', 'credit_alphanum4', 'credit_alphanum12']),
    balance: NumericStringSchema,
    // Only present for non-native assets
    asset_code: z.string().optional(),
    asset_issuer: z.string().optional(),
    limit: NumericStringSchema.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Account response (loadAccount)
// ---------------------------------------------------------------------------

const AccountResponseSchema = z
  .object({
    id: z.string().min(1),
    balances: z.array(BalanceEntrySchema).min(0),
    // sequence is a string in Horizon responses
    sequence: z.string().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Transaction submission response (submitTransaction)
// ---------------------------------------------------------------------------

const TransactionSubmitResponseSchema = z
  .object({
    hash: TxHashSchema,
    ledger: LedgerSchema,
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Transaction record (transactions().forAccount().call())
// ---------------------------------------------------------------------------

const TransactionRecordSchema = z
  .object({
    id: z.string().min(1),
    hash: TxHashSchema,
    created_at: z.string().min(1),
    successful: z.boolean(),
    memo: z.string().optional(),
  })
  .passthrough();

const TransactionPageSchema = z.object({
  records: z.array(TransactionRecordSchema),
});

// ---------------------------------------------------------------------------
// Path payment path entry
// ---------------------------------------------------------------------------

const PathAssetSchema = z
  .object({
    asset_type: z.enum(['native', 'credit_alphanum4', 'credit_alphanum12']),
    asset_code: z.string().optional(),
    asset_issuer: z.string().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// strictSendPaths record
// ---------------------------------------------------------------------------

const PathRecordSchema = z
  .object({
    destination_amount: NumericStringSchema,
    path: z.array(PathAssetSchema),
  })
  .passthrough();

const PathPageSchema = z.object({
  records: z.array(PathRecordSchema),
});

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Parse `data` against `schema`.
 * Throws HorizonValidationError on failure so controllers can catch it
 * via the standard err.status pattern.
 *
 * @param {z.ZodSchema} schema
 * @param {unknown} data
 * @param {string} label  Human-readable label for error messages
 * @returns {z.infer<typeof schema>}
 */
function validateHorizonResponse(schema, data, label) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new HorizonValidationError(
      `Horizon response validation failed for ${label}: ${issues}`,
      { label, issues: result.error.issues }
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  HorizonValidationError,
  AccountResponseSchema,
  TransactionSubmitResponseSchema,
  TransactionRecordSchema,
  TransactionPageSchema,
  PathRecordSchema,
  PathPageSchema,
  validateHorizonResponse,
};
