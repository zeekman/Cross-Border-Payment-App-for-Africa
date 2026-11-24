#![no_std]

//! # Agent Escrow Contract
//!
//! Trustless agent payout escrow for AfriPay cross-border remittances.
//!
//! ## Flow
//! 1. Sender calls [`create_escrow`] — USDC is locked in the contract.
//! 2. Agent delivers fiat off-chain, then calls [`confirm_payout`] on-chain.
//! 3. Contract releases USDC to the agent (minus platform fee).
//! 4. If the agent does not confirm within 48 hours, the sender may call
//!    [`cancel_escrow`] to receive a full refund.

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol};

#[cfg(test)]
mod test;

mod errors;
pub use errors::Error;
use soroban_sdk::panic_with_error;

// ── Storage keys ─────────────────────────────────────────────────────────────

#[derive(Debug)]
#[contracttype]
pub enum DataKey {
    Admin,
    UsdcAddress,
    Counter,
    Fees,
    CancelWindow,
    Escrow(u64),
    InsuranceFund,
    InsuranceContributionBps,
    /// bool flag: true if the address is a registered agent.
    RegisteredAgent(Address),
    /// Vec<Address> of all registered agents (bounded to 10000).
    AgentList,
    /// Cumulative insurance already paid out against an escrow (i128).
    InsurancePaid(u64),
}

/// Maximum insurance contribution rate: 10 % of each fee (1000 bps).
const MAX_INSURANCE_CONTRIBUTION_BPS: u32 = 1_000;

// ── TTL policy ────────────────────────────────────────────────────────────────
//
// Ledgers close roughly every 5 seconds, so:
//   * 30 days ≈ 518_400 ledgers
//   *  7 days ≈ 120_960 ledgers
//
// Instance storage (global config) is bumped to ~30 days whenever it falls
// below the ~7 day threshold. Persistent records (escrows, agent flags) are
// bumped on every read/write with the same policy.

/// Target TTL for instance storage entries (~30 days).
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
/// Bump instance storage when its TTL drops below this (~7 days).
const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960;
/// Target TTL for persistent records (~30 days).
const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;
/// Bump persistent records when their TTL drops below this (~7 days).
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;

// ── Domain types ──────────────────────────────────────────────────────────────

/// Status of an agent escrow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[contracttype]
pub enum EscrowStatus {
    /// Awaiting agent payout confirmation.
    Pending,
    /// Agent confirmed payout; funds released.
    Completed,
    /// Cancelled by sender after timeout; funds refunded.
    Cancelled,
}

/// On-chain record for a single agent escrow.
#[derive(Debug, Clone)]
#[contracttype]
pub struct AgentEscrow {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub agent: Address,
    /// USDC amount in stroops (7 decimal places).
    pub amount: i128,
    /// Platform fee in basis points (e.g. 250 = 2.5 %).
    pub fee_bps: u32,
    pub status: EscrowStatus,
    pub created_at: u64,
    /// Unix timestamp after which the sender may cancel (created_at + 48 h).
    pub expires_at: u64,
    /// Cumulative amount already released via partial_confirm_payout (stroops).
    pub released_amount: i128,
}

// ── Event payloads ────────────────────────────────────────────────────────────

/// Emitted by `create_escrow`. Topics: ("AgentEscrow", "EscrowCreated").
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtEscrowCreated {
    pub escrow_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub agent: Address,
    pub amount: i128,
    pub expires_at: u64,
}

/// Emitted by `confirm_payout` and `admin_release` (to_agent=true).
/// Topics: ("AgentEscrow", "EscrowConfirmed").
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtEscrowConfirmed {
    pub escrow_id: u64,
    pub agent: Address,
    pub agent_amount: i128,
    pub fee_amount: i128,
}

/// Emitted by `cancel_escrow` and `admin_release` (to_agent=false).
/// Topics: ("AgentEscrow", "EscrowCancelled").
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtEscrowCancelled {
    pub escrow_id: u64,
    pub sender: Address,
    pub refund_amount: i128,
}

