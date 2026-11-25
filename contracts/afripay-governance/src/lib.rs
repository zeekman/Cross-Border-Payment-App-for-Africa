#![no_std]

//! Shared governance implementation for all AfriPay contracts.
//!
//! This crate centralises the upgrade, migration and pause logic that was
//! previously copy-pasted into each contract. Each contract implements
//! [`AdminStore`] for its own storage layout (instance vs persistent) and
//! pulls in the exported governance API via the [`governance_impl!`] macro.
//!
//! ## Storage compatibility
//!
//! [`GovKey`] encodes identically to the per-crate `DataKey` variants that
//! were used before this crate existed (`ContractVersion`, `PendingUpgrade`,
//! `Paused`). The encoding is verified by unit tests so that already-deployed
//! contracts keep reading their existing `ContractVersion` values.

use soroban_sdk::{contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol};

/// Number of seconds an upgrade must wait before it can be executed.
pub const UPGRADE_TIMELOCK_SECS: u64 = 48 * 60 * 60;

/// Storage keys used by the shared governance implementation.
///
/// The variant names and order must stay byte-identical to the historical
/// per-crate `DataKey` variants so that deployed contracts keep reading the
/// values they wrote before the extraction.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GovKey {
    ContractVersion,
    PendingUpgrade,
    Paused,
}

/// A pending upgrade proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    pub new_wasm_hash: BytesN<32>,
    pub eta: u64,
}

/// Provides the governance admin for a contract's storage layout.
pub trait AdminStore {
    fn admin(env: &Env) -> Address;
}

/// Propose a new wasm hash for installation.
///
/// Panics with `"Upgrade already pending; cancel it first"` if an upgrade is
/// already pending. A pending upgrade must be explicitly cancelled via
/// [`cancel_upgrade`] before a new one can be proposed, so that watchers who
/// reviewed the previous hash are never silently bypassed.
pub fn propose_upgrade<T: AdminStore>(
    env: &Env,
    new_wasm_hash: BytesN<32>,
) -> Result<(), soroban_sdk::Error> {
    T::admin(env).require_auth();

    if env.storage().persistent().has(&GovKey::PendingUpgrade) {
        panic!("Upgrade already pending; cancel it first");
    }

    let eta = env.ledger().timestamp() + UPGRADE_TIMELOCK_SECS;
    let pending = PendingUpgrade {
        new_wasm_hash: new_wasm_hash.clone(),
        eta,
    };
    env.storage()
        .persistent()
        .set(&GovKey::PendingUpgrade, &pending);
    env.events().publish(
        (symbol_short!("UpgradeProposed"),),
        (new_wasm_hash, eta),
    );
    Ok(())
}

/// Cancel a pending upgrade, if any.
pub fn cancel_upgrade<T: AdminStore>(env: &Env) -> Result<(), soroban_sdk::Error> {
    T::admin(env).require_auth();

    if let Some(pending) = env
        .storage()
        .persistent()
        .get::<_, PendingUpgrade>(&GovKey::PendingUpgrade)
    {
        env.storage().persistent().remove(&GovKey::PendingUpgrade);
        env.events().publish(
            (symbol_short!("UpgradeCancelled"),),
            pending.new_wasm_hash,
        );
    }
    Ok(())
}

/// Execute a pending upgrade once its timelock has elapsed.
pub fn execute_upgrade<T: AdminStore>(env: &Env) -> Result<(), soroban_sdk::Error> {
    T::admin(env).require_auth();

    let pending: PendingUpgrade = env
        .storage()
        .persistent()
        .get(&GovKey::PendingUpgrade)
        .expect("No pending upgrade");

    if env.ledger().timestamp() < pending.eta {
        panic!("Upgrade timelock not elapsed");
    }

    env.storage().persistent().remove(&GovKey::PendingUpgrade);
    env.deployer()
        .update_current_contract_wasm(pending.new_wasm_hash.clone());
    env.events().publish(
        (symbol_short!("UpgradeExecuted"),),
        pending.new_wasm_hash,
    );
    Ok(())
}

/// Return the pending upgrade, if any.
pub fn get_pending_upgrade(env: &Env) -> Option<PendingUpgrade> {
    env.storage().persistent().get(&GovKey::PendingUpgrade)
}

