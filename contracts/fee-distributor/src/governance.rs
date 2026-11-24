//! Upgrade governance (SC-172 / SC-173 / SC-184).
//!
//! WASM upgrades are timelocked on-chain: the admin proposes a new WASM hash,
//! which can only be executed after `UPGRADE_TIMELOCK_SECS`, giving users an
//! exit window. Proposals can be cancelled.
//!
//! `execute_upgrade` swaps the WASM but does **not** migrate storage: the new
//! code must call `migrate` afterwards (same deployment run). `migrate` runs
//! each intermediate `migrate_vN_to_vN+1` step exactly once and emits
//! `Migrated { from_version, to_version }`.
//! The implementation lives in the shared `afripay-governance` crate; this
//! module only wires the contract's storage layout into it.
use crate::{DataKey, FeeDistributorContract};
use afripay_governance::AdminStore;
use soroban_sdk::{Address, Env};

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 1;

/// Minimum delay between proposing and executing an upgrade (48 hours).
pub const UPGRADE_TIMELOCK_SECS: u64 = 48 * 60 * 60;

/// Ledgers to extend instance storage TTL by on each call (~30 days at 5s).
pub const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
/// Extend instance storage when its remaining TTL drops below ~7 days.
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960;
/// Ledgers to extend persistent storage TTL by on each touched record.
pub const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;
/// Extend persistent storage when its remaining TTL drops below ~7 days.
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;

/// Payload of the `Migrated` event.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct MigratedEvent {
    pub from_version: u32,
    pub to_version: u32,
}

pub(crate) fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

pub(crate) fn bump_persistent(env: &Env, key: &GovKey) {
    env.storage().persistent().extend_ttl(
        key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}
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

/// A proposed admin rotation, executable once `eta` is reached.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PendingAdmin {
    pub new_admin: Address,
    pub eta: u64,
}

pub(crate) fn require_gov_admin(env: &Env, admin: &Address, msg: &str) {
    bump_instance(env);
    admin.require_auth();
    env.storage().persistent().extend_ttl(
        &DataKey::Admin,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
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
impl FeeDistributorContract {
    /// Schedule a WASM upgrade. Executable after `UPGRADE_TIMELOCK_SECS`.
    /// Returns the earliest execution timestamp (eta).
    pub fn propose_upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> u64 {
        require_gov_admin(&env, &admin, "Only admin can upgrade the contract");
        let eta = env.ledger().timestamp() + UPGRADE_TIMELOCK_SECS;
        let pending = PendingUpgrade { new_wasm_hash: new_wasm_hash.clone(), eta };
        env.storage().persistent().set(&GovKey::PendingUpgrade, &pending);
        bump_persistent(&env, &GovKey::PendingUpgrade);
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
        bump_persistent(&env, &GovKey::PendingUpgrade);
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
    /// The new WASM only takes effect after this invocation ends, so the event
    /// carries the new hash only — the version is reported by `migrate`, which
    /// runs in the new code. Call `migrate` in the same deployment run.
    ///
    /// Upgrades are **irreversible on-chain**; test on testnet first.
    pub fn execute_upgrade(env: Env, admin: Address) {
        require_gov_admin(&env, &admin, "Only admin can upgrade the contract");
        bump_persistent(&env, &GovKey::PendingUpgrade);
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
        env.events()
            .publish((Symbol::new(&env, "Upgraded"),), pending.new_wasm_hash);
    }

    pub fn get_pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        bump_instance(&env);
        bump_persistent(&env, &GovKey::PendingUpgrade);
        env.storage().persistent().get(&GovKey::PendingUpgrade)
    }

    /// Run storage migrations for the current WASM.
    ///
    /// Runs every intermediate step from the stored version up to
    /// `CONTRACT_VERSION`, persisting the version after each step so a partial
    /// run resumes where it stopped. Idempotent: a second call is a no-op.
    /// Propose a two-step admin rotation. The new admin must call
    /// `accept_admin` after `ADMIN_ROTATION_DELAY_SECS`.
    ///
    /// It is strongly recommended that the admin be a multisig account or the
    /// `multisig-approval` contract so a single lost or compromised key cannot
    /// permanently lock governance.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) -> u64 {
        require_gov_admin(&env, &admin, "Only admin can propose a new admin");
        let eta = env.ledger().timestamp() + ADMIN_ROTATION_DELAY_SECS;
        let pending = PendingAdmin { new_admin: new_admin.clone(), eta };
        env.storage().persistent().set(&GovKey::PendingAdmin, &pending);
        env.events()
            .publish((Symbol::new(&env, "AdminProposed"),), (new_admin, eta));
        eta
    }

    /// Accept a pending admin rotation. Requires the new admin's signature and
    /// that the rotation delay has elapsed.
    pub fn accept_admin(env: Env, new_admin: Address) {
        new_admin.require_auth();
        let pending: PendingAdmin = env
            .storage()
            .persistent()
            .get(&GovKey::PendingAdmin)
            .expect("No pending admin");
        if new_admin != pending.new_admin {
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
        env.storage().persistent().set(&DataKey::Admin, &new_admin);
        env.storage().persistent().remove(&GovKey::PendingAdmin);
        env.events().publish(
            (Symbol::new(&env, "AdminChanged"),),
            (old_admin, new_admin),
        );
    }

    /// Cancel a pending admin rotation.
    pub fn cancel_admin_proposal(env: Env, admin: Address) {
        require_gov_admin(&env, &admin, "Only admin can cancel an admin proposal");
        let pending: PendingAdmin = env
            .storage()
            .persistent()
            .get(&GovKey::PendingAdmin)
            .expect("No pending admin");
        env.storage().persistent().remove(&GovKey::PendingAdmin);
        env.events()
            .publish((Symbol::new(&env, "AdminProposalCancelled"),), pending.new_admin);
    }

    pub fn get_pending_admin(env: Env) -> Option<PendingAdmin> {
        env.storage().persistent().get(&GovKey::PendingAdmin)
    }

    /// Run storage migrations for the current WASM. Idempotent.
    pub fn migrate(env: Env, admin: Address) {
        require_gov_admin(&env, &admin, "Only admin can perform this action");
        bump_persistent(&env, &GovKey::ContractVersion);
        let mut current: u32 = env
            .storage()
            .persistent()
            .get(&GovKey::ContractVersion)
            .unwrap_or(0);
        while current < CONTRACT_VERSION {
            match current {
                1 => migrate_v1_to_v2(&env),
                // Add future steps here: 2 => migrate_v2_to_v3(&env), ...
                _ => {}
            }
            let from_version = current;
            current += 1;
            env.storage()
                .persistent()
                .set(&GovKey::ContractVersion, &current);
            bump_persistent(&env, &GovKey::ContractVersion);
            env.events().publish(
                (Symbol::new(&env, "Migrated"),),
                MigratedEvent { from_version, to_version: current },
            );
        }
    }

    pub fn get_contract_version(env: Env) -> u32 {
        bump_instance(&env);
        bump_persistent(&env, &GovKey::ContractVersion);
impl AdminStore for FeeDistributorContract {
    fn admin(env: &Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized")
    }
}

/// v1 → v2 storage migration. No-op today; kept so the step is recorded.
fn migrate_v1_to_v2(_env: &Env) {}
afripay_governance::governance_impl!(FeeDistributorContract, CONTRACT_VERSION);
