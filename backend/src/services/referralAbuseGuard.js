'use strict';

const db = require('../db');

const MAX_REFERRAL_CHAIN_DEPTH = 20;

/**
 * Detects referral-reward abuse before a reward/credit is issued:
 *   - self-referral: the referrer and referee are the same account, or two
 *     accounts sharing KYC identity signals (id_type + id_number_last4 +
 *     date_of_birth) — i.e. the same real person operating both accounts.
 *   - circular referral chains: walking up the referrer's referred_by chain
 *     leads back to the referee (or loops), which would let a ring of
 *     accounts farm rewards off each other.
 *
 * @param {string} referrerId    - account that would receive the reward
 * @param {string} refereeUserId - account whose action (payment) triggered it
 * @returns {Promise<string|null>} abuse reason, or null if the referral is clean
 */
async function detectReferralAbuse(referrerId, refereeUserId) {
  if (!referrerId || !refereeUserId) return null;
  if (referrerId === refereeUserId) return 'self_referral';

  const identity = await db.query(
    `SELECT id, kyc_data->>'id_type' AS id_type,
            kyc_data->>'id_number_last4' AS id_last4,
            kyc_data->>'date_of_birth' AS dob
       FROM users WHERE id = ANY($1::uuid[])`,
    [[referrerId, refereeUserId]],
  );
  const byId = {};
  for (const row of identity.rows) byId[row.id] = row;
  const referrer = byId[referrerId];
  const referee = byId[refereeUserId];
  if (
    referrer?.id_type && referrer.id_last4 && referrer.dob &&
    referrer.id_type === referee?.id_type &&
    referrer.id_last4 === referee?.id_last4 &&
    referrer.dob === referee?.dob
  ) {
    return 'kyc_identity_match';
  }

  // Walk the referrer's referred_by chain looking for the referee (or a
  // repeated node), which would indicate a circular referral ring.
  let currentId = referrerId;
  const visited = new Set([referrerId]);
  for (let hop = 0; hop < MAX_REFERRAL_CHAIN_DEPTH; hop++) {
    const { rows } = await db.query('SELECT referred_by FROM users WHERE id = $1', [currentId]);
    const referredByCode = rows[0]?.referred_by;
    if (!referredByCode) break;

    const parent = await db.query('SELECT id FROM users WHERE referral_code = $1', [referredByCode]);
    const parentId = parent.rows[0]?.id;
    if (!parentId) break;
    if (parentId === refereeUserId || visited.has(parentId)) return 'circular_chain';
    visited.add(parentId);
    currentId = parentId;
  }

  return null;
}

module.exports = { detectReferralAbuse };
