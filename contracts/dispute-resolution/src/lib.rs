#![no_std]

//! # Dispute Resolution Contract
//!
//! On-chain three-party dispute resolution for AfriPay cross-border payments.
//!
//! ## Parties
//! - **Sender**          — initiated the payment / escrow
//! - **Recipient**       — the intended beneficiary
//! - **Arbitrator**      — neutral third party (platform-appointed) who resolves disputes
//!                         via [`resolve_dispute`] OR participates in the panel via
//!                         [`cast_vote`]
//! - **SuperArbitrator** — elevated authority who handles appeals
//! - **Agent**           — (escrow disputes only) the payout agent who pays the
//!                         recipient in fiat. May submit evidence, appeal, and be
//!                         awarded the funds via [`resolve_dispute_for_agent`] /
//!                         [`resolve_appeal_for_agent`]. The multi-arbitrator panel
//!                         votes only for sender or recipient.
//!
//! ## Flow (single-arbitrator path)
//! 1. Either party calls [`open_dispute`] — escrowed funds are locked for arbitration.
//! 2. Sender or recipient calls [`submit_evidence`] with an IPFS CID or text hash.
//! 3. Arbitrator reviews evidence off-chain, then calls [`resolve_dispute`] to
//!    transition the dispute to `Appealing` status and start a 24-hour appeal window.
//! 4. During the appeal window, either party may call [`appeal`] to escalate to the
//!    super-arbitrator (`UnderAppeal` status).
//! 5a. If no appeal is filed by `appeal_deadline`, anyone may call [`finalize_resolution`]
//!     to release funds to the arbitrator's chosen winner.
//! 5b. If an appeal was filed, the super-arbitrator calls [`resolve_appeal`] for the
//!     final binding decision.
//! 6. Disputes not resolved within 7 days expire and the sender may reclaim funds
//!    via [`claim_expired`].
//!
//! ## Flow (multi-arbitrator panel path)
//! 1-2. Same as above.
//! 3. Each panel member calls [`cast_vote`] on the open dispute.
//! 4. After every vote, the contract tallies votes and checks whether the configured
//!    quorum (in basis points) has been reached.
//! 5. Once quorum is reached the funds are released immediately and the dispute is
//!    marked `ResolvedForRecipient` or `ResolvedForSender`.

use soroban_sdk::{
    contract, contractimpl, contracttype, token, Address, Bytes, Env, Symbol, Vec,
};

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_budget;

// ── Constants ─────────────────────────────────────────────────────────────────

/// 7-day resolution deadline in seconds.
const RESOLUTION_DEADLINE_SECS: u64 = 7 * 24 * 60 * 60;

/// 24-hour appeal window in seconds.
const APPEAL_WINDOW_SECS: u64 = 24 * 60 * 60;

/// Maximum number of arbitrators in the panel.
const MAX_ARBITRATORS: u32 = 7;

/// Default quorum threshold in basis points (6001 = strictly more than 60 %).
const DEFAULT_QUORUM_BPS: u32 = 6_001;

// ── TTL policy ────────────────────────────────────────────────────────────────
//
// Instance storage (global config) is bumped to ~30 days on every call and is
// re-extended once it drops below ~7 days. Persistent records (disputes,
// votes, per-user indexes) are bumped to ~30 days whenever they are read or
// written, with the same ~7-day threshold.

/// Target TTL for instance storage (~30 days at 5s ledgers).
const INSTANCE_BUMP_AMOUNT: u32 = 30 * 24 * 60 * 12;
/// Re-extend instance storage once its TTL falls below ~7 days.
const INSTANCE_LIFETIME_THRESHOLD: u32 = 7 * 24 * 60 * 12;
/// Target TTL for persistent records (~30 days at 5s ledgers).
const PERSISTENT_BUMP_AMOUNT: u32 = 30 * 24 * 60 * 12;
/// Re-extend persistent records once their TTL falls below ~7 days.
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 7 * 24 * 60 * 12;

// ── Storage keys ──────────────────────────────────────────────────────────────

#[derive(Debug)]
#[contracttype]
pub enum DataKey {
    Admin,
    Arbitrator,
    PendingArbitrator,
    UsdcAddress,
    MaxEvidenceBytes,
    Counter,
    Dispute(u64),
    /// Address of the super-arbitrator who handles escalated appeals.
    SuperArbitrator,
    /// Vec<Address> of panel arbitrators (max 7).
    Arbitrators,
    /// Required majority threshold in basis points (e.g. 6001 = >60 %).
    QuorumBps,
    /// The filing fee (in stroops) required to open a dispute.
    FilingFee,
    /// Address that receives forfeited filing fees when the opener loses.
    FeeDistributorAddress,
    /// The address that paid the filing fee for a given dispute.
    FilingFeeHolder(u64),
    /// The filing fee amount actually paid for a given dispute. Stored so a
    /// later `update_filing_fee` cannot change what is refunded or forfeited.
    FilingFeePaid(u64),
    /// Individual vote cast by one panel arbitrator on a dispute.
    /// Value is `bool`: `true` = for recipient, `false` = for sender.
    Vote(u64, Address),
    /// Vec<u64> of dispute IDs for a user (as sender or recipient).
    /// Bounded to 1000 entries per user (circular buffer).
    UserDisputes(Address),
    /// Total number of disputes opened (for admin pagination).
    TotalDisputes,
    /// Address of the escrow contract authorised to push funds into disputes
    /// via [`open_escrow_dispute`]. Set by the admin during setup.
    EscrowContract,
    /// Payout agent of an escrow-backed dispute. Absent for free-form disputes.
    DisputeAgent(u64),
    /// `true` if the agent had confirmed fiat delivery before the escrow
    /// dispute was opened. Unresolved disputes then default to the agent.
    PayoutConfirmed(u64),
    /// Evidence (IPFS CID / hash) submitted by the agent of an escrow dispute.
    AgentEvidence(u64),
    /// Present while the pending (or final) ruling awards the funds to the agent.
    RulingForAgent(u64),
    /// `(escrow contract, escrow_id)` backing an escrow dispute. Used to report
    /// the outcome back via `close_disputed_escrow`.
    EscrowRef(u64),
}

// ── Domain types ──────────────────────────────────────────────────────────────

/// Lifecycle state of a dispute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[contracttype]
pub enum DisputeStatus {
    /// Opened, awaiting evidence and arbitration.
    Open,
    /// Arbitrator resolved in favour of the recipient — funds released.
    ResolvedForRecipient,
    /// Arbitrator resolved in favour of the sender — funds refunded.
    ResolvedForSender,
    /// Deadline elapsed without resolution; sender reclaimed funds.
    Expired,
    /// Arbitrator has resolved the dispute; 24-hour appeal window is open.
    /// `appeal_deadline` in the Dispute struct holds the cutoff timestamp.
    /// `resolved_for_recipient` in the Dispute struct holds the pending decision.
    Appealing,
    /// A party has filed an appeal; awaiting super-arbitrator decision.
    UnderAppeal,
    /// Resolved in favour of the payout agent of an escrow dispute — funds
    /// released to the agent.
    ResolvedForAgent,
}

