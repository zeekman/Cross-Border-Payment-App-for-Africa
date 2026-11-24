//! Upgrade governance (SC-172 / SC-173 / SC-174 / SC-184).
//!
//! WASM upgrades are timelocked on-chain: the admin proposes a new WASM hash,
//! which can only be executed after `UPGRADE_TIMELOCK_SECS`, giving users an
//! exit window. Proposals can be cancelled.
//!
//! `execute_upgrade` only swaps the WASM; it runs in the *old* binary, so it
//! cannot know the new version. `migrate` runs in the *new* binary and walks
//! the version chain one step at a time, emitting `Migrated { from_version,
//! to_version }` for each step. `execute_upgrade` must be followed by
//! `migrate` in the same deployment run.
//! exit window. Proposals can be cancelled. `migrate` bumps the stored
//! contract version after an upgrade.
//!
//! Admin rotation is two-step: the current admin proposes a successor, which
//! is stored as `PendingAdmin` with an ETA (`ADMIN_ROTATION_DELAY_SECS`). The
//! successor must then call `accept_admin` with their own signature after the
//! delay. This prevents a lost or compromised admin key from being permanent.
//!
//! **Recommendation:** the admin should be a multisig account (or the
//! `multisig-approval` contract) so that no single key can rotate the admin.
//! The implementation lives in the shared `afripay-governance` crate; this
//! module only wires it to this contract's storage layout.
use crate::{DataKey, DisputeResolutionContract};
use afripay_governance::{governance_impl, AdminStore};
use soroban_sdk::Env;

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 1;

/// Minimum delay between proposing and executing an upgrade (48 hours).
pub const UPGRADE_TIMELOCK_SECS: u64 = 48 * 60 * 60;

/// TTL bump applied to instance storage on every governance call (~30 days).
pub const INSTANCE_BUMP_AMOUNT: u32 = 30 * 24 * 60 * 60 / 5;
/// TTL below which instance storage is bumped (~7 days).
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 7 * 24 * 60 * 60 / 5;
/// TTL bump applied to persistent governance keys on every access (~30 days).
pub const PERSISTENT_BUMP_AMOUNT: u32 = 30 * 24 * 60 * 60 / 5;
/// TTL below which persistent governance keys are bumped (~7 days).
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = 7 * 24 * 60 * 60 / 5;

/// Extend the instance TTL. Called from every governance entry point.
pub(crate) fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Extend the TTL of a persistent governance key.
pub(crate) fn bump_persistent(env: &Env, key: &GovKey) {
    env.storage().persistent().extend_ttl(
        key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}
/// Minimum delay between proposing a new admin and accepting it (24 hours).
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

pub(crate) fn paused(env: &Env) -> bool {
    bump_instance(env);
    bump_persistent(env, &GovKey::Paused);
    env.storage().persistent().get(&GovKey::Paused).unwrap_or(false)
}

pub(crate) fn require_not_paused(env: &Env) {
    if paused(env) {
        panic!("Contract is paused");
    }
}

#[contractimpl]
impl DisputeResolutionContract {
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
    /// This runs in the *old* WASM, so it cannot know the new version: the
    /// `Upgraded` event carries only the new WASM hash. Call `migrate` right
    /// after this in the same deployment run to run the versioned migrations
    /// and emit `Migrated { from_version, to_version }`.
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

    /// Run storage migrations for the current WASM. Idempotent.
    ///
    /// Walks the version chain one step at a time, persisting the version and
    /// emitting `Migrated { from_version, to_version }` after each step, so a
    /// v1 → v3 jump runs both the v1→v2 and v2→v3 steps exactly once.
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
                // Future steps: 2 => migrate_v2_to_v3(&env), ...
                _ => {}
            }
            let next = current + 1;
            env.storage()
                .persistent()
                .set(&GovKey::ContractVersion, &next);
            bump_persistent(&env, &GovKey::ContractVersion);
            env.events().publish(
                (Symbol::new(&env, "Migrated"),),
                (current, next),
            );
            current = next;
        }
    }

    pub fn get_contract_version(env: Env) -> u32 {
        bump_instance(&env);
        bump_persistent(&env, &GovKey::ContractVersion);
impl AdminStore for DisputeResolutionContract {
    fn admin(env: &Env) -> soroban_sdk::Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized")
    }

    /// Propose a new admin. The successor must call `accept_admin` after
    /// `ADMIN_ROTATION_DELAY_SECS` to complete the rotation.
    /// Returns the earliest acceptance timestamp (eta).
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) -> u64 {
        require_gov_admin(&env, &admin, "Only admin can perform this action");
        env.storage().persistent().set(&GovKey::Paused, &true);
        bump_persistent(&env, &GovKey::Paused);
        env.events().publish((Symbol::new(&env, "Paused"),), admin);
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
        bump_persistent(&env, &GovKey::Paused);
        env.events().publish((Symbol::new(&env, "Unpaused"),), admin);
        env.storage()
            .persistent()
            .get::<GovKey, PendingAdmin>(&GovKey::PendingAdmin)
            .expect("No pending admin");
        env.storage().persistent().remove(&GovKey::PendingAdmin);
        env.events()
            .publish((Symbol::new(&env, "AdminProposalCancelled"),), admin);
    }

    pub fn get_pending_admin(env: Env) -> Option<PendingAdmin> {
        env.storage().persistent().get(&GovKey::PendingAdmin)
    }
}

/// v1 → v2 migration step. No-op today; add data rewrites here when v2 lands.
fn migrate_v1_to_v2(_env: &Env) {}
governance_impl!(DisputeResolutionContract, CONTRACT_VERSION);
