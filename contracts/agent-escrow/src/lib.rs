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
        let mut result: soroban_sdk::Vec<Address> = soroban_sdk::Vec::new(&env);
        let len = list.len();
        let mut i = start;
        while i < len && (i - start) < cap {
            result.push_back(list.get(i).unwrap());
            i += 1;
        }
        result
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

        // Validate agent is whitelisted
        if !env.storage().persistent()
            .get::<DataKey, bool>(&DataKey::RegisteredAgent(agent.clone()))
            .unwrap_or(false)
        {
            panic!("Agent not registered");
        }

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

        let cancel_window: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::CancelWindow)
            .expect("not initialized");
        let now = env.ledger().timestamp();
        let expires_at = now + cancel_window;

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
            released_amount: 0,
        };
        env.storage().persistent().set(&DataKey::Escrow(id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "AgentEscrow"), Symbol::new(&env, "EscrowCreated")),
            EvtEscrowCreated { escrow_id: id, sender, recipient, agent, amount, expires_at },
        );

        id
    }

    /// Helper to calculate the remaining escrow amount (not yet released).
    ///
    /// Returns: amount - released_amount
    fn remaining(escrow: &AgentEscrow) -> i128 {
        escrow.amount - escrow.released_amount
    }

    /// Agent confirms off-chain fiat delivery, releasing USDC from escrow.
    ///
    /// Transfers `(remaining - fee)` to the agent and accumulates the fee.
    /// A portion of the fee is contributed to the insurance fund.
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

        let remaining_amount = Self::remaining(&escrow);
        let fee_amount = (remaining_amount * escrow.fee_bps as i128) / 10_000;
        let agent_amount = remaining_amount - fee_amount;

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

        // Calculate insurance contribution
        let contribution_bps: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::InsuranceContributionBps)
            .unwrap_or(500);
        let insurance_contribution = (fee_amount * contribution_bps as i128) / 10_000;
        let fee_to_distribute = fee_amount - insurance_contribution;

        // Add to insurance fund
        let insurance_balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::InsuranceFund)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::InsuranceFund, &(insurance_balance + insurance_contribution));

        // Add remaining fee to distributable fees
        let fees: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Fees)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::Fees, &(fees + fee_to_distribute));

        escrow.status = EscrowStatus::Completed;
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "AgentEscrow"), Symbol::new(&env, "EscrowConfirmed")),
            EvtEscrowConfirmed { escrow_id, agent, agent_amount, fee_amount },
        );
    }

    /// Release a portion of the escrowed USDC to the agent.
    ///
    /// The agent delivers cash in installments off-chain and calls this
    /// function for each installment. The contract deducts a pro-rata
    /// platform fee from each release. When the cumulative `released_amount`
    /// equals the original `amount`, the escrow is automatically marked
    /// `Completed`.
    ///
    /// Emits a `PartialPayoutReleased` event on every call.
    ///
    /// # Arguments
    /// * `agent`     — Must match the agent recorded in the escrow.
    /// * `escrow_id` — ID returned by `create_escrow`.
    /// * `amount`    — Gross amount to release in this call (stroops, > 0).
    ///                 Must not exceed `original_amount - released_amount`.
    pub fn partial_confirm_payout(env: Env, agent: Address, escrow_id: u64, amount: i128) {
        if amount <= 0 {
            panic!("amount must be positive");
        }

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
        if env.ledger().timestamp() >= escrow.expires_at {
            panic!("escrow has expired");
        }

        let remaining_gross = escrow.amount - escrow.released_amount;
        if amount > remaining_gross {
            panic!("Release exceeds remaining balance");
        }

        // Pro-rata fee: same fee_bps applied to this partial amount.
        let fee_amount = (amount * escrow.fee_bps as i128) / 10_000;
        let net_to_agent = amount - fee_amount;

        let usdc: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .unwrap();

        token::Client::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &escrow.agent,
            &net_to_agent,
        );

        // Accumulate platform fee.
        let fees: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Fees)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::Fees, &(fees + fee_amount));

        // Update released_amount and auto-complete when fully settled.
        escrow.released_amount += amount;
        if escrow.released_amount == escrow.amount {
            escrow.status = EscrowStatus::Completed;
        }

        let remaining_after = escrow.amount - escrow.released_amount;
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "PartialPayoutReleased"),),
            EvtPartialPayoutReleased {
                escrow_id,
                agent: escrow.agent,
                released_amount: net_to_agent,
                remaining_amount: remaining_after,
                fee_amount,
            },
        );
    }

    /// Cancel a pending escrow and refund the sender.
    ///
    /// Only the original sender may cancel, and only after the 48-hour
    /// cancellation window has elapsed without agent confirmation.
    /// Refunds the remaining balance (accounting for any prior partial releases).
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

        let remaining_amount = Self::remaining(&escrow);

        let usdc: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .unwrap();

        token::Client::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &escrow.sender,
            &remaining_amount,
        );

        escrow.status = EscrowStatus::Cancelled;
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "AgentEscrow"), Symbol::new(&env, "EscrowCancelled")),
            EvtEscrowCancelled { escrow_id, sender: escrow.sender.clone(), refund_amount: remaining_amount },
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

        if amount <= 0 {
            panic!("withdrawal amount must be greater than zero");
        }

        let fees: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Fees)
            .unwrap_or(0);
        if amount > fees {
            panic!("withdrawal amount exceeds accumulated fees");
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

    /// Update the admin address. Only the current admin may call this.
    ///
    /// # Arguments
    /// * `new_admin` — Address that will become the new admin.
    pub fn update_admin(env: Env, new_admin: Address) {
        let stored_admin: Address =
            env.storage().persistent().get(&DataKey::Admin).unwrap();
        if new_admin == stored_admin {
            panic!("new admin must differ from current admin");
        }
        env.storage().persistent().set(&DataKey::Admin, &new_admin);
    }

    /// Admin override to release or refund a pending escrow before timeout.
    ///
    /// If `to_agent` is true, transfers the remaining amount (minus platform fee) to the agent.
    /// If `to_agent` is false, refunds the remaining amount to the sender.
    /// Accounts for any prior partial releases.
    ///
    /// The `reason` parameter must be one of the accepted reason codes:
    /// - "DisputeResolved": Dispute between sender and agent has been resolved in favor of the receiver
    /// - "AgentUnresponsive": Agent failed to respond or deliver within expected timeframe
    /// - "FraudConfirmed": Agent fraud or non-delivery has been confirmed
    /// - "SenderRequest": Sender requested early release or refund
    /// - "SystemError": Contract or system error necessitated manual intervention
    ///
    /// # Arguments
    /// * `escrow_id` — ID of the escrow to override.
    /// * `to_agent`  — true to release to agent, false to refund sender.
    /// * `reason`    — Symbol code documenting why the override occurred.
    pub fn admin_release(env: Env, escrow_id: u64, to_agent: bool, reason: Symbol) {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .unwrap();
        admin.require_auth();

        let mut escrow: AgentEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");

        if escrow.status != EscrowStatus::Pending {
            panic!("escrow is not pending");
        }

        let remaining_amount = Self::remaining(&escrow);
        let fee_amount = (remaining_amount * escrow.fee_bps as i128) / 10_000;
        let net_amount = remaining_amount - fee_amount;

        let usdc: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .unwrap();

        if to_agent {
            token::Client::new(&env, &usdc).transfer(
                &env.current_contract_address(),
                &escrow.agent,
                &net_amount,
            );
            escrow.status = EscrowStatus::Completed;

            let fees: i128 = env
                .storage()
                .persistent()
                .get(&DataKey::Fees)
                .unwrap_or(0);
            env.storage()
                .persistent()
                .set(&DataKey::Fees, &(fees + fee_amount));

            env.events().publish(
                (Symbol::new(&env, "AgentEscrow"), Symbol::new(&env, "EscrowConfirmed")),
                EvtEscrowConfirmed {
                    escrow_id,
                    agent: escrow.agent.clone(),
                    agent_amount: net_amount,
                    fee_amount,
                },
            );
        } else {
            token::Client::new(&env, &usdc).transfer(
                &env.current_contract_address(),
                &escrow.sender,
                &remaining_amount,
            );
            escrow.status = EscrowStatus::Cancelled;

            env.events().publish(
                (Symbol::new(&env, "AgentEscrow"), Symbol::new(&env, "EscrowCancelled")),
                EvtEscrowCancelled {
                    escrow_id,
                    sender: escrow.sender.clone(),
                    refund_amount: remaining_amount,
                },
            );
        }

        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "AgentEscrow"), Symbol::new(&env, "AdminOverride")),
            AdminOverride {
                escrow_id,
                admin,
                to_agent,
                amount: remaining_amount,
                amount: escrow.amount,
                reason,
            },
        );
    }

    /// Return the current insurance fund balance.
    pub fn get_insurance_balance(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::InsuranceFund)
            .unwrap_or(0)
    }

    /// Admin-only function to payout from the insurance fund to the defrauded sender.
    ///
    /// The referenced escrow **must** be in `Cancelled` status — i.e. the agent
    /// failed to deliver and the sender was already refunded via `cancel_escrow`,
    /// or the admin force-cancelled via `admin_release`. Using a `Pending` or
    /// `Completed` escrow as the `escrow_id` argument is rejected to prevent an
    /// admin fat-finger (or a compromised key) from draining the fund against an
    /// unrelated, healthy escrow.
    ///
    /// The payout goes to `escrow.sender` — the party who was defrauded — rather
    /// than an arbitrary caller-supplied recipient address.
    ///
    /// # Arguments
    /// * `escrow_id` — ID of a `Cancelled` escrow that was fraudulent.
    pub fn insurance_payout(env: Env, escrow_id: u64) {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .unwrap();
        admin.require_auth();

        let escrow: AgentEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");

        // SC-013: only allow payout against a Cancelled escrow — a state that
        // indicates actual agent non-performance or fraud.  Pending/Completed
        // escrows have no basis for an insurance claim.
        if escrow.status != EscrowStatus::Cancelled {
            panic!("insurance_payout: escrow must be in Cancelled status");
        }

        let insurance_balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::InsuranceFund)
            .unwrap_or(0);

        // Pay up to the original escrow amount or available balance
        let payout_amount = if escrow.amount <= insurance_balance {
            escrow.amount
        } else {
            insurance_balance
        };

        if payout_amount == 0 {
            panic!("insufficient insurance fund balance");
        }

        let usdc: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .unwrap();

        // SC-013: recipient is locked to the escrow's original sender — the
        // defrauded party — not an arbitrary caller-supplied address.
        let recipient = escrow.sender.clone();

        token::Client::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &recipient,
            &payout_amount,
        );

        env.storage()
            .persistent()
            .set(&DataKey::InsuranceFund, &(insurance_balance - payout_amount));

        env.events().publish(
            (Symbol::new(&env, "InsurancePayout"),),
            InsurancePayout {
                escrow_id,
                recipient,
                amount: payout_amount,
            },
        );
    }

    /// Update the insurance contribution rate. Admin-only.
    ///
    /// # Arguments
    /// * `new_bps` — New contribution rate in basis points (max 1000 = 10%).
    pub fn set_insurance_contribution_bps(env: Env, new_bps: u32) {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .unwrap();
        admin.require_auth();

        if new_bps > 1000 {
            panic!("contribution rate cannot exceed 1000 bps (10%)");
        }

        env.storage()
            .persistent()
            .set(&DataKey::InsuranceContributionBps, &new_bps);
    }
}
