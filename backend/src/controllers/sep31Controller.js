const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const db = require('../db');
const cache = require('../utils/cache');
const logger = require('../utils/logger');
const { validateCallbackUrl, deliverCallback } = require('../services/sep31CallbackService');

const ANCHOR_INFO_TTL = 5 * 60; // 5 minutes in seconds
const anchorUrl = process.env.ANCHOR_URL || 'https://testanchor.stellar.org';

/**
 * Fetch the anchor's SEP-31 /info endpoint and cache for 5 minutes.
 * Returns the parsed JSON response.
 */
async function fetchAnchorInfo(assetCode) {
  const cacheKey = `sep31:anchor_info:${anchorUrl}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const response = await fetch(`${anchorUrl}/sep31/info`);
  if (!response.ok) {
    throw new Error(`Anchor /info returned ${response.status}`);
  }
  const data = await response.json();
  await cache.set(cacheKey, data, ANCHOR_INFO_TTL);
  return data;
}

/**
 * Get required fields for a given asset from the anchor /info response.
 * Returns an array of required field names.
 */
function getRequiredFields(anchorInfo, assetCode) {
  const assetInfo = anchorInfo?.receive?.[assetCode];
  if (!assetInfo) return [];
  const fields = assetInfo.fields || {};
  return Object.entries(fields)
    .filter(([, meta]) => !meta.optional)
    .map(([name]) => name);
}

/**
 * GET /api/sep31/info
 *
 * Returns the supported assets and required SEP-12 fields for cross-border
 * payments. Conforms to the SEP-31 /info response schema.
 */
async function getInfo(req, res, next) {
  try {
    res.json({
      receive: {
        USDC: {
          enabled: true,
          min_amount: parseFloat(process.env.SEP31_MIN_AMOUNT || '1'),
          max_amount: parseFloat(process.env.SEP31_MAX_AMOUNT || '10000'),
          fee_fixed: parseFloat(process.env.SEP31_FEE_FIXED || '0.5'),
          fee_percent: parseFloat(process.env.SEP31_FEE_PERCENT || '0'),
          sep12: {
            sender: {
              types: {
                'sep31-sender': {
                  description: 'Sender of a cross-border USDC payment'
                }
              }
            },
            receiver: {
              types: {
                'sep31-receiver': {
                  description: 'Receiver of a cross-border USDC payment'
                }
              }
            }
          },
          fields: {
            transaction: {
              receiver_routing_number: {
                description: 'Routing number of the receiver\'s bank account',
                optional: true
              },
              receiver_account_number: {
                description: 'Bank account number of the receiver',
                optional: true
              },
              type: {
                description: 'Type of payment (e.g. SWIFT, ACH, mobile_money)',
                choices: ['SWIFT', 'ACH', 'mobile_money'],
                optional: true
              }
            }
          }
        },
        XLM: {
          enabled: true,
          min_amount: parseFloat(process.env.SEP31_XLM_MIN_AMOUNT || '1'),
          max_amount: parseFloat(process.env.SEP31_XLM_MAX_AMOUNT || '50000'),
          fee_fixed: parseFloat(process.env.SEP31_XLM_FEE_FIXED || '0'),
          fee_percent: parseFloat(process.env.SEP31_XLM_FEE_PERCENT || '0'),
          sep12: {
            sender: {
              types: {
                'sep31-sender': {
                  description: 'Sender of a cross-border XLM payment'
                }
              }
            },
            receiver: {
              types: {
                'sep31-receiver': {
                  description: 'Receiver of a cross-border XLM payment'
                }
              }
            }
          },
          fields: {
            transaction: {}
          }
        }
      }
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/sep31/transactions
 *
 * Initiates a new SEP-31 cross-border payment transaction.
 * Validates required fields against the anchor's /info schema when reachable.
 */
async function createTransaction(req, res, next) {
  try {
    const {
      amount,
      asset_code = 'USDC',
      receiver_account,
      fields = {},
      sender_name,
      sender_email,
      callback_url,
    } = req.body;
    const userId = req.user.userId;

    if (!amount || !receiver_account) {
      return res.status(400).json({ error: 'amount and receiver_account required' });
    }

    // SSRF-hardened: resolve-then-validate against the shared allow-list
    // (see BE-015). Re-validated again immediately before every callback
    // delivery attempt, not just here.
    if (callback_url && !(await validateCallbackUrl(callback_url))) {
      return res.status(400).json({ error: 'callback_url must be a public HTTPS endpoint' });
    }

    // Validate fields against anchor /info schema
    let requiredFields = [];
    try {
      const anchorInfo = await fetchAnchorInfo(asset_code);
      requiredFields = getRequiredFields(anchorInfo, asset_code);
    } catch (err) {
      logger.warn('Could not fetch anchor /info for field validation', { error: err.message });
      // Proceed without remote validation if anchor is unreachable
    }

    if (requiredFields.length > 0) {
      const missing = requiredFields.filter((f) => !fields[f]);
      if (missing.length > 0) {
        return res.status(400).json({ error: 'Missing required fields', missing_fields: missing });
      }
    }

    // Check KYC status
    const user = await db.query('SELECT kyc_status FROM users WHERE id = $1', [userId]);
    const kycVerified = user.rows[0]?.kyc_status === 'verified';

    const txId = uuidv4();
    const sharedSecret = callback_url ? crypto.randomBytes(32).toString('hex') : null;

    // A transaction with a callback_url must never be persisted without a shared_secret —
    // deliverCallback() would otherwise sign the outbound webhook with an empty-string key (#951).
    if (callback_url && !sharedSecret) {
      logger.error('Refusing to create SEP-31 transaction ready for callback delivery without a shared_secret', {
        userId,
        callback_url,
      });
      return res.status(500).json({ error: 'Failed to configure callback delivery for this transaction' });
    }

    await db.query(
      `INSERT INTO sep31_transactions
         (id, sender_id, receiver_account, amount, asset_code, kyc_verified, status, callback_url, shared_secret)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
      [txId, userId, receiver_account, amount, asset_code, kycVerified, callback_url || null, sharedSecret]
    );

    if (callback_url) {
      // Fire-and-forget: delivery failures are logged, never block the response.
      deliverCallback({ id: txId, callback_url, shared_secret: sharedSecret, status: 'pending' }).catch(() => {});
    }

    logger.info('SEP-31 transaction created', {
      txId,
      userId,
      asset_code,
      amount,
      kyc_verified: kycVerified
    });

    res.status(201).json({
      id: txId,
      status: 'pending',
      amount: parseFloat(amount),
      asset_code,
      receiver_account,
      kyc_verified: kycVerified,
      ...(sharedSecret && { shared_secret: sharedSecret }),
      sender_name: sender_name || null,
      sender_email: sender_email || null
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/sep31/transactions/:id
 *
 * Returns the current status and details of a SEP-31 transaction.
 * Only the transaction's sender may retrieve it.
 */
async function getTransaction(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const result = await db.query(
      `SELECT id, status, status_message, stellar_transaction_id, refunded, amount, asset_code,
              receiver_account, kyc_verified, callback_url, created_at, updated_at
       FROM sep31_transactions
       WHERE id = $1 AND sender_id = $2`,
      [id, userId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const callbacks = await db.query(
      `SELECT url, http_status, response_time_ms, attempt_number, created_at
       FROM sep31_callbacks WHERE transaction_id = $1 ORDER BY created_at ASC`,
      [id]
    );

    res.json({ ...result.rows[0], callback_attempts: callbacks.rows });
  } catch (err) {
    next(err);
  }
}

async function updateTransactionStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status, status_message, stellar_transaction_id, refunded } = req.body;
    const userId = req.user.userId;

    const VALID_STATUSES = ['pending', 'completed', 'error', 'refunded'];
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const result = await db.query(
      `UPDATE sep31_transactions
       SET status = $1, status_message = $2, stellar_transaction_id = $3, refunded = $4, updated_at = NOW()
       WHERE id = $5 AND sender_id = $6
       RETURNING *`,
      [status, status_message || null, stellar_transaction_id || null, refunded || false, id, userId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    deliverCallback(result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getInfo,
  createTransaction,
  getTransaction,
  updateTransactionStatus,
  fetchAnchorInfo,
  getRequiredFields,
};
