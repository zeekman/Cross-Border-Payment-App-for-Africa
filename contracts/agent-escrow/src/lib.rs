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
    Escrow(u64),
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
}

// ── Event payloads ────────────────────────────────────────────────────────────

#[derive(Clone)]
#[contracttype]
pub struct EvtCreated {
    pub escrow_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub agent: Address,
    pub amount: i128,
    pub fee_bps: u32,
    pub expires_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct EvtCompleted {
    pub escrow_id: u64,
    pub agent_amount: i128,
    pub fee_amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct EvtCancelled {
    pub escrow_id: u64,
    pub refund_amount: i128,
}

// ── Constants ─────────────────────────────────────────────────────────────────

/// 48 hours in seconds — cancellation window.
const CANCEL_WINDOW_SECS: u64 = 48 * 60 * 60;

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct AgentEscrowContract;

#[contractimpl]
impl AgentEscrowContract {
    /// Initialise the contract. Must be called once before any other function.
    ///
    /// # Arguments
    /// * `admin`        — Address that may withdraw accumulated fees.
    /// * `usdc_address` — Stellar asset contract address for USDC.
    pub fn initialize(env: Env, admin: Address, usdc_address: Address) {
        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::UsdcAddress, &usdc_address);
        env.storage().persistent().set(&DataKey::Counter, &0u64);
    }

    /// Lock USDC in escrow pending agent payout confirmation.
    ///
    /// Transfers `amount` USDC from `sender` into the contract.
    /// Returns the new escrow ID.
    ///
    /// # Arguments
    /// * `sender`    — Payer; must authorise this call.
    /// * `recipient` — Off-chain fiat recipient (informational).
    /// * `agent`     — Registered payout agent who will call `confirm_payout`.
    /// * `amount`    — USDC amount in stroops (must be > 0).
    /// * `fee_bps`   — Platform fee in basis points (0–10 000).
    pub fn create_escrow(
        env: Env,
        sender: Address,
        recipient: Address,
        agent: Address,
        amount: i128,
        fee_bps: u32,
    ) -> u64 {
        if amount <= 0 {
            panic!("amount must be positive");
        }
        if fee_bps > 10_000 {
            panic!("fee_bps cannot exceed 10000");
        }

        sender.require_auth();

        let usdc: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("not initialized");

        token::Client::new(&env, &usdc).transfer(
            &sender,
            &env.current_contract_address(),
            &amount,
        );

        let current_count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Counter)
            .unwrap_or(0);
        // u64::MAX is 18,446,744,073,709,551,615. At one escrow per second,
        // exhausting the counter would take ~584 billion years.
        let id = current_count.checked_add(1).expect("Escrow counter overflow");
        env.storage().persistent().set(&DataKey::Counter, &id);

        let now = env.ledger().timestamp();
        let expires_at = now + CANCEL_WINDOW_SECS;

        let escrow = AgentEscrow {
            id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            agent: agent.clone(),
            amount,
            fee_bps,
            status: EscrowStatus::Pending,
            created_at: now,
            expires_at,
        };
        env.storage().persistent().set(&DataKey::Escrow(id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "EscrowCreated"),),
            EvtCreated { escrow_id: id, sender, recipient, agent, amount, fee_bps, expires_at },
        );

        id
    }

    /// Agent confirms off-chain fiat delivery, releasing USDC from escrow.
    ///
    /// Transfers `(amount - fee)` to the agent and accumulates the fee.
    /// Only the designated agent may call this function.
    ///
    /// # Arguments
    /// * `agent`     — Must match the agent recorded in the escrow.
    /// * `escrow_id` — ID returned by `create_escrow`.
    pub fn confirm_payout(env: Env, agent: Address, escrow_id: u64) {
        agent.require_auth();

        let mut escrow: AgentEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");

        if agent != escrow.agent {
            panic!("unauthorized: caller is not the escrow agent");
        }
        if escrow.status != EscrowStatus::Pending {
            panic!("escrow is not pending");
        }

        let fee_amount = (escrow.amount * escrow.fee_bps as i128) / 10_000;
        let agent_amount = escrow.amount - fee_amount;

        let usdc: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .unwrap();

        token::Client::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &escrow.agent,
            &agent_amount,
        );

        let fees: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Fees)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::Fees, &(fees + fee_amount));

        escrow.status = EscrowStatus::Completed;
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "PayoutConfirmed"),),
            EvtCompleted { escrow_id, agent_amount, fee_amount },
        );
    }

    /// Cancel a pending escrow and refund the sender.
    ///
    /// Only the original sender may cancel, and only after the 48-hour
    /// cancellation window has elapsed without agent confirmation.
    ///
    /// # Arguments
    /// * `sender`    — Must match the sender recorded in the escrow.
    /// * `escrow_id` — ID returned by `create_escrow`.
    pub fn cancel_escrow(env: Env, sender: Address, escrow_id: u64) {
        sender.require_auth();

        let mut escrow: AgentEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");

        if sender != escrow.sender {
            panic!("unauthorized: caller is not the escrow sender");
        }
        if escrow.status != EscrowStatus::Pending {
            panic!("escrow is not pending");
        }
        if env.ledger().timestamp() < escrow.expires_at {
            panic!("cancellation window has not elapsed");
        }

        let usdc: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .unwrap();

        token::Client::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &escrow.sender,
            &escrow.amount,
        );

        escrow.status = EscrowStatus::Cancelled;
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "EscrowCancelled"),),
            EvtCancelled { escrow_id, refund_amount: escrow.amount },
        );
    }

    /// Return the full escrow record for the given ID.
    ///
    /// # Arguments
    /// * `escrow_id` — ID returned by `create_escrow`.
    pub fn get_escrow(env: Env, escrow_id: u64) -> AgentEscrow {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found")
    }

    /// Return total platform fees accumulated but not yet withdrawn.
    pub fn get_fees(env: Env) -> i128 {
        env.storage().persistent().get(&DataKey::Fees).unwrap_or(0)
    }

    /// Withdraw accumulated platform fees to the admin address.
    ///
    /// # Arguments
    /// * `admin`  — Must match the admin set during `initialize`.
    /// * `amount` — Amount to withdraw (must not exceed accumulated fees).
    pub fn withdraw_fees(env: Env, admin: Address, amount: i128) {
        admin.require_auth();

        let stored_admin: Address =
            env.storage().persistent().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let fees: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Fees)
            .unwrap_or(0);
        if amount > fees {
            panic!("insufficient accumulated fees");
        }

        let usdc: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .unwrap();

        token::Client::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &admin,
            &amount,
        );

        env.storage().persistent().set(&DataKey::Fees, &(fees - amount));
    }
}
