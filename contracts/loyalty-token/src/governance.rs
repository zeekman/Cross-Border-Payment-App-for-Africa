//! Upgrade governance (SC-172 / SC-173 / SC-174).
//!
//! WASM upgrades are timelocked on-chain: the admin proposes a new WASM hash,
//! which can only be executed after `UPGRADE_TIMELOCK_SECS`, giving users an
//! exit window. Proposals can be cancelled.
//!
//! `execute_upgrade` runs in the *old* WASM and only schedules the swap; the
//! new code takes effect after the invocation ends. `migrate` must therefore be
//! called afterwards (in the new code) to run per-version storage migrations
//! and record the new version.
use crate::{DataKey, LoyaltyTokenContract};
use soroban_sdk::{contractimpl, contracttype, Address, BytesN, Env, Symbol};

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 1;

/// Minimum delay between proposing and executing an upgrade (48 hours).
pub const UPGRADE_TIMELOCK_SECS: u64 = 48 * 60 * 60;

/// Number of ledgers to extend instance storage TTL by (~30 days at 5s/ledger).
pub const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
/// Extend instance storage when its remaining TTL drops below ~7 days.
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960;
/// Number of ledgers to extend persistent storage TTL by (~30 days).
pub const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;
/// Extend persistent storage when its remaining TTL drops below ~7 days.
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;

/// Bump the instance TTL. Called from every governance entry point.
pub(crate) fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Bump the TTL of a persistent governance key.
fn bump_persistent(env: &Env, key: &GovKey) {
    env.storage().persistent().extend_ttl(
        key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

/// Encodes identically to a `DataKey` variant of the same name, so existing
/// `ContractVersion` entries remain readable.
#[contracttype]
pub enum GovKey {
    ContractVersion,
    PendingUpgrade,
    Paused,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PendingUpgrade {
    pub new_wasm_hash: BytesN<32>,
    pub eta: u64,
}

pub(crate) fn require_gov_admin(env: &Env, admin: &Address, msg: &str) {
    bump_instance(env);
    admin.require_auth();
    let stored: Address = env
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("Contract not initialized");
    env.storage().persistent().extend_ttl(
        &DataKey::Admin,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
    if admin != &stored {
        panic!("{}", msg);
    }
}

pub(crate) fn paused(env: &Env) -> bool {
    bump_instance(env);
    env.storage().persistent().get(&GovKey::Paused).unwrap_or(false)
}

pub(crate) fn require_not_paused(env: &Env) {
    if paused(env) {
        panic!("Contract is paused");
    }
}

#[contractimpl]
impl LoyaltyTokenContract {
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
        let pending: PendingUpgrade = env
            .storage()
            .persistent()
            .get(&GovKey::PendingUpgrade)
            .expect("No pending upgrade");
        env.storage().persistent().remove(&GovKey::PendingUpgrade);
        bump_persistent(&env, &GovKey::PendingUpgrade);
        env.events()
            .publish((Symbol::new(&env, "UpgradeCancelled"),), pending.new_wasm_hash);
    }

    /// Apply the pending upgrade once its timelock has expired.
    ///
    /// This runs in the **old** WASM: the new code only takes effect after the
    /// invocation ends, so the emitted event carries no version. Call
    /// `migrate` afterwards (in the new code) to record the new version.
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
        bump_persistent(&env, &GovKey::PendingUpgrade);
        env.deployer()
            .update_current_contract_wasm(pending.new_wasm_hash.clone());
        env.events()
            .publish((Symbol::new(&env, "Upgraded"),), pending.new_wasm_hash);
    }

    pub fn get_pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        bump_instance(&env);
        let pending = env.storage().persistent().get(&GovKey::PendingUpgrade);
        bump_persistent(&env, &GovKey::PendingUpgrade);
        pending
    }

    /// Run storage migrations for the current WASM. Idempotent.
    ///
    /// Runs every intermediate step exactly once, from the stored version up to
    /// `CONTRACT_VERSION`, persisting the version after each step and emitting
    /// `Migrated { from_version, to_version }` per step.
    pub fn migrate(env: Env, admin: Address) {
        require_gov_admin(&env, &admin, "Only admin can perform this action");
        let mut current: u32 = env
            .storage()
            .persistent()
            .get(&GovKey::ContractVersion)
            .unwrap_or(0);
        while current < CONTRACT_VERSION {
            let from_version = current;
            match current {
                1 => migrate_v1_to_v2(&env),
                // Add future steps here, e.g. `2 => migrate_v2_to_v3(&env),`.
                _ => {}
            }
            current += 1;
            env.storage()
                .persistent()
                .set(&GovKey::ContractVersion, &current);
            bump_persistent(&env, &GovKey::ContractVersion);
            env.events().publish(
                (Symbol::new(&env, "Migrated"),),
                (from_version, current),
            );
        }
    }

    pub fn get_contract_version(env: Env) -> u32 {
        bump_instance(&env);
        let version = env
            .storage()
            .persistent()
            .get(&GovKey::ContractVersion)
            .unwrap_or(0);
        bump_persistent(&env, &GovKey::ContractVersion);
        version
    }

    /// Emergency pause (SC-174). Blocks entry points that move funds into the
    /// contract; exit paths (refund / withdraw / release / cancel) stay open.
    pub fn pause(env: Env, admin: Address) {
        require_gov_admin(&env, &admin, "Only admin can perform this action");
        env.storage().persistent().set(&GovKey::Paused, &true);
        bump_persistent(&env, &GovKey::Paused);
        env.events().publish((Symbol::new(&env, "Paused"),), admin);
    }

    pub fn unpause(env: Env, admin: Address) {
        require_gov_admin(&env, &admin, "Only admin can perform this action");
        env.storage().persistent().set(&GovKey::Paused, &false);
        bump_persistent(&env, &GovKey::Paused);
        env.events().publish((Symbol::new(&env, "Unpaused"),), admin);
    }

    pub fn is_paused(env: Env) -> bool {
        paused(&env)
    }
}

/// Migration step from contract version 1 to version 2.
///
/// No storage changes are required today; the hook exists so future upgrades
/// can add data migrations without changing the `migrate` loop.
fn migrate_v1_to_v2(_env: &Env) {}
