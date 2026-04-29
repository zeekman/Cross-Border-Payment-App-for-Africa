const db = require('../db');
const { issueAsset, getAssetInfo } = require('../services/stellar');
const logger = require('../utils/logger');

// Issue AFRI tokens to a recipient (admin only)
async function issueTokens(req, res, next) {
  try {
    const { recipient, amount } = req.body;

    if (!recipient || !amount || amount <= 0) {
      const err = new Error('Recipient and positive amount are required');
      err.status = 400;
      throw err;
    }

    const result = await issueAsset(recipient, amount);

    await db.query(
      `INSERT INTO transactions (sender_wallet, recipient_wallet, amount, asset, status, tx_hash, type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [process.env.AFRI_DISTRIBUTION_PUBLIC, recipient, amount, 'AFRI', 'completed', result.transactionHash, 'issuance']
    );

    logger.info('AFRI tokens issued', { recipient, amount, hash: result.transactionHash });

    res.json({
      success: true,
      transactionHash: result.transactionHash,
      amount,
      recipient
    });
  } catch (err) {
    next(err);
  }
}

// Get AFRI asset metadata
async function getAssetMetadata(req, res, next) {
  try {
    const info = await getAssetInfo();
    res.json(info);
  } catch (err) {
    next(err);
  }
}

module.exports = { issueTokens, getAssetMetadata };
