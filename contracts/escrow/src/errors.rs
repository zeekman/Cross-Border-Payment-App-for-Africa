//! Typed error codes for the escrow contract (SC-212).
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
    /// Caller is not the admin.
    Unauthorized = 3,
    /// No escrow with this id.
    EscrowNotFound = 4,
    /// Escrow is not in `Pending` status.
    EscrowNotPending = 5,
    /// Escrow is past its expiry.
    EscrowExpired = 6,
    /// Escrow has not reached its expiry yet.
    EscrowNotExpired = 7,
    /// Amount must be positive.
    InvalidAmount = 8,
    /// Amount is below the 100-stroop minimum.
    AmountBelowMinimum = 9,
    /// Amount is above the maximum escrow amount.
    AmountAboveMaximum = 10,
    /// Sender, recipient and agent must be distinct.
    PartiesNotDistinct = 11,
    /// Sender has no valid KYC attestation (or no KYC contract is configured).
    SenderKycRequired = 12,
    /// Agent has no valid KYC attestation.
    AgentKycRequired = 13,
    /// Caller is not the escrow agent.
    NotAgent = 14,
    /// Caller is not the escrow sender.
    NotSender = 15,
    /// Caller is neither sender nor recipient.
    NotParty = 16,
    /// Fee exceeds the allowed maximum.
    FeeTooHigh = 17,
    /// Configured platform fee exceeds `max_fee_bps`.
    PlatformFeeExceedsMax = 18,
    /// Fee on an existing escrow can only be lowered.
    FeeCanOnlyDecrease = 19,
    /// Partial release is larger than the escrow balance.
    ReleaseExceedsBalance = 20,
    /// Delivery was already confirmed.
    DeliveryAlreadyConfirmed = 21,
    /// Delivery is confirmed, so only the recipient may dispute.
    RecipientOnlyDispute = 22,
    /// Agent confirmed delivery, so the sender can no longer cancel.
    DeliveryConfirmed = 23,
    /// Hold period has not elapsed.
    HoldPeriodActive = 24,
    /// Hold period exceeds 7 days.
    HoldPeriodTooLong = 25,
    /// Retention period must be positive.
    InvalidRetentionPeriod = 26,
    /// Only released or cancelled escrows can be cleaned up.
    NotCleanable = 27,
    /// Retention period has not elapsed.
    RetentionNotElapsed = 28,
    /// Escrow is not under dispute.
    NotUnderDispute = 29,
    /// No dispute-resolution contract is configured.
    DisputeContractNotSet = 30,
    /// Escrow has no recorded dispute.
    DisputeNotFound = 31,
    /// Not enough accumulated fees.
    InsufficientFees = 32,
    /// Batch has more than 20 entries.
    BatchTooLarge = 33,
    /// Batch is empty.
    BatchEmpty = 34,
}