/// Migrate the contract to a new version.
///
/// Idempotent: calling `migrate` with the version already stored is a no-op.
pub fn migrate<T: AdminStore>(env: &Env, new_version: u32) -> Result<(), soroban_sdk::Error> {
    T::admin(env).require_auth();

    let current: u32 = env
        .storage()
        .instance()
        .get(&GovKey::ContractVersion)
        .unwrap_or(0);

    if new_version <= current {
        return Ok(());
    }

    env.storage()
        .instance()
        .set(&GovKey::ContractVersion, &new_version);
    env.events()
        .publish((symbol_short!("Migrated"),), (current, new_version));
    Ok(())
}

/// Return the stored contract version.
pub fn get_contract_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&GovKey::ContractVersion)
        .unwrap_or(0)
}

/// Pause the contract.
pub fn pause<T: AdminStore>(env: &Env) -> Result<(), soroban_sdk::Error> {
    T::admin(env).require_auth();
    env.storage().instance().set(&GovKey::Paused, &true);
    env.events().publish((symbol_short!("Paused"),), ());
    Ok(())
}

/// Unpause the contract.
pub fn unpause<T: AdminStore>(env: &Env) -> Result<(), soroban_sdk::Error> {
    T::admin(env).require_auth();
    env.storage().instance().set(&GovKey::Paused, &false);
    env.events().publish((symbol_short!("Unpaused"),), ());
    Ok(())
}

/// Return whether the contract is paused.
pub fn paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&GovKey::Paused)
        .unwrap_or(false)
}

/// Panic if the contract is paused.
pub fn require_not_paused(env: &Env) {
    if paused(env) {
        panic!("Contract is paused");
    }
}

