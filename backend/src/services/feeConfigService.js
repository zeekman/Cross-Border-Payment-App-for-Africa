const db = require('../db');
const cache = require('../utils/cache');
const audit = require('../services/audit');

const CACHE_KEY_PREFIX = 'fee_config:active';
const CACHE_TTL = 300;

function cacheKey(feeType, assetCode) {
  return `${CACHE_KEY_PREFIX}:${feeType}:${assetCode}`;
}

async function refreshCache() {
  const { rows } = await db.query(
    `SELECT fee_type, asset_code, fee_bps, max_fee_usdc, min_fee_usdc, effective_from
     FROM fee_configs
     WHERE is_active = true AND effective_from <= NOW()`
  );

  const grouped = {};
  for (const row of rows) {
    const key = cacheKey(row.fee_type, row.asset_code);
    grouped[key] = row;
  }

  let keysToDelete = [];
  try {
    const redis = cache.getClient();
    if (redis) {
      const allKeys = await redis.keys(`${CACHE_KEY_PREFIX}:*`);
      keysToDelete.push(...allKeys);
    }
  } catch (_) {
    // ignore Redis errors during key enumeration
  }

  for (const key of Object.keys(grouped)) {
    await cache.set(key, grouped[key], CACHE_TTL);
    keysToDelete = keysToDelete.filter((k) => k !== key);
  }
  for (const key of keysToDelete) {
    await cache.del(key);
  }
}

async function getActiveConfig(feeType, assetCode) {
  const key = cacheKey(feeType, assetCode);
  const cached = await cache.get(key);
  if (cached) return cached;

  const { rows } = await db.query(
    `SELECT id, fee_type, asset_code, fee_bps, max_fee_usdc, min_fee_usdc, is_active, created_by, created_at, effective_from
     FROM fee_configs
     WHERE fee_type = $1 AND asset_code = $2 AND is_active = true AND effective_from <= NOW()
     ORDER BY effective_from DESC
     LIMIT 1`,
    [feeType, assetCode]
  );

  if (rows[0]) {
    const config = rows[0];
    await cache.set(key, config, CACHE_TTL);
    return config;
  }
  return null;
}

async function listAllConfigs() {
  const { rows } = await db.query(
    `SELECT id, fee_type, asset_code, fee_bps, max_fee_usdc, min_fee_usdc, is_active, created_by, created_at, effective_from
     FROM fee_configs
     ORDER BY created_at DESC`
  );
  return rows;
}

async function getHistory() {
  const { rows } = await db.query(
    `SELECT id, fee_type, asset_code, fee_bps, max_fee_usdc, min_fee_usdc, is_active, created_by, created_at, effective_from
     FROM fee_configs
     ORDER BY created_at DESC`
  );
  return rows;
}

