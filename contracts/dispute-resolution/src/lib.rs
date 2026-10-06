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

mod test;

// ── Constants ─────────────────────────────────────────────────────────────────

/// 7-day resolution deadline in seconds.
const RESOLUTION_DEADLINE_SECS: u64 = 7 * 24 * 60 * 60;

/// 24-hour appeal window in seconds.
const APPEAL_WINDOW_SECS: u64 = 24 * 60 * 60;

/// Maximum number of arbitrators in the panel.
const MAX_ARBITRATORS: u32 = 7;

/// Default quorum threshold in basis points (6001 = strictly more than 60 %).
const DEFAULT_QUORUM_BPS: u32 = 6_001;

// ── Storage keys ──────────────────────────────────────────────────────────────

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
}

// ── Domain types ──────────────────────────────────────────────────────────────

/// Lifecycle state of a dispute.
#[derive(Clone, Copy, PartialEq, Eq)]
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
}

/// On-chain dispute record.
#[derive(Clone)]
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

#[derive(Clone)]
#[contracttype]
pub struct EvtDisputeOpened {
    pub dispute_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub amount: i128,
    pub deadline: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct EvtEvidenceSubmitted {
    pub dispute_id: u64,
    pub submitted_by: Address,
}

#[derive(Clone)]
#[contracttype]
pub struct EvtDisputeResolved {
    pub dispute_id: u64,
    pub winner: Address,
    pub amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct EvtDisputeExpired {
    pub dispute_id: u64,
    pub sender: Address,
    pub refund_amount: i128,
}

/// Emitted when a party files an appeal within the 24-hour window.
#[derive(Clone)]
#[contracttype]
pub struct EvtAppealFiled {
    pub dispute_id: u64,
    pub filed_by: Address,
}

/// Emitted when a panel arbitrator casts a vote on a dispute.
#[derive(Clone)]
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
#[derive(Clone)]
#[contracttype]
pub struct EvtQuorumReached {
    pub dispute_id: u64,
    pub for_recipient: bool,
    pub winner: Address,
    pub amount: i128,
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
        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::Arbitrator, &arbitrator);
        env.storage().persistent().set(&DataKey::UsdcAddress, &usdc_address);
        env.storage().persistent().set(&DataKey::MaxEvidenceBytes, &max_evidence_bytes);
        env.storage().persistent().set(&DataKey::Counter, &0u64);
        env.storage().persistent().set(&DataKey::SuperArbitrator, &super_arbitrator);
        env.storage().persistent().set(&DataKey::FilingFee, &50_000000i128);
        env.storage().persistent().set(&DataKey::FeeDistributorAddress, &admin);
        env.storage().persistent().set(&DataKey::TotalDisputes, &0u64);
        // Initialise the arbitrator panel with an empty list and the default quorum.
        let empty: Vec<Address> = Vec::new(&env);
        env.storage().persistent().set(&DataKey::Arbitrators, &empty);
        env.storage().persistent().set(&DataKey::QuorumBps, &DEFAULT_QUORUM_BPS);
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
        if amount <= 0 {
            panic!("amount must be positive");
        }
        if opener != sender && opener != recipient {
            panic!("opener must be sender or recipient");
        }

        opener.require_auth();

        let usdc: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("not initialized");

        let filing_fee: i128 = env
            .storage()
            .persistent()
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
            .persistent()
            .get(&DataKey::Counter)
            .unwrap_or(0)
            + 1;
        env.storage().persistent().set(&DataKey::Counter, &id);

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
        env.storage().persistent().set(&DataKey::Dispute(id), &dispute);
        env.storage()
            .persistent()
            .set(&DataKey::FilingFeeHolder(id), &opener);

        // Update TotalDisputes counter
        let total_disputes: u64 = env.storage().persistent().get(&DataKey::TotalDisputes).unwrap_or(0);
        env.storage().persistent().set(&DataKey::TotalDisputes, &(total_disputes + 1));

