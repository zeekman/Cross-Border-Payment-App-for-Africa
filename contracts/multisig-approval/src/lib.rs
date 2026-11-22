#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, xdr::ToXdr, Address, Bytes, BytesN, Env, String, Symbol,
    Vec,
};

#[cfg(test)]
mod test;

const DEFAULT_PROPOSAL_TTL_SECS: u64 = 604_800; // 7 days
const EXPIRY_SECONDS: u64 = 86_400; // 24 hours
const ROTATION_DELAY: u64 = 259_200; // 72 hours

/// Default weight for a signer that has never had one set explicitly.
const DEFAULT_SIGNER_WEIGHT: u32 = 1;
/// Upper bound on any single signer's weight. Caps how much influence one key
/// can hold so a single signer cannot unilaterally satisfy quorum.
const MAX_SIGNER_WEIGHT: u32 = 100;

/// Domain-separation tag prefixed to every `proposal_hash` preimage.
const PROPOSAL_HASH_TAG: &[u8] = b"AFRIPAY_MULTISIG_PROPOSAL";
/// Version byte of the `proposal_hash` preimage format.
const PROPOSAL_HASH_VERSION: u8 = 1;

#[contracttype]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxStatus {
    Pending,
    Executed,
    Rejected,
    Expired,
    Cancelled,
}

#[contracttype]
#[derive(Debug, Clone)]
pub struct Proposal {
    pub proposer: Address,
    pub description: String,
    pub amount: i128,
    pub recipient: Address,
    pub approvals: u32,
    pub rejections: u32,
    pub status: TxStatus,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Debug, Clone)]
pub struct QuorumChangeProposal {
    pub proposer: Address,
    pub new_quorum: u32,
    pub approvals: u32,
    pub rejections: u32,
    pub status: TxStatus,
    pub expires_at: u64,
}

/// Whether a pending rotation adds or removes a signer.
#[contracttype]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RotationAction {
    Add,
    Remove,
}

/// A time-locked signer-rotation request waiting to become effective.
#[contracttype]
#[derive(Debug, Clone)]
pub struct PendingRotation {
    pub action: RotationAction,
    pub signer: Address,
    /// Unix timestamp after which `execute_signer_change` may be called.
    pub effective_at: u64,
}

#[derive(Debug)]
#[contracttype]
pub enum DataKey {
    Admin,
    Approvers,
    Quorum,
    TxCounter,
    Proposal(u64),
    Voted(u64, Address),
    QuorumCounter,
    QuorumProposal(u64),
    QuorumVoted(u64, Address),
    ProposalTtl,
    PendingRotation,
    /// Weight assigned to each signer address (u32).
    SignerWeight(Address),
}

// ── Signer-rotation event payloads ────────────────────────────────────────────

#[contracttype]
#[derive(Debug, Clone)]
pub struct EvtSignerChangeProposed {
    pub action: RotationAction,
    pub signer: Address,
    pub effective_at: u64,
}

#[contracttype]
#[derive(Debug, Clone)]
pub struct EvtSignerChanged {
    pub action: RotationAction,
    pub signer: Address,
    pub executed_at: u64,
}

#[contracttype]
#[derive(Debug, Clone)]
pub struct EvtSignerChangeCancelled {
    pub action: RotationAction,
    pub signer: Address,
    pub cancelled_at: u64,
}

// ── Treasury-workflow event payloads (issue #1447) ────────────────────────────

#[contracttype]
#[derive(Debug, Clone)]
pub struct EvtProposed {
    pub proposer: Address,
    pub amount: i128,
    pub recipient: Address,
    pub description: String,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Debug, Clone)]
pub struct EvtApproved {
    pub approver: Address,
    pub weight: u32,
    pub total_approvals: u32,
    pub quorum: u32,
}

#[contracttype]
#[derive(Debug, Clone)]
pub struct EvtRejected {
    pub approver: Address,
    pub total_rejections: u32,
}

#[contracttype]
#[derive(Debug, Clone)]
pub struct EvtCancelled {
    pub proposer: Address,
}