async function createConfig(feeType, assetCode, feeBps, maxFeeUsdc, minFeeUsdc, effectiveFrom, createdBy, actorRole, ip, userAgent) {
  if (feeBps > 1000) {
    throw new Error('fee_bps must not exceed 1000 (10% max)');
  }
  if (minFeeUsdc > maxFeeUsdc) {
    throw new Error('min_fee_usdc must not exceed max_fee_usdc');
  }
  if (!effectiveFrom) {
    effectiveFrom = new Date();
  }

  const isEffectiveNow = effectiveFrom <= new Date();
  const initialActive = isEffectiveNow ? true : false;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    if (initialActive) {
      await client.query(
        `UPDATE fee_configs SET is_active = false WHERE fee_type = $1 AND asset_code = $2 AND is_active = true`,
        [feeType, assetCode]
      );
    }
    const { rows } = await client.query(
      `INSERT INTO fee_configs
         (fee_type, asset_code, fee_bps, max_fee_usdc, min_fee_usdc, is_active, created_by, effective_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [feeType, assetCode, feeBps, maxFeeUsdc, minFeeUsdc, initialActive, createdBy, effectiveFrom]
    );
    await client.query('COMMIT');

    const config = rows[0];
    await refreshCache();
    await audit.auditLog({ user: { userId: createdBy, role: actorRole }, ip, headers: { 'user-agent': userAgent } }, 'fee_config_created', {
      type: 'fee_config',
      id: config.id,
      newValue: {
        fee_type: feeType,
        asset_code: assetCode,
        fee_bps: feeBps,
        max_fee_usdc: maxFeeUsdc,
        min_fee_usdc: minFeeUsdc,
        effective_from: effectiveFrom,
      },
    });
    return config;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function patchConfig(id, updates, createdBy, actorRole, ip, userAgent) {
  const existingResult = await db.query(
    `SELECT * FROM fee_configs WHERE id = $1`,
    [id]
  );
  const existing = existingResult.rows[0];
  if (!existing) {
    throw new Error('Fee configuration not found');
  }

  const newFeeType = updates.fee_type ?? existing.fee_type;
  const newAssetCode = updates.asset_code ?? existing.asset_code;
  const newFeeBps = updates.fee_bps ?? existing.fee_bps;
  const newMaxFeeUsdc = updates.max_fee_usdc ?? existing.max_fee_usdc;
  const newMinFeeUsdc = updates.min_fee_usdc ?? existing.min_fee_usdc;
  const newEffectiveFrom = updates.effective_from ? new Date(updates.effective_from) : new Date();

  if (newFeeBps > 1000) {
    throw new Error('fee_bps must not exceed 1000 (10% max)');
  }
  if (newMinFeeUsdc > newMaxFeeUsdc) {
    throw new Error('min_fee_usdc must not exceed max_fee_usdc');
  }

  const oldValue = {
    fee_type: existing.fee_type,
    asset_code: existing.asset_code,
    fee_bps: existing.fee_bps,
    max_fee_usdc: existing.max_fee_usdc,
    min_fee_usdc: existing.min_fee_usdc,
    effective_from: existing.effective_from,
  };

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE fee_configs SET is_active = false WHERE fee_type = $1 AND asset_code = $2 AND is_active = true`,
      [newFeeType, newAssetCode]
    );
    await client.query(
      `UPDATE fee_configs SET is_active = false WHERE id = $1`,
      [id]
    );
    const { rows } = await client.query(
      `INSERT INTO fee_configs
         (fee_type, asset_code, fee_bps, max_fee_usdc, min_fee_usdc, is_active, created_by, effective_from)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7)
       RETURNING *`,
      [newFeeType, newAssetCode, newFeeBps, newMaxFeeUsdc, newMinFeeUsdc, createdBy, newEffectiveFrom]
    );
    await client.query('COMMIT');

    const config = rows[0];
    await refreshCache();
    await audit.auditLog({ user: { userId: createdBy, role: actorRole }, ip, headers: { 'user-agent': userAgent } }, 'fee_config_updated', {
      type: 'fee_config',
      id: config.id,
      oldValue,
      newValue: {
        fee_type: newFeeType,
        asset_code: newAssetCode,
        fee_bps: newFeeBps,
        max_fee_usdc: newMaxFeeUsdc,
        min_fee_usdc: newMinFeeUsdc,
        effective_from: newEffectiveFrom,
      },
    });
    return config;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Simulate a proposed (or existing scheduled) fee config against recent
 * historical transaction volume, without applying anything. Returns the
 * estimated fee-revenue delta versus what actually happened under the
 * currently active config for the same window.
 *
 * @param {string} feeType
 * @param {string} assetCode
 * @param {number} feeBps          - proposed fee_bps to simulate
 * @param {number} maxFeeUsdc      - proposed max_fee_usdc cap
 * @param {number} minFeeUsdc      - proposed min_fee_usdc floor
 * @param {number} [lookbackDays]  - historical window to simulate against (default 7)
 */
async function previewFeeConfig(feeType, assetCode, feeBps, maxFeeUsdc, minFeeUsdc, lookbackDays = 7) {
  if (feeBps > 1000) {
    throw new Error('fee_bps must not exceed 1000 (10% max)');
  }
  if (minFeeUsdc > maxFeeUsdc) {
    throw new Error('min_fee_usdc must not exceed max_fee_usdc');
  }

  const days = Math.min(Math.max(parseInt(lookbackDays, 10) || 7, 1), 90);
  const from = new Date();
  from.setDate(from.getDate() - days);

  const { rows } = await db.query(
    `SELECT amount, fee_amount
     FROM transactions
     WHERE created_at >= $1 AND status = 'completed' AND asset_code = $2`,
    [from, assetCode]
  );

  let actualFeeTotal = 0;
  let simulatedFeeTotal = 0;
  let volumeTotal = 0;

  for (const row of rows) {
    const amount = parseFloat(row.amount) || 0;
    const actualFee = parseFloat(row.fee_amount) || 0;
    volumeTotal += amount;
    actualFeeTotal += actualFee;

    let simulatedFee = (amount * feeBps) / 10000;
    simulatedFee = Math.max(minFeeUsdc, Math.min(maxFeeUsdc, simulatedFee));
    simulatedFeeTotal += simulatedFee;
  }

  return {
    fee_type: feeType,
    asset_code: assetCode,
    proposed: { fee_bps: feeBps, max_fee_usdc: maxFeeUsdc, min_fee_usdc: minFeeUsdc },
    window_days: days,
    transaction_count: rows.length,
    volume_total: volumeTotal,
    actual_fee_revenue: actualFeeTotal,
    simulated_fee_revenue: simulatedFeeTotal,
    estimated_delta: simulatedFeeTotal - actualFeeTotal,
  };
}

/**
 * Send a reminder notification to admins for scheduled fee configs that will
 * activate within `windowHours` hours but haven't been reminded about yet.
 * Intended to be invoked by a scheduled job (see jobs/remindScheduledFeeConfigs.js).
 */
async function findConfigsDueForReminder(windowHours = 24) {
  const { rows } = await db.query(
    `SELECT id, fee_type, asset_code, fee_bps, max_fee_usdc, min_fee_usdc, effective_from, created_by
     FROM fee_configs
     WHERE is_active = false
       AND effective_from > NOW()
       AND effective_from <= NOW() + ($1 || ' hours')::interval
       AND reminder_sent_at IS NULL
     ORDER BY effective_from ASC`,
    [windowHours]
  );
  return rows;
}

async function markReminderSent(id) {
  await db.query(
    `UPDATE fee_configs SET reminder_sent_at = NOW() WHERE id = $1`,
    [id]
  );
}

module.exports = {
  getActiveConfig,
  listAllConfigs,
  getHistory,
  createConfig,
  patchConfig,
  refreshCache,
  previewFeeConfig,
  findConfigsDueForReminder,
  markReminderSent,
};
