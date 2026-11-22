//! Upgrade governance (SC-172 / SC-173).
//!
//! WASM upgrades are timelocked on-chain: the admin proposes a new WASM hash,
//! which can only be executed after `UPGRADE_TIMELOCK_SECS`, giving users an
//! exit window. Proposals can be cancelled. `migrate` bumps the stored
//! contract version after an upgrade.
//!
//! `execute_upgrade` runs in the *old* WASM and only emits the new hash; the
//! version reported on-chain comes from `migrate`, which runs in the *new*
//! WASM and emits `Migrated { from_version, to_version }`.
use crate::{DataKey, KycAttestationContract};
use soroban_sdk::{contractimpl, contracttype, Address, BytesN, Env, Symbol};

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

/// Encodes identically to a `DataKey` variant of the same name, so existing
/// `ContractVersion` entries remain readable.
#[contracttype]
pub enum GovKey {
    ContractVersion,
    PendingUpgrade,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PendingUpgrade {
    pub new_wasm_hash: BytesN<32>,
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

/// Bump the instance TTL so global config never archives.
fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Bump the TTL of a governance persistent key that was just read or written.
fn bump_gov_key(env: &Env, key: &GovKey) {
    env.storage().persistent().extend_ttl(
        key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

/// v1 -> v2 data migration. No storage changes yet.
fn migrate_v1_to_v2(_env: &Env) {}

/// v2 -> v3 data migration. No storage changes yet.
fn migrate_v2_to_v3(_env: &Env) {}

#[contractimpl]
impl KycAttestationContract {
    /// Schedule a WASM upgrade. Executable after `UPGRADE_TIMELOCK_SECS`.
    /// Returns the earliest execution timestamp (eta).
    pub fn propose_upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> u64 {
        bump_instance(&env);
        require_gov_admin(&env, &admin, "Only admin can upgrade the contract");
        let eta = env.ledger().timestamp() + UPGRADE_TIMELOCK_SECS;
        let pending = PendingUpgrade { new_wasm_hash: new_wasm_hash.clone(), eta };
        env.storage().persistent().set(&GovKey::PendingUpgrade, &pending);
        bump_gov_key(&env, &GovKey::PendingUpgrade);
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
        // version is reported by `migrate` in the new code, not here.
        env.events()
            .publish((Symbol::new(&env, "Upgraded"),), pending.new_wasm_hash);
    }

    pub fn get_pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        bump_instance(&env);
        let pending = env.storage().persistent().get(&GovKey::PendingUpgrade);
        if pending.is_some() {
            bump_gov_key(&env, &GovKey::PendingUpgrade);
        }
        pending
    }

    /// Run storage migrations for the current WASM. Idempotent: each
    /// intermediate step runs exactly once and the version is persisted after
    /// every step, so a v1 -> v3 jump runs both v1->v2 and v2->v3.
    pub fn migrate(env: Env, admin: Address) {
        bump_instance(&env);
        require_gov_admin(&env, &admin, "Only admin can perform this action");
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
            bump_gov_key(&env, &GovKey::ContractVersion);
            env.events().publish(
                (Symbol::new(&env, "Migrated"),),
                (from_version, current),
            );
        }
    }

    pub fn get_contract_version(env: Env) -> u32 {
        bump_instance(&env);
        env.storage()
            .persistent()
            .get(&GovKey::ContractVersion)
            .unwrap_or(0)
    }
}
