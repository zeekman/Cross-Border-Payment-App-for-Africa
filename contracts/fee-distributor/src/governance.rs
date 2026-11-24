//! Upgrade governance (SC-172 / SC-173 / SC-184).
//!
//! The implementation lives in the shared `afripay-governance` crate; this
//! module only wires the contract's storage layout into it.
use crate::{DataKey, FeeDistributorContract};
use afripay_governance::AdminStore;
use soroban_sdk::{Address, Env};

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 1;

impl AdminStore for FeeDistributorContract {
    fn admin(env: &Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized")
    }
}

afripay_governance::governance_impl!(FeeDistributorContract, CONTRACT_VERSION);