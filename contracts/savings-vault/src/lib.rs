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
pub struct AccrueInterestEvent {
    pub user: Address,
    pub interest: i128,
    pub new_balance: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct YieldDistributed {
    pub total_amount: i128,
    pub distributor: Address,
    pub recipient_count: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct YieldClaimed {
    pub user: Address,
    pub amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct InterestRateUpdatedEvent {
    pub admin: Address,
    pub old_rate: u32,
    pub new_rate: u32,
    pub timestamp: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct InterestReserveFundedEvent {
    pub distributor: Address,
    pub amount: i128,
    pub new_reserve: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct InsufficientReserveEvent {
    pub user: Address,
    pub requested: i128,
    pub paid: i128,
    pub reserve_remaining: i128,
    pub timestamp: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct EmergencyAnnouncedEvent {
    pub admin: Address,
    pub timestamp: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct EmergencyCancelledEvent {
    pub admin: Address,
    pub timestamp: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct EmergencyWithdrawnEvent {
    pub admin: Address,
    pub user: Address,
    pub amount: i128,
    pub timestamp: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct LockBoundsUpdated {
    pub old_min: u64,
    pub old_max: u64,
    pub new_min: u64,
    pub new_max: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct Vault {
    pub balance: i128,
    pub unlock_time: u64,
    pub last_accrue_time: u64,
    pub accrued_interest: i128,
}

#[contracttype]
pub enum DataKey {
    Admin,
    TokenAddress,
    InterestRateBps,
    PenaltyBps,
    Vault(Address),
    TotalLocked,
    YieldAccrued(Address),
    YieldDistributor,
    FeeDistributor,
    InterestReserve,
    EmergencyWithdrawalAnnounced,
    EmergencyActivated,
    EmergencyActivatedAt,
    MinLockSecs,
    MaxLockSecs,
}

const SECONDS_PER_YEAR: u64 = 31_536_000;
const MAX_INTEREST_BPS: u32 = 2_000;
/// Maximum deposit amount to prevent arithmetic overflow in interest and penalty math.
pub const MAX_DEPOSIT_AMOUNT: i128 = 100_000_000_000_000_000_000; // 100B tokens (7 decimals)

#[contract]
pub struct SavingsVaultContract;

#[contractimpl]
impl SavingsVaultContract {
    pub fn initialize(env: Env, admin: Address, token_address: Address, penalty_bps: u32) {
        if env.storage().persistent().has(&DataKey::TokenAddress) {
            panic!("Contract already initialized");
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::TokenAddress, &token_address);
        env.storage().persistent().set(&DataKey::PenaltyBps, &penalty_bps);
        env.storage().persistent().set(&DataKey::TotalLocked, &0i128);
        env.storage().persistent().set(&DataKey::InterestReserve, &0i128);
        env.storage().persistent().set(&DataKey::InterestRateBps, &0u32);
        env.storage().persistent().set(&DataKey::MinLockSecs, &86400u64);
        env.storage().persistent().set(&DataKey::MaxLockSecs, &31536000u64);
    }

    /// Set the annual interest rate. Only admin may call this.
    pub fn set_interest_rate(env: Env, admin: Address, rate_bps: u32) {
        Self::update_interest_rate(env, admin, rate_bps);
    }

    /// Update the annual interest rate. Only admin may call this.
    /// Capped at 2000 bps (20% APY).
    pub fn update_interest_rate(env: Env, admin: Address, rate_bps: u32) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        if rate_bps > MAX_INTEREST_BPS {
            panic!("interest rate cannot exceed 2000 bps");
        }
        let old_rate: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::InterestRateBps)
            .unwrap_or(0u32);
        env.storage().persistent().set(&DataKey::InterestRateBps, &rate_bps);
        env.events().publish(
            (Symbol::new(&env, "InterestRateUpdated"),),
            InterestRateUpdatedEvent {
                admin,
                old_rate,
                new_rate: rate_bps,
                timestamp: env.ledger().timestamp(),
            },
        );
    }

    /// Set the authorized fee distributor address. Only admin may call this.
    pub fn set_yield_distributor(env: Env, admin: Address, distributor: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        env.storage().persistent().set(&DataKey::YieldDistributor, &distributor);
    }

    /// Set the authorized fee distributor address. Only admin may call this.
    pub fn set_fee_distributor(env: Env, admin: Address, distributor: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        env.storage().persistent().set(&DataKey::FeeDistributor, &distributor);
    }

    /// Fund the interest reserve from the authorized fee distributor.
    pub fn fund_interest_reserve(env: Env, distributor: Address, amount: i128) {
        distributor.require_auth();
        let stored_distributor: Address = env
            .storage()
            .persistent()
            .get(&DataKey::FeeDistributor)
            .expect("fee distributor not set");
        if distributor != stored_distributor {
            panic!("unauthorized: caller is not fee distributor");
        }
        if amount <= 0 {
            panic!("amount must be positive");
        }

        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenAddress)
            .expect("Contract not initialized");

        token::Client::new(&env, &token_address).transfer(
            &distributor,
            &env.current_contract_address(),
            &amount,
        );

        let reserve: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::InterestReserve)
            .unwrap_or(0);
        let new_reserve = reserve.checked_add(amount).expect("interest reserve overflow");
        env.storage()
            .persistent()
            .set(&DataKey::InterestReserve, &new_reserve);

        env.events().publish(
            (Symbol::new(&env, "InterestReserveFunded"),),
            InterestReserveFundedEvent {
                distributor,
                amount,
                new_reserve,
            },
        );
    }

    fn get_interest_reserve(env: &Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::InterestReserve)
            .unwrap_or(0)
    }

    fn accrue_interest_internal(env: &Env, vault: &mut Vault, require_rate: bool) -> i128 {
        let rate_bps: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::InterestRateBps)
            .unwrap_or(0);
        let now = env.ledger().timestamp();
        if rate_bps == 0 {
            if require_rate {
                panic!("interest rate not set");
            }
            vault.last_accrue_time = now;
            return 0;
        }
        let elapsed = now.saturating_sub(vault.last_accrue_time);
        if elapsed == 0 || vault.balance <= 0 {
            vault.last_accrue_time = now;
            return 0;
        }
        let numerator = vault
            .balance
            .checked_mul(rate_bps as i128)
            .and_then(|v| v.checked_mul(elapsed as i128))
            .expect("interest calculation overflow");
        let denominator = (10_000i128)
            .checked_mul(SECONDS_PER_YEAR as i128)
            .expect("denominator overflow");
        let interest = numerator
            .checked_div(denominator)
            .expect("interest calculation division error");
        if interest <= 0 {
            vault.last_accrue_time = now;
            return 0;
        }
        vault.accrued_interest = vault
            .accrued_interest
            .checked_add(interest)
            .expect("accrued interest overflow");
        vault.last_accrue_time = now;
        interest
    }

    fn settle_interest_payment(
        env: &Env,
        user: &Address,
        vault: &mut Vault,
        withdraw_amount: i128,
    ) {
        if vault.accrued_interest <= 0 || withdraw_amount <= 0 || vault.balance <= 0 {
            return;
        }
        let interest_due = vault
            .accrued_interest
            .checked_mul(withdraw_amount)
            .and_then(|v| v.checked_div(vault.balance))
            .expect("interest due overflow");
        if interest_due <= 0 {
            return;
        }
        let reserve: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::InterestReserve)
            .unwrap_or(0);
        let paid = if reserve >= interest_due {
            interest_due
        } else {
            reserve
        };
        if paid > 0 {
            let token_address: Address = env
                .storage()
                .persistent()
                .get(&DataKey::TokenAddress)
                .expect("Contract not initialized");
            token::Client::new(&env, &token_address).transfer(
                &env.current_contract_address(),
                user,
                &paid,
            );
            let rem_reserve = reserve.checked_sub(paid).expect("reserve underflow");
            env.storage()
                .persistent()
                .set(&DataKey::InterestReserve, &rem_reserve);
            vault.accrued_interest = vault
                .accrued_interest
                .checked_sub(paid)
                .expect("accrued interest underflow");
        }
        if paid < interest_due {
            let timestamp = env.ledger().timestamp();
            let rem_reserve = reserve.checked_sub(paid).expect("reserve underflow");
            env.events().publish(
                (Symbol::new(&env, "InsufficientReserve"),),
                InsufficientReserveEvent {
                    user: user.clone(),
                    requested: interest_due,
                    paid,
                    reserve_remaining: rem_reserve,
                    timestamp,
                },
            );
        }
    }

    /// Announce an emergency withdrawal. Must be called by admin.
    /// This creates a 48-hour delay before emergency withdrawals may execute.
    pub fn announce_emergency(env: Env, admin: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let existing: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::EmergencyWithdrawalAnnounced)
            .unwrap_or(0u64);
        if existing != 0 {
            panic!("emergency already announced");
        }

        let now = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::EmergencyWithdrawalAnnounced, &now);
        env.events().publish(
            (Symbol::new(&env, "EmergencyAnnounced"),),
            EmergencyAnnouncedEvent { admin, timestamp: now },
        );
    }

    /// Execute an emergency withdrawal for a user after the 48-hour delay.
    /// Transitions: EmergencyAnnounced (t >= 48h) -> Closed Vault (removes vault).
    pub fn emergency_withdraw(env: Env, admin: Address, user: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let announced_at: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::EmergencyWithdrawalAnnounced)
            .unwrap_or(0u64);
        if announced_at == 0 {
            panic!("no emergency announced");
        }

        let now = env.ledger().timestamp();
        if now < announced_at.saturating_add(172_800) {
            panic!("emergency withdrawal not yet allowed");
        }

        let vault_key = DataKey::Vault(user.clone());
        let vault: Vault = env.storage().persistent().get(&vault_key).expect("No vault found for user");
        if vault.balance <= 0 {
            panic!("No balance to withdraw");
        }

        let amount = vault.balance;
        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenAddress)
            .expect("Contract not initialized");

