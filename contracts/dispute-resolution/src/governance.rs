//! Upgrade governance (SC-172 / SC-173 / SC-174).
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
use crate::{DataKey, DisputeResolutionContract};
use soroban_sdk::{contractimpl, contracttype, Address, BytesN, Env, Symbol};

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
        env.storage()
            .persistent()
            .get(&GovKey::ContractVersion)
            .unwrap_or(0)
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

/// v1 → v2 migration step. No-op today; add data rewrites here when v2 lands.
fn migrate_v1_to_v2(_env: &Env) {}
