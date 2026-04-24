#![no_std]

//! # Dispute Resolution Contract
//!
//! On-chain three-party dispute resolution for AfriPay cross-border payments.
//!
//! ## Parties
//! - **Sender**     — initiated the payment / escrow
//! - **Recipient**  — the intended beneficiary
//! - **Arbitrator** — neutral third party (platform-appointed) who resolves disputes
//!
//! ## Flow
//! 1. Either party calls [`open_dispute`] — escrowed funds are locked for arbitration.
//! 2. Sender or recipient calls [`submit_evidence`] with an IPFS CID or text hash.
//! 3. Arbitrator reviews evidence off-chain, then calls [`resolve_dispute`] to
//!    release funds to either the sender (refund) or recipient (release).
//! 4. Disputes not resolved within 7 days expire and the sender may reclaim funds
//!    via [`claim_expired`].

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Bytes, Env, Symbol};

mod test;

// ── Constants ─────────────────────────────────────────────────────────────────

/// 7-day resolution deadline in seconds.
const RESOLUTION_DEADLINE_SECS: u64 = 7 * 24 * 60 * 60;

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    Arbitrator,
    UsdcAddress,
    Counter,
    Dispute(u64),
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
    pub refund_amount: i128,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct DisputeResolutionContract;

#[contractimpl]
impl DisputeResolutionContract {
    /// Initialise the contract. Must be called once before any other function.
    ///
    /// # Arguments
    /// * `admin`        — Address that may update the arbitrator.
    /// * `arbitrator`   — Neutral third party authorised to resolve disputes.
    /// * `usdc_address` — Stellar asset contract address for USDC.
    pub fn initialize(env: Env, admin: Address, arbitrator: Address, usdc_address: Address) {
        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::Arbitrator, &arbitrator);
        env.storage().persistent().set(&DataKey::UsdcAddress, &usdc_address);
        env.storage().persistent().set(&DataKey::Counter, &0u64);
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

        // Lock funds in the contract for the duration of the dispute
        token::Client::new(&env, &usdc).transfer(
            &opener,
            &env.current_contract_address(),
            &amount,
        );

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
        };
        env.storage().persistent().set(&DataKey::Dispute(id), &dispute);

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
        if evidence.len() > 256 {
            panic!("evidence must be 256 bytes or fewer");
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

    /// Resolve a dispute, releasing funds to the winning party.
    ///
    /// Only the arbitrator may call this function. The arbitrator decides
    /// whether to release funds to the recipient (payment stands) or refund
    /// the sender (payment reversed).
    ///
    /// # Arguments
    /// * `arbitrator`   — Must match the arbitrator set during `initialize`.
    /// * `dispute_id`   — ID returned by `open_dispute`.
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
                refund_amount: dispute.amount,
            },
        );
    }

    /// Return the full dispute record for the given ID.
    pub fn get_dispute(env: Env, dispute_id: u64) -> Dispute {
        env.storage()
            .persistent()
            .get(&DataKey::Dispute(dispute_id))
            .expect("dispute not found")
    }

    /// Update the arbitrator address. Only admin may call this.
    pub fn set_arbitrator(env: Env, admin: Address, new_arbitrator: Address) {
        admin.require_auth();
        let stored_admin: Address = env.storage().persistent().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        env.storage().persistent().set(&DataKey::Arbitrator, &new_arbitrator);
    }
}
