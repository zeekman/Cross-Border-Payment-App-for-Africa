//! Upgrade governance (SC-172 / SC-173 / SC-184).
//!
//! The implementation lives in the shared `afripay-governance` crate; this
//! module only wires it to this contract's storage layout.
use crate::{DataKey, MultisigContract};
use afripay_governance::{governance_impl, AdminStore};
use soroban_sdk::Env;

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 1;

/// This contract keeps its admin in **instance** storage.
impl AdminStore for MultisigContract {
    fn admin(env: &Env) -> soroban_sdk::Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized")
    }
}

governance_impl!(MultisigContract, 1);
