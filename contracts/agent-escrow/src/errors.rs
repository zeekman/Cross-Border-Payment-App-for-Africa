//! Typed error codes for the agent escrow contract (SC-212).
//!
//! Codes are part of the public ABI: they are stable, documented in the
//! contract README and mirrored in `backend/src/config/contractErrors.json`.
//! Never renumber or reuse a code; append new variants at the end.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `initialize` was already called.
    AlreadyInitialized = 1,
    /// Caller is not the admin.
    Unauthorized = 2,
    /// No escrow with this id.
    EscrowNotFound = 3,
    /// Escrow is not in `Pending` status.
    EscrowNotPending = 4,
    /// Escrow is past its expiry.
    EscrowExpired = 5,
    /// Amount must be positive.
    InvalidAmount = 6,
    /// `fee_bps` exceeds 10000.
    FeeTooHigh = 7,
    /// Agent is not registered.
    AgentNotRegistered = 8,
    /// Agent list capacity reached.
    AgentListFull = 9,
    /// New agent is the current agent.
    SameAgent = 10,
    /// Caller is not the escrow agent.
    NotAgent = 11,
    /// Caller is not the escrow sender.
    NotSender = 12,
    /// Release is larger than the remaining balance.
    ReleaseExceedsBalance = 13,
    /// Cancellation window has not elapsed.
    CancellationWindowActive = 14,
    /// Cannot withdraw to the contract itself.
    InvalidRecipient = 15,
    /// Not enough accumulated fees.
    InsufficientFees = 16,
    /// New admin must differ from the current admin.
    SameAdmin = 17,
    /// Insurance contribution rate exceeds 1000 bps.
    ContributionRateTooHigh = 18,
    /// Insurance payout requires a `Cancelled` escrow.
    EscrowNotCancelled = 19,
    /// No outstanding loss recorded for this escrow.
    NoOutstandingLoss = 20,
    /// Insurance fund balance is too low.
    InsufficientInsuranceFund = 21,
}
