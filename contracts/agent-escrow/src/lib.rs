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

mod test;

// ── Storage keys ─────────────────────────────────────────────────────────────

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
}

// ── Domain types ──────────────────────────────────────────────────────────────

/// Status of an agent escrow.
#[derive(Clone, Copy, PartialEq, Eq)]
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
#[derive(Clone)]
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
#[derive(Clone)]
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
#[derive(Clone)]
#[contracttype]
pub struct EvtEscrowConfirmed {
    pub escrow_id: u64,
    pub agent: Address,
    pub agent_amount: i128,
    pub fee_amount: i128,
}

/// Emitted by `cancel_escrow` and `admin_release` (to_agent=false).
/// Topics: ("AgentEscrow", "EscrowCancelled").
#[derive(Clone)]
#[contracttype]
pub struct EvtEscrowCancelled {
    pub escrow_id: u64,
    pub sender: Address,
    pub refund_amount: i128,
}

/// Emitted by `admin_release` in addition to the outcome event.
/// Topics: ("AgentEscrow", "AdminOverride").
#[derive(Clone)]
#[contracttype]
pub struct AdminOverride {
    pub escrow_id: u64,
    pub admin: Address,
    pub to_agent: bool,
    pub amount: i128,
    pub reason: Symbol,
}

#[derive(Clone)]
#[contracttype]
pub struct InsuranceFundContribution {
    pub escrow_id: u64,
    pub amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct EvtAgentRegistered {
    pub agent: Address,
}

#[derive(Clone)]
#[contracttype]
pub struct EvtAgentRemoved {
    pub agent: Address,
}

#[derive(Clone)]
#[contracttype]
pub struct InsurancePayout {
    pub escrow_id: u64,
    pub recipient: Address,
    pub amount: i128,
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
        admin.require_auth();
        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::UsdcAddress, &usdc_address);
        env.storage().persistent().set(&DataKey::CancelWindow, &cancel_window_seconds);
        env.storage().persistent().set(&DataKey::Counter, &0u64);
        env.storage().persistent().set(&DataKey::InsuranceFund, &0i128);
        env.storage().persistent().set(&DataKey::InsuranceContributionBps, &500u32); // 5% default
        env.storage().persistent().set(&DataKey::AgentList, &soroban_sdk::Vec::<Address>::new(&env));
    }

    /// Register an agent address in the whitelist. Admin only.
    /// Emits AgentRegistered event.
    pub fn register_agent(env: Env, agent: Address) {
        let admin: Address = env.storage().persistent().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if env.storage().persistent().get::<DataKey, bool>(&DataKey::RegisteredAgent(agent.clone())).unwrap_or(false) {
            return; // already registered, idempotent
        }
        let mut list: soroban_sdk::Vec<Address> = env.storage().persistent()
            .get(&DataKey::AgentList).unwrap_or(soroban_sdk::Vec::new(&env));
        if list.len() >= 10000 {
            panic!("Agent list capacity reached");
        }
        list.push_back(agent.clone());
        env.storage().persistent().set(&DataKey::AgentList, &list);
        env.storage().persistent().set(&DataKey::RegisteredAgent(agent.clone()), &true);
        env.events().publish(
            (Symbol::new(&env, "AgentRegistered"),),
            EvtAgentRegistered { agent },
        );
    }

    /// Remove an agent address from the whitelist. Admin only.
    /// Emits AgentRemoved event.
    pub fn remove_agent(env: Env, agent: Address) {
        let admin: Address = env.storage().persistent().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().persistent().remove(&DataKey::RegisteredAgent(agent.clone()));
        let list: soroban_sdk::Vec<Address> = env.storage().persistent()
            .get(&DataKey::AgentList).unwrap_or(soroban_sdk::Vec::new(&env));
        let mut new_list: soroban_sdk::Vec<Address> = soroban_sdk::Vec::new(&env);
        for a in list.iter() {
            if a != agent { new_list.push_back(a); }
        }
        env.storage().persistent().set(&DataKey::AgentList, &new_list);
        env.events().publish(
            (Symbol::new(&env, "AgentRemoved"),),
            EvtAgentRemoved { agent },
        );
    }

    /// Returns true if the address is a registered agent.
    pub fn is_registered_agent(env: Env, agent: Address) -> bool {
        env.storage().persistent()
            .get::<DataKey, bool>(&DataKey::RegisteredAgent(agent))
            .unwrap_or(false)
    }

    /// Returns a paginated list of registered agents.
    /// `start` is the 0-based index; `limit` is capped at 100.
    pub fn get_registered_agents(env: Env, start: u32, limit: u32) -> soroban_sdk::Vec<Address> {
        let cap = if limit > 100 { 100 } else { limit };
        let list: soroban_sdk::Vec<Address> = env.storage().persistent()
            .get(&DataKey::AgentList).unwrap_or(soroban_sdk::Vec::new(&env));
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
        let bps: u32 = env.storage().persistent()
            .get(&DataKey::InsuranceContributionBps).unwrap_or(0u32);
        let insurance_contribution = fee_amount * (bps as i128) / 10_000;
        let fee_contribution = fee_amount - insurance_contribution;

        if insurance_contribution > 0 {
            let insurance: i128 = env.storage().persistent()
                .get(&DataKey::InsuranceFund).unwrap_or(0i128);
            env.storage().persistent().set(&DataKey::InsuranceFund, &(insurance + insurance_contribution));
            env.events().publish(
                (Symbol::new(env, "InsuranceFundContribution"),),
                InsuranceFundContribution { escrow_id, amount: insurance_contribution },
            );
        }

        if fee_contribution > 0 {
            let fees: i128 = env.storage().persistent()
                .get(&DataKey::Fees).unwrap_or(0i128);
            env.storage().persistent().set(&DataKey::Fees, &(fees + fee_contribution));
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
        sender.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }
        if fee_bps > 10_000 {
            panic!("fee_bps out of range");
        }
        if !Self::is_registered_agent(env.clone(), agent.clone()) {
            panic!("agent not registered");
        }

        let usdc: Address = env.storage().persistent().get(&DataKey::UsdcAddress).unwrap();
        let token_client = token::Client::new(&env, &usdc);
        token_client.transfer(&sender, &env.current_contract_address(), &amount);

        let id: u64 = env.storage().persistent().get(&DataKey::Counter).unwrap_or(0u64) + 1;
        env.storage().persistent().set(&DataKey::Counter, &id);

        let cancel_window: u64 = env.storage().persistent()
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
        env.storage().persistent().set(&DataKey::Escrow(id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "EscrowCreated"),),
            EvtEscrowCreated { escrow_id: id, sender, recipient, agent, amount, expires_at: escrow.expires_at },
        );
        id
    }

    /// Agent confirms the full payout. Releases `amount - fee` to the agent and
    /// books the fee via [`Self::book_fee`].
    pub fn confirm_payout(env: Env, escrow_id: u64) {
        let mut escrow: AgentEscrow = env.storage().persistent()
            .get(&DataKey::Escrow(escrow_id)).expect("escrow not found");
        if escrow.status != EscrowStatus::Pending {
            panic!("escrow not pending");
        }
        escrow.agent.require_auth();

        let remaining = escrow.amount - escrow.released_amount;
        let fee_amount = remaining * (escrow.fee_bps as i128) / 10_000;
        let agent_amount = remaining - fee_amount;

        Self::book_fee(&env, escrow_id, fee_amount);

        let usdc: Address = env.storage().persistent().get(&DataKey::UsdcAddress).unwrap();
        let token_client = token::Client::new(&env, &usdc);
        token_client.transfer(&env.current_contract_address(), &escrow.agent, &agent_amount);

        escrow.status = EscrowStatus::Completed;
        escrow.released_amount = escrow.amount;
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "EscrowConfirmed"),),
            EvtEscrowConfirmed { escrow_id, agent: escrow.agent, agent_amount, fee_amount },
        );
    }

    /// Agent releases a partial amount. The pro-rata fee is booked via
    /// [`Self::book_fee`] so partial settlements fund insurance identically to
    /// a single full `confirm_payout`.
    pub fn partial_confirm_payout(env: Env, escrow_id: u64, release_amount: i128) {
        let mut escrow: AgentEscrow = env.storage().persistent()
            .get(&DataKey::Escrow(escrow_id)).expect("escrow not found");
        if escrow.status != EscrowStatus::Pending {
            panic!("escrow not pending");
        }
        escrow.agent.require_auth();
        if release_amount <= 0 {
            panic!("release_amount must be positive");
        }

        let remaining = escrow.amount - escrow.released_amount;
        if release_amount > remaining {
            panic!("release_amount exceeds remaining");
        }

        let fee_amount = release_amount * (escrow.fee_bps as i128) / 10_000;
        let agent_amount = release_amount - fee_amount;

        Self::book_fee(&env, escrow_id, fee_amount);

        let usdc: Address = env.storage().persistent().get(&DataKey::UsdcAddress).unwrap();
        let token_client = token::Client::new(&env, &usdc);
        token_client.transfer(&env.current_contract_address(), &escrow.agent, &agent_amount);

        escrow.released_amount += release_amount;
        if escrow.released_amount >= escrow.amount {
            escrow.status = EscrowStatus::Completed;
        }
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &escrow);

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
    /// The full amount is refunded; no fee is charged.
    pub fn cancel_escrow(env: Env, escrow_id: u64) {
        let mut escrow: AgentEscrow = env.storage().persistent()
            .get(&DataKey::Escrow(escrow_id)).expect("escrow not found");
        if escrow.status != EscrowStatus::Pending {
            panic!("escrow not pending");
        }
        escrow.sender.require_auth();
        if env.ledger().timestamp() < escrow.expires_at {
            panic!("cancel window not elapsed");
        }

        let refund_amount = escrow.amount - escrow.released_amount;
        let usdc: Address = env.storage().persistent().get(&DataKey::UsdcAddress).unwrap();
        let token_client = token::Client::new(&env, &usdc);
        token_client.transfer(&env.current_contract_address(), &escrow.sender, &refund_amount);

        escrow.status = EscrowStatus::Cancelled;
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "EscrowCancelled"),),
            EvtEscrowCancelled { escrow_id, sender: escrow.sender, refund_amount },
        );
    }

    /// Admin override. When `to_agent` is true the remaining balance is released
    /// to the agent (fee booked via [`Self::book_fee`]); otherwise it is refunded
    /// to the sender with no fee.
    pub fn admin_release(env: Env, escrow_id: u64, to_agent: bool, reason: Symbol) {
        let admin: Address = env.storage().persistent().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let mut escrow: AgentEscrow = env.storage().persistent()
            .get(&DataKey::Escrow(escrow_id)).expect("escrow not found");
        if escrow.status != EscrowStatus::Pending {
            panic!("escrow not pending");
        }

        let remaining = escrow.amount - escrow.released_amount;
        let usdc: Address = env.storage().persistent().get(&DataKey::UsdcAddress).unwrap();
        let token_client = token::Client::new(&env, &usdc);

        if to_agent {
            let fee_amount = remaining * (escrow.fee_bps as i128) / 10_000;
            let agent_amount = remaining - fee_amount;

            Self::book_fee(&env, escrow_id, fee_amount);
            token_client.transfer(&env.current_contract_address(), &escrow.agent, &agent_amount);

            escrow.status = EscrowStatus::Completed;
            escrow.released_amount = escrow.amount;
            env.storage().persistent().set(&DataKey::Escrow(escrow_id), &escrow);

            env.events().publish(
                (Symbol::new(&env, "EscrowConfirmed"),),
                EvtEscrowConfirmed { escrow_id, agent: escrow.agent.clone(), agent_amount, fee_amount },
            );
        } else {
            token_client.transfer(&env.current_contract_address(), &escrow.sender, &remaining);

            escrow.status = EscrowStatus::Cancelled;
            env.storage().persistent().set(&DataKey::Escrow(escrow_id), &escrow);

            env.events().publish(
                (Symbol::new(&env, "EscrowCancelled"),),
                EvtEscrowCancelled { escrow_id, sender: escrow.sender.clone(), refund_amount: remaining },
            );
        }

        env.events().publish(
            (Symbol::new(&env, "AdminOverride"),),
            AdminOverride { escrow_id, admin, to_agent, amount: remaining, reason },
        );
    }

    /// Admin withdraws accumulated platform fees. Insurance contributions are
    /// held separately in `InsuranceFund` and are not withdrawable here.
    pub fn withdraw_fees(env: Env, to: Address) {
        let admin: Address = env.storage().persistent().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        let fees: i128 = env.storage().persistent().get(&DataKey::Fees).unwrap_or(0i128);
        if fees <= 0 {
            panic!("no fees to withdraw");
        }
        env.storage().persistent().set(&DataKey::Fees, &0i128);
        let usdc: Address = env.storage().persistent().get(&DataKey::UsdcAddress).unwrap();
        let token_client = token::Client::new(&env, &usdc);
        token_client.transfer(&env.current_contract_address(), &to, &fees);
    }

    /// Returns the accumulated insurance fund balance.
    pub fn get_insurance_fund(env: Env) -> i128 {
        env.storage().persistent().get(&DataKey::InsuranceFund).unwrap_or(0i128)
    }

    /// Returns the accumulated withdrawable fee balance.
    pub fn get_fees(env: Env) -> i128 {
        env.storage().persistent().get(&DataKey::Fees).unwrap_or(0i128)
    }

    /// Returns the escrow record for `escrow_id`.
    pub fn get_escrow(env: Env, escrow_id: u64) -> AgentEscrow {
        env.storage().persistent().get(&DataKey::Escrow(escrow_id)).expect("escrow not found")
    }
}
