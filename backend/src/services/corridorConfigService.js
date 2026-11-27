'use strict';

const db = require('../db');

const VALID_TIERS = ['basic', 'enhanced', 'business'];
const VALID_ASSETS = ['XLM', 'USDC', 'NGN', 'GHS', 'KES'];

function normalizeCountryCode(value) {
  if (typeof value !== 'string' || !/^[A-Z]{2}$/i.test(value.trim())) return null;
  return value.trim().toUpperCase();
}

function validateConfig(config) {
  const originCountry = normalizeCountryCode(config.origin_country);
  const destinationCountry = normalizeCountryCode(config.destination_country);
  if (!originCountry || !destinationCountry) {
    throw Object.assign(new Error('origin_country and destination_country must be ISO alpha-2 codes'), { status: 400 });
  }
  if (!VALID_TIERS.includes(config.required_kyc_tier)) {
    throw Object.assign(new Error(`required_kyc_tier must be one of: ${VALID_TIERS.join(', ')}`), { status: 400 });
  }
  if (!Array.isArray(config.allowed_assets) || config.allowed_assets.length === 0) {
    throw Object.assign(new Error('allowed_assets must contain at least one asset'), { status: 400 });
  }
  const assets = [...new Set(config.allowed_assets.map((asset) => String(asset).toUpperCase()))];
  if (assets.some((asset) => !VALID_ASSETS.includes(asset))) {
    throw Object.assign(new Error(`allowed_assets may contain only: ${VALID_ASSETS.join(', ')}`), { status: 400 });
  }
  for (const field of [
    'daily_limit_usd',
    'single_transaction_limit_usd',
    'kyc_threshold_usd',
    'phone_verification_threshold_usd',
  ]) {
    const value = config[field];
    if (value !== null && value !== undefined && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
      throw Object.assign(new Error(`${field} must be a non-negative number or null`), { status: 400 });
    }
  }
  return { originCountry, destinationCountry, assets };
}

async function getCorridorConfig(originCountry, destinationCountry) {
  const origin = normalizeCountryCode(originCountry);
  const destination = normalizeCountryCode(destinationCountry);
  if (!origin || !destination) return null;

  const { rows } = await db.query(
    `SELECT id, origin_country, destination_country, daily_limit_usd,
            single_transaction_limit_usd, kyc_threshold_usd,
            phone_verification_threshold_usd, required_kyc_tier, allowed_assets, is_active
     FROM corridor_configs
     WHERE origin_country = $1 AND destination_country = $2
     LIMIT 1`,
    [origin, destination]
  );
  return rows[0] || null;
}

async function getUserCorridorConfig(userId, recipientPublicKey) {
  const { rows } = await db.query(
    `SELECT sender.country_code AS origin_country,
            recipient.country_code AS destination_country
     FROM users AS sender
     LEFT JOIN wallets AS recipient_wallet ON recipient_wallet.public_key = $2
     LEFT JOIN users AS recipient ON recipient.id = recipient_wallet.user_id
     WHERE sender.id = $1
     LIMIT 1`,
    [userId, recipientPublicKey]
  );
  const countries = rows[0];
  if (!countries) return null;
  return getCorridorConfig(countries.origin_country, countries.destination_country);
}

async function listCorridorConfigs() {
  const { rows } = await db.query(
    `SELECT id, origin_country, destination_country, daily_limit_usd,
            single_transaction_limit_usd, kyc_threshold_usd,
            phone_verification_threshold_usd, required_kyc_tier, allowed_assets,
            is_active, created_by, created_at, updated_at
     FROM corridor_configs
     ORDER BY origin_country, destination_country`
  );
  return rows;
}

async function upsertCorridorConfig(config, createdBy) {
  const { originCountry, destinationCountry, assets } = validateConfig(config);
  const { rows } = await db.query(
    `INSERT INTO corridor_configs
       (origin_country, destination_country, daily_limit_usd, single_transaction_limit_usd,
        kyc_threshold_usd, phone_verification_threshold_usd, required_kyc_tier,
        allowed_assets, is_active, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (origin_country, destination_country) DO UPDATE SET
       daily_limit_usd = EXCLUDED.daily_limit_usd,
       single_transaction_limit_usd = EXCLUDED.single_transaction_limit_usd,
       kyc_threshold_usd = EXCLUDED.kyc_threshold_usd,
       phone_verification_threshold_usd = EXCLUDED.phone_verification_threshold_usd,
       required_kyc_tier = EXCLUDED.required_kyc_tier,
       allowed_assets = EXCLUDED.allowed_assets,
       is_active = EXCLUDED.is_active,
       created_by = EXCLUDED.created_by,
       updated_at = NOW()
     RETURNING *`,
    [
      originCountry,
      destinationCountry,
      config.daily_limit_usd ?? null,
      config.single_transaction_limit_usd ?? null,
      config.kyc_threshold_usd ?? null,
      config.phone_verification_threshold_usd ?? null,
      config.required_kyc_tier,
      assets,
      config.is_active !== false,
      createdBy || null,
    ]
  );
  return rows[0];
}

module.exports = {
  VALID_TIERS,
  normalizeCountryCode,
  getCorridorConfig,
  getUserCorridorConfig,
  listCorridorConfigs,
  upsertCorridorConfig,
};
