const { getActiveConfig } = require('./feeConfigService');
const { depositFee } = require('./feeDistributor');
const { getAssetContractAddress } = require('./stellar');
const logger = require('../utils/logger');

const FALLBACK_PLATFORM_FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || '250', 10);

async function buildFeeBreakdown(grossAmount, asset = 'XLM', feeCharged = null) {
  const gross = Number(grossAmount);
  let feeBps = FALLBACK_PLATFORM_FEE_BPS;
  let minFee = 0;
  let maxFee = Infinity;

  try {
    const config = await getActiveConfig('platform', asset);
    if (config) {
      feeBps = Number(config.fee_bps);
      if (config.min_fee_usdc != null) minFee = Number(config.min_fee_usdc);
      if (config.max_fee_usdc != null) maxFee = Number(config.max_fee_usdc);
    }
  } catch (_) {
    // Keep the environment fallback when the fee config store is unavailable.
  }

  const platformFee = Number(Math.min(gross, maxFee, Math.max(minFee, (gross * feeBps) / 10000)).toFixed(7));
  const netAmount = Number((gross - platformFee).toFixed(7));
  const stellarBaseFeeXlm = feeCharged != null
    ? Number((parseInt(feeCharged, 10) / 1e7).toFixed(7))
    : null;

  return {
    gross_amount: Number(gross.toFixed(7)),
    platform_fee_bps: feeBps,
    platform_fee_amount: platformFee,
    net_amount: netAmount,
    gross_amount_usdc: Number(gross.toFixed(7)),
    platform_fee_usdc: platformFee,
    stellar_base_fee_xlm: stellarBaseFeeXlm,
    net_amount_usdc: netAmount,
    asset,
  };
}

function withStellarFee(feeBreakdown, feeCharged) {
  return Object.assign({}, feeBreakdown, {
    stellar_base_fee_xlm: feeCharged == null
      ? null
      : Number((parseInt(feeCharged, 10) / 1e7).toFixed(7)),
  });
}

async function collectPlatformFee(feeBreakdown, source) {
  const feeAmount = Number(feeBreakdown?.platform_fee_amount ?? feeBreakdown?.platform_fee_usdc ?? 0);
  if (!feeBreakdown?.asset || !Number.isFinite(feeAmount) || feeAmount <= 0) return;

  const feeStroops = Math.floor(feeAmount * 1e7);
  if (feeStroops <= 0) return;

  try {
    await depositFee(feeStroops, getAssetContractAddress(feeBreakdown.asset), source);
  } catch (err) {
    logger.error('Fee deposit failed', { error: err.message, feeStroops, asset: feeBreakdown.asset });
  }
}

module.exports = { buildFeeBreakdown, collectPlatformFee, withStellarFee };