/// On-chain dispute record.
#[derive(Debug, Clone)]
#[contracttype]
pub struct Dispute {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    /// USDC amount in stroops locked for this dispute.
    pub amount: i128,
    pub status: DisputeStatus,
    pub opened_at: u64,
    /// Unix timestamp after which the dispute is considered expired.
    pub deadline: u64,
    /// Optional IPFS CID / evidence hash submitted by sender (max 256 bytes).
    pub sender_evidence: Bytes,
    /// Optional IPFS CID / evidence hash submitted by recipient (max 256 bytes).
    pub recipient_evidence: Bytes,
    /// Unix timestamp after which the appeal window closes.
    /// Set to `appeal_deadline = env.ledger().timestamp() + 86400` when
    /// the arbitrator calls `resolve_dispute`. Zero when no appeal window is active.
    pub appeal_deadline: u64,
    /// Records the arbitrator's pending decision while the dispute is in
    /// `Appealing` or `UnderAppeal` status.
    /// `true`  → funds earmarked for the recipient.
    /// `false` → funds earmarked for the sender.
    /// Unused (false) for other statuses.
    pub resolved_for_recipient: bool,
}

// ── Event payloads ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtDisputeOpened {
    pub dispute_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub amount: i128,
    pub deadline: u64,
}

#[derive(Debug, Clone)]
/// Emitted by [`DisputeResolutionContract::open_escrow_dispute`] alongside
/// `DisputeOpened`, carrying the escrow-specific parties and state.
#[derive(Clone)]
#[contracttype]
pub struct EvtEscrowDisputeOpened {
    pub dispute_id: u64,
    pub agent: Address,
    pub payout_confirmed: bool,
}

