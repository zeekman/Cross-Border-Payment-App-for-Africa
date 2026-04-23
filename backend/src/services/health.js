const db = require('../db');
const { withTimeout } = require('../utils/withTimeout');
const stellar = require('./stellar');

async function checkDatabase() {
  try {
    await withTimeout(db.query('SELECT 1'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Dependency probes for load balancers. Never includes internal error messages.
 */
async function runHealthChecks() {
  const [dbOk, stellarOk] = await Promise.all([
    checkDatabase(),
    stellar.checkHorizonHealth(),
  ]);

  const ok = dbOk && stellarOk;
  return {
    status: ok ? 'ok' : 'degraded',
    db: dbOk ? 'ok' : 'down',
    stellar: stellarOk ? 'ok' : 'down',
    network: process.env.STELLAR_NETWORK || 'testnet',
  };
}

module.exports = { runHealthChecks };
