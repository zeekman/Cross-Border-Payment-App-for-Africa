#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol};

mod test;

#[derive(Clone)]
#[contracttype]
pub struct DepositEvent {
    pub user: Address,
    pub amount: i128,
    pub unlock_time: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct WithdrawalEvent {
    pub user: Address,
    pub amount: i128,
    pub penalty: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct Vault {
    pub balance: i128,
    pub unlock_time: u64,
}

// Storage keys
#[contracttype]
pub enum DataKey {
    TokenAddress,
    Vault(Address),
}

// Penalty percentage for early withdrawal: 10%
const EARLY_WITHDRAWAL_PENALTY_BPS: u32 = 1000; // 10% in basis points

#[contract]
pub struct SavingsVaultContract;

#[contractimpl]
impl SavingsVaultContract {
    /// Initialize the contract with the token address (USDC)
    pub fn initialize(env: Env, token_address: Address) {
        if env.storage().persistent().has(&DataKey::TokenAddress) {
            panic!("Contract already initialized");
        }
        env.storage().persistent().set(&DataKey::TokenAddress, &token_address);
    }

    /// Deposit funds into the vault with a lock period
    /// The unlock_time is the ledger timestamp when funds can be withdrawn without penalty
    pub fn deposit(env: Env, user: Address, amount: i128, unlock_time: u64) {
        user.require_auth();
        if amount <= 0 {
            panic!("Amount must be positive");
        }
        if unlock_time <= env.ledger().timestamp() {
            panic!("Unlock time must be in the future");
        }

        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenAddress)
            .expect("Contract not initialized");

        // Transfer tokens from user to contract
        token::Client::new(&env, &token_address).transfer_from(
            &env.current_contract_address(),
            &user,
            &env.current_contract_address(),
            &amount,
        );

        // Get existing vault or create new one
        let mut vault = env
            .storage()
            .persistent()
            .get(&DataKey::Vault(user.clone()))
            .unwrap_or(Vault {
                balance: 0,
                unlock_time: 0,
            });

        vault.balance += amount;
        // Update unlock_time if this deposit has a later unlock time
        if unlock_time > vault.unlock_time {
            vault.unlock_time = unlock_time;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Vault(user.clone()), &vault);

        env.events().publish(
            (Symbol::new(&env, "Deposit"),),
            DepositEvent {
                user,
                amount,
                unlock_time: vault.unlock_time,
            },
        );
    }

    /// Withdraw funds from the vault
    /// If withdrawing before unlock_time, apply 10% penalty
    pub fn withdraw(env: Env, user: Address, amount: i128) {
        user.require_auth();
        if amount <= 0 {
            panic!("Amount must be positive");
        }

        let mut vault: Vault = env
            .storage()
            .persistent()
            .get(&DataKey::Vault(user.clone()))
            .expect("No vault found for user");

        if vault.balance < amount {
            panic!("Insufficient balance");
        }

        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenAddress)
            .unwrap();

        let now = env.ledger().timestamp();
        let penalty = if now < vault.unlock_time {
            // Early withdrawal: 10% penalty
            (amount * EARLY_WITHDRAWAL_PENALTY_BPS as i128) / 10000
        } else {
            0
        };

        let withdraw_amount = amount - penalty;

        // Transfer tokens back to user
        token::Client::new(&env, &token_address).transfer(
            &env.current_contract_address(),
            &user,
            &withdraw_amount,
        );

        vault.balance -= amount;
        env.storage()
            .persistent()
            .set(&DataKey::Vault(user.clone()), &vault);

        env.events().publish(
            (Symbol::new(&env, "Withdrawal"),),
            WithdrawalEvent {
                user,
                amount: withdraw_amount,
                penalty,
            },
        );
    }

    /// Get the balance and unlock time for a user
    pub fn get_balance(env: Env, user: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Vault(user))
            .map(|v: Vault| v.balance)
            .unwrap_or(0)
    }

    /// Get the unlock time for a user's vault
    pub fn get_unlock_time(env: Env, user: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::Vault(user))
            .map(|v: Vault| v.unlock_time)
            .unwrap_or(0)
    }
}