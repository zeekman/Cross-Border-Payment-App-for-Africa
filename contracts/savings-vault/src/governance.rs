//! Upgrade governance (SC-172 / SC-173 / SC-174 / SC-184).
//!
//! WASM upgrades are timelocked on-chain: the admin proposes a new WASM hash,
//! which can only be executed after `UPGRADE_TIMELOCK_SECS`, giving users an
//! exit window. Proposals can be cancelled. `migrate` bumps the stored
//! contract version after an upgrade.
//!
//! Admin rotation (SC-184) is two-step and timelocked: the current admin
//! proposes a successor, and the successor must accept after
//! `ADMIN_ROTATION_DELAY_SECS`. This prevents a lost or compromised admin key
//! from being permanent. **Recommendation:** the admin should be a multisig
//! account (or the `multisig-approval` contract) rather than a single key.
//! The implementation lives in the shared `afripay-governance` crate. This
//! module only wires the contract's storage layout into the shared code and
//! expands the exported governance API via `governance_impl!`.
use crate::{DataKey, SavingsVaultContract};
use afripay_governance::AdminStore;
use soroban_sdk::{Address, Env};

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 1;

/// Minimum delay between proposing and executing an upgrade (48 hours).
pub const UPGRADE_TIMELOCK_SECS: u64 = 48 * 60 * 60;

/// Ledgers to extend instance storage TTL by on each governance call
/// (~30 days at 5s per ledger).
pub const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
/// Extend instance storage when its remaining TTL drops below this
/// (~7 days at 5s per ledger).
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960;
/// Ledgers to extend persistent governance entries by on each touch
/// (~30 days at 5s per ledger).
pub const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;
/// Extend persistent governance entries when their remaining TTL drops below
/// this (~7 days at 5s per ledger).
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;

/// Bump the instance TTL. Called from every governance entry point.
pub(crate) fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Bump the TTL of a persistent governance entry.
pub(crate) fn extend_gov_ttl(env: &Env, key: &GovKey) {
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
    Paused,
    PendingAdmin,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PendingUpgrade {
    pub new_wasm_hash: BytesN<32>,
    pub eta: u64,
}

/// A proposed admin rotation awaiting acceptance by the new admin.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PendingAdmin {
    pub new_admin: Address,
    pub eta: u64,
}

pub(crate) fn require_gov_admin(env: &Env, admin: &Address, msg: &str) {
    extend_instance_ttl(env);
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

pub(crate) fn paused(env: &Env) -> bool {
    extend_instance_ttl(env);
    extend_gov_ttl(env, &GovKey::Paused);
    env.storage().persistent().get(&GovKey::Paused).unwrap_or(false)
}

pub(crate) fn require_not_paused(env: &Env) {
    if paused(env) {
        panic!("Contract is paused");
    }
}

#[contractimpl]
impl SavingsVaultContract {
    /// Schedule a WASM upgrade. Executable after `UPGRADE_TIMELOCK_SECS`.
    /// Returns the earliest execution timestamp (eta).
    pub fn propose_upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> u64 {
        require_gov_admin(&env, &admin, "Only admin can upgrade the contract");
        let eta = env.ledger().timestamp() + UPGRADE_TIMELOCK_SECS;
        let pending = PendingUpgrade { new_wasm_hash: new_wasm_hash.clone(), eta };
        env.storage().persistent().set(&GovKey::PendingUpgrade, &pending);
        extend_gov_ttl(&env, &GovKey::PendingUpgrade);
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
        extend_gov_ttl(&env, &GovKey::PendingUpgrade);
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
        extend_gov_ttl(&env, &GovKey::PendingUpgrade);
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
        // The new WASM only takes effect after this invocation ends, so the
        // old binary's `CONTRACT_VERSION` must not be reported here. The
        // version is reported by `migrate`, which runs in the new code.
        env.events()
            .publish((Symbol::new(&env, "Upgraded"),), pending.new_wasm_hash);
    }

    pub fn get_pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        extend_instance_ttl(&env);
        extend_gov_ttl(&env, &GovKey::PendingUpgrade);
        env.storage().persistent().get(&GovKey::PendingUpgrade)
    }

    /// Run storage migrations for the current WASM. Idempotent.
    ///
    /// Must be called after `execute_upgrade` (in the same deployment run) so
    /// that the new code's migrations run and the stored version is bumped.
    /// Each intermediate step runs exactly once, so a v1 → v3 jump runs both
    /// `migrate_v1_to_v2` and `migrate_v2_to_v3`.
    pub fn migrate(env: Env, admin: Address) {
        require_gov_admin(&env, &admin, "Only admin can perform this action");
        extend_gov_ttl(&env, &GovKey::ContractVersion);
        let mut current: u32 = env
            .storage()
            .persistent()
            .get(&GovKey::ContractVersion)
            .unwrap_or(0);
        while current < CONTRACT_VERSION {
            match current {
                1 => migrate_v1_to_v2(&env),
                2 => migrate_v2_to_v3(&env),
                _ => {}
            }
            let from_version = current;
            current += 1;
            env.storage()
                .persistent()
                .set(&GovKey::ContractVersion, &current);
            extend_gov_ttl(&env, &GovKey::ContractVersion);
            env.events().publish(
                (Symbol::new(&env, "Migrated"),),
                (from_version, current),
            );
        }
    }

    pub fn get_contract_version(env: Env) -> u32 {
        extend_instance_ttl(&env);
        extend_gov_ttl(&env, &GovKey::ContractVersion);
impl AdminStore for SavingsVaultContract {
    fn admin(env: &Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized")
    }

    /// Propose a new admin (SC-184). The successor must call `accept_admin`
    /// after `ADMIN_ROTATION_DELAY_SECS`. Returns the earliest acceptance
    /// timestamp (eta).
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) -> u64 {
        require_gov_admin(&env, &admin, "Only admin can perform this action");
        env.storage().persistent().set(&GovKey::Paused, &true);
        extend_gov_ttl(&env, &GovKey::Paused);
        env.events().publish((Symbol::new(&env, "Paused"),), admin);
        let eta = env.ledger().timestamp() + ADMIN_ROTATION_DELAY_SECS;
        let pending = PendingAdmin { new_admin: new_admin.clone(), eta };
        env.storage().persistent().set(&GovKey::PendingAdmin, &pending);
        env.events()
            .publish((Symbol::new(&env, "AdminProposed"),), (admin, new_admin, eta));
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
        env.storage().persistent().set(&DataKey::Admin, &new_admin);
        env.storage().persistent().remove(&GovKey::PendingAdmin);
        env.events().publish(
            (Symbol::new(&env, "AdminChanged"),),
            (old_admin, new_admin),
        );
    }

    /// Cancel a pending admin rotation. Only the current admin may cancel.
    pub fn cancel_admin_proposal(env: Env, admin: Address) {
        require_gov_admin(&env, &admin, "Only admin can perform this action");
        env.storage().persistent().set(&GovKey::Paused, &false);
        extend_gov_ttl(&env, &GovKey::Paused);
        env.events().publish((Symbol::new(&env, "Unpaused"),), admin);
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
}

/// Migration from contract version 1 to version 2.
///
/// No storage changes are required today; the hook exists so future upgrades
/// can add data migrations without changing the `migrate` control flow.
fn migrate_v1_to_v2(_env: &Env) {}

/// Migration from contract version 2 to version 3.
///
/// No storage changes are required today.
fn migrate_v2_to_v3(_env: &Env) {}
afripay_governance::governance_impl!(SavingsVaultContract, CONTRACT_VERSION);
