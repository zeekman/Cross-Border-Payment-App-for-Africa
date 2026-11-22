//! Upgrade governance (SC-172 / SC-173) and admin rotation (SC-190).
//!
//! WASM upgrades are timelocked on-chain: the admin proposes a new WASM hash,
//! which can only be executed after `UPGRADE_TIMELOCK_SECS`, giving users an
//! exit window. Proposals can be cancelled. `migrate` bumps the stored
//! contract version after an upgrade.
//!
//! Admin rotation is two-step: the current admin proposes a successor, which
//! is only accepted after `ADMIN_ROTATION_DELAY_SECS` and with the new admin's
//! signature. This lets a lost or compromised admin key be replaced.
//! **Recommendation:** the admin should be a multisig account or the
//! `multisig-approval` contract, never a single hot key.
use crate::{DataKey, KycAttestationContract};
use soroban_sdk::{contractimpl, contracttype, Address, BytesN, Env, Symbol};

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 1;

/// Minimum delay between proposing and executing an upgrade (48 hours).
pub const UPGRADE_TIMELOCK_SECS: u64 = 48 * 60 * 60;

/// Minimum delay between proposing and accepting an admin rotation (24 hours).
pub const ADMIN_ROTATION_DELAY_SECS: u64 = 24 * 60 * 60;

/// Encodes identically to a `DataKey` variant of the same name, so existing
/// `ContractVersion` entries remain readable.
#[contracttype]
pub enum GovKey {
    ContractVersion,
    PendingUpgrade,
    PendingAdmin,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PendingUpgrade {
    pub new_wasm_hash: BytesN<32>,
    pub eta: u64,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PendingAdmin {
    pub new_admin: Address,
    pub eta: u64,
}

pub(crate) fn require_gov_admin(env: &Env, admin: &Address, msg: &str) {
    admin.require_auth();
    let stored: Address = env
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("Contract not initialized");
    if admin != &stored {
        panic!("{}", msg);
    }
}

#[contractimpl]
impl KycAttestationContract {
    /// Schedule a WASM upgrade. Executable after `UPGRADE_TIMELOCK_SECS`.
    /// Returns the earliest execution timestamp (eta).
    pub fn propose_upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> u64 {
        require_gov_admin(&env, &admin, "Only admin can upgrade the contract");
        let eta = env.ledger().timestamp() + UPGRADE_TIMELOCK_SECS;
        let pending = PendingUpgrade { new_wasm_hash: new_wasm_hash.clone(), eta };
        env.storage().persistent().set(&GovKey::PendingUpgrade, &pending);
        env.events()
            .publish((Symbol::new(&env, "UpgradeProposed"),), (new_wasm_hash, eta));
        eta
    }

    /// Alias of `propose_upgrade` — upgrades are never applied instantly.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> u64 {
        Self::propose_upgrade(env, admin, new_wasm_hash)
    }

    pub fn cancel_upgrade(env: Env, admin: Address) {
        require_gov_admin(&env, &admin, "Only admin can upgrade the contract");
        let pending: PendingUpgrade = env
            .storage()
            .persistent()
            .get(&GovKey::PendingUpgrade)
            .expect("No pending upgrade");
        env.storage().persistent().remove(&GovKey::PendingUpgrade);
        env.events()
            .publish((Symbol::new(&env, "UpgradeCancelled"),), pending.new_wasm_hash);
    }

    /// Apply the pending upgrade once its timelock has expired.
    ///
    /// Upgrades are **irreversible on-chain**; test on testnet first.
    pub fn execute_upgrade(env: Env, admin: Address) {
        require_gov_admin(&env, &admin, "Only admin can upgrade the contract");
        let pending: PendingUpgrade = env
            .storage()
            .persistent()
            .get(&GovKey::PendingUpgrade)
            .expect("No pending upgrade");
        if env.ledger().timestamp() < pending.eta {
            panic!("Upgrade timelock has not expired");
        }
        env.storage().persistent().remove(&GovKey::PendingUpgrade);
        env.deployer()
            .update_current_contract_wasm(pending.new_wasm_hash.clone());
        env.events().publish(
            (Symbol::new(&env, "Upgraded"),),
            (pending.new_wasm_hash, CONTRACT_VERSION),
        );
    }

    pub fn get_pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        env.storage().persistent().get(&GovKey::PendingUpgrade)
    }

    /// Run storage migrations for the current WASM. Idempotent.
    pub fn migrate(env: Env, admin: Address) {
        require_gov_admin(&env, &admin, "Only admin can perform this action");
        let current: u32 = env
            .storage()
            .persistent()
            .get(&GovKey::ContractVersion)
            .unwrap_or(0);
        if current >= CONTRACT_VERSION {
            return;
        }
        env.storage()
            .persistent()
            .set(&GovKey::ContractVersion, &CONTRACT_VERSION);
        env.events()
            .publish((Symbol::new(&env, "Migrated"),), CONTRACT_VERSION);
    }

    pub fn get_contract_version(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&GovKey::ContractVersion)
            .unwrap_or(0)
    }

    /// Step 1 of admin rotation: the current admin nominates a successor.
    /// The successor can only accept after `ADMIN_ROTATION_DELAY_SECS`.
    /// Returns the earliest acceptance timestamp (eta).
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) -> u64 {
        require_gov_admin(&env, &admin, "Only admin can propose a new admin");
        let eta = env.ledger().timestamp() + ADMIN_ROTATION_DELAY_SECS;
        let pending = PendingAdmin { new_admin: new_admin.clone(), eta };
        env.storage().persistent().set(&GovKey::PendingAdmin, &pending);
        env.events().publish(
            (Symbol::new(&env, "AdminProposed"),),
            (admin, new_admin, eta),
        );
        eta
    }

    /// Step 2 of admin rotation: the nominated successor accepts the role.
    /// Requires the new admin's signature and an expired delay.
    pub fn accept_admin(env: Env, new_admin: Address) {
        new_admin.require_auth();
        let pending: PendingAdmin = env
            .storage()
            .persistent()
            .get(&GovKey::PendingAdmin)
            .expect("No pending admin proposal");
        if pending.new_admin != new_admin {
            panic!("Only the proposed admin can accept");
        }
        if env.ledger().timestamp() < pending.eta {
            panic!("Admin rotation delay has not expired");
        }
        let old_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        env.storage().persistent().remove(&GovKey::PendingAdmin);
        env.storage().persistent().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (Symbol::new(&env, "AdminChanged"),),
            (old_admin, new_admin),
        );
    }

    /// Cancel a pending admin proposal. Only the current admin may do this.
    pub fn cancel_admin_proposal(env: Env, admin: Address) {
        require_gov_admin(&env, &admin, "Only admin can cancel an admin proposal");
        let pending: PendingAdmin = env
            .storage()
            .persistent()
            .get(&GovKey::PendingAdmin)
            .expect("No pending admin proposal");
        env.storage().persistent().remove(&GovKey::PendingAdmin);
        env.events()
            .publish((Symbol::new(&env, "AdminProposalCancelled"),), pending.new_admin);
    }

    pub fn get_pending_admin(env: Env) -> Option<PendingAdmin> {
        env.storage().persistent().get(&GovKey::PendingAdmin)
    }
}
