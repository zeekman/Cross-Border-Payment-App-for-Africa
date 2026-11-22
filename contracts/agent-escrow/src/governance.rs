//! Upgrade governance (SC-172 / SC-173 / SC-174 / SC-184 / SC-185).
//!
//! The implementation lives in the shared `afripay-governance` crate; this
//! module only wires the contract's storage layout into it.
use crate::{AgentEscrowContract, DataKey};
use afripay_governance::AdminStore;
use soroban_sdk::Env;

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 1;

impl AdminStore for AgentEscrowContract {
    fn admin(env: &Env) -> soroban_sdk::Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized")
    }
}

afripay_governance::governance_impl!(AgentEscrowContract, CONTRACT_VERSION);