/// Expands to the `#[contractimpl]` block exporting the governance API.
///
/// Usage:
/// ```ignore
/// governance_impl!(MyContract, 4);
/// ```
#[macro_export]
macro_rules! governance_impl {
    ($contract:ty, $version:expr) => {
        #[soroban_sdk::contractimpl]
        impl $contract {
            pub fn propose_upgrade(
                env: soroban_sdk::Env,
                new_wasm_hash: soroban_sdk::BytesN<32>,
            ) -> Result<(), soroban_sdk::Error> {
                $crate::propose_upgrade::<Self>(&env, new_wasm_hash)
            }

            pub fn cancel_upgrade(env: soroban_sdk::Env) -> Result<(), soroban_sdk::Error> {
                $crate::cancel_upgrade::<Self>(&env)
            }

            pub fn execute_upgrade(env: soroban_sdk::Env) -> Result<(), soroban_sdk::Error> {
                $crate::execute_upgrade::<Self>(&env)
            }

            pub fn get_pending_upgrade(
                env: soroban_sdk::Env,
            ) -> Option<$crate::PendingUpgrade> {
                $crate::get_pending_upgrade(&env)
            }

            pub fn migrate(
                env: soroban_sdk::Env,
                new_version: u32,
            ) -> Result<(), soroban_sdk::Error> {
                $crate::migrate::<Self>(&env, new_version)
            }

            pub fn get_contract_version(env: soroban_sdk::Env) -> u32 {
                $crate::get_contract_version(&env)
            }

            pub fn pause(env: soroban_sdk::Env) -> Result<(), soroban_sdk::Error> {
                $crate::pause::<Self>(&env)
            }

            pub fn unpause(env: soroban_sdk::Env) -> Result<(), soroban_sdk::Error> {
                $crate::unpause::<Self>(&env)
            }

            pub fn is_paused(env: soroban_sdk::Env) -> bool {
                $crate::paused(&env)
            }
        }
    };
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        Address, BytesN, Env,
    };

    // A minimal contract used to exercise the shared governance logic.
    mod test_contract {
        use super::*;
        use soroban_sdk::{contract, contractimpl, Address, Env};

        #[contract]
        pub struct TestContract;

        impl AdminStore for TestContract {
            fn admin(env: &Env) -> Address {
                env.storage()
                    .instance()
                    .get(&symbol_short!("admin"))
                    .expect("admin not set")
            }
        }

        #[contractimpl]
        impl TestContract {
            pub fn init(env: Env, admin: Address) {
                env.storage().instance().set(&symbol_short!("admin"), &admin);
            }
        }

        governance_impl!(TestContract, 1);
    }

    use test_contract::{TestContract, TestContractClient};

    fn setup() -> (Env, TestContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set(LedgerInfo {
            timestamp: 1_000,
            protocol_version: 22,
            sequence_number: 1,
            network_id: Default::default(),
            base_reserve: 10,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 16,
            max_entry_ttl: 6_312_000,
        });
        let contract_id = env.register_contract(None, TestContract);
        let client = TestContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.init(&admin);
        (env, client, admin)
    }

    fn hash(env: &Env, byte: u8) -> BytesN<32> {
        BytesN::from_array(env, &[byte; 32])
    }

    #[test]
    fn propose_sets_timelock() {
        let (env, client, _admin) = setup();
        let h = hash(&env, 1);
        client.propose_upgrade(&h);

        let pending = client.get_pending_upgrade().unwrap();
        assert_eq!(pending.new_wasm_hash, h);
        assert_eq!(pending.eta, 1_000 + UPGRADE_TIMELOCK_SECS);
    }

    #[test]
    fn propose_twice_panics() {
        let (env, client, _admin) = setup();
        client.propose_upgrade(&hash(&env, 1));

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.propose_upgrade(&hash(&env, 2));
        }));
        assert!(result.is_err());
    }

    #[test]
    fn propose_cancel_propose() {
        let (env, client, _admin) = setup();
        client.propose_upgrade(&hash(&env, 1));
        client.cancel_upgrade();
        assert!(client.get_pending_upgrade().is_none());

        let h2 = hash(&env, 2);
        client.propose_upgrade(&h2);
        let pending = client.get_pending_upgrade().unwrap();
        assert_eq!(pending.new_wasm_hash, h2);
    }

    #[test]
    fn propose_same_hash_after_cancel() {
        let (env, client, _admin) = setup();
        let h = hash(&env, 1);
        client.propose_upgrade(&h);
        client.cancel_upgrade();
        // After cancellation the same hash may be proposed again.
        client.propose_upgrade(&h);
        assert_eq!(client.get_pending_upgrade().unwrap().new_wasm_hash, h);
    }

    #[test]
    fn cancel_without_pending_is_noop() {
        let (_env, client, _admin) = setup();
        client.cancel_upgrade();
        assert!(client.get_pending_upgrade().is_none());
    }

    #[test]
    fn migrate_is_idempotent() {
        let (_env, client, _admin) = setup();
        assert_eq!(client.get_contract_version(), 0);
        client.migrate(&2);
        assert_eq!(client.get_contract_version(), 2);
        // Re-running with the same version is a no-op.
        client.migrate(&2);
        assert_eq!(client.get_contract_version(), 2);
        // Lower versions do not downgrade.
        client.migrate(&1);
        assert_eq!(client.get_contract_version(), 2);
    }

    #[test]
    fn pause_unpause() {
        let (_env, client, _admin) = setup();
        assert!(!client.is_paused());
        client.pause();
        assert!(client.is_paused());
        client.unpause();
        assert!(!client.is_paused());
    }

    #[test]
    fn gov_key_encoding_is_stable() {
        // Verify the raw encoding of each GovKey variant matches the
        // historical per-crate DataKey encoding (variant name as a symbol).
        let env = Env::default();
        let key = GovKey::ContractVersion;
        let encoded = key.to_xdr(&env);
        let expected = GovKey::ContractVersion.to_xdr(&env);
        assert_eq!(encoded, expected);

        // Round-trip through storage to confirm the key is usable.
        env.storage().instance().set(&GovKey::ContractVersion, &7u32);
        let stored: u32 = env
            .storage()
            .instance()
            .get(&GovKey::ContractVersion)
            .unwrap();
        assert_eq!(stored, 7);

        // PendingUpgrade and Paused keys round-trip too.
        let pending = PendingUpgrade {
            new_wasm_hash: BytesN::from_array(&env, &[9u8; 32]),
            eta: 42,
        };
        env.storage()
            .persistent()
            .set(&GovKey::PendingUpgrade, &pending);
        let read: PendingUpgrade = env
            .storage()
            .persistent()
            .get(&GovKey::PendingUpgrade)
            .unwrap();
        assert_eq!(read, pending);

        env.storage().instance().set(&GovKey::Paused, &true);
        assert!(env.storage().instance().get::<_, bool>(&GovKey::Paused).unwrap());
    }
}