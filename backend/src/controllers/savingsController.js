const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { PENALTY_BPS, calculateEarlyWithdrawalPenalty } = require('../utils/savingsPenalty');

const SUPPORTED_ASSETS = ['XLM', 'USDC'];

async function create(req, res, next) {
  try {
    const { amount, asset = 'XLM', lock_period_days } = req.body;
    const userId = req.user.userId;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }

    if (!SUPPORTED_ASSETS.includes(asset)) {
      return res.status(400).json({ error: `Asset must be one of ${SUPPORTED_ASSETS.join(', ')}` });
    }

    const lockPeriodDays = parseInt(lock_period_days, 10);
    if (![7, 30, 90, 180, 365].includes(lockPeriodDays)) {
      return res.status(400).json({ error: 'Invalid lock period' });
    }

    // Vault amount plus funds already locked in other vaults must not exceed the wallet balance.
    const wallet = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
      [userId]
    );
    if (!wallet.rows[0]) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    const locked = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM savings_vaults
       WHERE user_id = $1 AND asset = $2 AND status = 'locked'`,
      [userId, asset]
    );
    const { checkSufficientBalance } = require('./paymentController');
    try {
      await checkSufficientBalance(
        wallet.rows[0].public_key,
        parseFloat(amount) + parseFloat(locked.rows[0].total),
        asset
      );
    } catch (balanceErr) {
      if (balanceErr.status === 400) {
        return res.status(400).json({ error: balanceErr.message, ...balanceErr.payload });
      }
      throw balanceErr;
    }

    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    const unlockTimestamp = now + lockPeriodDays * 24 * 60 * 60;

    const result = await db.query(
      `INSERT INTO savings_vaults (id, user_id, amount, asset, lock_period_days, unlock_timestamp, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'locked')
       RETURNING id, amount, asset, lock_period_days, unlock_timestamp, status, created_at`,
      [id, userId, amount, asset, lockPeriodDays, unlockTimestamp]
    );

    res.status(201).json({ vault: result.rows[0], message: 'Savings vault created' });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const userId = req.user.userId;

    const result = await db.query(
      `SELECT id, amount, asset, lock_period_days, unlock_timestamp, status, created_at
       FROM savings_vaults
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json({ vaults: result.rows });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/savings/:id/withdraw-quote
 * Pre-flight quote: computes the exact early-withdrawal penalty for a vault
 * without executing the withdrawal, using the same formula/constant as
 * withdraw() below and the savings-vault contract's penalty_bps.
 */
async function getWithdrawQuote(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const vault = await db.query(
      `SELECT * FROM savings_vaults WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (!vault.rows.length) {
      return res.status(404).json({ error: 'Vault not found' });
    }

    const v = vault.rows[0];
    if (v.status === 'withdrawn') {
      return res.status(400).json({ error: 'Vault already withdrawn' });
    }

    const now = Math.floor(Date.now() / 1000);
    const isEarly = now < v.unlock_timestamp;
    const penalty = isEarly ? calculateEarlyWithdrawalPenalty(v.amount) : 0;
    const payout = parseFloat(v.amount) - penalty;

    res.json({
      vault_id: v.id,
      amount: v.amount,
      early_withdrawal: isEarly,
      penalty_bps: PENALTY_BPS,
      penalty: penalty.toFixed(7),
      payout: payout.toFixed(7),
      unlock_timestamp: v.unlock_timestamp,
    });
  } catch (err) {
    next(err);
  }
}

async function withdraw(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const vault = await db.query(
      `SELECT * FROM savings_vaults WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (!vault.rows.length) {
      return res.status(404).json({ error: 'Vault not found' });
    }

    const v = vault.rows[0];

    if (v.status === 'withdrawn') {
      return res.status(400).json({ error: 'Vault already withdrawn' });
    }

    const now = Math.floor(Date.now() / 1000);
    const isEarly = now < v.unlock_timestamp;
    const penalty = isEarly ? calculateEarlyWithdrawalPenalty(v.amount) : 0;
    const payout = parseFloat(v.amount) - penalty;

    // Conditional update so concurrent withdrawals can't both succeed.
    const updated = await db.query(
      `UPDATE savings_vaults SET status = 'withdrawn', withdrawn_at = NOW(), early_withdrawal = $1, penalty_amount = $2
       WHERE id = $3 AND status = 'locked' RETURNING id`,
      [isEarly, penalty, id]
    );
    if (!updated.rows.length) {
      return res.status(400).json({ error: 'Vault already withdrawn' });
    }

    res.json({
      message: isEarly
        ? `Early withdrawal processed with ${PENALTY_BPS / 100}% penalty`
        : 'Vault withdrawn successfully',
      vault: {
        id: v.id,
        amount: v.amount,
        payout: payout.toFixed(7),
        penalty: penalty.toFixed(7),
        early_withdrawal: isEarly,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, list, withdraw, getWithdrawQuote };
