const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

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

async function getInfo(req, res, next) {
  try {
    res.json({
      assets: [
        {
          code: 'USDC',
          issuer: process.env.USDC_ISSUER || 'GBBD47UZQ2BNSE7E2CMPL3XUREV3ZCYY5LMPJCJ7I7ZLIP4UGJLE66V2',
          sep12: {
            sender: ['name', 'email', 'phone_number'],
            receiver: ['name', 'email', 'phone_number']
          }
        }
      ],
      sep12: {
        sender: ['name', 'email', 'phone_number'],
        receiver: ['name', 'email', 'phone_number']
      }
    });
  } catch (err) {
    next(err);
  }
}

async function createTransaction(req, res, next) {
  try {
    const { amount, asset_code = 'USDC', receiver_account, fields = {}, sender_name, sender_email } = req.body;
    const userId = req.user.userId;

    if (!amount || !receiver_account) {
      return res.status(400).json({ error: 'amount and receiver_account required' });
    }

    // Validate fields against anchor /info schema
    let requiredFields = [];
    try {
      const anchorInfo = await fetchAnchorInfo(asset_code);
      requiredFields = getRequiredFields(anchorInfo, asset_code);
    } catch (err) {
      logger.warn('Could not fetch anchor /info for field validation', { error: err.message });
      // Proceed without validation if anchor is unreachable
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
    await db.query(
      `INSERT INTO sep31_transactions (id, sender_id, receiver_account, amount, asset_code, kyc_verified, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [txId, userId, receiver_account, amount, asset_code, kycVerified]
    );

    res.status(201).json({
      id: txId,
      status: 'pending',
      amount,
      asset_code,
      receiver_account,
      kyc_verified: kycVerified
    });
  } catch (err) {
    next(err);
  }
}

async function getTransaction(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const result = await db.query(
      `SELECT id, status, amount, asset_code, receiver_account, kyc_verified, created_at, updated_at
       FROM sep31_transactions
       WHERE id = $1 AND sender_id = $2`,
      [id, userId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getInfo,
  createTransaction,
  getTransaction,
  fetchAnchorInfo,
  getRequiredFields,
};
