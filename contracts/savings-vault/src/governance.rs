//! Upgrade governance (SC-172 / SC-173 / SC-174 / SC-184).
//!
//! The implementation lives in the shared `afripay-governance` crate. This
//! module only wires the contract's storage layout into the shared code and
//! expands the exported governance API via `governance_impl!`.
use crate::{DataKey, SavingsVaultContract};
use afripay_governance::AdminStore;
use soroban_sdk::{Address, Env};

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 1;

impl AdminStore for SavingsVaultContract {
    fn admin(env: &Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized")
    }
}

afripay_governance::governance_impl!(SavingsVaultContract, CONTRACT_VERSION);