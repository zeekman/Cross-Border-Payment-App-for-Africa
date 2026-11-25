const db = require('../db');
const { issueAsset, getAssetInfo, getAssetMetadataByCodeAndIssuer } = require('../services/stellar');
const logger = require('../utils/logger');
const cache = require('../utils/cache');

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

// GET /api/assets/:code/:issuer — return Stellar asset info for any asset
async function getAssetByParams(req, res, next) {
  try {
    const { code, issuer } = req.params;
    const info = await getAssetMetadataByCodeAndIssuer(code, issuer);
    res.json(info);
  } catch (err) {
    next(err);
  }
}

// PATCH /api/assets/:id/status (admin only) — enable/disable a supported asset.
//
// Cache-invalidation path (BE-030): asset whitelist metadata is folded into the
// per-wallet `balance:<public_key>` cache entries in walletController (TTL =
// MULTI_ASSET_TTL, currently 10s) rather than cached under its own key. Simply
// waiting out that TTL after disabling an asset for compliance reasons would let
// it remain "sendable" from a client's point of view for up to 10s. To avoid
// relying on TTL expiry, every toggle here does a `cache.delPattern('balance:*')`
// immediately after the DB write, so the next balance read for any wallet is
// forced to hit Postgres and pick up the fresh `is_active` flag. Direct
// whitelist checks (e.g. addTrustlineHandler in walletController) already query
// `supported_assets` live and are unaffected by this cache.
async function setAssetStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== 'boolean') {
      const err = new Error('is_active must be a boolean');
      err.status = 400;
      throw err;
    }

    const result = await db.query(
      `UPDATE supported_assets SET is_active = $1 WHERE id = $2
       RETURNING id, asset_code, asset_issuer, is_active`,
      [is_active, id]
    );

    if (!result.rows[0]) {
      const err = new Error('Asset not found');
      err.status = 404;
      throw err;
    }

    // Explicit invalidation — do not rely on the balance cache TTL alone.
    await cache.delPattern('balance:*');

    logger.info('Supported asset status toggled', {
      assetId: id,
      is_active,
      admin: req.user?.userId,
    });

    res.json({ success: true, asset: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

module.exports = { issueTokens, getAssetMetadata, getAssetByParams, setAssetStatus };