        // Add dispute ID to UserDisputes for both sender and recipient (circular buffer, max 1000)
        for user in [sender.clone(), recipient.clone()] {
            let mut user_disputes: Vec<u64> = env.storage().persistent()
                .get(&DataKey::UserDisputes(user.clone()))
                .unwrap_or_else(|| Vec::new(&env));
            if user_disputes.len() >= 1000 {
                user_disputes.remove(0);
            }
            user_disputes.push_back(id);
            env.storage().persistent().set(&DataKey::UserDisputes(user), &user_disputes);
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
    /// Cross-contract hook called by the escrow contract (see
    /// `contracts/escrow`). The escrow has already transferred `amount` USDC
    /// into this contract's custody; this function records the dispute so the
    /// normal resolution/appeal/expiry flow applies. The adjudicated winner is
    /// paid directly from the locked funds.
    ///
    /// Unlike [`open_dispute`], no filing fee is charged: the escrow contract
    /// transfers only the disputed `amount`, and only the registered escrow
    /// contract may call this function.
    ///
    /// # Arguments
    /// * `escrow_contract` — The calling escrow contract. Must be the immediate
    ///                       caller and match the registered escrow contract.
    /// * `sender`          — Original escrow sender.
    /// * `recipient`       — Intended escrow recipient.
    /// * `amount`          — USDC amount (in stroops) already transferred.
    pub fn open_escrow_dispute(
        env: Env,
        escrow_contract: Address,
        sender: Address,
        recipient: Address,
        amount: i128,
    ) -> u64 {
        if amount <= 0 {
            panic!("amount must be positive");
        }
        if env.caller() != escrow_contract {
            panic!("unauthorized: caller is not the escrow contract");
        }
        let trusted_escrow: Address = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowContract)
            .expect("escrow contract not set");
        if escrow_contract != trusted_escrow {
            panic!("unauthorized: escrow contract not registered");
        }

        let id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Counter)
            .unwrap_or(0)
            + 1;
        env.storage().persistent().set(&DataKey::Counter, &id);

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
        env.storage().persistent().set(&DataKey::Dispute(id), &dispute);

