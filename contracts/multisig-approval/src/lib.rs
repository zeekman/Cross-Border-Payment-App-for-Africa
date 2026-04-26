#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec};

mod test;

const EXPIRY_SECONDS: u64 = 86_400; // 24 hours

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TxStatus {
    Pending,
    Executed,
    Rejected,
    Expired,
}

#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    pub proposer: Address,
    pub amount: i128,
    pub recipient: Address,
    pub approvals: u32,
    pub rejections: u32,
    pub status: TxStatus,
    pub expires_at: u64,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Approvers,
    Quorum,
    TxCounter,
    Proposal(u64),
    Voted(u64, Address),
}

#[contract]
pub struct MultisigContract;

#[contractimpl]
impl MultisigContract {
    /// Initialize the contract with a list of approvers and minimum quorum.
    pub fn initialize(env: Env, admin: Address, approvers: Vec<Address>, quorum: u32) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        assert!(quorum > 0 && quorum as usize <= approvers.len(), "invalid quorum");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Approvers, &approvers);
        env.storage().instance().set(&DataKey::Quorum, &quorum);
        env.storage().instance().set(&DataKey::TxCounter, &0u64);
    }

    /// Propose a new transaction. Any approver may propose.
    pub fn propose_transaction(env: Env, proposer: Address, amount: i128, recipient: Address) -> u64 {
        proposer.require_auth();
        Self::assert_is_approver(&env, &proposer);
        assert!(amount > 0, "amount must be positive");

        let id: u64 = env.storage().instance().get(&DataKey::TxCounter).unwrap();
        let expires_at = env.ledger().timestamp() + EXPIRY_SECONDS;

        let proposal = Proposal {
            proposer,
            amount,
            recipient,
            approvals: 0,
            rejections: 0,
            status: TxStatus::Pending,
            expires_at,
        };
        env.storage().persistent().set(&DataKey::Proposal(id), &proposal);
        env.storage().instance().set(&DataKey::TxCounter, &(id + 1));
        id
    }

    /// Approve a pending proposal. Executes automatically when quorum is reached.
    pub fn approve(env: Env, approver: Address, tx_id: u64) {
        approver.require_auth();
        Self::assert_is_approver(&env, &approver);

        let mut proposal = Self::get_pending(&env, tx_id);
        assert!(!env.storage().persistent().has(&DataKey::Voted(tx_id, approver.clone())), "already voted");

        env.storage().persistent().set(&DataKey::Voted(tx_id, approver), &true);
        proposal.approvals += 1;

        let quorum: u32 = env.storage().instance().get(&DataKey::Quorum).unwrap();
        if proposal.approvals >= quorum {
            proposal.status = TxStatus::Executed;
        }
        env.storage().persistent().set(&DataKey::Proposal(tx_id), &proposal);
    }

    /// Reject a pending proposal. Marks as rejected when majority of approvers reject.
    pub fn reject(env: Env, approver: Address, tx_id: u64) {
        approver.require_auth();
        Self::assert_is_approver(&env, &approver);

        let mut proposal = Self::get_pending(&env, tx_id);
        assert!(!env.storage().persistent().has(&DataKey::Voted(tx_id, approver.clone())), "already voted");

        env.storage().persistent().set(&DataKey::Voted(tx_id, approver), &true);
        proposal.rejections += 1;

        let approvers: Vec<Address> = env.storage().instance().get(&DataKey::Approvers).unwrap();
        let quorum: u32 = env.storage().instance().get(&DataKey::Quorum).unwrap();
        // Rejected when remaining possible approvals can no longer reach quorum
        let remaining = approvers.len() as u32 - proposal.approvals - proposal.rejections;
        if proposal.approvals + remaining < quorum {
            proposal.status = TxStatus::Rejected;
        }
        env.storage().persistent().set(&DataKey::Proposal(tx_id), &proposal);
    }

    /// Mark an expired proposal as Expired. Anyone may call this.
    pub fn execute(env: Env, tx_id: u64) {
        let mut proposal: Proposal = env.storage().persistent().get(&DataKey::Proposal(tx_id))
            .expect("proposal not found");
        assert!(proposal.status == TxStatus::Pending, "not pending");
        assert!(env.ledger().timestamp() >= proposal.expires_at, "not yet expired");
        proposal.status = TxStatus::Expired;
        env.storage().persistent().set(&DataKey::Proposal(tx_id), &proposal);
    }

    /// Read a proposal.
    pub fn get_proposal(env: Env, tx_id: u64) -> Proposal {
        env.storage().persistent().get(&DataKey::Proposal(tx_id))
            .expect("proposal not found")
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
}
