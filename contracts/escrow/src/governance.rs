//! Upgrade governance (SC-172 / SC-173 / SC-174).
//!
//! WASM upgrades are timelocked on-chain: the admin proposes a new WASM hash,
//! which can only be executed after `UPGRADE_TIMELOCK_SECS`, giving users an
//! exit window. Proposals can be cancelled. `migrate` bumps the stored
//! contract version after an upgrade.
use crate::{DataKey, EscrowContract};
use soroban_sdk::{contractimpl, contracttype, Address, BytesN, Env, Symbol};

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 4;

/// Minimum delay between proposing and executing an upgrade (48 hours).
pub const UPGRADE_TIMELOCK_SECS: u64 = 48 * 60 * 60;

/// Ledgers to extend instance storage TTL by on each call (~30 days at 5s).
pub const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
/// Extend instance storage when its remaining TTL drops below ~7 days.
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960;
/// Ledgers to extend persistent storage TTL by on each touched record (~30 days).
pub const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;
/// Extend persistent storage when its remaining TTL drops below ~7 days.
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;

/// Bump the instance TTL; call at the top of every public entry point.
pub(crate) fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Bump the TTL of a governance persistent key.
fn bump_gov(env: &Env, key: &GovKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
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
    admin.require_auth();
    bump_instance(env);
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
    bump_gov(env, &GovKey::Paused);
    env.storage().persistent().get(&GovKey::Paused).unwrap_or(false)
}

pub(crate) fn require_not_paused(env: &Env) {
    if paused(env) {
        panic!("Contract is paused");
    }
}

#[contractimpl]
impl EscrowContract {
    /// Schedule a WASM upgrade. Executable after `UPGRADE_TIMELOCK_SECS`.
    /// Returns the earliest execution timestamp (eta).
    pub fn propose_upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> u64 {
        bump_instance(&env);
        require_gov_admin(&env, &admin, "Only admin can upgrade the contract");
        let eta = env.ledger().timestamp() + UPGRADE_TIMELOCK_SECS;
        let pending = PendingUpgrade { new_wasm_hash: new_wasm_hash.clone(), eta };
        env.storage().persistent().set(&GovKey::PendingUpgrade, &pending);
        bump_gov(&env, &GovKey::PendingUpgrade);
        env.events()
            .publish((Symbol::new(&env, "UpgradeProposed"),), (new_wasm_hash, eta));
        eta
    }

    /// Alias of `propose_upgrade` — upgrades are never applied instantly.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> u64 {
        Self::propose_upgrade(env, admin, new_wasm_hash)
    }

    pub fn cancel_upgrade(env: Env, admin: Address) {
        bump_instance(&env);
        require_gov_admin(&env, &admin, "Only admin can upgrade the contract");
        bump_gov(&env, &GovKey::PendingUpgrade);
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
        bump_instance(&env);
        require_gov_admin(&env, &admin, "Only admin can upgrade the contract");
        bump_gov(&env, &GovKey::PendingUpgrade);
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
        // version reported here would be the *old* binary's constant. Emit the
        // hash alone; `migrate` (running in the new code) reports versions.
        env.events()
            .publish((Symbol::new(&env, "Upgraded"),), pending.new_wasm_hash);
    }

    pub fn get_pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        bump_instance(&env);
        bump_gov(&env, &GovKey::PendingUpgrade);
        env.storage().persistent().get(&GovKey::PendingUpgrade)
    }

    /// Run storage migrations for the current WASM. Idempotent.
    ///
    /// Must be called after `execute_upgrade` (in the new WASM). Each
    /// intermediate step runs exactly once, so a v1 → v3 jump runs both the
    /// v1→v2 and v2→v3 steps.
    pub fn migrate(env: Env, admin: Address) {
        bump_instance(&env);
        require_gov_admin(&env, &admin, "Only admin can perform this action");
        bump_gov(&env, &GovKey::ContractVersion);
        let from_version: u32 = env
            .storage()
            .persistent()
            .get(&GovKey::ContractVersion)
            .unwrap_or(0);
        if from_version >= CONTRACT_VERSION {
            return;
        }
        let mut current = from_version;
        while current < CONTRACT_VERSION {
            match current {
                1 => migrate_v1_to_v2(&env),
                2 => migrate_v2_to_v3(&env),
                3 => migrate_v3_to_v4(&env),
                _ => {}
            }
            current += 1;
            env.storage()
                .persistent()
                .set(&GovKey::ContractVersion, &current);
            bump_gov(&env, &GovKey::ContractVersion);
        }
        env.events().publish(
            (Symbol::new(&env, "Migrated"),),
            (from_version, CONTRACT_VERSION),
        );
    }

    pub fn get_contract_version(env: Env) -> u32 {
        bump_instance(&env);
        bump_gov(&env, &GovKey::ContractVersion);
        env.storage()
            .persistent()
            .get(&GovKey::ContractVersion)
            .unwrap_or(0)
    }

    /// Emergency pause (SC-174). Blocks entry points that move funds into the
    /// contract; exit paths (refund / withdraw / release / cancel) stay open.
    pub fn pause(env: Env, admin: Address) {
        bump_instance(&env);
        require_gov_admin(&env, &admin, "Only admin can perform this action");
        env.storage().persistent().set(&GovKey::Paused, &true);
        bump_gov(&env, &GovKey::Paused);
        env.events().publish((Symbol::new(&env, "Paused"),), admin);
    }

    pub fn unpause(env: Env, admin: Address) {
        bump_instance(&env);
        require_gov_admin(&env, &admin, "Only admin can perform this action");
        env.storage().persistent().set(&GovKey::Paused, &false);
        bump_gov(&env, &GovKey::Paused);
        env.events().publish((Symbol::new(&env, "Unpaused"),), admin);
    }

    pub fn is_paused(env: Env) -> bool {
        bump_instance(&env);
        paused(&env)
    }
}

/// v1 → v2: no storage changes required.
fn migrate_v1_to_v2(_env: &Env) {}

/// v2 → v3: no storage changes required.
fn migrate_v2_to_v3(_env: &Env) {}

/// v3 → v4: no storage changes required.
fn migrate_v3_to_v4(_env: &Env) {}
