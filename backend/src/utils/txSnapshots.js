'use strict';

/**
 * BE-227: FX + fee snapshots persisted on each transaction at send time so
 * history, CSV export, receipts and analytics show the fiat value at send
 * time instead of today's rate.
 *
 * fx_snapshot shape:
 *   { asset, rates: { USD, NGN, GHS, KES }, xlm: { USD, NGN, GHS, KES },
 *     source, cached_at, captured_at }
 * where `rates` is the price of ONE unit of the transaction asset in each fiat.
 */

const db = require('../db');
const logger = require('./logger');

const FIATS = ['USD', 'NGN', 'GHS', 'KES'];

function assetRates(asset, xlm) {
  const a = String(asset || 'XLM').toUpperCase();
  const out = {};
  for (const f of FIATS) {
    if (a === 'XLM') out[f] = xlm[f];
    else if (a === 'USDC') out[f] = f === 'USD' ? 1 : xlm[f] / xlm.USD;
    else if (FIATS.includes(a)) out[f] = a === f ? 1 : xlm[f] / xlm[a];
    else out[f] = null;
    if (out[f] != null) out[f] = Number.isFinite(out[f]) ? parseFloat(out[f].toFixed(8)) : null;
  }
  return out;
}

async function buildFxSnapshot(asset) {
  try {
    const { getXlmRates } = require('../services/priceOracle');
    const xlm = await getXlmRates();
    return {
      asset,
      rates: assetRates(asset, xlm),
      xlm: { USD: xlm.USD, NGN: xlm.NGN, GHS: xlm.GHS, KES: xlm.KES },
      source: xlm.stale ? 'stale' : xlm.rate_source,
      cached_at: xlm.cached_at || null,
      captured_at: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn('fx snapshot unavailable', { error: err.message });
    return null;
  }
}

/**
 * Persist snapshots on an already-inserted transaction row. Best effort:
 * a snapshot failure must never fail a payment that is already on-chain.
 */
async function persistSnapshots(txId, asset, feeSnapshot = null) {
  try {
    const fx = await buildFxSnapshot(asset);
    await db.query(
      'UPDATE transactions SET fx_snapshot = $1, fee_snapshot = COALESCE($2, fee_snapshot) WHERE id = $3',
      [fx ? JSON.stringify(fx) : null, feeSnapshot ? JSON.stringify(feeSnapshot) : null, txId],
    );
  } catch (err) {
    logger.warn('failed to persist tx snapshots', { txId, error: err.message });
  }
}

/** Fiat value of a transaction at send time, or null ("rate unavailable"). */
function fiatValueAtSend(tx, currency = 'USD') {
  const rate = tx?.fx_snapshot?.rates?.[String(currency).toUpperCase()];
  if (rate == null) return null;
  return parseFloat((parseFloat(tx.amount) * rate).toFixed(2));
}

/** Sum fiat values across rows using each row's own snapshot. */
function sumFiatVolume(rows, currency = 'USD') {
  let total = 0;
  let unpriced = 0;
  for (const r of rows) {
    const v = fiatValueAtSend(r, currency);
    if (v == null) unpriced += 1;
    else total += v;
  }
  return { currency, total: parseFloat(total.toFixed(2)), unpriced_count: unpriced };
}

module.exports = { FIATS, assetRates, buildFxSnapshot, persistSnapshots, fiatValueAtSend, sumFiatVolume };
