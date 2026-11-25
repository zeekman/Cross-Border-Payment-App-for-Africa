const { getActiveConfig, listAllConfigs, getHistory, createConfig, patchConfig, previewFeeConfig } = require('../services/feeConfigService');

async function listConfigs(req, res, next) {
  try {
    const configs = await listAllConfigs();
    res.json(configs);
  } catch (err) {
    next(err);
  }
}

async function createFeeConfig(req, res, next) {
  try {
    const { fee_type, asset_code, fee_bps, max_fee_usdc, min_fee_usdc, effective_from } = req.body;
    const config = await createConfig(
      fee_type,
      asset_code,
      fee_bps,
      max_fee_usdc,
      min_fee_usdc,
      effective_from ? new Date(effective_from) : null,
      req.user.userId,
      req.user.role,
      req.ip,
      req.headers['user-agent']
    );
    res.status(201).json(config);
  } catch (err) {
    if (err.message.includes('must not exceed')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
}

async function updateFeeConfig(req, res, next) {
  try {
    const { id } = req.params;
    const updates = req.body;
    const config = await patchConfig(
      id,
      updates,
      req.user.userId,
      req.user.role,
      req.ip,
      req.headers['user-agent']
    );
    res.json(config);
  } catch (err) {
    if (err.message === 'Fee configuration not found') {
      return res.status(404).json({ error: err.message });
    }
    if (err.message.includes('must not exceed')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
}

async function listHistory(req, res, next) {
  try {
    const history = await getHistory();
    res.json(history);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/fee-configs/preview
 * Simulates a proposed fee config against recent historical transaction
 * volume and returns the estimated fee-revenue delta, without applying
 * any change.
 */
async function previewFeeConfigChange(req, res, next) {
  try {
    const { fee_type, asset_code, fee_bps, max_fee_usdc, min_fee_usdc, lookback_days } = req.body;
    const preview = await previewFeeConfig(
      fee_type,
      asset_code,
      fee_bps,
      max_fee_usdc,
      min_fee_usdc,
      lookback_days
    );
    res.json(preview);
  } catch (err) {
    if (err.message.includes('must not exceed')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
}

module.exports = {
  listConfigs,
  createFeeConfig,
  updateFeeConfig,
  listHistory,
  previewFeeConfigChange,
};
