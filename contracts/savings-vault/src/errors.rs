//! Typed error codes for the savings vault contract (SC-212).
//!
//! Codes are part of the public ABI: they are stable, documented in the
//! contract README and mirrored in `backend/src/config/contractErrors.json`.
//! Never renumber or reuse a code; append new variants at the end.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `initialize` has not been called.
    NotInitialized = 1,
    /// `initialize` was already called.
    AlreadyInitialized = 2,
    /// Caller is not the admin / authorized distributor.
    Unauthorized = 3,
    /// No vault with this id for this user.
    VaultNotFound = 4,
    /// Amount must be positive.
    InvalidAmount = 5,
    /// Amount exceeds the maximum deposit bound.
    AmountAboveMaximum = 6,
    /// Unlock time must be in the future.
    UnlockTimeInPast = 7,
    /// Lock period is outside the configured bounds.
    LockPeriodOutOfRange = 8,
    /// Vault balance is too low.
    InsufficientBalance = 9,
    /// Interest rate exceeds 2000 bps.
    InterestRateTooHigh = 10,
    /// No interest rate is configured.
    InterestRateNotSet = 11,
    /// Deposits are disabled during an emergency.
    DepositsDisabled = 12,
    /// An emergency is already announced.
    EmergencyAlreadyAnnounced = 13,
    /// No emergency is announced.
    NoEmergencyAnnounced = 14,
    /// Emergency withdrawal delay has not elapsed.
    EmergencyDelayActive = 15,
    /// Emergency delay already elapsed; cannot cancel.
    EmergencyDelayElapsed = 16,
    /// Emergency mode is already active.
    EmergencyAlreadyActive = 17,
    /// Emergency mode is not active.
    NoEmergencyActive = 18,
    /// Emergency return requires 48h since activation.
    EmergencyReturnTooEarly = 19,
    /// Nothing to pay out in an emergency withdrawal.
    NoBalanceToWithdraw = 20,
    /// Nothing to return in an emergency return.
    NoBalanceToReturn = 21,
    /// No distributed yield to claim.
    NoYieldToClaim = 22,
    /// `min_secs` must be less than `max_secs`.
    InvalidLockBounds = 23,
    /// No fee distributor is configured.
    FeeDistributorNotSet = 24,
    /// No yield distributor is configured.
    YieldDistributorNotSet = 25,
}
