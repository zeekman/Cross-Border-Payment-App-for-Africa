const db = require('../db');

const FRAUD_RULES = {
  VELOCITY_TRANSACTIONS: {
    limit: parseInt(process.env.FRAUD_VELOCITY_LIMIT || '5'),
    window: parseInt(process.env.FRAUD_VELOCITY_WINDOW || '10') // minutes
  },
  LARGE_TRANSACTION: {
    multiplier: parseFloat(process.env.FRAUD_LARGE_TX_MULTIPLIER || '3')
  },
  UNIQUE_RECIPIENTS: {
    limit: parseInt(process.env.FRAUD_UNIQUE_RECIPIENTS || '5'),
    window: parseInt(process.env.FRAUD_UNIQUE_RECIPIENTS_WINDOW || '60') // minutes
  },
  DAILY_LIMIT: {
    amount: parseFloat(process.env.FRAUD_DAILY_LIMIT_USD || '10000')
  }
};

async function checkVelocity(walletAddress) {
  const result = await db.query(
    `SELECT COUNT(*) FROM transactions
     WHERE sender_wallet = $1 AND created_at > NOW() - INTERVAL '${FRAUD_RULES.VELOCITY_TRANSACTIONS.window} minutes'`,
    [walletAddress]
  );
  const count = parseInt(result.rows[0].count);
  if (count >= FRAUD_RULES.VELOCITY_TRANSACTIONS.limit) {
    return { blocked: true, reason: `Exceeded ${FRAUD_RULES.VELOCITY_TRANSACTIONS.limit} transactions in ${FRAUD_RULES.VELOCITY_TRANSACTIONS.window} minutes` };
  }
  return { blocked: false };
}

async function checkLargeTransaction(walletAddress, amount, asset) {
  const result = await db.query(
    `SELECT AVG(amount) as avg_amount FROM transactions
     WHERE sender_wallet = $1 AND asset = $2 AND created_at > NOW() - INTERVAL '30 days'`,
    [walletAddress, asset]
  );
  
  const avgAmount = parseFloat(result.rows[0]?.avg_amount || 0);
  if (avgAmount > 0 && amount > avgAmount * FRAUD_RULES.LARGE_TRANSACTION.multiplier) {
    return { blocked: true, reason: `Transaction exceeds ${FRAUD_RULES.LARGE_TRANSACTION.multiplier}x average (${avgAmount} ${asset})` };
  }
  return { blocked: false };
}

async function checkUniqueRecipients(walletAddress) {
  const result = await db.query(
    `SELECT COUNT(DISTINCT recipient_wallet) FROM transactions
     WHERE sender_wallet = $1 AND created_at > NOW() - INTERVAL '${FRAUD_RULES.UNIQUE_RECIPIENTS.window} minutes'`,
    [walletAddress]
  );
  const count = parseInt(result.rows[0].count);
  if (count >= FRAUD_RULES.UNIQUE_RECIPIENTS.limit) {
    return { blocked: true, reason: `Sending to ${count} unique recipients in ${FRAUD_RULES.UNIQUE_RECIPIENTS.window} minutes` };
  }
  return { blocked: false };
}

async function checkDailyLimit(walletAddress, amount, asset) {
  const XLM_USD_RATE = parseFloat(process.env.XLM_USD_RATE || '0.11');
  const amountUSD = asset === 'USDC' ? parseFloat(amount) : parseFloat(amount) * XLM_USD_RATE;

  const result = await db.query(
    `SELECT SUM(CASE WHEN asset = 'USDC' THEN amount ELSE amount * $2 END) as total_usd
     FROM transactions
     WHERE sender_wallet = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [walletAddress, XLM_USD_RATE]
  );

  const totalUSD = parseFloat(result.rows[0]?.total_usd || 0) + amountUSD;
  if (totalUSD > FRAUD_RULES.DAILY_LIMIT.amount) {
    return { blocked: true, reason: `Daily limit exceeded: $${totalUSD.toFixed(2)} > $${FRAUD_RULES.DAILY_LIMIT.amount}` };
  }
  return { blocked: false };
}

async function checkFraud(walletAddress, amount, asset) {
  const checks = [
    await checkVelocity(walletAddress),
    await checkLargeTransaction(walletAddress, amount, asset),
    await checkUniqueRecipients(walletAddress),
    await checkDailyLimit(walletAddress, amount, asset)
  ];

  const blocked = checks.find(c => c.blocked);
  return blocked || { blocked: false };
}

async function logFraudBlock(walletAddress, reason, amount, asset) {
  await db.query(
    `INSERT INTO fraud_blocks (wallet_address, reason, amount, asset)
     VALUES ($1, $2, $3, $4)`,
    [walletAddress, reason, amount, asset]
  );
}

module.exports = {
  checkFraud,
  logFraudBlock,
  FRAUD_RULES
};
