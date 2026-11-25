use soroban_sdk::{contracttype, Address, BytesN, String, Vec};

/// Status of a dispute throughout its lifecycle.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DisputeStatus {
    /// Dispute has been opened and is awaiting a resolution.
    Open,
    /// A resolution has been proposed and is awaiting finalization.
    Resolved,
    /// The dispute has been finalized and funds distributed.
    Finalized,
    /// The dispute expired without resolution and funds were refunded.
    Expired,
    /// The dispute was cancelled by the opener.
    Cancelled,
}

/// A dispute over a payment between a sender and a recipient.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispute {
    /// Unique identifier for the dispute.
    pub id: u64,
    /// Address that opened the dispute.
    pub opener: Address,
    /// Address that supplied (and therefore owns) the locked funds.
    /// This is the address from which `amount + filing_fee` was pulled when
    /// the dispute was opened, and the address refunded on expiry.
    pub funds_owner: Address,
    /// The counterparty designated as the sender of the disputed payment.
    pub sender: Address,
    /// The counterparty designated as the recipient of the disputed payment.
    pub recipient: Address,
    /// Amount locked in the dispute.
    pub amount: i128,
    /// Filing fee paid when the dispute was opened.
    pub filing_fee: i128,
    /// Current status of the dispute.
    pub status: DisputeStatus,
    /// Ledger timestamp at which the dispute was opened.
    pub opened_at: u64,
    /// Ledger timestamp at which the dispute expires if unresolved.
    pub expires_at: u64,
    /// Optional evidence hash supplied by the opener.
    pub evidence_hash: Option<BytesN<32>>,
    /// Optional human-readable reason for the dispute.
    pub reason: Option<String>,
    /// Votes cast by arbiters, if any.
    pub votes: Vec<Address>,
}
