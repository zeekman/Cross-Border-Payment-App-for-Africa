'use strict';

/**
 * Shared early-withdrawal penalty calculation for savings vaults.
 *
 * Mirrors the `savings-vault` Soroban contract's withdraw() formula exactly
 * (contracts/savings-vault/src/lib.rs):
 *   penalty = (amount * penalty_bps) / 10000
 *
 * Both the pre-flight quote endpoint (savingsController.getWithdrawQuote)
 * and the actual withdrawal (savingsController.withdraw) call this single
 * helper so the quoted penalty can never drift from what's charged.
 */
const PENALTY_BPS = parseInt(process.env.SAVINGS_EARLY_WITHDRAWAL_PENALTY_BPS || '1000', 10);

function calculateEarlyWithdrawalPenalty(amount) {
  const amt = parseFloat(amount);
  return (amt * PENALTY_BPS) / 10000;
}

module.exports = { PENALTY_BPS, calculateEarlyWithdrawalPenalty };