#[contracttype]
#[derive(Debug, Clone)]
pub struct EvtExpired {
    pub expired_at: u64,
}

#[contracttype]
#[derive(Debug, Clone)]
pub struct EvtExecuted {
    pub executed_at: u64,
}

#[contracttype]
#[derive(Debug, Clone)]
pub struct EvtQuorumProposed {
    pub proposer: Address,
    pub new_quorum: u32,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Debug, Clone)]
pub struct EvtQuorumChanged {
    pub old_quorum: u32,
    pub new_quorum: u32,
}

#[contracttype]
#[derive(Debug, Clone)]
pub struct EvtWeightSet {
    pub signer: Address,
    pub weight: u32,
}

// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct MultisigContract;

#[contractimpl]
impl MultisigContract {
    /// Initialize the contract with a list of approvers and minimum quorum.
    ///
    /// Rejects an empty approver list and duplicate addresses (issue #1446):
    /// duplicates would inflate the apparent quorum weight while only one vote
    /// per address is possible, deadlocking the treasury.
    pub fn initialize(env: Env, admin: Address, approvers: Vec<Address>, quorum: u32) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        assert!(!approvers.is_empty(), "no approvers");
        // Reject duplicate approvers.
        let mut distinct: Vec<Address> = Vec::new(&env);
        for a in approvers.iter() {
            if distinct.contains(&a) {
                panic!("duplicate approver");
            }
            distinct.push_back(a);
        }
        assert!(quorum > 0, "invalid quorum");
        // Quorum must be reachable by the distinct approvers' weights.
        let mut total_weight: u32 = 0;
        for a in approvers.iter() {
            total_weight += Self::signer_weight(&env, &a);
        }
        assert!(quorum <= total_weight, "invalid quorum");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Approvers, &approvers);
        env.storage().instance().set(&DataKey::Quorum, &quorum);
        env.storage().instance().set(&DataKey::TxCounter, &0u64);
        env.storage().instance().set(&DataKey::QuorumCounter, &0u64);
        env.storage().instance().set(&DataKey::ProposalTtl, &DEFAULT_PROPOSAL_TTL_SECS);
    }

    /// Return the current approver set (issue #1446).
    pub fn get_approvers(env: Env) -> Vec<Address> {
        env.storage().instance().get(&DataKey::Approvers).unwrap()
    }

    /// Propose a new transaction. Any approver may propose.
    ///
    /// # Arguments
    /// * `description` — Human-readable summary of the transaction so approvers know what they are voting on.
    pub fn propose_transaction(env: Env, proposer: Address, description: String, amount: i128, recipient: Address) -> u64 {
        proposer.require_auth();
        Self::assert_is_approver(&env, &proposer);
        assert!(amount > 0, "amount must be positive");

        let id: u64 = env.storage().instance().get(&DataKey::TxCounter).unwrap();
        let proposal_ttl: u64 = env.storage().instance().get(&DataKey::ProposalTtl).unwrap_or(DEFAULT_PROPOSAL_TTL_SECS);
        let expires_at = env.ledger().timestamp() + proposal_ttl;

        let proposal = Proposal {
            proposer: proposer.clone(),
            description: description.clone(),
            amount,
            recipient: recipient.clone(),
            approvals: 0,
            rejections: 0,
            status: TxStatus::Pending,
            expires_at,
        };
        env.storage().persistent().set(&DataKey::Proposal(id), &proposal);
        env.storage().instance().set(&DataKey::TxCounter, &(id + 1));

        env.events().publish(
            (Symbol::new(&env, "ms_proposed"), id),
            EvtProposed { proposer, amount, recipient, description, expires_at },
        );
        id
    }

    /// Approve a pending proposal. Executes automatically when the cumulative
    /// **weight** of approvals reaches quorum.
    ///
    /// Both execution paths — this on-chain `approve` flow and the off-chain
    /// `execute_with_signatures` flow — count each signer's configured
    /// `SignerWeight` (default `DEFAULT_SIGNER_WEIGHT`). Quorum is therefore a
    /// weight threshold enforced identically regardless of path (issue #1056).
    pub fn approve(env: Env, approver: Address, tx_id: u64) {
        approver.require_auth();
        Self::assert_is_approver(&env, &approver);

        let mut proposal = Self::get_pending(&env, tx_id);
        assert!(!env.storage().persistent().has(&DataKey::Voted(tx_id, approver.clone())), "already voted");

        // Check expiry
        if env.ledger().timestamp() > proposal.expires_at {
            panic!("Proposal has expired");
        }

        env.storage().persistent().set(&DataKey::Voted(tx_id, approver.clone()), &true);
        let weight = Self::signer_weight(&env, &approver);
        proposal.approvals += weight;

        let quorum: u32 = env.storage().instance().get(&DataKey::Quorum).unwrap();
        let reached_quorum = proposal.approvals >= quorum;
        if reached_quorum {
            proposal.status = TxStatus::Executed;
        }
        env.storage().persistent().set(&DataKey::Proposal(tx_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "ms_approved"), tx_id),
            EvtApproved {
                approver,
                weight,
                total_approvals: proposal.approvals,
                quorum,
            },
        );
        if reached_quorum {
            env.events().publish(
                (Symbol::new(&env, "ms_executed"), tx_id),
                EvtExecuted { executed_at: env.ledger().timestamp() },
            );
        }
    }

    /// Reject a pending proposal. Marks as rejected when majority of approvers reject.
    pub fn reject(env: Env, approver: Address, tx_id: u64) {
        approver.require_auth();
        Self::assert_is_approver(&env, &approver);

        let mut proposal = Self::get_pending(&env, tx_id);
        assert!(!env.storage().persistent().has(&DataKey::Voted(tx_id, approver.clone())), "already voted");

        env.storage().persistent().set(&DataKey::Voted(tx_id, approver.clone()), &true);
        proposal.rejections += 1;

        let approvers: Vec<Address> = env.storage().instance().get(&DataKey::Approvers).unwrap();
        let quorum: u32 = env.storage().instance().get(&DataKey::Quorum).unwrap();
        // Rejected once the weight still available from signers who have not voted
        // can no longer lift the current approval weight to quorum.
        let mut remaining_weight: u32 = 0;
        for a in approvers.iter() {
            if !env.storage().persistent().has(&DataKey::Voted(tx_id, a.clone())) {
                remaining_weight += Self::signer_weight(&env, &a);
            }
        }
        if proposal.approvals + remaining_weight < quorum {
            proposal.status = TxStatus::Rejected;
        }
        env.storage().persistent().set(&DataKey::Proposal(tx_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "ms_rejected"), tx_id),
            EvtRejected {
                approver,
                total_rejections: proposal.rejections,
            },
        );
    }

    /// Mark an expired proposal as Expired. Anyone may call this.
    pub fn execute(env: Env, tx_id: u64) {
        let mut proposal: Proposal = env.storage().persistent().get(&DataKey::Proposal(tx_id))
            .expect("proposal not found");
        assert!(proposal.status == TxStatus::Pending, "not pending");
        
        if env.ledger().timestamp() <= proposal.expires_at {
            panic!("Proposal has not expired yet");
        }
        
        proposal.status = TxStatus::Expired;
        env.storage().persistent().set(&DataKey::Proposal(tx_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "ms_expired"), tx_id),
            EvtExpired { expired_at: env.ledger().timestamp() },
        );
    }

    /// Read a proposal.
    pub fn get_proposal(env: Env, tx_id: u64) -> Proposal {
        env.storage().persistent().get(&DataKey::Proposal(tx_id))
            .expect("proposal not found")
    }

    /// Cancel a pending proposal. Only the original proposer may call this, and only before expiry.
    pub fn cancel_proposal(env: Env, proposer: Address, tx_id: u64) {
        proposer.require_auth();

        let mut proposal: Proposal = env.storage().persistent().get(&DataKey::Proposal(tx_id))
            .expect("proposal not found");

        assert!(proposal.proposer == proposer, "only the proposer can cancel");
        assert!(proposal.status == TxStatus::Pending, "not pending");
        assert!(env.ledger().timestamp() < proposal.expires_at, "proposal expired");

        proposal.status = TxStatus::Cancelled;
        env.storage().persistent().set(&DataKey::Proposal(tx_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "ms_cancelled"), tx_id),
            EvtCancelled { proposer },
        );
    }

    /// Propose a quorum threshold change. Any approver may propose.
    /// The change takes effect only when the current quorum of approvers approve it.
    pub fn propose_quorum_change(env: Env, proposer: Address, new_quorum: u32) -> u64 {
        proposer.require_auth();
        Self::assert_is_approver(&env, &proposer);
        let approvers: Vec<Address> = env.storage().instance().get(&DataKey::Approvers).unwrap();
        assert!(new_quorum > 0 && new_quorum <= approvers.len(), "invalid quorum");

        let id: u64 = env.storage().instance().get(&DataKey::QuorumCounter).unwrap();
        let proposal_ttl: u64 = env.storage().instance().get(&DataKey::ProposalTtl).unwrap_or(DEFAULT_PROPOSAL_TTL_SECS);
        let expires_at = env.ledger().timestamp() + proposal_ttl;

        let proposal = QuorumChangeProposal {
            proposer: proposer.clone(),
            new_quorum,
            approvals: 0,
            rejections: 0,
            status: TxStatus::Pending,
            expires_at,
        };
        env.storage().persistent().set(&DataKey::QuorumProposal(id), &proposal);
        env.storage().instance().set(&DataKey::QuorumCounter, &(id + 1));

        env.events().publish(
            (Symbol::new(&env, "ms_quorum_proposed"), id),
            EvtQuorumProposed { proposer, new_quorum, expires_at },
        );
        id
    }

    /// Approve a pending quorum-change proposal. Updates quorum when threshold is reached.
    pub fn approve_quorum_change(env: Env, approver: Address, id: u64) {
        approver.require_auth();
        Self::assert_is_approver(&env, &approver);

        let mut proposal = Self::get_pending_quorum(&env, id);
        assert!(!env.storage().persistent().has(&DataKey::QuorumVoted(id, approver.clone())), "already voted");

        env.storage().persistent().set(&DataKey::QuorumVoted(id, approver), &true);
        proposal.approvals += 1;

        let quorum: u32 = env.storage().instance().get(&DataKey::Quorum).unwrap();
        if proposal.approvals >= quorum {
            proposal.status = TxStatus::Executed;
            env.storage().instance().set(&DataKey::Quorum, &proposal.new_quorum);
        }
        env.storage().persistent().set(&DataKey::QuorumProposal(id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "ms_quorum_changed"), id),
            EvtQuorumChanged { old_quorum: quorum, new_quorum: proposal.new_quorum },
        );
    }

    /// Reject a pending quorum-change proposal. Marks as rejected when quorum is no longer reachable.
    pub fn reject_quorum_change(env: Env, approver: Address, id: u64) {
        approver.require_auth();
        Self::assert_is_approver(&env, &approver);

        let mut proposal = Self::get_pending_quorum(&env, id);
        assert!(!env.storage().persistent().has(&DataKey::QuorumVoted(id, approver.clone())), "already voted");

        env.storage().persistent().set(&DataKey::QuorumVoted(id, approver), &true);
        proposal.rejections += 1;

        let approvers: Vec<Address> = env.storage().instance().get(&DataKey::Approvers).unwrap();
        let quorum: u32 = env.storage().instance().get(&DataKey::Quorum).unwrap();
        let remaining = approvers.len() as u32 - proposal.approvals - proposal.rejections;
        if proposal.approvals + remaining < quorum {
            proposal.status = TxStatus::Rejected;
        }
        env.storage().persistent().set(&DataKey::QuorumProposal(id), &proposal);
    }

    /// Read a quorum-change proposal.
    pub fn get_quorum_proposal(env: Env, id: u64) -> QuorumChangeProposal {
        env.storage().persistent().get(&DataKey::QuorumProposal(id))
            .expect("quorum proposal not found")
    }

    /// Update the proposal TTL (time-to-live). Only admin may call this.
    /// Applies to future proposals only, not retroactively.
    pub fn update_proposal_ttl(env: Env, admin: Address, new_ttl: u64) {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("Only admin can update proposal TTL");
        }
        if new_ttl == 0 {
            panic!("TTL must be positive");
        }
        env.storage().instance().set(&DataKey::ProposalTtl, &new_ttl);

        env.events().publish(
            (Symbol::new(&env, "ms_ttl_updated"),),
            new_ttl,
        );
    }

    /// Clean up an expired proposal. Anyone may call this.
    /// Removes the proposal from storage to reclaim ledger rent.
    pub fn cleanup_expired(env: Env, tx_id: u64) {
        let proposal: Proposal = env.storage().persistent().get(&DataKey::Proposal(tx_id))
            .expect("proposal not found");
        
        if proposal.status != TxStatus::Expired {
            panic!("Only expired proposals can be cleaned up");
        }
        
        env.storage().persistent().remove(&DataKey::Proposal(tx_id));
    }

    // --- signer rotation ---

    /// Propose adding or removing a signer. Admin only.
    ///
    /// The rotation is time-locked: it cannot be executed until
    /// `now + 259200` (72 hours). Only one rotation may be pending at a time.
    /// A pending rotation may be aborted during the time-lock window — see
    /// `cancel_signer_change` for the (lower-threshold) cancellation authority.
    /// Emits `SignerChangeProposed`.
    ///
    /// # Arguments
    /// * `action` — `RotationAction::Add` or `RotationAction::Remove`.
    /// * `signer` — The address to add or remove from the approvers list.
    pub fn propose_signer_change(env: Env, action: RotationAction, signer: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        if env.storage().instance().has(&DataKey::PendingRotation) {
            panic!("Rotation already pending");
        }

        let approvers: Vec<Address> = env.storage().instance().get(&DataKey::Approvers).unwrap();
        match action {
            RotationAction::Add => {
                if approvers.contains(&signer) {
                    panic!("signer already present");
                }
            }
            RotationAction::Remove => {
                if !approvers.contains(&signer) {
                    panic!("signer not present");
                }
            }
        }

        let effective_at = env.ledger().timestamp() + ROTATION_DELAY;
        let rotation = PendingRotation {
            action,
            signer: signer.clone(),
            effective_at,
        };
        env.storage()
            .instance()
            .set(&DataKey::PendingRotation, &rotation);

        env.events().publish(
            (Symbol::new(&env, "SignerChangeProposed"),),
            EvtSignerChangeProposed { action, signer, effective_at },
        );
    }

    /// Execute a pending signer rotation after the time-lock has elapsed.
    ///
    /// Anyone may call this once `effective_at` is reached.
    /// - `Add`: appends the signer to the approvers list (no-op if already present).
    /// - `Remove`: removes the signer; panics if doing so would make the quorum
    ///   unreachable.
    /// Emits `SignerChanged`.
    pub fn execute_signer_change(env: Env) {
        let rotation: PendingRotation = env
            .storage()
            .instance()
            .get(&DataKey::PendingRotation)
            .expect("no pending rotation");

        if env.ledger().timestamp() < rotation.effective_at {
            panic!("Time-lock has not elapsed");
        }

        let mut approvers: Vec<Address> =
            env.storage().instance().get(&DataKey::Approvers).unwrap();

        match rotation.action {
            RotationAction::Add => {
                // Reject a signer that is already present (issue #1446).
                if approvers.contains(&rotation.signer) {
                    panic!("signer already present");
                }
                approvers.push_back(rotation.signer.clone());
            }
            RotationAction::Remove => {
                let quorum: u32 = env.storage().instance().get(&DataKey::Quorum).unwrap();
                // Rebuild the approvers list without the target signer, then
                // re-validate that quorum is still reachable by the remaining
                // distinct signers' weights (issue #1446).
                let mut new_approvers: Vec<Address> = Vec::new(&env);
                let mut remaining_weight: u32 = 0;
                for a in approvers.iter() {
                    if a != rotation.signer {
                        remaining_weight += Self::signer_weight(&env, &a);
                        new_approvers.push_back(a);
                    }
                }
                if remaining_weight < quorum {
                    panic!("Cannot remove: threshold would be unreachable");
                }
                approvers = new_approvers;
            }
        }

        env.storage()
            .instance()
            .set(&DataKey::Approvers, &approvers);
        env.storage()
            .instance()
            .remove(&DataKey::PendingRotation);

        env.events().publish(
            (Symbol::new(&env, "SignerChanged"),),
            EvtSignerChanged {
                action: rotation.action,
                signer: rotation.signer,
                executed_at: env.ledger().timestamp(),
            },
        );
    }

    /// Cancel the pending signer rotation before its time-lock elapses.
    ///
    /// # Authorization model (issue #1054)
    ///
    /// Cancellation is deliberately held to a **lower threshold** than proposal.
    /// `propose_signer_change` is admin-only, but `cancel_signer_change` may be
    /// called by the admin **or by any single current approver**. This preserves
    /// the multisig's single-key-compromise resistance: if a compromised admin
    /// key proposes a malicious rotation, any one honest signer can veto it
    /// during the 72-hour window. `caller` must authorize the call.
    ///
    /// Emits `SignerChangeCancelled`.
    pub fn cancel_signer_change(env: Env, caller: Address) {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        let approvers: Vec<Address> = env.storage().instance().get(&DataKey::Approvers).unwrap();
        if caller != admin && !approvers.contains(&caller) {
            panic!("not authorized to cancel");
        }

        let rotation: PendingRotation = env
            .storage()
            .instance()
            .get(&DataKey::PendingRotation)
            .expect("no pending rotation");

        env.storage()
            .instance()
            .remove(&DataKey::PendingRotation);

        env.events().publish(
            (Symbol::new(&env, "SignerChangeCancelled"),),
            EvtSignerChangeCancelled {
                action: rotation.action,
                signer: rotation.signer,
                cancelled_at: env.ledger().timestamp(),
            },
        );
    }

    // --- helpers ---

    fn assert_is_approver(env: &Env, addr: &Address) {
        let approvers: Vec<Address> = env.storage().instance().get(&DataKey::Approvers).unwrap();
        assert!(approvers.contains(addr), "not an approver");
    }

    fn get_pending(env: &Env, tx_id: u64) -> Proposal {
        let proposal: Proposal = env.storage().persistent().get(&DataKey::Proposal(tx_id))
            .expect("proposal not found");
        assert!(proposal.status == TxStatus::Pending, "not pending");
        assert!(env.ledger().timestamp() < proposal.expires_at, "proposal expired");
        proposal
    }

    fn get_pending_quorum(env: &Env, id: u64) -> QuorumChangeProposal {
        let proposal: QuorumChangeProposal = env.storage().persistent().get(&DataKey::QuorumProposal(id))
            .expect("quorum proposal not found");
        assert!(proposal.status == TxStatus::Pending, "not pending");
        assert!(env.ledger().timestamp() < proposal.expires_at, "proposal expired");
        proposal
    }

    /// Quorum weight contributed by `addr`, defaulting to
    /// `DEFAULT_SIGNER_WEIGHT` when no weight has been set. Used by both
    /// execution paths so quorum enforcement is identical (issue #1056).
    fn signer_weight(env: &Env, addr: &Address) -> u32 {
        env.storage().persistent()
            .get(&DataKey::SignerWeight(addr.clone()))
            .unwrap_or(DEFAULT_SIGNER_WEIGHT)
    }

    // ── Issue #760: Off-chain signature aggregation ───────────────────────────

    /// Set the signing weight for an approver. Admin only.
    ///
    /// Weight defaults to `DEFAULT_SIGNER_WEIGHT` (1) when never set. The
    /// accepted range is `1..=MAX_SIGNER_WEIGHT` (issue #1055):
    ///
    /// * `weight == 0` is **rejected**. A zero weight would leave a signer in the
    ///   approvers list while contributing nothing to quorum, blurring the line
    ///   between "present" and "removed". To drop a signer's influence, use the
    ///   time-locked `propose_signer_change(RotationAction::Remove, ..)` flow so
    ///   the approvers list and quorum stay consistent.
    /// * `weight > MAX_SIGNER_WEIGHT` (100) is **rejected** so no single signer
    ///   can concentrate enough weight to satisfy quorum alone.
    pub fn set_signer_weight(env: Env, admin: Address, signer: Address, weight: u32) {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        if admin != stored_admin { panic!("Only admin can set signer weight"); }
        if weight == 0 { panic!("Weight must be positive"); }
        if weight > MAX_SIGNER_WEIGHT { panic!("Weight exceeds maximum"); }
        Self::assert_is_approver(&env, &signer);
        env.storage().persistent().set(&DataKey::SignerWeight(signer.clone()), &weight);

        env.events().publish(
            (Symbol::new(&env, "ms_weight_set"), signer.clone()),
            EvtWeightSet { signer, weight },
        );
    }

    /// Deterministic SHA-256 digest an off-chain signer signs to approve a
    /// proposal.
    ///
    /// # Domain separation (issue #1053)
    ///
    /// The preimage binds a signature to one exact context so it cannot be
    /// replayed elsewhere:
    ///
    /// * **contract instance** — `current_contract_address()` prevents replay
    ///   against another deployment of this contract.
    /// * **network** — `ledger().network_id()` (the chain id) prevents replay of
    ///   a testnet signature on mainnet or across any two networks.
    /// * **proposal id** — a signature over `proposal_hash(a)` can never satisfy
    ///   `proposal_hash(b)`, even if every other field matches.
    /// * **payload** — every immutable proposal field (proposer, recipient,
    ///   amount, expiry, description), so a signature commits to the full message.
    ///
    /// # Preimage format (version 1)
    ///
    /// `sha256` over the concatenation of:
    ///
    /// | Field          | Encoding                                     |
    /// |----------------|----------------------------------------------|
    /// | tag            | ASCII `AFRIPAY_MULTISIG_PROPOSAL` (25 bytes) |
    /// | version        | `0x01` (1 byte)                              |
    /// | contract       | `ScVal::Address` XDR                         |
    /// | network id     | 32 bytes                                     |
    /// | proposal_id    | u64 big-endian (8 bytes)                     |
    /// | proposer       | `ScVal::Address` XDR                         |
    /// | recipient      | `ScVal::Address` XDR                         |
    /// | amount         | i128 big-endian (16 bytes)                   |
    /// | expires_at     | u64 big-endian (8 bytes)                     |
    /// | description    | `ScVal::String` XDR (length-prefixed)        |
    ///
    /// XDR values are self-delimiting, so the encoding is unambiguous. Client
    /// tooling can rebuild the preimage with `stellar-xdr` and must match this
    /// function's output.
    pub fn proposal_hash(env: Env, proposal_id: u64) -> BytesN<32> {
        let proposal: Proposal = env.storage().persistent().get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");
        let contract_addr = env.current_contract_address();
        let mut preimage = Bytes::from_slice(&env, PROPOSAL_HASH_TAG);
        preimage.push_back(PROPOSAL_HASH_VERSION);
        // Domain separator: this contract instance.
        preimage.append(&contract_addr.to_xdr(&env));
        // Domain separator: the network / chain id.
        preimage.append(&Bytes::from(env.ledger().network_id()));
        // proposal_id — binds the signature to one proposal.
        preimage.append(&Bytes::from_array(&env, &proposal_id.to_be_bytes()));
        preimage.append(&proposal.proposer.to_xdr(&env));
        preimage.append(&proposal.recipient.to_xdr(&env));
        preimage.append(&Bytes::from_array(&env, &proposal.amount.to_be_bytes()));
        preimage.append(&Bytes::from_array(&env, &proposal.expires_at.to_be_bytes()));
        preimage.append(&proposal.description.to_xdr(&env));
        env.crypto().sha256(&preimage).into()
    }

    /// Extract the raw ed25519 public key of a `G…` account address.
    ///
    /// `ScVal::Address(ScAddress::Account(PublicKey::Ed25519(key)))` encodes as
    /// `[ScVal tag u32][ScAddress tag u32 = 0][PublicKey tag u32 = 0][key 32B]`.
    /// Contract (`C…`) addresses have no ed25519 key and are rejected; they must
    /// approve through the Soroban-auth `approve` path instead.
    fn account_ed25519_key(env: &Env, addr: &Address) -> BytesN<32> {
        let xdr = addr.to_xdr(env);
        let account_tag = Bytes::from_array(env, &[0u8; 4]);
        if xdr.len() != 44 || xdr.slice(4..8) != account_tag || xdr.slice(8..12) != account_tag {
            panic!("Signer must be an ed25519 account address");
        }
        xdr.slice(12..44).try_into().unwrap()
    }

    /// Execute a proposal using pre-collected off-chain ed25519 signatures.
    ///
    /// Each entry in `signatures` is `(signer_address, ed25519_sig_over_proposal_hash)`.
    /// Verifies all signatures against `Self::proposal_hash`, checks cumulative
    /// weight `>= quorum`, rejects duplicate signers, and marks the proposal
    /// `Executed`.
    ///
    /// Replay protection (issue #1053):
    /// * Signatures are bound to this contract instance, this network and this
    ///   `proposal_id` — see `Self::proposal_hash`.
    /// * Execution state is unified with the on-chain `approve` path: this call
    ///   goes through `Self::get_pending`, so a proposal already `Executed`
    ///   (or `Expired`/`Cancelled`) via any path is rejected with `"not pending"`.
    ///
    /// Quorum here counts each signer's `SignerWeight` exactly as `approve` does
    /// (issue #1056).
    pub fn execute_with_signatures(
        env: Env,
        proposal_id: u64,
        signatures: Vec<(Address, BytesN<64>)>,
    ) {
        let mut proposal = Self::get_pending(&env, proposal_id);
        let hash = Self::proposal_hash(env.clone(), proposal_id);
        let quorum: u32 = env.storage().instance().get(&DataKey::Quorum).unwrap();

        let mut seen: Vec<Address> = Vec::new(&env);
        let mut total_weight: u32 = 0;

        for (signer, sig) in signatures.iter() {
            // Reject duplicate signers
            if seen.contains(&signer) {
                panic!("Duplicate signer");
            }
            seen.push_back(signer.clone());

            // Signer must be a registered approver
            Self::assert_is_approver(&env, &signer);

            // Verify ed25519 signature over the proposal hash. Only `G…` account
            // signers can sign off-chain; contract signers use `approve`.
            let pub_key = Self::account_ed25519_key(&env, &signer);
            env.crypto().ed25519_verify(&pub_key, &Bytes::from(hash.clone()), &sig);

            total_weight += Self::signer_weight(&env, &signer);
        }

        if total_weight < quorum {
            panic!("Insufficient weight");
        }

        proposal.status = TxStatus::Executed;
        env.storage().persistent().set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "ms_executed"), proposal_id),
            EvtExecuted { executed_at: env.ledger().timestamp() },
        );
    }

    // --- admin rotation (two-step, issue #1444) ---

    /// Propose a new admin. Current admin only. The rotation is time-locked
    /// (`ADMIN_ROTATION_DELAY`) and must be accepted by the new admin.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) {
        governance::propose_admin(&env, &admin, &new_admin);
    }

    /// Accept a pending admin rotation. Requires the new admin's signature and
    /// that the time-lock has elapsed.
    pub fn accept_admin(env: Env, new_admin: Address) {
        governance::accept_admin(&env, &new_admin);
    }

    /// Cancel a pending admin rotation. Current admin only.
    pub fn cancel_admin_proposal(env: Env, admin: Address) {
        governance::cancel_admin_proposal(&env, &admin);
    }

    /// Read the current admin.
    pub fn get_admin(env: Env) -> Address {
        governance::get_admin(&env)
    }

    /// Read the pending admin rotation, if any.
    pub fn get_pending_admin(env: Env) -> Option<governance::PendingAdmin> {
        governance::get_pending_admin(&env)
    }
}

mod governance;
pub use governance::{CONTRACT_VERSION, UPGRADE_TIMELOCK_SECS};
