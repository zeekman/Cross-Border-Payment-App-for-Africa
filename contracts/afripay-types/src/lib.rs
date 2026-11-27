#![no_std]

//! # AfriPay shared types and cross-contract interfaces (SC-214)
//!
//! One definition for every type and function signature that crosses a
//! contract boundary:
//!
//! - [`KycTier`] — defined once here; `kyc-attestation` and `loyalty-token`
//!   re-export it instead of declaring their own copy, so the XDR encoding can
//!   never drift between provider and consumer.
//! - `#[contractclient]` interfaces for the AfriPay contracts other contracts
//!   call. Consumers use the generated `*Client` instead of hand-built
//!   `invoke_contract` argument vectors, and each provider contract
//!   implements the matching trait. Changing a provider's signature without
//!   updating the trait here fails the provider's build; updating the trait
//!   fails every consumer that still calls the old signature.
//!
//! | Interface | Provider | Consumers |
//! |---|---|---|
//! | [`KycAttestationInterface`] | `kyc-attestation` | `escrow` |
//! | [`DisputeResolutionInterface`] | `dispute-resolution` | `escrow` |
//! | [`EscrowInterface`] | `escrow` | `dispute-resolution` |
//! | [`FeeDistributorInterface`] | `fee-distributor` | `recurring-payments` |
//! | [`AgentRegistryInterface`] | `agent-escrow` | — (off-chain / future) |

use soroban_sdk::{contractclient, contracttype, Address, Env};

// ── Shared types ──────────────────────────────────────────────────────────────

/// KYC verification tier. Encoded as its `u32` discriminant. The discriminants
/// are part of the on-chain ABI and of stored keys: never reorder or renumber.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[contracttype]
#[repr(u32)]
pub enum KycTier {
    Basic = 0,
    Enhanced = 1,
    Business = 2,
}

impl KycTier {
    /// Convert a stored `u32` discriminant back into a tier. Returns `None`
    /// for unknown values so callers can fail closed.
    pub fn from_u32(value: u32) -> Option<KycTier> {
        match value {
            0 => Some(KycTier::Basic),
            1 => Some(KycTier::Enhanced),
            2 => Some(KycTier::Business),
            _ => None,
        }
    }
}

// ── Cross-contract interfaces ─────────────────────────────────────────────────

/// Interface of the `kyc-attestation` contract used by other contracts.
#[contractclient(name = "KycAttestationClient")]
pub trait KycAttestationInterface {
    /// `true` if `user` holds a non-revoked, non-expired attestation for `tier`.
    fn is_valid_and_unexpired(env: Env, user: Address, tier: KycTier) -> bool;
}

/// Interface of the `dispute-resolution` contract used by `escrow`.
#[contractclient(name = "DisputeResolutionClient")]
pub trait DisputeResolutionInterface {
    /// Open a dispute for an escrow whose funds were already transferred to
    /// the dispute-resolution contract. Returns the new dispute id.
    #[allow(clippy::too_many_arguments)]
    fn open_escrow_dispute(
        env: Env,
        escrow_contract: Address,
        opener: Address,
        escrow_id: u64,
        sender: Address,
        recipient: Address,
        agent: Address,
        amount: i128,
        payout_confirmed: bool,
    ) -> u64;
}

/// Interface of the `escrow` contract used by `dispute-resolution`.
#[contractclient(name = "EscrowClient")]
pub trait EscrowInterface {
    /// Callback from the dispute contract once a dispute on `escrow_id` is
    /// settled in favour of `winner`.
    fn close_disputed_escrow(env: Env, escrow_id: u64, winner: Address);
}

/// Interface of the `fee-distributor` contract used by `recurring-payments`.
#[contractclient(name = "FeeDistributorClient")]
pub trait FeeDistributorInterface {
    /// Deposit `amount` of `token` as a platform fee, attributed to `source`.
    /// The depositor must have transferred the tokens to itself and authorize
    /// this call.
    fn deposit_fee(
        env: Env,
        depositor: Address,
        token: Address,
        amount: i128,
        source: Option<Address>,
    );
}

/// Agent registry interface exposed by the `agent-escrow` contract.
#[contractclient(name = "AgentRegistryClient")]
pub trait AgentRegistryInterface {
    /// `true` if `agent` is registered.
    fn is_registered_agent(env: Env, agent: Address) -> bool;
}