/// Emitted when an unresolved dispute over a payout-confirmed escrow expires
/// and the agent claims the funds.
#[derive(Clone)]
#[contracttype]
pub struct EvtDisputeExpiredToAgent {
    pub dispute_id: u64,
    pub agent: Address,
    pub amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct EvtEvidenceSubmitted {
    pub dispute_id: u64,
    pub submitted_by: Address,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtDisputeResolved {
    pub dispute_id: u64,
    pub winner: Address,
    pub amount: i128,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtDisputeExpired {
    pub dispute_id: u64,
    pub sender: Address,
    pub refund_amount: i128,
}

/// Emitted when a party files an appeal within the 24-hour window.
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtAppealFiled {
    pub dispute_id: u64,
    pub filed_by: Address,
}

/// Emitted when a panel arbitrator casts a vote on a dispute.
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtVoteCast {
    pub dispute_id: u64,
    pub arbitrator: Address,
    /// `true` = voted for recipient; `false` = voted for sender.
    pub for_recipient: bool,
    /// Total votes cast so far for this dispute (across both sides).
    pub total_votes: u32,
}

/// Emitted when the panel reaches quorum and funds are released.
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtQuorumReached {
    pub dispute_id: u64,
    pub for_recipient: bool,
    pub winner: Address,
    pub amount: i128,
}

/// Emitted once by [`DisputeResolutionContract::initialize`].
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtInitialized {
    pub admin: Address,
    pub arbitrator: Address,
    pub usdc_address: Address,
    pub super_arbitrator: Address,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Who a ruling awards the disputed funds to.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ruling {
    Sender,
    Recipient,
    Agent,
}

/// Extend the instance (global config) TTL. Called from every entry point.
fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Extend the TTL of a persistent record that was just read or written.
fn bump_persistent<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
    env.storage().persistent().extend_ttl(
        key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

/// Read a dispute record and bump its TTL.
fn load_dispute(env: &Env, dispute_id: u64) -> Dispute {
    let dispute: Dispute = env
        .storage()
        .persistent()
        .get(&DataKey::Dispute(dispute_id))
        .expect("dispute not found");
    bump_persistent(env, &DataKey::Dispute(dispute_id));
    dispute
}

/// Write a dispute record and bump its TTL.
fn store_dispute(env: &Env, dispute: &Dispute) {
    env.storage()
        .persistent()
        .set(&DataKey::Dispute(dispute.id), dispute);
    bump_persistent(env, &DataKey::Dispute(dispute.id));
}

fn dispute_agent(env: &Env, dispute_id: u64) -> Option<Address> {
    let agent: Option<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::DisputeAgent(dispute_id));
    if agent.is_some() {
        bump_persistent(env, &DataKey::DisputeAgent(dispute_id));
    }
    agent
}

fn payout_confirmed(env: &Env, dispute_id: u64) -> bool {
    let confirmed: Option<bool> = env
        .storage()
        .persistent()
        .get(&DataKey::PayoutConfirmed(dispute_id));
    if confirmed.is_some() {
        bump_persistent(env, &DataKey::PayoutConfirmed(dispute_id));
    }
    confirmed.unwrap_or(false)
}

/// Tell the escrow contract backing `dispute_id` (if any) who won, so the
/// escrow leaves `UnderDispute` and becomes eligible for cleanup (#1367).
fn notify_escrow(env: &Env, dispute_id: u64, winner: &Address) {
    let escrow_ref: Option<(Address, u64)> =
        env.storage().persistent().get(&DataKey::EscrowRef(dispute_id));
    if escrow_ref.is_some() {
        bump_persistent(env, &DataKey::EscrowRef(dispute_id));
    }
    if let Some((escrow_contract, escrow_id)) = escrow_ref {
        afripay_types::EscrowClient::new(env, &escrow_contract)
            .close_disputed_escrow(&escrow_id, winner);
    }
}

/// The ruling currently recorded on a dispute in `Appealing` status.
fn pending_ruling(env: &Env, dispute: &Dispute) -> Ruling {
    if env.storage().persistent().has(&DataKey::RulingForAgent(dispute.id)) {
        bump_persistent(env, &DataKey::RulingForAgent(dispute.id));
        Ruling::Agent
    } else if dispute.resolved_for_recipient {
        Ruling::Recipient
    } else {
        Ruling::Sender
    }
}

/// Record `ruling` as the pending decision on `dispute` (not yet persisted).
fn record_ruling(env: &Env, dispute: &mut Dispute, ruling: Ruling) {
    if ruling == Ruling::Agent {
        if dispute_agent(env, dispute.id).is_none() {
            panic!("dispute has no agent");
        }
        env.storage()
            .persistent()
            .set(&DataKey::RulingForAgent(dispute.id), &true);
        bump_persistent(env, &DataKey::RulingForAgent(dispute.id));
    } else {
        env.storage()
            .persistent()
            .remove(&DataKey::RulingForAgent(dispute.id));
    }
    dispute.resolved_for_recipient = ruling == Ruling::Recipient;
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct DisputeResolutionContract;

#[contractimpl]
impl DisputeResolutionContract {
    /// Initialise the contract. Must be called once before any other function.
    ///
    /// # Arguments
    /// * `admin`              — Address that may update the arbitrator.
    /// * `arbitrator`         — Neutral third party authorised to resolve disputes.
    /// * `usdc_address`       — Stellar asset contract address for USDC.
    /// * `max_evidence_bytes` — Maximum allowed size in bytes for submitted evidence.
    /// * `super_arbitrator`   — Address authorised to adjudicate appeals.
    pub fn initialize(
        env: Env,
        admin: Address,
        arbitrator: Address,
        usdc_address: Address,
        max_evidence_bytes: u32,
        super_arbitrator: Address,
    ) {
        bump_instance(&env);
        // The admin must co-sign so a watcher cannot front-run the deploy
        // script and install their own admin (#1442).
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Arbitrator, &arbitrator);
        env.storage().instance().set(&DataKey::UsdcAddress, &usdc_address);
        env.storage().instance().set(&DataKey::MaxEvidenceBytes, &max_evidence_bytes);
        env.storage().instance().set(&DataKey::Counter, &0u64);
        env.storage().instance().set(&DataKey::SuperArbitrator, &super_arbitrator);
        env.storage().instance().set(&DataKey::FilingFee, &50_000000i128);
        env.storage().instance().set(&DataKey::FeeDistributorAddress, &admin);
        env.storage().instance().set(&DataKey::TotalDisputes, &0u64);
        // Initialise the arbitrator panel with an empty list and the default quorum.
        let empty: Vec<Address> = Vec::new(&env);
        env.storage().instance().set(&DataKey::Arbitrators, &empty);
        env.storage().instance().set(&DataKey::QuorumBps, &DEFAULT_QUORUM_BPS);

        env.events().publish(
            (Symbol::new(&env, "Initialized"),),
            EvtInitialized {
                admin,
                arbitrator,
                usdc_address,
                super_arbitrator,
            },
        );
    }

    /// Open a dispute, locking `amount` USDC in the contract.
    ///
    /// Either the sender or recipient may open a dispute. The caller must
    /// authorise this call and transfer the disputed USDC amount.
    ///
    /// # Arguments
    /// * `opener`    — Must be either `sender` or `recipient`.
    /// * `sender`    — Original payment sender.
    /// * `recipient` — Original payment recipient.
    /// * `amount`    — USDC amount in stroops to lock (must be > 0).
    pub fn open_dispute(
        env: Env,
        opener: Address,
        sender: Address,
        recipient: Address,
        amount: i128,
    ) -> u64 {
        bump_instance(&env);
        governance::require_not_paused(&env);
        if amount <= 0 {
            panic!("amount must be positive");
        }
        if opener != sender && opener != recipient {
            panic!("opener must be sender or recipient");
        }

        opener.require_auth();

        let usdc: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddress)
            .expect("not initialized");

        let filing_fee: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FilingFee)
            .unwrap_or(50_000000);
        let token_client = token::Client::new(&env, &usdc);
        let balance = token_client.balance(&opener);
        if balance < filing_fee {
            panic!("Insufficient balance for dispute filing fee");
        }
        if balance < amount + filing_fee {
            panic!("insufficient balance");
        }

        // Lock both the dispute amount and the filing fee in the contract
        // for the duration of the dispute.
        token_client.transfer(&opener, &env.current_contract_address(), &filing_fee);
        token_client.transfer(&opener, &env.current_contract_address(), &amount);

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Counter)
            .unwrap_or(0)
            + 1;
        env.storage().instance().set(&DataKey::Counter, &id);

        let now = env.ledger().timestamp();
        let deadline = now + RESOLUTION_DEADLINE_SECS;

        let dispute = Dispute {
            id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            amount,
            status: DisputeStatus::Open,
            opened_at: now,
            deadline,
            sender_evidence: Bytes::new(&env),
            recipient_evidence: Bytes::new(&env),
            appeal_deadline: 0,
            resolved_for_recipient: false,
        };
        store_dispute(&env, &dispute);
        Self::record_filing_fee(&env, id, &opener, filing_fee);

        // Update TotalDisputes counter
        let total_disputes: u64 = env.storage().instance().get(&DataKey::TotalDisputes).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalDisputes, &(total_disputes + 1));

        // Add dispute ID to UserDisputes for both sender and recipient (circular buffer, max 1000)
        for user in [sender.clone(), recipient.clone()] {
            let mut user_disputes: Vec<u64> = env.storage().persistent()
                .get(&DataKey::UserDisputes(user.clone()))
                .unwrap_or_else(|| Vec::new(&env));
            if user_disputes.len() >= 1000 {
                user_disputes.remove(0);
            }
            user_disputes.push_back(id);
            env.storage().persistent().set(&DataKey::UserDisputes(user.clone()), &user_disputes);
            bump_persistent(&env, &DataKey::UserDisputes(user));
        }

        env.events().publish(
            (Symbol::new(&env, "DisputeOpened"),),
            EvtDisputeOpened {
                dispute_id: id,
                sender,
                recipient,
                amount,
                deadline,
            },
        );

        id
    }

