//! Upgrade governance (SC-172 / SC-173 / SC-174).
//!
//! The implementation lives in the shared `afripay-governance` crate; this
//! module only wires it to the escrow contract's storage layout.
use crate::{DataKey, EscrowContract};
use afripay_governance::{governance_impl, AdminStore};
use soroban_sdk::Env;

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 4;

impl AdminStore for EscrowContract {
    fn admin(env: &Env) -> soroban_sdk::Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized")
    }
}

governance_impl!(EscrowContract, CONTRACT_VERSION);