        let total_disputes: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalDisputes)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::TotalDisputes, &(total_disputes + 1));

        // Index the dispute under both parties for pagination.
        for user in [sender.clone(), recipient.clone()] {
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
                .set(&DataKey::UserDisputes(user), &user_disputes);
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

    /// Submit evidence for an open dispute.
    ///
    /// Only the sender or recipient of the dispute may submit evidence.
    /// Evidence is an IPFS CID or hash (max 256 bytes). Calling again
    /// overwrites the previous submission for that party.
    ///
    /// # Arguments
    /// * `submitter`  — Must be the dispute's sender or recipient.
    /// * `dispute_id` — ID returned by `open_dispute`.
    /// * `evidence`   — IPFS CID or content hash (max 256 bytes).
    pub fn submit_evidence(env: Env, submitter: Address, dispute_id: u64, evidence: Bytes) {
        let max_evidence_bytes: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::MaxEvidenceBytes)
            .expect("not initialized");
        if evidence.len() > max_evidence_bytes {
            panic!("evidence exceeds maximum allowed size");
        }

        submitter.require_auth();

        let mut dispute: Dispute = env
            .storage()
            .persistent()
            .get(&DataKey::Dispute(dispute_id))
            .expect("dispute not found");

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
        } else {
            panic!("submitter is not a party to this dispute");
        }

        env.storage().persistent().set(&DataKey::Dispute(dispute_id), &dispute);

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
        arbitrator.require_auth();

        let stored_arbitrator: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Arbitrator)
            .expect("not initialized");

        if arbitrator != stored_arbitrator {
            panic!("unauthorized: caller is not the arbitrator");
        }

        let mut dispute: Dispute = env
            .storage()
            .persistent()
            .get(&DataKey::Dispute(dispute_id))
            .expect("dispute not found");

        if dispute.status != DisputeStatus::Open {
            panic!("dispute is not open");
        }

        let now = env.ledger().timestamp();
        dispute.status = DisputeStatus::Appealing;
        dispute.resolved_for_recipient = release_to_recipient;
        dispute.appeal_deadline = now + APPEAL_WINDOW_SECS;

        env.storage().persistent().set(&DataKey::Dispute(dispute_id), &dispute);
    }

    /// File an appeal within the 24-hour window after the arbitrator's decision.
    ///
    /// Only the sender or recipient of the dispute may appeal. A second call
    /// on the same dispute panics — only one appeal per dispute is allowed.
    /// The dispute transitions to `UnderAppeal` status and the super-arbitrator
    /// must call [`resolve_appeal`] to issue the final binding decision.
    ///
    /// # Arguments
    /// * `caller`     — Must be the dispute's sender or recipient.
    /// * `dispute_id` — ID returned by `open_dispute`.
    pub fn appeal(env: Env, caller: Address, dispute_id: u64) {
        caller.require_auth();

        let mut dispute: Dispute = env
            .storage()
            .persistent()
            .get(&DataKey::Dispute(dispute_id))
            .expect("dispute not found");

        if dispute.status == DisputeStatus::UnderAppeal {
            panic!("appeal already filed");
        }
        if dispute.status != DisputeStatus::Appealing {
            panic!("dispute is not in the appeal window");
        }
        if env.ledger().timestamp() > dispute.appeal_deadline {
            panic!("appeal window has closed");
        }
        if caller != dispute.sender && caller != dispute.recipient {
            panic!("caller is not a party to this dispute");
        }

        dispute.status = DisputeStatus::UnderAppeal;
        env.storage().persistent().set(&DataKey::Dispute(dispute_id), &dispute);

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
        let mut dispute: Dispute = env
            .storage()
            .persistent()
            .get(&DataKey::Dispute(dispute_id))
            .expect("dispute not found");

        if dispute.status != DisputeStatus::Appealing {
            panic!("dispute is not awaiting finalization");
        }
        if env.ledger().timestamp() <= dispute.appeal_deadline {
            panic!("appeal window has not yet closed");
        }

        let usdc: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .unwrap();

        let winner = if dispute.resolved_for_recipient {
            dispute.status = DisputeStatus::ResolvedForRecipient;
            dispute.recipient.clone()
        } else {
            dispute.status = DisputeStatus::ResolvedForSender;
            dispute.sender.clone()
        };

        Self::settle_filing_fee(&env, dispute_id, &winner, &usdc);
        token::Client::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &winner,
            &dispute.amount,
        );

        env.storage().persistent().set(&DataKey::Dispute(dispute_id), &dispute);

        env.events().publish(
            (Symbol::new(&env, "DisputeResolved"),),
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
        super_arbitrator.require_auth();

        let stored_super: Address = env
            .storage()
            .persistent()
            .get(&DataKey::SuperArbitrator)
            .expect("super arbitrator not set");

        if super_arbitrator != stored_super {
            panic!("unauthorized: caller is not the super arbitrator");
        }

        let mut dispute: Dispute = env
            .storage()
            .persistent()
            .get(&DataKey::Dispute(dispute_id))
            .expect("dispute not found");

        if dispute.status != DisputeStatus::UnderAppeal {
            panic!("dispute is not under appeal");
        }

        let usdc: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .unwrap();

        let winner = if release_to_recipient {
            dispute.status = DisputeStatus::ResolvedForRecipient;
            dispute.recipient.clone()
        } else {
            dispute.status = DisputeStatus::ResolvedForSender;
            dispute.sender.clone()
        };

        Self::settle_filing_fee(&env, dispute_id, &winner, &usdc);
        token::Client::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &winner,
            &dispute.amount,
        );

        env.storage().persistent().set(&DataKey::Dispute(dispute_id), &dispute);

        env.events().publish(
            (Symbol::new(&env, "DisputeResolved"),),
            EvtDisputeResolved {
                dispute_id,
                winner,
                amount: dispute.amount,
            },
        );
    }

    /// Claim funds back after the 7-day deadline has elapsed without resolution.
    ///
    /// Only the original sender may call this. Refunds the full locked amount.
    ///
    /// # Arguments
    /// * `sender`     — Must match the sender recorded in the dispute.
    /// * `dispute_id` — ID returned by `open_dispute`.
    pub fn claim_expired(env: Env, sender: Address, dispute_id: u64) {
        sender.require_auth();

        let mut dispute: Dispute = env
            .storage()
            .persistent()
            .get(&DataKey::Dispute(dispute_id))
            .expect("dispute not found");

        if sender != dispute.sender {
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
            .persistent()
            .get(&DataKey::UsdcAddress)
            .unwrap();

        token::Client::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &dispute.sender,
            &dispute.amount,
        );

        dispute.status = DisputeStatus::Expired;
        env.storage().persistent().set(&DataKey::Dispute(dispute_id), &dispute);

        env.events().publish(
            (Symbol::new(&env, "DisputeExpired"),),
            EvtDisputeExpired {
                dispute_id,
                sender: dispute.sender.clone(),
                refund_amount: dispute.amount,
            },
        );
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

    fn settle_filing_fee(env: &Env, dispute_id: u64, winner: &Address, usdc: &Address) {
        let fee_amount: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::FilingFee)
            .unwrap_or(50_000000);
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

            Self::settle_filing_fee(&env, dispute_id, &winner, &usdc);
            token::Client::new(&env, &usdc).transfer(
                &env.current_contract_address(),
                &winner,
                &dispute.amount,
            );

            env.storage()
                .persistent()
                .set(&DataKey::Dispute(dispute_id), &dispute);

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
        let actual_start = if start as usize > total { total } else { start as usize };
        let actual_end = if actual_start + capped_limit as usize > total { total } else { actual_start + capped_limit as usize };
        
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
        
        let actual_start = if start as u64 > total_disputes { total_disputes } else { start as u64 };
        let actual_end = if actual_start + capped_limit as u64 > total_disputes { total_disputes } else { actual_start + capped_limit as u64 };
        
        let mut result: Vec<u64> = Vec::new(&env);
        for i in actual_start..actual_end {
            result.push_back(i + 1); // Dispute IDs are 1-indexed
        }
        result
    }
}
