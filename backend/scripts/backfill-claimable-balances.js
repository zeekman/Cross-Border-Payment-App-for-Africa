const db = require('../src/db');
const {
  getEffectsForTransaction,
  getClaimableBalanceExpiry,
  getClaimableBalanceRecord,
} = require('../src/services/stellar');

function amountFromTransaction(transaction, balance) {
  if (balance?.amount != null) return balance.amount;
  const feeBreakdown = typeof transaction.fee_breakdown === 'string'
    ? JSON.parse(transaction.fee_breakdown)
    : transaction.fee_breakdown;
  return feeBreakdown?.net_amount_usdc ?? transaction.amount;
}

async function backfillClaimableBalances() {
  const { rows: transactions } = await db.query(
    `SELECT t.id, t.tx_hash, t.sender_wallet, t.recipient_wallet, t.amount, t.asset,
            t.fee_breakdown, t.status, w.user_id
     FROM transactions AS t
     LEFT JOIN wallets AS w ON w.public_key = t.sender_wallet
     WHERE (t.status = 'pending_claim' OR t.claimable_balance_id IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM claimable_balances AS cb
         WHERE cb.balance_id = t.claimable_balance_id
       )
     ORDER BY t.created_at ASC`,
  );

  let inserted = 0;
  let skipped = 0;
  for (const transaction of transactions) {
    try {
      const effects = await getEffectsForTransaction(transaction.tx_hash);
      const createdEffect = effects.records?.find((effect) => effect.type === 'claimable_balance_created');
      if (!createdEffect?.balance_id) {
        skipped += 1;
        continue;
      }

      const balanceId = createdEffect.balance_id;
      const claimedEffect = effects.records?.find((effect) => effect.type === 'claimable_balance_claimed');
      const reclaimedEffect = effects.records?.find((effect) => effect.type === 'claimable_balance_clawed_back');
      let balance = null;
      try {
        balance = await getClaimableBalanceRecord(balanceId);
      } catch (err) {
        if (err.response?.status !== 404 && err.status !== 404) throw err;
      }

      const status = reclaimedEffect ? 'reclaimed' : claimedEffect ? 'claimed' : 'active';
      const expiry = balance ? getClaimableBalanceExpiry(balance) : null;
      const expiresAt = balance?.expires_at || expiry;
      const amount = amountFromTransaction(transaction, balance);

      await db.query(
        `WITH inserted_balance AS (
           INSERT INTO claimable_balances
             (balance_id, user_id, asset, amount, claimant_wallet, expires_at, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (balance_id) DO NOTHING
           RETURNING balance_id
         )
         UPDATE transactions AS t
         SET claimable_balance_id = $1,
             status = CASE $7
               WHEN 'claimed' THEN 'completed'
               WHEN 'reclaimed' THEN 'reclaimed'
               ELSE t.status
             END,
             confirmed_at = CASE WHEN $7 IN ('claimed', 'reclaimed') THEN NOW() ELSE t.confirmed_at END
         WHERE t.id = $8`,
        [balanceId, transaction.user_id, transaction.asset, amount, transaction.recipient_wallet, expiresAt, status, transaction.id],
      );
      inserted += 1;
    } catch (err) {
      console.error(`Failed to backfill transaction ${transaction.id}: ${err.message}`);
    }
  }

  return { scanned: transactions.length, inserted, skipped };
}

if (require.main === module) {
  backfillClaimableBalances()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((err) => {
      console.error(`Claimable balance backfill failed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => db.pool.end());
}

module.exports = { backfillClaimableBalances, amountFromTransaction };