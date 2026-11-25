/**
 * Loyalty Mint Queue
 *
 * Durable queue backing on-chain loyalty point minting. Payments enqueue a
 * row here instead of firing the Soroban call inline, so a transient RPC
 * failure (or a permanently-failing mint) can't silently drop points or
 * block the request path. backend/src/jobs/loyaltyMintJob.js drains it.
 */

const db = require('../db');

async function enqueueMint({ transactionId, userId, walletAddress, amount, asset }) {
  await db.query(
    `INSERT INTO loyalty_mint_queue (id, user_id, sender_wallet, amount, asset)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [transactionId, userId, walletAddress, amount, asset],
  );
}

module.exports = { enqueueMint };
