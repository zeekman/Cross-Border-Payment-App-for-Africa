//! Upgrade governance (SC-172 / SC-173 / SC-174).
//!
//! The implementation lives in the shared `afripay-governance` crate; this
//! module only wires it up to `LoyaltyTokenContract`'s storage layout.
use crate::{DataKey, LoyaltyTokenContract};
use afripay_governance::{governance_impl, AdminStore};
use soroban_sdk::Env;

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 1;

impl AdminStore for LoyaltyTokenContract {
    fn admin(env: &Env) -> soroban_sdk::Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized")
    }
}

governance_impl!(LoyaltyTokenContract, CONTRACT_VERSION);
