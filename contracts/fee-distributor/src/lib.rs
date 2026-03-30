#![no_std]

//! # Fee Distributor Contract
//!
//! On-chain platform fee accumulation and withdrawal for AfriPay.
//! Makes the fee model fully transparent and auditable on Stellar.
//!
//! ## Access control
//! - `deposit_fee`          — any caller (typically the backend service account)
//! - `get_accumulated_fees` — public
//! - `withdraw_fees`        — admin only

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol};

mod test;

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    UsdcAddress,
    AccumulatedFees,
}

// ── Event payloads ────────────────────────────────────────────────────────────

#[derive(Clone)]
#[contracttype]
pub struct EvtFeeDeposited {
    pub depositor: Address,
    pub amount: i128,
    pub total: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct EvtFeesWithdrawn {
    pub admin: Address,
    pub amount: i128,
    pub remaining: i128,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct FeeDistributorContract;

#[contractimpl]
impl FeeDistributorContract {
    /// Initialise the contract. Must be called once.
    ///
    /// # Arguments
    /// * `admin`        — Address authorised to withdraw accumulated fees.
    /// * `usdc_address` — Stellar asset contract address for USDC.
    pub fn initialize(env: Env, admin: Address, usdc_address: Address) {
        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::UsdcAddress, &usdc_address);
        env.storage().persistent().set(&DataKey::AccumulatedFees, &0i128);
    }

    /// Deposit a platform fee into the contract.
    ///
    /// Transfers `amount` USDC from `depositor` into the contract and
    /// increments the accumulated fee counter. Emits a `FeeDeposited` event.
    ///
    /// # Arguments
    /// * `depositor` — Address sending the fee (must authorise this call).
    /// * `amount`    — Fee amount in USDC stroops (must be > 0).
    pub fn deposit_fee(env: Env, depositor: Address, amount: i128) {
        if amount <= 0 {
            panic!("amount must be positive");
        }

        depositor.require_auth();

        let usdc: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("not initialized");

        token::Client::new(&env, &usdc).transfer(
            &depositor,
            &env.current_contract_address(),
            &amount,
        );

        let total: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0)
            + amount;

        env.storage()
            .persistent()
            .set(&DataKey::AccumulatedFees, &total);

        env.events().publish(
            (Symbol::new(&env, "FeeDeposited"),),
            EvtFeeDeposited { depositor, amount, total },
        );
    }

    /// Return the total USDC fees accumulated in the contract.
    pub fn get_accumulated_fees(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0)
    }

    /// Withdraw accumulated fees to the admin address.
    ///
    /// Only the admin may call this. Emits a `FeesWithdrawn` event.
    ///
    /// # Arguments
    /// * `admin`  — Must match the admin set during `initialize`.
    /// * `amount` — Amount to withdraw (must not exceed accumulated fees).
    pub fn withdraw_fees(env: Env, admin: Address, amount: i128) {
        if amount <= 0 {
            panic!("amount must be positive");
        }

        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let accumulated: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0);
        if amount > accumulated {
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

        let remaining = accumulated - amount;
        env.storage()
            .persistent()
            .set(&DataKey::AccumulatedFees, &remaining);

        env.events().publish(
            (Symbol::new(&env, "FeesWithdrawn"),),
            EvtFeesWithdrawn { admin, amount, remaining },
        );
    }
}
