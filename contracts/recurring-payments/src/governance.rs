//! Upgrade governance (SC-172 / SC-173 / SC-184).
//!
//! The implementation lives in the shared `afripay-governance` crate; this
//! module only wires it to `RecurringPaymentsContract`'s storage layout.
use crate::{DataKey, RecurringPaymentsContract};
use afripay_governance::{governance_impl, AdminStore};
use soroban_sdk::{Address, Env};

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 1;

impl AdminStore for RecurringPaymentsContract {
    fn admin(env: &Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized")
    }
}

governance_impl!(RecurringPaymentsContract, CONTRACT_VERSION);