/// Emitted by `admin_release` in addition to the outcome event.
/// Topics: ("AgentEscrow", "AdminOverride").
#[derive(Debug, Clone)]
#[contracttype]
pub struct AdminOverride {
    pub escrow_id: u64,
    pub admin: Address,
    pub to_agent: bool,
    pub amount: i128,
    pub reason: Symbol,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct InsuranceFundContribution {
    pub escrow_id: u64,
    pub amount: i128,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtAgentRegistered {
    pub agent: Address,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtAgentRemoved {
    pub agent: Address,
}

#[derive(Debug, Clone)]
/// Emitted by `withdraw_fees`. Topics: ("FeesWithdrawn",).
/// Lets the off-chain indexer and auditors track platform fee withdrawals.
#[derive(Clone)]
#[contracttype]
pub struct EvtFeesWithdrawn {
    pub admin: Address,
    pub to: Address,
    pub amount: i128,
    /// Withdrawable fee balance left after this withdrawal.
    pub remaining_fees: i128,
}

/// Emitted by `reassign_escrow`. Topics: ("EscrowReassigned",).
#[derive(Clone)]
#[contracttype]
pub struct EvtEscrowReassigned {
    pub escrow_id: u64,
    pub old_agent: Address,
    pub new_agent: Address,
}

#[derive(Clone)]
#[contracttype]
pub struct InsurancePayout {
    pub escrow_id: u64,
    pub recipient: Address,
    pub amount: i128,
}

#[derive(Debug, Clone)]
/// Emitted by `update_admin`. Topics: ("AdminUpdated",).
#[derive(Clone)]
#[contracttype]
pub struct EvtAdminUpdated {
    pub old_admin: Address,
    pub new_admin: Address,
}

/// Emitted by `set_insurance_contribution_bps`.
/// Topics: ("InsuranceContributionBpsUpdated",).
#[derive(Clone)]
#[contracttype]
pub struct EvtInsuranceContributionBpsUpdated {
    pub old_bps: u32,
    pub new_bps: u32,
}

/// Emitted by `initialize`. Topics: ("Initialized",).
#[derive(Clone)]
#[contracttype]
pub struct EvtInitialized {
    pub admin: Address,
    pub usdc_address: Address,
    pub cancel_window_seconds: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct EvtPartialPayoutReleased {
    pub escrow_id: u64,
    pub agent: Address,
    /// Amount released in this call (after pro-rata fee deduction), in stroops.
    pub released_amount: i128,
    /// Gross escrow amount not yet released (before fee), in stroops.
    pub remaining_amount: i128,
    /// Platform fee deducted from this partial release, in stroops.
    pub fee_amount: i128,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct AgentEscrowContract;

#[contractimpl]
impl AgentEscrowContract {
    /// Initialise the contract. Must be called once before any other function.
    /// The caller must be authorised as the admin.
    ///
    /// # Arguments
    /// * `admin`                  — Address that may withdraw accumulated fees.
    /// * `usdc_address`           — Stellar asset contract address for USDC.
    /// * `cancel_window_seconds`  — Seconds after escrow creation before the sender may cancel.
    pub fn initialize(env: Env, admin: Address, usdc_address: Address, cancel_window_seconds: u64) {
        Self::bump_instance(&env);
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(env, Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::UsdcAddress, &usdc_address);
        env.storage().instance().set(&DataKey::CancelWindow, &cancel_window_seconds);
        env.storage().instance().set(&DataKey::Counter, &0u64);
        env.storage().instance().set(&DataKey::InsuranceFund, &0i128);
        env.storage().instance().set(&DataKey::InsuranceContributionBps, &500u32); // 5% default
        let agent_list = soroban_sdk::Vec::<Address>::new(&env);
        env.storage().persistent().set(&DataKey::AgentList, &agent_list);
        Self::bump_persistent(&env, &DataKey::AgentList);
        env.events().publish(
            (Symbol::new(&env, "Initialized"),),
            EvtInitialized { admin, usdc_address, cancel_window_seconds },
        );
    }

    /// Extend the TTL of instance storage so global config is never archived.
    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    /// Extend the TTL of a persistent record so it is never archived.
    fn bump_persistent(env: &Env, key: &DataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
    }

    /// Read a persistent record, bumping its TTL first so an entry that is
    /// close to expiry is refreshed before it can be archived.
    fn get_persistent<T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: &DataKey,
    ) -> Option<T> {
        if env.storage().persistent().has(key) {
            Self::bump_persistent(env, key);
        }
        env.storage().persistent().get(key)
    }

    /// Write a persistent record and bump its TTL.
    fn set_persistent<T: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: &DataKey,
        value: &T,
    ) {
        env.storage().persistent().set(key, value);
        Self::bump_persistent(env, key);
    }

    /// Register an agent address in the whitelist. Admin only.
    /// Emits AgentRegistered event.
    pub fn register_agent(env: Env, agent: Address) {
        Self::bump_instance(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if Self::get_persistent::<bool>(&env, &DataKey::RegisteredAgent(agent.clone())).unwrap_or(false) {
            return; // already registered, idempotent
        }
        let mut list: soroban_sdk::Vec<Address> = Self::get_persistent(&env, &DataKey::AgentList)
            .unwrap_or(soroban_sdk::Vec::new(&env));
        if list.len() >= 10000 {
            panic_with_error!(env, Error::AgentListFull);
        }
        list.push_back(agent.clone());
        Self::set_persistent(&env, &DataKey::AgentList, &list);
        Self::set_persistent(&env, &DataKey::RegisteredAgent(agent.clone()), &true);
        env.events().publish(
            (Symbol::new(&env, "AgentRegistered"),),
            EvtAgentRegistered { agent },
        );
    }

    /// Remove an agent address from the whitelist. Admin only.
    /// Emits AgentRemoved event.
    ///
    /// A removed agent can no longer confirm or partially confirm any escrow
    /// assigned to them — their pending escrows are frozen. The admin can then
    /// move each one to another agent with [`Self::reassign_escrow`] or settle
    /// it with [`Self::admin_release`]; the sender can still cancel once the
    /// cancel window has elapsed.
    pub fn remove_agent(env: Env, agent: Address) {
        Self::bump_instance(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().persistent().remove(&DataKey::RegisteredAgent(agent.clone()));
        let list: soroban_sdk::Vec<Address> = Self::get_persistent(&env, &DataKey::AgentList)
            .unwrap_or(soroban_sdk::Vec::new(&env));
        let mut new_list: soroban_sdk::Vec<Address> = soroban_sdk::Vec::new(&env);
        for a in list.iter() {
            if a != agent { new_list.push_back(a); }
        }
        Self::set_persistent(&env, &DataKey::AgentList, &new_list);
        env.events().publish(
            (Symbol::new(&env, "AgentRemoved"),),
            EvtAgentRemoved { agent },
        );
    }

    /// Admin reassigns a pending escrow to another registered agent, e.g.
    /// after the original agent was removed for fraud or a compromised key.
    /// Any amount already released stays with the old agent; only the
    /// remaining balance can be claimed by the new agent.
    /// Emits EscrowReassigned event.
    pub fn reassign_escrow(env: Env, escrow_id: u64, new_agent: Address) {
        Self::bump_instance(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let mut escrow: AgentEscrow = Self::get_persistent(&env, &DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));
        if escrow.status != EscrowStatus::Pending {
            panic_with_error!(env, Error::EscrowNotPending);
        }
        if new_agent == escrow.agent {
            panic_with_error!(env, Error::SameAgent);
        }
        Self::require_registered_agent(&env, &new_agent);

        let old_agent = escrow.agent.clone();
        escrow.agent = new_agent.clone();
        Self::set_persistent(&env, &DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "EscrowReassigned"),),
            EvtEscrowReassigned { escrow_id, old_agent, new_agent },
        );
    }

    fn require_registered_agent(env: &Env, agent: &Address) {
        if !Self::is_registered_agent(env.clone(), agent.clone()) {
            panic_with_error!(env, Error::AgentNotRegistered);
        }
    }

    /// Returns true if the address is a registered agent.
    pub fn is_registered_agent(env: Env, agent: Address) -> bool {
        Self::bump_instance(&env);
        Self::get_persistent::<bool>(&env, &DataKey::RegisteredAgent(agent))
            .unwrap_or(false)
    }

    /// Returns a paginated list of registered agents.
    /// `start` is the 0-based index; `limit` is capped at 100.
    pub fn get_registered_agents(env: Env, start: u32, limit: u32) -> soroban_sdk::Vec<Address> {
        Self::bump_instance(&env);
        let cap = if limit > 100 { 100 } else { limit };
        let list: soroban_sdk::Vec<Address> = Self::get_persistent(&env, &DataKey::AgentList)
            .unwrap_or(soroban_sdk::Vec::new(&env));
        let mut out: soroban_sdk::Vec<Address> = soroban_sdk::Vec::new(&env);
        let len = list.len();
        let mut i = start;
        while i < len && out.len() < cap {
            out.push_back(list.get(i).unwrap());
            i += 1;
        }
        out
    }

    /// Split `fee_amount` between the insurance fund and withdrawable fees,
    /// then emit an `InsuranceFundContribution` event for the insurance share.
    ///
    /// `insurance_contribution = fee_amount * InsuranceContributionBps / 10_000`
    /// is added to `InsuranceFund`; the remainder is added to `Fees`.
    fn book_fee(env: &Env, escrow_id: u64, fee_amount: i128) {
        if fee_amount <= 0 {
            return;
        }
        let bps: u32 = env.storage().instance()
            .get(&DataKey::InsuranceContributionBps).unwrap_or(0u32);
        let insurance_contribution = fee_amount * (bps as i128) / 10_000;
        let fee_contribution = fee_amount - insurance_contribution;

        if insurance_contribution > 0 {
            let insurance: i128 = env.storage().instance()
                .get(&DataKey::InsuranceFund).unwrap_or(0i128);
            env.storage().instance().set(&DataKey::InsuranceFund, &(insurance + insurance_contribution));
            env.events().publish(
                (Symbol::new(env, "InsuranceFundContribution"),),
                InsuranceFundContribution { escrow_id, amount: insurance_contribution },
            );
        }

        if fee_contribution > 0 {
            let fees: i128 = env.storage().instance()
                .get(&DataKey::Fees).unwrap_or(0i128);
            env.storage().instance().set(&DataKey::Fees, &(fees + fee_contribution));
        }
    }

    /// Create a new agent escrow. The sender must authorise the USDC transfer.
    ///
    /// # Arguments
    /// * `sender`     — Address funding the escrow.
    /// * `recipient`  — Off-chain fiat recipient (informational).
    /// * `agent`      — Registered agent that will confirm the payout.
    /// * `amount`     — USDC amount in stroops.
    /// * `fee_bps`    — Platform fee in basis points.
    pub fn create_escrow(
        env: Env,
        sender: Address,
        recipient: Address,
        agent: Address,
        amount: i128,
        fee_bps: u32,
    ) -> u64 {
        Self::bump_instance(&env);
        governance::require_not_paused(&env);
        sender.require_auth();
        if amount <= 0 {
            panic_with_error!(env, Error::InvalidAmount);
        }
        if fee_bps > 10_000 {
            panic_with_error!(env, Error::FeeTooHigh);
        }
        if !Self::is_registered_agent(env.clone(), agent.clone()) {
            panic_with_error!(env, Error::AgentNotRegistered);
        }

        let usdc: Address = env.storage().instance().get(&DataKey::UsdcAddress).unwrap();
        let token_client = token::Client::new(&env, &usdc);
        token_client.transfer(&sender, &env.current_contract_address(), &amount);

        let id: u64 = env.storage().instance().get(&DataKey::Counter).unwrap_or(0u64) + 1;
        env.storage().instance().set(&DataKey::Counter, &id);

        let cancel_window: u64 = env.storage().instance()
            .get(&DataKey::CancelWindow).unwrap_or(172_800u64);
        let now = env.ledger().timestamp();

        let escrow = AgentEscrow {
            id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            agent: agent.clone(),
            amount,
            fee_bps,
            status: EscrowStatus::Pending,
            created_at: now,
            expires_at: now + cancel_window,
            released_amount: 0,
        };
        Self::set_persistent(&env, &DataKey::Escrow(id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "AgentEscrow"), Symbol::new(&env, "EscrowCreated")),
            EvtEscrowCreated { escrow_id: id, sender, recipient, agent, amount, expires_at: escrow.expires_at },
        );
        id
    }

    /// Agent confirms the full payout. Releases `remaining - fee` to the agent
    /// and books the fee via [`Self::book_fee`].
    ///
    /// # Arguments
    /// * `agent`     — Must match the agent recorded in the escrow.
    /// * `escrow_id` — ID returned by `create_escrow`.
    pub fn confirm_payout(env: Env, agent: Address, escrow_id: u64) {
        Self::bump_instance(&env);
        agent.require_auth();

        let mut escrow: AgentEscrow = Self::get_persistent(&env, &DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));
        if agent != escrow.agent {
            panic_with_error!(env, Error::NotAgent);
        }
        if escrow.status != EscrowStatus::Pending {
            panic_with_error!(env, Error::EscrowNotPending);
        }
        escrow.agent.require_auth();
        // A removed (e.g. fraudulent or compromised) agent must not be able
        // to claim escrows that were assigned to them before removal.
        Self::require_registered_agent(&env, &escrow.agent);

        let remaining = escrow.amount - escrow.released_amount;
        let fee_amount = remaining * (escrow.fee_bps as i128) / 10_000;
        let agent_amount = remaining - fee_amount;

        Self::book_fee(&env, escrow_id, fee_amount);

        let usdc: Address = env.storage().instance().get(&DataKey::UsdcAddress).unwrap();
        let token_client = token::Client::new(&env, &usdc);
        token_client.transfer(&env.current_contract_address(), &escrow.agent, &agent_amount);

        escrow.status = EscrowStatus::Completed;
        escrow.released_amount = escrow.amount;
        Self::set_persistent(&env, &DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "AgentEscrow"), Symbol::new(&env, "EscrowConfirmed")),
            EvtEscrowConfirmed { escrow_id, agent, agent_amount, fee_amount },
        );
    }

    /// Agent releases a partial amount. The pro-rata fee is booked via
    /// [`Self::book_fee`] so partial settlements fund insurance identically to
    /// a single full `confirm_payout`. Auto-completes when fully released.
    ///
    /// # Arguments
    /// * `agent`     — Must match the agent recorded in the escrow.
    /// * `escrow_id` — ID returned by `create_escrow`.
    /// * `amount`    — Gross amount to release (> 0, <= remaining balance).
    pub fn partial_confirm_payout(env: Env, agent: Address, escrow_id: u64, amount: i128) {
        Self::bump_instance(&env);
        if amount <= 0 {
            panic_with_error!(env, Error::InvalidAmount);
        }
        agent.require_auth();

        let mut escrow: AgentEscrow = Self::get_persistent(&env, &DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));
        if agent != escrow.agent {
            panic_with_error!(env, Error::NotAgent);
        }
        if escrow.status != EscrowStatus::Pending {
            panic_with_error!(env, Error::EscrowNotPending);
        }
        escrow.agent.require_auth();
        // A removed (e.g. fraudulent or compromised) agent must not be able
        // to claim escrows that were assigned to them before removal.
        Self::require_registered_agent(&env, &escrow.agent);
        if release_amount <= 0 {
            panic_with_error!(env, Error::InvalidAmount);
        if env.ledger().timestamp() >= escrow.expires_at {
            panic_with_error!(env, Error::EscrowExpired);
        }

        let remaining = escrow.amount - escrow.released_amount;
        if amount > remaining {
            panic_with_error!(env, Error::ReleaseExceedsBalance);
        }

        let fee_amount = amount * (escrow.fee_bps as i128) / 10_000;
        let agent_amount = amount - fee_amount;

        Self::book_fee(&env, escrow_id, fee_amount);

        let usdc: Address = env.storage().instance().get(&DataKey::UsdcAddress).unwrap();
        let token_client = token::Client::new(&env, &usdc);
        token_client.transfer(&env.current_contract_address(), &escrow.agent, &agent_amount);

        escrow.released_amount += amount;
        if escrow.released_amount >= escrow.amount {
            escrow.status = EscrowStatus::Completed;
        }
        Self::set_persistent(&env, &DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "PartialPayoutReleased"),),
            EvtPartialPayoutReleased {
                escrow_id,
                agent: escrow.agent,
                released_amount: agent_amount,
                remaining_amount: escrow.amount - escrow.released_amount,
                fee_amount,
            },
        );
    }

    /// Sender cancels a pending escrow after the cancel window has elapsed.
    /// The remaining (unreleased) amount is refunded; no fee is charged.
    ///
    /// # Arguments
    /// * `sender`    — Must match the sender recorded in the escrow.
    /// * `escrow_id` — ID returned by `create_escrow`.
    pub fn cancel_escrow(env: Env, sender: Address, escrow_id: u64) {
        Self::bump_instance(&env);
        sender.require_auth();

        let mut escrow: AgentEscrow = Self::get_persistent(&env, &DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));
        if sender != escrow.sender {
            panic_with_error!(env, Error::NotSender);
        }
        if escrow.status != EscrowStatus::Pending {
            panic_with_error!(env, Error::EscrowNotPending);
        }
        if env.ledger().timestamp() < escrow.expires_at {
            panic_with_error!(env, Error::CancellationWindowActive);
        }

        let refund_amount = escrow.amount - escrow.released_amount;
        let usdc: Address = env.storage().instance().get(&DataKey::UsdcAddress).unwrap();
        let token_client = token::Client::new(&env, &usdc);
        token_client.transfer(&env.current_contract_address(), &escrow.sender, &refund_amount);

        escrow.status = EscrowStatus::Cancelled;
        Self::set_persistent(&env, &DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "AgentEscrow"), Symbol::new(&env, "EscrowCancelled")),
            EvtEscrowCancelled { escrow_id, sender, refund_amount },
        );
    }

    /// Admin override. When `to_agent` is true the remaining balance is released
    /// to the agent (fee booked via [`Self::book_fee`]); otherwise it is refunded
    /// to the sender with no fee. Releasing to a removed agent is rejected —
    /// reassign the escrow first.
    pub fn admin_release(env: Env, escrow_id: u64, to_agent: bool, reason: Symbol) {
        Self::bump_instance(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let mut escrow: AgentEscrow = Self::get_persistent(&env, &DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));
        if escrow.status != EscrowStatus::Pending {
            panic_with_error!(env, Error::EscrowNotPending);
        }

        let remaining = escrow.amount - escrow.released_amount;
        let usdc: Address = env.storage().instance().get(&DataKey::UsdcAddress).unwrap();
        let token_client = token::Client::new(&env, &usdc);

        if to_agent {
            Self::require_registered_agent(&env, &escrow.agent);
            let fee_amount = remaining * (escrow.fee_bps as i128) / 10_000;
            let agent_amount = remaining - fee_amount;

            Self::book_fee(&env, escrow_id, fee_amount);
            token_client.transfer(&env.current_contract_address(), &escrow.agent, &agent_amount);

            escrow.status = EscrowStatus::Completed;
            escrow.released_amount = escrow.amount;
            Self::set_persistent(&env, &DataKey::Escrow(escrow_id), &escrow);

            env.events().publish(
                (Symbol::new(&env, "AgentEscrow"), Symbol::new(&env, "EscrowConfirmed")),
                EvtEscrowConfirmed { escrow_id, agent: escrow.agent.clone(), agent_amount, fee_amount },
            );
        } else {
            token_client.transfer(&env.current_contract_address(), &escrow.sender, &remaining);

            escrow.status = EscrowStatus::Cancelled;
            Self::set_persistent(&env, &DataKey::Escrow(escrow_id), &escrow);

            env.events().publish(
                (Symbol::new(&env, "AgentEscrow"), Symbol::new(&env, "EscrowCancelled")),
                EvtEscrowCancelled { escrow_id, sender: escrow.sender.clone(), refund_amount: remaining },
            );
        }

        env.events().publish(
            (Symbol::new(&env, "AgentEscrow"), Symbol::new(&env, "AdminOverride")),
            AdminOverride { escrow_id, admin, to_agent, amount: remaining, reason },
        );
    }

    /// Admin withdraws `amount` of the accumulated platform fees to `to`.
    /// Partial withdrawals are allowed. Insurance contributions are held
    /// separately in `InsuranceFund` and are not withdrawable here.
    /// Emits FeesWithdrawn event.
    ///
    /// # Panics
    /// * `amount` is not positive or exceeds the withdrawable fee balance.
    /// * `to` is this contract (the transfer would be a no-op that still
    ///   zeroes the books).
    pub fn withdraw_fees(env: Env, to: Address, amount: i128) {
        Self::bump_instance(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if amount <= 0 {
            panic_with_error!(env, Error::InvalidAmount);
        }
        if to == env.current_contract_address() {
            panic_with_error!(env, Error::InvalidRecipient);
        }
        let fees: i128 = env.storage().instance().get(&DataKey::Fees).unwrap_or(0i128);
        if amount > fees {
            panic_with_error!(env, Error::InsufficientFees);
        }

        let remaining_fees = fees - amount;
        env.storage().instance().set(&DataKey::Fees, &remaining_fees);
        let usdc: Address = env.storage().instance().get(&DataKey::UsdcAddress).unwrap();
        let token_client = token::Client::new(&env, &usdc);
        token_client.transfer(&env.current_contract_address(), &to, &amount);

        env.events().publish(
            (Symbol::new(&env, "FeesWithdrawn"),),
            EvtFeesWithdrawn { admin, to, amount, remaining_fees },
        );
    /// Withdraw accumulated platform fees to the admin address. Insurance
    /// contributions are held separately in `InsuranceFund`; they are spent
    /// only through [`Self::insurance_payout`].
    ///
    /// # Arguments
    /// * `admin`  — Must match the stored admin.
    /// * `amount` — Amount to withdraw (> 0, <= accumulated fees).
    pub fn withdraw_fees(env: Env, admin: Address, amount: i128) {
        Self::bump_instance(&env);
        admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            panic_with_error!(env, Error::Unauthorized);
        }
        if amount <= 0 {
            panic_with_error!(env, Error::InvalidAmount);
        }
        let fees: i128 = env.storage().instance().get(&DataKey::Fees).unwrap_or(0i128);
        if amount > fees {
            panic_with_error!(env, Error::InsufficientFees);
        }
        env.storage().instance().set(&DataKey::Fees, &(fees - amount));
        let usdc: Address = env.storage().instance().get(&DataKey::UsdcAddress).unwrap();
        let token_client = token::Client::new(&env, &usdc);
        token_client.transfer(&env.current_contract_address(), &admin, &amount);
    }

    /// Rotate the admin. Both the current and the new admin must authorise,
    /// so the role cannot be handed to a mistyped or uncontrolled address.
    ///
    /// This is the immediate, single-step rotation. For the delayed two-step
    /// rotation (SC-190) use the governance entry points [`Self::propose_admin`],
    /// [`Self::accept_admin`] and [`Self::cancel_admin_proposal`], which are
    /// implemented in the shared `governance` module and compiled into this
    /// contract. The admin should be a multisig account or the
    /// `multisig-approval` contract so a single lost key is never fatal.
    pub fn update_admin(env: Env, new_admin: Address) {
        Self::bump_instance(&env);
        let old_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        old_admin.require_auth();
        if new_admin == old_admin {
            panic_with_error!(env, Error::SameAdmin);
        }
        new_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (Symbol::new(&env, "AdminUpdated"),),
            EvtAdminUpdated { old_admin, new_admin },
        );
    }

    /// Update the share of each fee routed to the insurance fund. Admin only.
    ///
    /// # Arguments
    /// * `new_bps` — Contribution rate in basis points (max 1000 = 10 %).
    pub fn set_insurance_contribution_bps(env: Env, new_bps: u32) {
        Self::bump_instance(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if new_bps > MAX_INSURANCE_CONTRIBUTION_BPS {
            panic_with_error!(env, Error::ContributionRateTooHigh);
        }
        let old_bps: u32 = env.storage().instance()
            .get(&DataKey::InsuranceContributionBps).unwrap_or(0u32);
        env.storage().instance().set(&DataKey::InsuranceContributionBps, &new_bps);
        env.events().publish(
            (Symbol::new(&env, "InsuranceContributionBpsUpdated"),),
            EvtInsuranceContributionBpsUpdated { old_bps, new_bps },
        );
    }

    /// Return the current insurance contribution rate in basis points.
    pub fn get_insurance_contribution_bps(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage().instance()
            .get(&DataKey::InsuranceContributionBps).unwrap_or(0u32)
    }

    /// Admin pays the escrow's sender from the insurance fund. Admin only.
    ///
    /// Only a `Cancelled` escrow is eligible, and only for the portion the
    /// sender actually lost: `released_amount` (funds paid to the agent before
    /// cancellation; the rest was refunded). Cumulative payouts per escrow are
    /// capped at that amount, so repeat calls cannot pay twice (SC-128).
    /// Pays `min(outstanding claim, fund balance)` to `escrow.sender`.
    pub fn insurance_payout(env: Env, escrow_id: u64) {
        Self::bump_instance(&env);
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let escrow: AgentEscrow = Self::get_persistent(&env, &DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));
        if escrow.status != EscrowStatus::Cancelled {
            panic_with_error!(env, Error::EscrowNotCancelled);
        }

        let already_paid: i128 = Self::get_persistent(&env, &DataKey::InsurancePaid(escrow_id))
            .unwrap_or(0i128);
        let outstanding = escrow.released_amount - already_paid;
        if outstanding <= 0 {
            panic_with_error!(env, Error::NoOutstandingLoss);
        }

        let fund: i128 = env.storage().instance()
            .get(&DataKey::InsuranceFund).unwrap_or(0i128);
        let payout_amount = if outstanding < fund { outstanding } else { fund };
        if payout_amount <= 0 {
            panic_with_error!(env, Error::InsufficientInsuranceFund);
        }

        env.storage().instance().set(&DataKey::InsuranceFund, &(fund - payout_amount));
        Self::set_persistent(&env, &DataKey::InsurancePaid(escrow_id), &(already_paid + payout_amount));

        let usdc: Address = env.storage().instance().get(&DataKey::UsdcAddress).unwrap();
        let token_client = token::Client::new(&env, &usdc);
        token_client.transfer(&env.current_contract_address(), &escrow.sender, &payout_amount);

        env.events().publish(
            (Symbol::new(&env, "InsurancePayout"),),
            InsurancePayout { escrow_id, recipient: escrow.sender, amount: payout_amount },
        );
    }

    /// Returns the cumulative insurance already paid out against `escrow_id`.
    pub fn get_insurance_paid(env: Env, escrow_id: u64) -> i128 {
        Self::bump_instance(&env);
        Self::get_persistent(&env, &DataKey::InsurancePaid(escrow_id)).unwrap_or(0i128)
    }

    /// Returns the accumulated insurance fund balance.
    pub fn get_insurance_balance(env: Env) -> i128 {
        Self::bump_instance(&env);
        env.storage().instance().get(&DataKey::InsuranceFund).unwrap_or(0i128)
    }

    /// Alias of [`Self::get_insurance_balance`], kept for callers that
    /// integrated against the renamed getter.
    pub fn get_insurance_fund(env: Env) -> i128 {
        Self::get_insurance_balance(env)
    }

    /// Returns the accumulated withdrawable fee balance.
    pub fn get_fees(env: Env) -> i128 {
        env.storage().persistent().get(&DataKey::Fees).unwrap_or(0i128)
    }

    /// Returns the escrow record for `escrow_id`.
    pub fn get_escrow(env: Env, escrow_id: u64) -> AgentEscrow {
        env.storage().persistent().get(&DataKey::Escrow(escrow_id)).unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound))
    }
}

// SC-214: this contract implements its interface from `afripay-types`, so the
// compiler checks the exported signature against the one consumers call.
// Changing the entry point without updating the shared trait breaks this build;
// updating the trait breaks every consumer still using the old signature.
impl afripay_types::AgentRegistryInterface for AgentEscrowContract {
    fn is_registered_agent(env: Env, agent: Address) -> bool {
        AgentEscrowContract::is_registered_agent(env, agent)
    }
}

mod governance;
pub use governance::{CONTRACT_VERSION, UPGRADE_TIMELOCK_SECS};
// The governance module carries its own `#[contractimpl]` block, so the
// two-step admin rotation (`propose_admin` / `accept_admin` /
// `cancel_admin_proposal`) is exported on `AgentEscrowContract` alongside the
// functions above. All admin-only entry points read `DataKey::Admin`, so once
// `accept_admin` swaps it the previous admin loses every privilege.