    /// Open a dispute backed by funds held in an escrow contract.
    ///
    /// Called only by the registered escrow contract, which has already
    /// moved `amount` USDC here. Like [`open_dispute`], the `opener` pays the
    /// filing fee from their own balance: refunded if they win, forfeited to
    /// the fee distributor if they lose.
    ///
    /// # Arguments
    /// * `escrow_contract` — The calling (registered) escrow contract.
    /// * `opener`          — Sender or recipient escalating; pays the fee.
    /// Cross-contract hook called by the registered escrow contract, which has
    /// already transferred `amount` USDC into this contract's custody. No
    /// filing fee is charged.
    ///
    /// The escrow's payout `agent` is a third party: it may submit evidence,
    /// appeal, and be awarded the funds. If the agent had already confirmed
    /// delivery (`payout_confirmed`), an unresolved dispute defaults to the
    /// agent on expiry instead of refunding the sender.
    ///
    /// # Arguments
    /// * `escrow_contract`  — Calling escrow contract (must be registered).
    /// * `escrow_id`        — Escrow to notify via `close_disputed_escrow` on settlement.
    /// * `sender`, `recipient`, `agent` — Escrow parties.
    /// * `amount`           — USDC (stroops) already transferred.
    /// * `payout_confirmed` — Whether the agent had called `confirm_delivery`.
    /// * `escrow_contract` — The calling escrow contract. Must match the
    ///                       registered escrow contract and authorise the call
    ///                       (`require_auth`), which it does implicitly when it
    ///                       is the direct invoker.
    /// * `sender`          — Original escrow sender.
    /// * `recipient`       — Intended escrow recipient.
    /// * `amount`          — USDC amount (in stroops) already transferred.
    pub fn open_escrow_dispute(
        env: Env,
        escrow_contract: Address,
        opener: Address,
        escrow_id: u64,
        sender: Address,
        recipient: Address,
        agent: Address,
        amount: i128,
        payout_confirmed: bool,
    ) -> u64 {
        bump_instance(&env);
        governance::require_not_paused(&env);
        if amount <= 0 {
            panic!("amount must be positive");
        }
        // A contract calling this function directly authorizes itself, so this
        // proves the call really comes from `escrow_contract`.
        // A contract calling another contract is implicitly authorized for
        // its own address, so this only passes when `escrow_contract` is the
        // direct caller.
        escrow_contract.require_auth();
        let trusted_escrow: Address = env
            .storage()
            .instance()
            .get(&DataKey::EscrowContract)
            .expect("escrow contract not set");
        if escrow_contract != trusted_escrow {
            panic!("unauthorized: escrow contract not registered");
        }
        if opener != sender && opener != recipient {
            panic!("opener must be sender or recipient");
        }

        opener.require_auth();

        let usdc: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddress)
            .expect("not initialized");
        let filing_fee: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FilingFee)
            .unwrap_or(50_000000);
        if filing_fee > 0 {
            let token_client = token::Client::new(&env, &usdc);
            if token_client.balance(&opener) < filing_fee {
                panic!("Insufficient balance for dispute filing fee");
            }
            token_client.transfer(&opener, &env.current_contract_address(), &filing_fee);
        }
        // A contract address only passes require_auth when that contract is the
        // direct invoker, so this proves the registered escrow is the caller.
        // Soroban has no implicit "msg.sender". When the escrow contract
        // invokes this function directly, its own address is authorised
        // automatically; any other invoker cannot produce this auth.
        escrow_contract.require_auth();

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Counter)
            .unwrap_or(0)
            + 1;
        env.storage().instance().set(&DataKey::Counter, &id);

        let now = env.ledger().timestamp();
        let deadline = now + RESOLUTION_DEADLINE_SECS;

        let dispute = Dispute {
            id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            amount,
            status: DisputeStatus::Open,
            opened_at: now,
            deadline,
            sender_evidence: Bytes::new(&env),
            recipient_evidence: Bytes::new(&env),
            appeal_deadline: 0,
            resolved_for_recipient: false,
        };
        store_dispute(&env, &dispute);
        Self::record_filing_fee(&env, id, &opener, filing_fee);
        env.storage().persistent().set(&DataKey::DisputeAgent(id), &agent);
        bump_persistent(&env, &DataKey::DisputeAgent(id));
        env.storage()
            .persistent()
            .set(&DataKey::PayoutConfirmed(id), &payout_confirmed);
        bump_persistent(&env, &DataKey::PayoutConfirmed(id));
        env.storage()
            .persistent()
            .set(&DataKey::EscrowRef(id), &(escrow_contract, escrow_id));
        bump_persistent(&env, &DataKey::EscrowRef(id));

        let total_disputes: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalDisputes)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalDisputes, &(total_disputes + 1));

        // Index the dispute under all three parties for pagination.
        for user in [sender.clone(), recipient.clone(), agent.clone()] {
            let mut user_disputes: Vec<u64> = env
                .storage()
                .persistent()
                .get(&DataKey::UserDisputes(user.clone()))
                .unwrap_or_else(|| Vec::new(&env));
            if user_disputes.len() >= 1000 {
                user_disputes.remove(0);
            }
            user_disputes.push_back(id);
            env.storage()
                .persistent()
                .set(&DataKey::UserDisputes(user.clone()), &user_disputes);
            bump_persistent(&env, &DataKey::UserDisputes(user));
        }

        env.events().publish(
            (Symbol::new(&env, "DisputeOpened"),),
            EvtDisputeOpened {
                dispute_id: id,
                sender,
                recipient,
                amount,
                deadline,
            },
        );
        env.events().publish(
            (Symbol::new(&env, "EscrowDisputeOpened"),),
            EvtEscrowDisputeOpened {
                dispute_id: id,
                agent,
                payout_confirmed,
            },
        );

        id
    }

    /// Submit evidence for an open dispute.
    ///
    /// Only the sender or recipient of the dispute — or, for escrow disputes,
    /// the payout agent — may submit evidence.
    /// Evidence is an IPFS CID or hash (max 256 bytes). Calling again
    /// overwrites the previous submission for that party.
    ///
    /// # Arguments
    /// * `submitter`  — Must be the dispute's sender or recipient.
    /// * `dispute_id` — ID returned by `open_dispute`.
    /// * `evidence`   — IPFS CID or content hash (max 256 bytes).
    pub fn submit_evidence(env: Env, submitter: Address, dispute_id: u64, evidence: Bytes) {
        bump_instance(&env);
        let max_evidence_bytes: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxEvidenceBytes)
            .expect("not initialized");
        if evidence.len() > max_evidence_bytes {
            panic!("evidence exceeds maximum allowed size");
        }

        submitter.require_auth();

        let mut dispute: Dispute = load_dispute(&env, dispute_id);

        if dispute.status != DisputeStatus::Open {
            panic!("dispute is not open");
        }
        if env.ledger().timestamp() >= dispute.deadline {
            panic!("dispute deadline has passed");
        }

        if submitter == dispute.sender {
            dispute.sender_evidence = evidence;
        } else if submitter == dispute.recipient {
            dispute.recipient_evidence = evidence;
        } else if dispute_agent(&env, dispute_id) == Some(submitter.clone()) {
            env.storage()
                .persistent()
                .set(&DataKey::AgentEvidence(dispute_id), &evidence);
            bump_persistent(&env, &DataKey::AgentEvidence(dispute_id));
        } else {
            panic!("submitter is not a party to this dispute");
        }

        store_dispute(&env, &dispute);

        env.events().publish(
            (Symbol::new(&env, "EvidenceSubmitted"),),
            EvtEvidenceSubmitted {
                dispute_id,
                submitted_by: submitter,
            },
        );
    }

    /// Resolve a dispute, opening a 24-hour appeal window.
    ///
    /// Only the (single) arbitrator may call this function. The arbitrator decides
    /// whether to release funds to the recipient (payment stands) or refund
    /// the sender (payment reversed). The decision is recorded but funds are
    /// NOT transferred immediately — the dispute enters `Appealing` status and
    /// either party has 24 hours to file an appeal via [`appeal`].
    ///
    /// If no appeal is filed, anyone may call [`finalize_resolution`] after
    /// `appeal_deadline` to execute the transfer.
    ///
    /// # Arguments
    /// * `arbitrator`           — Must match the arbitrator set during `initialize`.
    /// * `dispute_id`           — ID returned by `open_dispute`.
    /// * `release_to_recipient` — `true` → funds go to recipient; `false` → refund sender.
    pub fn resolve_dispute(
        env: Env,
        arbitrator: Address,
        dispute_id: u64,
        release_to_recipient: bool,
    ) {
        let ruling = if release_to_recipient {
            Ruling::Recipient
        } else {
            Ruling::Sender
        };
        Self::resolve_with(&env, arbitrator, dispute_id, ruling);
    }

    /// Resolve an escrow dispute in favour of the payout agent, opening the
    /// same 24-hour appeal window as [`resolve_dispute`]. Arbitrator only.
    pub fn resolve_dispute_for_agent(env: Env, arbitrator: Address, dispute_id: u64) {
        Self::resolve_with(&env, arbitrator, dispute_id, Ruling::Agent);
    }

    fn resolve_with(env: &Env, arbitrator: Address, dispute_id: u64, ruling: Ruling) {
        bump_instance(env);
        arbitrator.require_auth();

        let stored_arbitrator: Address = env
            .storage()
            .instance()
            .get(&DataKey::Arbitrator)
            .expect("not initialized");

        if arbitrator != stored_arbitrator {
            panic!("unauthorized: caller is not the arbitrator");
        }

        let mut dispute: Dispute = load_dispute(env, dispute_id);

        if dispute.status != DisputeStatus::Open {
            panic!("dispute is not open");
        }

        let now = env.ledger().timestamp();
        dispute.status = DisputeStatus::Appealing;
        record_ruling(env, &mut dispute, ruling);
        dispute.appeal_deadline = now + APPEAL_WINDOW_SECS;

        store_dispute(env, &dispute);
    }

    /// File an appeal within the 24-hour window after the arbitrator's decision.
    ///
    /// Only the sender or recipient of the dispute — or, for escrow disputes,
    /// the payout agent — may appeal. A second call
    /// on the same dispute panics — only one appeal per dispute is allowed.
    /// The dispute transitions to `UnderAppeal` status and the super-arbitrator
    /// must call [`resolve_appeal`] to issue the final binding decision.
    ///
    /// # Arguments
    /// * `caller`     — Must be the dispute's sender or recipient.
    /// * `dispute_id` — ID returned by `open_dispute`.
    pub fn appeal(env: Env, caller: Address, dispute_id: u64) {
        bump_instance(&env);
        caller.require_auth();

        let mut dispute: Dispute = load_dispute(&env, dispute_id);

        if dispute.status == DisputeStatus::UnderAppeal {
            panic!("appeal already filed");
        }
        if dispute.status != DisputeStatus::Appealing {
            panic!("dispute is not in the appeal window");
        }
        if env.ledger().timestamp() > dispute.appeal_deadline {
            panic!("appeal window has closed");
        }
        if caller != dispute.sender
            && caller != dispute.recipient
            && dispute_agent(&env, dispute_id) != Some(caller.clone())
        {
            panic!("caller is not a party to this dispute");
        }

        dispute.status = DisputeStatus::UnderAppeal;
        store_dispute(&env, &dispute);

        env.events().publish(
            (Symbol::new(&env, "AppealFiled"),),
            EvtAppealFiled {
                dispute_id,
                filed_by: caller,
            },
        );
    }

    /// Finalise the arbitrator's resolution after the appeal window expires.
    ///
    /// Callable by anyone once `appeal_deadline` has passed and no appeal was
    /// filed (status is still `Appealing`). Executes the pending transfer
    /// recorded by [`resolve_dispute`] and emits `DisputeResolved`.
    ///
    /// # Arguments
    /// * `dispute_id` — ID returned by `open_dispute`.
    pub fn finalize_resolution(env: Env, dispute_id: u64) {
        bump_instance(&env);
        let dispute: Dispute = load_dispute(&env, dispute_id);

        if dispute.status != DisputeStatus::Appealing {
            panic!("dispute is not awaiting finalization");
        }
        if env.ledger().timestamp() <= dispute.appeal_deadline {
            panic!("appeal window has not yet closed");
        }

        let ruling = pending_ruling(&env, &dispute);
        Self::award(&env, dispute, ruling);
    }

    /// Pay the disputed funds to the party chosen by `ruling`, mark the
    /// dispute resolved, settle the filing fee, and emit `DisputeResolved`.
    fn award(env: &Env, mut dispute: Dispute, ruling: Ruling) {
        let dispute_id = dispute.id;
        let usdc: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddress)
            .unwrap();

        let winner = match ruling {
            Ruling::Recipient => {
                dispute.status = DisputeStatus::ResolvedForRecipient;
                dispute.recipient.clone()
            }
            Ruling::Sender => {
                dispute.status = DisputeStatus::ResolvedForSender;
                dispute.sender.clone()
            }
            Ruling::Agent => {
                dispute.status = DisputeStatus::ResolvedForAgent;
                dispute_agent(env, dispute_id).expect("dispute has no agent")
            }
        };

        store_dispute(env, &dispute);

        Self::settle_filing_fee(env, dispute_id, &winner, &usdc);
        token::Client::new(env, &usdc).transfer(
            &env.current_contract_address(),
            &winner,
            &dispute.amount,
        );
        notify_escrow(env, dispute_id, &winner);

        env.events().publish(
            (Symbol::new(env, "DisputeResolved"),),
            EvtDisputeResolved {
                dispute_id,
                winner,
                amount: dispute.amount,
            },
        );
    }

    /// Issue the final binding decision on an appealed dispute.
    ///
    /// Only the super-arbitrator may call this function. Immediately transfers
    /// funds to the chosen winner and emits `DisputeResolved`.
    ///
    /// # Arguments
    /// * `super_arbitrator`     — Must match the super-arbitrator address in storage.
    /// * `dispute_id`           — ID returned by `open_dispute`.
    /// * `release_to_recipient` — `true` → funds go to recipient; `false` → refund sender.
    pub fn resolve_appeal(
        env: Env,
        super_arbitrator: Address,
        dispute_id: u64,
        release_to_recipient: bool,
    ) {
        let ruling = if release_to_recipient {
            Ruling::Recipient
        } else {
            Ruling::Sender
        };
        Self::resolve_appeal_with(&env, super_arbitrator, dispute_id, ruling);
    }

    /// Final binding decision on an appealed escrow dispute in favour of the
    /// payout agent. Super-arbitrator only.
    pub fn resolve_appeal_for_agent(env: Env, super_arbitrator: Address, dispute_id: u64) {
        Self::resolve_appeal_with(&env, super_arbitrator, dispute_id, Ruling::Agent);
    }

    fn resolve_appeal_with(env: &Env, super_arbitrator: Address, dispute_id: u64, ruling: Ruling) {
        bump_instance(env);
        super_arbitrator.require_auth();

        let stored_super: Address = env
            .storage()
            .instance()
            .get(&DataKey::SuperArbitrator)
            .expect("super arbitrator not set");

        if super_arbitrator != stored_super {
            panic!("unauthorized: caller is not the super arbitrator");
        }

        let mut dispute: Dispute = load_dispute(env, dispute_id);

        if dispute.status != DisputeStatus::UnderAppeal {
            panic!("dispute is not under appeal");
        }

        record_ruling(env, &mut dispute, ruling);
        Self::award(env, dispute, ruling);
    }

    /// Claim the locked funds after the 7-day deadline has elapsed without
    /// resolution.
    ///
    /// Normally only the original sender may call this, and the full locked
    /// amount is refunded to them. For an escrow dispute opened after the agent
    /// confirmed delivery, the agent's confirmation stands by default: only the
    /// agent may claim, and the funds go to the agent.
    ///
    /// # Arguments
    /// * `claimant`   — The sender, or the agent for payout-confirmed escrow disputes.
    /// * `dispute_id` — ID returned by `open_dispute`.
    pub fn claim_expired(env: Env, claimant: Address, dispute_id: u64) {
        bump_instance(&env);
        claimant.require_auth();

        let mut dispute: Dispute = load_dispute(&env, dispute_id);

        let agent = dispute_agent(&env, dispute_id);
        let pays_agent = payout_confirmed(&env, dispute_id) && agent.is_some();
        if pays_agent {
            if Some(claimant.clone()) != agent {
                panic!("unauthorized: caller is not the dispute agent");
            }
        } else if claimant != dispute.sender {
            panic!("unauthorized: caller is not the dispute sender");
        }
        if dispute.status != DisputeStatus::Open {
            panic!("dispute is not open");
        }
        if env.ledger().timestamp() <= dispute.deadline {
            panic!("resolution deadline has not elapsed");
        }

        let usdc: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddress)
            .unwrap();

        dispute.status = DisputeStatus::Expired;
        store_dispute(&env, &dispute);

        token::Client::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &claimant,
            &dispute.amount,
        );
        notify_escrow(&env, dispute_id, &claimant);

        // The arbitrator missed the deadline, so the opener is not at fault:
        // refund the filing fee to whoever paid it.
        let fee_holder: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::FilingFeeHolder(dispute_id));
        if fee_holder.is_some() {
            bump_persistent(&env, &DataKey::FilingFeeHolder(dispute_id));
        }
        if let Some(holder) = fee_holder {
            Self::settle_filing_fee(&env, dispute_id, &holder, &usdc);
        }

        dispute.status = DisputeStatus::Expired;
        store_dispute(&env, &dispute);

        env.events().publish(
            (Symbol::new(&env, "DisputeExpired"),),
            EvtDisputeExpired {
                dispute_id,
                sender: dispute.sender.clone(),
                refund_amount: dispute.amount,
            },
        );
        if pays_agent {
            env.events().publish(
                (Symbol::new(&env, "DisputeExpiredToAgent"),),
                EvtDisputeExpiredToAgent {
                    dispute_id,
                    agent: claimant,
                    amount: dispute.amount,
                },
            );
        } else {
            env.events().publish(
                (Symbol::new(&env, "DisputeExpired"),),
                EvtDisputeExpired {
                    dispute_id,
                    sender: dispute.sender.clone(),
                    refund_amount: dispute.amount,
                },
            );
        }
    }

    /// Update the filing fee required to open a dispute. Admin only.
    pub fn update_filing_fee(env: Env, admin: Address, new_fee: i128) {
        admin.require_auth();
        let stored_admin: Address = env.storage().persistent().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        if new_fee > 500_000_000 {
            panic!("filing fee exceeds maximum of 50 USDC");
        }
        env.storage().persistent().set(&DataKey::FilingFee, &new_fee);
    }

    /// Update the address that receives forfeited filing fees. Admin only.
    pub fn set_fee_distributor_address(env: Env, admin: Address, fee_distributor: Address) {
        admin.require_auth();
        let stored_admin: Address = env.storage().persistent().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        env.storage()
            .persistent()
            .set(&DataKey::FeeDistributorAddress, &fee_distributor);
    }

    fn record_filing_fee(env: &Env, dispute_id: u64, opener: &Address, fee: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::FilingFeeHolder(dispute_id), opener);
        env.storage()
            .persistent()
            .set(&DataKey::FilingFeePaid(dispute_id), &fee);
    }

    fn settle_filing_fee(env: &Env, dispute_id: u64, winner: &Address, usdc: &Address) {
        // Prefer the amount recorded at open time; fall back to the current
        // fee for disputes opened before `FilingFeePaid` existed.
        let fee_amount: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::FilingFeePaid(dispute_id))
            .unwrap_or_else(|| {
                env.storage()
                    .persistent()
                    .get(&DataKey::FilingFee)
                    .unwrap_or(50_000000)
            });
        if fee_amount <= 0 {
            return;
        }

        if let Some(holder) = env
            .storage()
            .persistent()
            .get(&DataKey::FilingFeeHolder(dispute_id))
        {
            if winner == &holder {
                token::Client::new(env, usdc).transfer(
                    &env.current_contract_address(),
                    winner,
                    &fee_amount,
                );
            } else {
                let fee_distributor: Address = env
                    .storage()
                    .persistent()
                    .get(&DataKey::FeeDistributorAddress)
                    .expect("fee distributor not configured");
                token::Client::new(env, usdc).transfer(
                    &env.current_contract_address(),
                    &fee_distributor,
                    &fee_amount,
                );
            }
        }
    }

    /// Return the full dispute record for the given ID.
    pub fn get_dispute(env: Env, dispute_id: u64) -> Dispute {
        env.storage()
            .persistent()
            .get(&DataKey::Dispute(dispute_id))
            .expect("dispute not found")
    }

    /// Payout agent of an escrow dispute, or `None` for free-form disputes.
    pub fn get_dispute_agent(env: Env, dispute_id: u64) -> Option<Address> {
        dispute_agent(&env, dispute_id)
    }

    /// Whether the agent had confirmed delivery before the escrow dispute opened.
    pub fn is_payout_confirmed(env: Env, dispute_id: u64) -> bool {
        payout_confirmed(&env, dispute_id)
    }

    /// Evidence submitted by the agent of an escrow dispute (empty if none).
    pub fn get_agent_evidence(env: Env, dispute_id: u64) -> Bytes {
        env.storage()
            .persistent()
            .get(&DataKey::AgentEvidence(dispute_id))
            .unwrap_or_else(|| Bytes::new(&env))
    }

    /// Step 1 of two-step arbitrator handoff. Admin proposes a new arbitrator.
    /// The proposal is stored but the active arbitrator is unchanged until the
    /// nominee accepts.
    pub fn propose_new_arbitrator(env: Env, admin: Address, new_arbitrator: Address) {
        admin.require_auth();
        let stored_admin: Address = env.storage().persistent().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        env.storage().persistent().set(&DataKey::PendingArbitrator, &new_arbitrator);
    }

    /// Step 2 of two-step arbitrator handoff. The proposed address accepts and
    /// becomes the active arbitrator, clearing the pending slot.
    pub fn accept_arbitrator(env: Env, new_arbitrator: Address) {
        new_arbitrator.require_auth();
        let pending: Address = env
            .storage()
            .persistent()
            .get(&DataKey::PendingArbitrator)
            .expect("no pending arbitrator");
        if new_arbitrator != pending {
            panic!("caller is not the pending arbitrator");
        }
        env.storage().persistent().set(&DataKey::Arbitrator, &new_arbitrator);
        env.storage().persistent().remove(&DataKey::PendingArbitrator);
    }

    /// Set or update the super-arbitrator address. Admin only.
    ///
    /// # Arguments
    /// * `admin`            — Must match the admin address set during `initialize`.
    /// * `super_arbitrator` — New super-arbitrator address.
    pub fn set_super_arbitrator(env: Env, admin: Address, super_arbitrator: Address) {
        admin.require_auth();
        let stored_admin: Address = env.storage().persistent().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        env.storage().persistent().set(&DataKey::SuperArbitrator, &super_arbitrator);
    }

    /// Register the escrow contract authorised to open disputes via
    /// [`open_escrow_dispute`]. Admin only.
    ///
    /// # Arguments
    /// * `admin`          — Must match the admin address set during `initialize`.
    /// * `escrow_contract` — The escrow contract address.
    pub fn set_escrow_contract(env: Env, admin: Address, escrow_contract: Address) {
        admin.require_auth();
        let stored_admin: Address = env.storage().persistent().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        env.storage()
            .persistent()
            .set(&DataKey::EscrowContract, &escrow_contract);
    }

    /// Return the registered escrow contract address, or None if not set.
    pub fn get_escrow_contract(env: Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::EscrowContract)
    }

    // ── Admin rotation (two-step, timelocked) ─────────────────────────────────

    /// Step 1 of two-step admin rotation. The current admin nominates
    /// `new_admin`; the change only takes effect once the nominee accepts it
    /// after the governance timelock has elapsed.
    ///
    /// The admin should be a multisig account or the `multisig-approval`
    /// contract so that a single lost or compromised key cannot lock the
    /// contract out of administration.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) {
        governance::propose_admin(&env, &DataKey::Admin, admin, new_admin);
    }

    /// Step 2 of two-step admin rotation. The nominee must authorise the call
    /// and the timelock must have elapsed; the stored admin is then replaced.
    pub fn accept_admin(env: Env, new_admin: Address) {
        governance::accept_admin(&env, &DataKey::Admin, new_admin);
    }

    /// Cancel a pending admin proposal. Current admin only.
    pub fn cancel_admin_proposal(env: Env, admin: Address) {
        governance::cancel_admin_proposal(&env, &DataKey::Admin, admin);
    }

    /// Return the pending admin proposal as `(new_admin, eta)`, if any.
    pub fn get_pending_admin(env: Env) -> Option<(Address, u64)> {
        governance::get_pending_admin(&env)
    }

    /// Return the current admin address.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    // ── Multi-arbitrator panel ────────────────────────────────────────────────

    /// Cast a vote on an open dispute as a registered panel arbitrator.
    ///
    /// Each registered arbitrator may vote exactly once per dispute. After every
    /// vote the contract tallies the results and, if the configured quorum is
    /// reached, immediately releases funds to the winning side.
    ///
    /// # Arguments
    /// * `arbitrator`    — Must be a member of the `Arbitrators` panel.
    /// * `dispute_id`    — ID returned by `open_dispute`.
    /// * `for_recipient` — `true` = vote for recipient; `false` = vote for sender.
    pub fn cast_vote(env: Env, arbitrator: Address, dispute_id: u64, for_recipient: bool) {
        arbitrator.require_auth();

        // Verify the caller is a registered panel arbitrator.
        let panel: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Arbitrators)
            .unwrap_or_else(|| Vec::new(&env));

        let mut is_member = false;
        for i in 0..panel.len() {
            if panel.get(i).unwrap() == arbitrator {
                is_member = true;
                break;
            }
        }
        if !is_member {
            panic!("caller is not a registered panel arbitrator");
        }

        // Reject duplicate votes.
        if env
            .storage()
            .persistent()
            .has(&DataKey::Vote(dispute_id, arbitrator.clone()))
        {
            panic!("arbitrator has already voted");
        }

        // Dispute must be Open.
        let mut dispute: Dispute = env
            .storage()
            .persistent()
            .get(&DataKey::Dispute(dispute_id))
            .expect("dispute not found");

        if dispute.status != DisputeStatus::Open {
            panic!("dispute is not open");
        }

        // Record the vote.
        env.storage()
            .persistent()
            .set(&DataKey::Vote(dispute_id, arbitrator.clone()), &for_recipient);

        // Tally all votes cast so far for this dispute.
        let panel_size = panel.len();
        let mut votes_for_recipient: u32 = 0;
        let mut votes_for_sender: u32 = 0;
        let mut total_votes: u32 = 0;

        for i in 0..panel_size {
            let member = panel.get(i).unwrap();
            let key = DataKey::Vote(dispute_id, member);
            if let Some(vote) = env.storage().persistent().get::<DataKey, bool>(&key) {
                total_votes += 1;
                if vote {
                    votes_for_recipient += 1;
                } else {
                    votes_for_sender += 1;
                }
            }
        }

        env.events().publish(
            (Symbol::new(&env, "VoteCast"),),
            EvtVoteCast {
                dispute_id,
                arbitrator: arbitrator.clone(),
                for_recipient,
                total_votes,
            },
        );

        // Check whether either side has reached quorum.
        let quorum_bps: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::QuorumBps)
            .unwrap_or(DEFAULT_QUORUM_BPS);

        // A side reaches quorum when its vote share (in bps) strictly exceeds
        // quorum_bps: votes_for_side * 10_000 / panel_size > quorum_bps.
        // We rearrange to avoid division: votes_for_side * 10_000 > quorum_bps * panel_size.
        let quorum_threshold = quorum_bps as u64 * panel_size as u64;

        let recipient_bps = votes_for_recipient as u64 * 10_000;
        let sender_bps = votes_for_sender as u64 * 10_000;

        let quorum_for_recipient = recipient_bps > quorum_threshold;
        let quorum_for_sender = sender_bps > quorum_threshold;

        if quorum_for_recipient || quorum_for_sender {
            let usdc: Address = env
                .storage()
                .persistent()
                .get(&DataKey::UsdcAddress)
                .unwrap();

            let release_to_recipient = quorum_for_recipient;

            let winner = if release_to_recipient {
                dispute.status = DisputeStatus::ResolvedForRecipient;
                dispute.recipient.clone()
            } else {
                dispute.status = DisputeStatus::ResolvedForSender;
                dispute.sender.clone()
            };

            env.storage()
                .persistent()
                .set(&DataKey::Dispute(dispute_id), &dispute);

            Self::settle_filing_fee(&env, dispute_id, &winner, &usdc);
            token::Client::new(&env, &usdc).transfer(
                &env.current_contract_address(),
                &winner,
                &dispute.amount,
            );
            notify_escrow(&env, dispute_id, &winner);

            env.events().publish(
                (Symbol::new(&env, "QuorumReached"),),
                EvtQuorumReached {
                    dispute_id,
                    for_recipient: release_to_recipient,
                    winner,
                    amount: dispute.amount,
                },
            );
        } else {
            // No quorum yet — persist the unchanged dispute record.
            env.storage()
                .persistent()
                .set(&DataKey::Dispute(dispute_id), &dispute);
        }
    }

    /// Add an address to the arbitrator panel. Admin only.
    ///
    /// Panics if the panel already contains 7 members or if the address is
    /// already in the panel.
    ///
    /// # Arguments
    /// * `admin`      — Must match the admin address set during `initialize`.
    /// * `arbitrator` — Address to add to the panel.
    pub fn add_arbitrator(env: Env, admin: Address, arbitrator: Address) {
        admin.require_auth();
        let stored_admin: Address = env.storage().persistent().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let mut panel: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Arbitrators)
            .unwrap_or_else(|| Vec::new(&env));

        if panel.len() >= MAX_ARBITRATORS {
            panic!("arbitrator panel is full (max 7)");
        }

        // Check for duplicates.
        for i in 0..panel.len() {
            if panel.get(i).unwrap() == arbitrator {
                panic!("arbitrator is already in the panel");
            }
        }

        panel.push_back(arbitrator);
        env.storage().persistent().set(&DataKey::Arbitrators, &panel);
    }

    /// Remove an address from the arbitrator panel. Admin only.
    ///
    /// Panics if the address is not in the panel.
    ///
    /// # Arguments
    /// * `admin`      — Must match the admin address set during `initialize`.
    /// * `arbitrator` — Address to remove from the panel.
    pub fn remove_arbitrator(env: Env, admin: Address, arbitrator: Address) {
        admin.require_auth();
        let stored_admin: Address = env.storage().persistent().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let panel: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Arbitrators)
            .unwrap_or_else(|| Vec::new(&env));

        let mut new_panel: Vec<Address> = Vec::new(&env);
        let mut found = false;
        for i in 0..panel.len() {
            let member = panel.get(i).unwrap();
            if member == arbitrator {
                found = true;
            } else {
                new_panel.push_back(member);
            }
        }

        if !found {
            panic!("arbitrator not found in panel");
        }

        env.storage().persistent().set(&DataKey::Arbitrators, &new_panel);
    }

    /// Set the quorum threshold in basis points. Admin only.
    ///
    /// # Arguments
    /// * `admin`      — Must match the admin address set during `initialize`.
    /// * `quorum_bps` — New threshold. Must be in range 1..=10_000.
    pub fn set_quorum_bps(env: Env, admin: Address, quorum_bps: u32) {
        admin.require_auth();
        let stored_admin: Address = env.storage().persistent().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        if quorum_bps == 0 || quorum_bps > 10_000 {
            panic!("quorum_bps must be between 1 and 10000");
        }
        env.storage().persistent().set(&DataKey::QuorumBps, &quorum_bps);
    }

    /// Return the current arbitrator panel.
    pub fn get_arbitrators(env: Env) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Arbitrators)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Return the current quorum threshold in basis points.
    pub fn get_quorum_bps(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::QuorumBps)
            .unwrap_or(DEFAULT_QUORUM_BPS)
    }

    /// Get paginated dispute IDs for a user (as sender or recipient).
    /// Limit capped at 50 per call.
    pub fn get_disputes_for_user(env: Env, user: Address, start: u32, limit: u32) -> Vec<u64> {
        let capped_limit = if limit > 50 { 50 } else { limit };
        let user_disputes: Vec<u64> = env.storage().persistent()
            .get(&DataKey::UserDisputes(user))
            .unwrap_or_else(|| Vec::new(&env));
        
        let total = user_disputes.len();
        let actual_start = start.min(total);
        let actual_end = actual_start.saturating_add(capped_limit).min(total);
        
        let actual_start = if start > total { total } else { start };
        let total: u32 = user_disputes.len();
        let actual_start = start.min(total);
        let actual_end = actual_start.saturating_add(capped_limit).min(total);

        let mut result: Vec<u64> = Vec::new(&env);
        for i in actual_start..actual_end {
            if let Some(id) = user_disputes.get(i) {
                result.push_back(id);
            }
        }
        result
    }

    /// Get all disputes with pagination (admin-accessible, public data).
    /// Uses TotalDisputes counter for offset-based pagination.
    pub fn get_all_disputes(env: Env, start: u32, limit: u32) -> Vec<u64> {
        let capped_limit = if limit > 50 { 50 } else { limit };
        let total_disputes: u64 = env.storage().persistent().get(&DataKey::TotalDisputes).unwrap_or(0);
        
        let actual_start = (start as u64).min(total_disputes);
        let actual_end = actual_start.saturating_add(capped_limit as u64).min(total_disputes);

        let mut result: Vec<u64> = Vec::new(&env);
        for i in actual_start..actual_end {
            result.push_back(i + 1); // Dispute IDs are 1-indexed
        }
        result
    }
}

// SC-214: this contract implements its interface from `afripay-types`, so the
// compiler checks the exported signature against the one consumers call.
// Changing the entry point without updating the shared trait breaks this build;
// updating the trait breaks every consumer still using the old signature.
impl afripay_types::DisputeResolutionInterface for DisputeResolutionContract {
    fn open_escrow_dispute(
        env: Env,
        escrow_contract: Address,
        opener: Address,
        escrow_id: u64,
        sender: Address,
        recipient: Address,
        agent: Address,
        amount: i128,
        payout_confirmed: bool,
    ) -> u64 {
        DisputeResolutionContract::open_escrow_dispute(
            env,
            escrow_contract,
            opener,
            escrow_id,
            sender,
            recipient,
            agent,
            amount,
            payout_confirmed,
        )
    }
}

mod governance;
pub use governance::{CONTRACT_VERSION, UPGRADE_TIMELOCK_SECS};