        token::Client::new(&env, &token_address).transfer(
            &env.current_contract_address(),
            &user,
            &amount,
        );

        env.storage().persistent().remove(&vault_key);

        let total_locked: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);
        let new_total = total_locked.checked_sub(amount).expect("total locked underflow");
        env.storage()
            .persistent()
            .set(&DataKey::TotalLocked, &new_total);

        env.events().publish(
            (Symbol::new(&env, "EmergencyWithdrawn"),),
            EmergencyWithdrawnEvent {
                admin,
                user,
                amount,
                timestamp: now,
            },
        );
    }

    /// Cancel a pending emergency withdrawal announcement before the 48-hour delay expires.
    /// Transitions: EmergencyAnnounced (t < 48h) -> Normal.
    pub fn cancel_emergency(env: Env, admin: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let announced_at: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::EmergencyWithdrawalAnnounced)
            .unwrap_or(0u64);
        if announced_at == 0 {
            panic!("no emergency announced");
        }

        let now = env.ledger().timestamp();
        if now >= announced_at.saturating_add(172_800) {
            panic!("cannot cancel after emergency delay has elapsed");
        }

        env.storage()
            .persistent()
            .set(&DataKey::EmergencyWithdrawalAnnounced, &0u64);
        env.events().publish(
            (Symbol::new(&env, "EmergencyCancelled"),),
            EmergencyCancelledEvent { admin, timestamp: now },
        );
    }

    /// Activate emergency mode. Admin-only. Sets EmergencyActivated = true and records timestamp.
    /// Transitions: Normal -> EmergencyActive.
    /// Emits EmergencyActivated event. Normal deposit/withdraw remain unblocked.
    pub fn activate_emergency(env: Env, admin: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        if env.storage().persistent().get(&DataKey::EmergencyActivated).unwrap_or(false) {
            panic!("emergency already active");
        }
        let now = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::EmergencyActivated, &true);
        env.storage().persistent().set(&DataKey::EmergencyActivatedAt, &now);
        env.events().publish(
            (Symbol::new(&env, "EmergencyActivated"),),
            EmergencyAnnouncedEvent { admin, timestamp: now },
        );
    }

    /// Deactivate emergency before the 48-hour window expires. Admin-only.
    /// Transitions: EmergencyActive (t < 48h) -> Normal.
    pub fn deactivate_emergency(env: Env, admin: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        if !env.storage().persistent().get(&DataKey::EmergencyActivated).unwrap_or(false) {
            panic!("no emergency active");
        }
        env.storage().persistent().set(&DataKey::EmergencyActivated, &false);
        env.storage().persistent().set(&DataKey::EmergencyActivatedAt, &0u64);
        let now = env.ledger().timestamp();
        env.events().publish(
            (Symbol::new(&env, "EmergencyCancelled"),),
            EmergencyCancelledEvent { admin, timestamp: now },
        );
    }

    /// Return full vault balance to user. Admin-only, callable only after 48h from activation.
    /// Transitions: EmergencyActive (t >= 48h) -> Closed Vault (removes vault).
    /// Normal deposit/withdraw are NOT blocked. Emits EmergencyFundsReturned event.
    pub fn emergency_return_funds(env: Env, admin: Address, user: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        if !env.storage().persistent().get(&DataKey::EmergencyActivated).unwrap_or(false) {
            panic!("no emergency active");
        }
        let activated_at: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::EmergencyActivatedAt)
            .unwrap_or(0);
        let now = env.ledger().timestamp();
        if now < activated_at.saturating_add(172_800) {
            panic!("emergency return not yet allowed: 48h not elapsed");
        }
        let vault_key = DataKey::Vault(user.clone());
        let vault: Vault = env.storage().persistent().get(&vault_key).expect("No vault found for user");
        if vault.balance <= 0 {
            panic!("No balance to return");
        }
        let amount = vault.balance;
        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenAddress)
            .expect("Contract not initialized");
        token::Client::new(&env, &token_address).transfer(
            &env.current_contract_address(),
            &user,
            &amount,
        );
        env.storage().persistent().remove(&vault_key);
        let total_locked: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);
        let new_total = total_locked.checked_sub(amount).expect("total locked underflow");
        env.storage().persistent().set(&DataKey::TotalLocked, &new_total);
        env.events().publish(
            (Symbol::new(&env, "EmergencyFundsReturned"),),
            EmergencyWithdrawnEvent { admin, user, amount, timestamp: now },
        );
    }

    /// Accrue interest for a single depositor.
    ///
    /// Calculates interest = balance * rate_bps * elapsed_seconds / (10000 * seconds_per_year)
    /// and credits it to the vault's internal balance. The contract must hold sufficient
    /// USDC to cover the increased balance when the user later withdraws.
    pub fn accrue_interest(env: Env, user: Address) {
        user.require_auth();
        let mut vault: Vault = env
            .storage()
            .persistent()
            .get(&DataKey::Vault(user.clone()))
            .expect("No vault found for user");

        let interest = Self::accrue_interest_internal(&env, &mut vault, true);
        env.storage()
            .persistent()
            .set(&DataKey::Vault(user.clone()), &vault);

        if interest > 0 {
            env.events().publish(
                (Symbol::new(&env, "AccrueInterest"),),
                AccrueInterestEvent {
                    user,
                    interest,
                    new_balance: vault.balance,
                },
            );
        }
    }

    pub fn get_interest_rate(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::InterestRateBps)
            .unwrap_or(0u32)
    }

    /// Deposit tokens into the vault. Accumulates on top of any existing balance.
    /// Extends the unlock time only if the new unlock_time is later than the current one.
    pub fn deposit(env: Env, user: Address, amount: i128, unlock_time: u64) {
        user.require_auth();
        if amount <= 0 {
            panic!("Amount must be positive");
        }
        if amount > MAX_DEPOSIT_AMOUNT {
            panic!("Amount exceeds maximum deposit bound");
        }
        if unlock_time <= env.ledger().timestamp() {
            panic!("Unlock time must be in the future");
        }

        let min_lock_secs: u64 = env.storage().persistent().get(&DataKey::MinLockSecs).unwrap_or(86400);
        let max_lock_secs: u64 = env.storage().persistent().get(&DataKey::MaxLockSecs).unwrap_or(31536000);
        let now = env.ledger().timestamp();
        let min_unlock = now + min_lock_secs;
        let max_unlock = now + max_lock_secs;

        if unlock_time < min_unlock || unlock_time > max_unlock {
            panic!("Lock period out of allowed range (min {}s, max {}s)", min_lock_secs, max_lock_secs);
        }

        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenAddress)
            .expect("Contract not initialized");

        token::Client::new(&env, &token_address).transfer_from(
            &env.current_contract_address(),
            &user,
            &env.current_contract_address(),
            &amount,
        );

        let now = env.ledger().timestamp();
        let mut vault = env
            .storage()
            .persistent()
            .get(&DataKey::Vault(user.clone()))
            .unwrap_or(Vault {
                balance: 0,
                unlock_time: 0,
                last_accrue_time: now,
                accrued_interest: 0,
            });

        vault.balance = vault.balance.checked_add(amount).expect("vault balance overflow");
        if vault.balance > MAX_DEPOSIT_AMOUNT {
            panic!("Vault balance exceeds maximum bound");
        }
        if unlock_time > vault.unlock_time {
            vault.unlock_time = unlock_time;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Vault(user.clone()), &vault);

        // Update total locked
        let total_locked: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);
        let new_total = total_locked.checked_add(amount).expect("total locked overflow");
        env.storage()
            .persistent()
            .set(&DataKey::TotalLocked, &new_total);

        env.events().publish(
            (Symbol::new(&env, "Deposit"),),
            DepositEvent {
                user,
                amount,
                unlock_time: vault.unlock_time,
            },
        );
    }

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

        let penalty_bps: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::PenaltyBps)
            .unwrap_or(1000);

        let now = env.ledger().timestamp();
        let penalty = if now < vault.unlock_time {
            amount
                .checked_mul(penalty_bps as i128)
                .and_then(|v| v.checked_div(10000))
                .expect("penalty calculation overflow")
        } else {
            0
        };

        let withdraw_amount = amount
            .checked_sub(penalty)
            .expect("withdrawal amount calculation underflow");

        Self::accrue_interest_internal(&env, &mut vault, false);
        Self::settle_interest_payment(&env, &user, &mut vault, amount);

        token::Client::new(&env, &token_address).transfer(
            &env.current_contract_address(),
            &user,
            &withdraw_amount,
        );

        vault.balance = vault
            .balance
            .checked_sub(amount)
            .expect("vault balance underflow");
        env.storage()
            .persistent()
            .set(&DataKey::Vault(user.clone()), &vault);

        // Update total locked
        let total_locked: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);
        let new_total = total_locked
            .checked_sub(amount)
            .expect("total locked underflow");
        env.storage()
            .persistent()
            .set(&DataKey::TotalLocked, &new_total);

        env.events().publish(
            (Symbol::new(&env, "Withdrawal"),),
            WithdrawalEvent {
                user,
                amount: withdraw_amount,
                penalty,
            },
        );
    }

    pub fn get_balance(env: Env, user: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Vault(user))
            .map(|v: Vault| v.balance)
            .unwrap_or(0)
    }

    pub fn get_unlock_time(env: Env, user: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::Vault(user))
            .map(|v: Vault| v.unlock_time)
            .unwrap_or(0)
    }

    /// Returns the full vault state for a user, or a zero-valued Vault if none exists.
    pub fn get_vault(env: Env, user: Address) -> Vault {
        env.storage()
            .persistent()
            .get(&DataKey::Vault(user))
            .unwrap_or(Vault {
                balance: 0,
                unlock_time: 0,
                last_accrue_time: 0,
                accrued_interest: 0,
            })
    }

    /// Distribute yield from platform fees proportionally to all vault holders.
    /// Only the authorized distributor (typically fee-distributor contract) may call this.
    /// If total locked is zero, the amount is transferred to the admin as fallback.
    pub fn distribute_yield(env: Env, distributor: Address, amount: i128) {
        distributor.require_auth();

        if amount <= 0 {
            panic!("Amount must be positive");
        }

        let stored_distributor: Address = env
            .storage()
            .persistent()
            .get(&DataKey::YieldDistributor)
            .expect("Yield distributor not set");
        if distributor != stored_distributor {
            panic!("unauthorized: caller is not yield distributor");
        }

        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenAddress)
            .expect("Contract not initialized");

        token::Client::new(&env, &token_address).transfer_from(
            &env.current_contract_address(),
            &distributor,
            &env.current_contract_address(),
            &amount,
        );

        let total_locked: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);

        if total_locked == 0 {
            // No active vaults, transfer to admin
            let admin: Address = env
                .storage()
                .persistent()
                .get(&DataKey::Admin)
                .expect("Contract not initialized");
            token::Client::new(&env, &token_address).transfer(
                &env.current_contract_address(),
                &admin,
                &amount,
            );
        }

        env.events().publish(
            (Symbol::new(&env, "YieldDistributed"),),
            YieldDistributed {
                total_amount: amount,
                distributor,
                recipient_count: 0, // Proportional distribution happens on-claim
            },
        );
    }

    /// Claim accrued yield for the caller. Yield can be claimed without unlocking principal.
    pub fn claim_yield(env: Env, user: Address) {
        user.require_auth();

        let yield_amount: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::YieldAccrued(user.clone()))
            .unwrap_or(0);

        if yield_amount <= 0 {
            panic!("No yield to claim");
        }

        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenAddress)
            .expect("Contract not initialized");

        token::Client::new(&env, &token_address).transfer(
            &env.current_contract_address(),
            &user,
            &yield_amount,
        );

        env.storage()
            .persistent()
            .set(&DataKey::YieldAccrued(user.clone()), &0i128);

        env.events().publish(
            (Symbol::new(&env, "YieldClaimed"),),
            YieldClaimed {
                user,
                amount: yield_amount,
            },
        );
    }

    /// Get the total amount locked across all vaults.
    pub fn get_total_locked(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0)
    }

    /// Get the accrued yield for a user.
    pub fn get_yield_accrued(env: Env, user: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::YieldAccrued(user))
            .unwrap_or(0)
    }

    /// Update the minimum and maximum lock period bounds. Admin only.
    pub fn update_lock_bounds(env: Env, admin: Address, min_secs: u64, max_secs: u64) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        if min_secs >= max_secs {
            panic!("min_secs must be less than max_secs");
        }

        let old_min: u64 = env.storage().persistent().get(&DataKey::MinLockSecs).unwrap_or(86400);
        let old_max: u64 = env.storage().persistent().get(&DataKey::MaxLockSecs).unwrap_or(31536000);

        env.storage().persistent().set(&DataKey::MinLockSecs, &min_secs);
        env.storage().persistent().set(&DataKey::MaxLockSecs, &max_secs);

        env.events().publish(
            (Symbol::new(&env, "LockBoundsUpdated"),),
            LockBoundsUpdated {
                old_min,
                old_max,
                new_min: min_secs,
                new_max: max_secs,
            },
        );
    }
}
