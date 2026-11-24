//! Upgrade governance (SC-172 / SC-173 / SC-184).
//!
//! The implementation lives in the shared `afripay-governance` crate; this
//! module only wires it to this contract's storage layout.
use crate::{DataKey, MultisigContract};
use afripay_governance::{governance_impl, AdminStore};
use soroban_sdk::Env;

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 1;

/// Minimum delay between proposing and executing an upgrade (48 hours).
pub const UPGRADE_TIMELOCK_SECS: u64 = 48 * 60 * 60;

/// Ledgers added to the instance TTL on every governance entry point (~30 days).
pub const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
/// Bump the instance TTL when it drops below this (~7 days).
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960;
/// Ledgers added to the TTL of governance persistent keys (~30 days).
pub const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;
/// Bump a governance persistent key when its TTL drops below this (~7 days).
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;

/// Extend the instance TTL; called at the top of every governance entry point.
pub(crate) fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Extend the TTL of a governance persistent key that is about to be read or written.
pub(crate) fn bump_persistent(env: &Env, key: &GovKey) {
    env.storage().persistent().extend_ttl(
        key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}
/// Minimum delay between proposing a new admin and accepting it (24 hours).
///
/// The delay gives users and integrators an exit window if the current admin
/// key is compromised and starts a rotation. The admin should be a multisig
/// account or the `multisig-approval` contract itself.
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

/// A proposed admin rotation, executable once `eta` has passed.
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
        .instance()
        .get(&DataKey::Admin)
        .expect("Contract not initialized");
    if admin != &stored {
        panic!("{}", msg);
    }
}

#[contractimpl]
impl MultisigContract {
    /// Schedule a WASM upgrade. Executable after `UPGRADE_TIMELOCK_SECS`.
    /// Returns the earliest execution timestamp (eta).
    pub fn propose_upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> u64 {
        bump_instance(&env);
        require_gov_admin(&env, &admin, "Only admin can upgrade the contract");
        let eta = env.ledger().timestamp() + UPGRADE_TIMELOCK_SECS;
        let pending = PendingUpgrade { new_wasm_hash: new_wasm_hash.clone(), eta };
        bump_persistent(&env, &GovKey::PendingUpgrade);
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
        bump_instance(&env);
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
    /// Upgrades are **irreversible on-chain**; test on testnet first.
    pub fn execute_upgrade(env: Env, admin: Address) {
        bump_instance(&env);
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
        // The new WASM only takes effect after this invocation ends, so the
        // version reported here would be the *old* binary's constant. Emit the
        // hash alone; `migrate` (running in the new code) reports versions.
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
    /// Runs every intermediate step from the stored version up to
    /// `CONTRACT_VERSION`, persisting the version after each step so a partial
    /// run resumes where it stopped. Must be called after `execute_upgrade`.
    pub fn migrate(env: Env, admin: Address) {
        bump_instance(&env);
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
                // Future steps: 2 => migrate_v2_to_v3(&env),
                _ => {}
            }
            let from_version = current;
            current += 1;
            env.storage()
                .persistent()
                .set(&GovKey::ContractVersion, &current);
            env.events().publish(
                (Symbol::new(&env, "Migrated"),),
                (from_version, current),
            );
        }
    }

    pub fn get_contract_version(env: Env) -> u32 {
        bump_instance(&env);
        bump_persistent(&env, &GovKey::ContractVersion);
        env.storage()
/// This contract keeps its admin in **instance** storage.
impl AdminStore for MultisigContract {
    fn admin(env: &Env) -> soroban_sdk::Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized")
    }

    /// Step 1 of two-step admin rotation: the current admin proposes a
    /// successor. The rotation only completes after `ADMIN_ROTATION_DELAY_SECS`
    /// and the new admin's own signature. Returns the earliest acceptance
    /// timestamp (eta).
    ///
    /// The admin should be a multisig account or the `multisig-approval`
    /// contract so a single lost or compromised key cannot rotate governance.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) -> u64 {
        require_gov_admin(&env, &admin, "Only admin can propose a new admin");
        let eta = env.ledger().timestamp() + ADMIN_ROTATION_DELAY_SECS;
        let pending = PendingAdmin { new_admin: new_admin.clone(), eta };
        env.storage().persistent().set(&GovKey::PendingAdmin, &pending);
        env.events()
            .publish((Symbol::new(&env, "AdminProposed"),), (new_admin, eta));
        eta
    }

    /// Step 2 of two-step admin rotation: the proposed admin accepts, after
    /// the delay has elapsed. Requires the new admin's signature.
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
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        env.storage().persistent().remove(&GovKey::PendingAdmin);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (Symbol::new(&env, "AdminChanged"),),
            (old_admin, new_admin),
        );
    }

    /// Cancel a pending admin rotation. Only the current admin may cancel.
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
}

/// v1 -> v2 migration step. No storage changes yet; kept as a hook so the
/// versioned loop is exercised and future migrations have a home.
fn migrate_v1_to_v2(_env: &Env) {}
governance_impl!(MultisigContract, 1);
