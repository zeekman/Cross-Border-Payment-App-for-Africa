#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol, Vec};

#[cfg(test)]
mod test;

#[derive(Debug, Clone)]
#[contracttype]
pub struct DepositEvent {
    pub user: Address,
    pub vault_id: u32,
    pub amount: i128,
    pub unlock_time: u64,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct WithdrawalEvent {
    pub user: Address,
    pub vault_id: u32,
    pub amount: i128,
    pub penalty: i128,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct AccrueInterestEvent {
    pub user: Address,
    pub vault_id: u32,
    pub interest: i128,
    pub new_balance: i128,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct YieldDistributed {
    pub total_amount: i128,
    pub distributor: Address,
    pub recipient_count: u32,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct YieldClaimed {
    pub user: Address,
    pub amount: i128,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct InterestRateUpdatedEvent {
    pub admin: Address,
    pub old_rate: u32,
    pub new_rate: u32,
    pub timestamp: u64,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct InterestReserveFundedEvent {
    pub distributor: Address,
    pub amount: i128,
    pub new_reserve: i128,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct InsufficientReserveEvent {
    pub user: Address,
    pub requested: i128,
    pub paid: i128,
    pub reserve_remaining: i128,
    pub timestamp: u64,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EmergencyAnnouncedEvent {
    pub admin: Address,
    pub timestamp: u64,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EmergencyCancelledEvent {
    pub admin: Address,
    pub timestamp: u64,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EmergencyWithdrawnEvent {
    pub admin: Address,
    pub user: Address,
    /// Total paid out: principal + interest + yield.
    pub amount: i128,
    pub principal: i128,
    /// Accrued interest actually paid from the interest reserve.
    pub interest: i128,
    /// Unclaimed distributed yield paid out.
    pub yield_amount: i128,
    pub timestamp: u64,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct LockBoundsUpdated {
    pub old_min: u64,
    pub old_max: u64,
    pub new_min: u64,
    pub new_max: u64,
}

#[derive(Debug, Clone)]
/// One independent savings position. A user may hold several, each with its
/// own unlock time (mirrors the backend's `savings_vaults` rows).
#[derive(Clone)]
#[contracttype]
pub struct Vault {
    pub balance: i128,
    pub unlock_time: u64,
    pub last_accrue_time: u64,
    pub accrued_interest: i128,
}

#[derive(Debug)]
#[contracttype]
pub enum DataKey {
    Admin,
    TokenAddress,
    InterestRateBps,
    PenaltyBps,
    /// (owner, vault_id) -> Vault
    Vault(Address, u32),
    /// owner -> next vault_id to assign
    NextVaultId(Address),
    /// owner -> ids of the owner's open vaults
    UserVaults(Address),
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
    /// Pending admin rotation: (new_admin, eta)
    PendingAdmin,
}

const SECONDS_PER_YEAR: u64 = 31_536_000;
const MAX_INTEREST_BPS: u32 = 2_000;
/// Maximum deposit amount to prevent arithmetic overflow in interest and penalty math.
pub const MAX_DEPOSIT_AMOUNT: i128 = 100_000_000_000_000_000_000; // 100B tokens (7 decimals)

/// TTL policy: instance storage (global config) is bumped to ~30 days and
/// refreshed once it drops below ~7 days. Persistent records (vaults, user
/// vault lists, yield balances) use the same policy.
const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // ~30 days at 5s/ledger
const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960; // ~7 days
const PERSISTENT_BUMP_AMOUNT: u32 = 518_400; // ~30 days
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960; // ~7 days

#[derive(Debug, Clone)]
#[contracttype]
pub struct InitializedEvent {
    pub admin: Address,
    pub token_address: Address,
    pub penalty_bps: u32,
}

#[contract]
pub struct SavingsVaultContract;

#[contractimpl]
impl SavingsVaultContract {
    pub fn initialize(env: Env, admin: Address, token_address: Address, penalty_bps: u32) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::TokenAddress) {
            panic!("Contract already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TokenAddress, &token_address);
        env.storage().instance().set(&DataKey::PenaltyBps, &penalty_bps);
        env.storage().instance().set(&DataKey::TotalLocked, &0i128);
        env.storage().instance().set(&DataKey::InterestReserve, &0i128);
        env.storage().instance().set(&DataKey::InterestRateBps, &0u32);
        env.storage().instance().set(&DataKey::MinLockSecs, &86400u64);
        env.storage().instance().set(&DataKey::MaxLockSecs, &31536000u64);
        Self::bump_instance(&env);
        env.events().publish(
            (Symbol::new(&env, "Initialized"),),
            InitializedEvent {
                admin,
                token_address,
                penalty_bps,
            },
        );
    }

    /// Extend the instance entry's TTL. Called from every public entry point.
    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    /// Extend a persistent entry's TTL after it has been read or written.
    fn bump_persistent(env: &Env, key: &DataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
    }

    /// Propose a new admin. The current admin must authorise this; the
    /// rotation only completes once the new admin accepts after the
    /// governance timelock (see `governance::ADMIN_ROTATION_DELAY_SECS`).
    /// The admin should be a multisig account or the `multisig-approval`
    /// contract so a single lost key cannot lock the vault forever.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) {
        governance::propose_admin(&env, &DataKey::Admin, &DataKey::PendingAdmin, admin, new_admin);
    }

    /// Accept a pending admin rotation. Requires the new admin's signature
    /// and that the governance timelock has elapsed.
    pub fn accept_admin(env: Env, new_admin: Address) {
        governance::accept_admin(&env, &DataKey::Admin, &DataKey::PendingAdmin, new_admin);
    }

    /// Cancel a pending admin rotation. Only the current admin may call this.
    pub fn cancel_admin_proposal(env: Env, admin: Address) {
        governance::cancel_admin_proposal(&env, &DataKey::Admin, &DataKey::PendingAdmin, admin);
    }

    /// Set the annual interest rate. Only admin may call this.
    pub fn set_interest_rate(env: Env, admin: Address, rate_bps: u32) {
        Self::update_interest_rate(env, admin, rate_bps);
    }

    /// Update the annual interest rate. Only admin may call this.
    /// Capped at 2000 bps (20% APY).
    pub fn update_interest_rate(env: Env, admin: Address, rate_bps: u32) {
        Self::bump_instance(&env);
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
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
            .instance()
            .get(&DataKey::InterestRateBps)
            .unwrap_or(0u32);
        env.storage().instance().set(&DataKey::InterestRateBps, &rate_bps);
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
        Self::bump_instance(&env);
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        env.storage().instance().set(&DataKey::YieldDistributor, &distributor);
    }

    /// Set the authorized fee distributor address. Only admin may call this.
    pub fn set_fee_distributor(env: Env, admin: Address, distributor: Address) {
        Self::bump_instance(&env);
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        env.storage().instance().set(&DataKey::FeeDistributor, &distributor);
    }

    /// Fund the interest reserve from the authorized fee distributor.
    pub fn fund_interest_reserve(env: Env, distributor: Address, amount: i128) {
        Self::bump_instance(&env);
        distributor.require_auth();
        let stored_distributor: Address = env
            .storage()
            .instance()
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
            .instance()
            .get(&DataKey::TokenAddress)
            .expect("Contract not initialized");

        token::Client::new(&env, &token_address).transfer(
            &distributor,
            &env.current_contract_address(),
            &amount,
        );

        let reserve: i128 = env
            .storage()
            .instance()
            .get(&DataKey::InterestReserve)
            .unwrap_or(0);
        let new_reserve = reserve.checked_add(amount).expect("interest reserve overflow");
        env.storage()
            .instance()
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

    fn load_vault(env: &Env, user: &Address, vault_id: u32) -> Vault {
        let key = DataKey::Vault(user.clone(), vault_id);
        let vault = env
            .storage()
            .persistent()
            .get(&key)
            .expect("No vault found for user");
        Self::bump_persistent(env, &key);
        vault
    }

    fn save_vault(env: &Env, user: &Address, vault_id: u32, vault: &Vault) {
        let key = DataKey::Vault(user.clone(), vault_id);
        env.storage().persistent().set(&key, vault);
        Self::bump_persistent(env, &key);
    }

    fn user_vault_ids(env: &Env, user: &Address) -> Vec<u32> {
        let key = DataKey::UserVaults(user.clone());
        let ids = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Vec::new(env));
        if env.storage().persistent().has(&key) {
            Self::bump_persistent(env, &key);
        }
        ids
    }
>>>> REPLACE

        if ids.is_empty() {
            env.storage().persistent().remove(&DataKey::UserVaults(user.clone()));
        } else {
            env.storage()
                .persistent()
                .set(&DataKey::UserVaults(user.clone()), &ids);
        }
    }
        if ids.is_empty() {
            env.storage().persistent().remove(&DataKey::UserVaults(user.clone()));
        } else {
            let key = DataKey::UserVaults(user.clone());
            env.storage().persistent().set(&key, &ids);
            Self::bump_persistent(env, &key);
        }
    }

    /// Delete a vault and drop its id from the owner's list.
    fn remove_vault(env: &Env, user: &Address, vault_id: u32) {
        env.storage()
            .persistent()
            .remove(&DataKey::Vault(user.clone(), vault_id));
        let mut ids = Self::user_vault_ids(env, user);
        if let Some(idx) = ids.first_index_of(vault_id) {
            ids.remove(idx);
        }
        if ids.is_empty() {
            env.storage().persistent().remove(&DataKey::UserVaults(user.clone()));
        } else {
            env.storage()
                .persistent()
                .set(&DataKey::UserVaults(user.clone()), &ids);
        }
    }

    /// Panic if an emergency wind-down is pending or active: new funds must
    /// not enter a vault that is about to be force-closed.
    fn assert_accepting_deposits(env: &Env) {
        let announced: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EmergencyWithdrawalAnnounced)
            .unwrap_or(0);
        let active: bool = env
            .storage()
            .instance()
            .get(&DataKey::EmergencyActivated)
            .unwrap_or(false);
        if announced != 0 || active {
            panic!("deposits disabled: emergency in progress");
        }
    }

    /// Emergency wind-down: close every vault `user` holds and pay out
    /// principal, interest accrued up to now (from the interest reserve) and
    /// any unclaimed distributed yield. Returns (principal, interest, yield).
    fn close_all_vaults(env: &Env, user: &Address, empty_msg: &str) -> (i128, i128, i128) {
        let ids = Self::user_vault_ids(env, user);
        if ids.is_empty() {
            panic!("No vault found for user");
        }

        let mut principal: i128 = 0;
        let mut interest_due: i128 = 0;
        for id in ids.iter() {
            let mut vault = Self::load_vault(env, user, id);
            // Bring interest up to date so nothing earned before the
            // wind-down is lost.
            Self::accrue_interest_internal(env, &mut vault, false);
            principal = principal
                .checked_add(vault.balance)
                .expect("vault balance overflow");
            interest_due = interest_due
                .checked_add(vault.accrued_interest)
                .expect("accrued interest overflow");
        }

        let yield_key = DataKey::YieldAccrued(user.clone());
        let yield_amount: i128 = env.storage().persistent().get(&yield_key).unwrap_or(0);
        if env.storage().persistent().has(&yield_key) {
            Self::bump_persistent(env, &yield_key);
        }

        if principal <= 0 && interest_due <= 0 && yield_amount <= 0 {
            panic!("{}", empty_msg);
        }

        // Interest is paid from the reserve, capped at what it holds.
        let reserve = Self::get_interest_reserve(env);
        let interest_paid = if interest_due > reserve { reserve } else { interest_due };
        if interest_paid > 0 {
            let rem_reserve = reserve
                .checked_sub(interest_paid)
                .expect("reserve underflow");
            env.storage()
                .instance()
                .set(&DataKey::InterestReserve, &rem_reserve);
        }
        if interest_paid < interest_due {
            env.events().publish(
                (Symbol::new(env, "InsufficientReserve"),),
                InsufficientReserveEvent {
                    user: user.clone(),
                    requested: interest_due,
                    paid: interest_paid,
                    reserve_remaining: reserve - interest_paid,
                    timestamp: env.ledger().timestamp(),
                },
            );
        }

        let total = principal
            .checked_add(interest_paid)
            .and_then(|v| v.checked_add(yield_amount))
            .expect("payout overflow");
        let token_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenAddress)
            .expect("Contract not initialized");
        token::Client::new(env, &token_address).transfer(
            &env.current_contract_address(),
            user,
            &total,
        );

        for id in ids.iter() {
            env.storage().persistent().remove(&DataKey::Vault(user.clone(), id));
        }
        env.storage().persistent().remove(&DataKey::UserVaults(user.clone()));
        if yield_amount != 0 {
            env.storage().persistent().set(&yield_key, &0i128);
            Self::bump_persistent(env, &yield_key);
        }

        let total_locked: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);
        let new_total = total_locked
            .checked_sub(principal)
            .expect("total locked underflow");
        env.storage()
            .instance()
            .set(&DataKey::TotalLocked, &new_total);
        (principal, interest_paid, yield_amount)
    }

    fn get_interest_reserve(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::InterestReserve)
            .unwrap_or(0)
    }

    fn accrue_interest_internal(env: &Env, vault: &mut Vault, require_rate: bool) -> i128 {
        let rate_bps: u32 = env
            .storage()
            .instance()
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
            .instance()
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
                .instance()
                .get(&DataKey::TokenAddress)
                .expect("Contract not initialized");
            token::Client::new(&env, &token_address).transfer(
                &env.current_contract_address(),
                user,
                &paid,
            );
            let rem_reserve = reserve.checked_sub(paid).expect("reserve underflow");
            env.storage()
                .instance()
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
    /// New deposits are rejected from this point until cancelled.
    pub fn announce_emergency(env: Env, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let existing: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EmergencyWithdrawalAnnounced)
            .unwrap_or(0u64);
        if existing != 0 {
            panic!("emergency already announced");
        }

        let now = env.ledger().timestamp();
        env.storage()
            .instance()
            .set(&DataKey::EmergencyWithdrawalAnnounced, &now);
        env.events().publish(
            (Symbol::new(&env, "EmergencyAnnounced"),),
            EmergencyAnnouncedEvent { admin, timestamp: now },
        );
    }

    /// Execute an emergency withdrawal for a user after the 48-hour delay.
    /// Pays principal + accrued interest (from the reserve) + unclaimed yield.
    /// Transitions: EmergencyAnnounced (t >= 48h) -> Closed Vault (removes vault).
    pub fn emergency_withdraw(env: Env, admin: Address, user: Address) {
        Self::bump_instance(&env);
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let announced_at: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EmergencyWithdrawalAnnounced)
            .unwrap_or(0u64);
        if announced_at == 0 {
            panic!("no emergency announced");
        }

        let now = env.ledger().timestamp();
        if now < announced_at.saturating_add(172_800) {
            panic!("emergency withdrawal not yet allowed");
        }

        let (principal, interest, yield_amount) =
            Self::close_all_vaults(&env, &user, "No balance to withdraw");

        env.events().publish(
            (Symbol::new(&env, "EmergencyWithdrawn"),),
            EmergencyWithdrawnEvent {
                admin,
                user,
                amount: principal + interest + yield_amount,
                principal,
                interest,
                yield_amount,
                timestamp: now,
            },
        );
    }

    /// Cancel a pending emergency withdrawal announcement before the 48-hour delay expires.
    /// Transitions: EmergencyAnnounced (t < 48h) -> Normal.
    pub fn cancel_emergency(env: Env, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let announced_at: u64 = env
            .storage()
            .instance()
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
            .instance()
            .set(&DataKey::EmergencyWithdrawalAnnounced, &0u64);
        env.events().publish(
            (Symbol::new(&env, "EmergencyCancelled"),),
            EmergencyCancelledEvent { admin, timestamp: now },
        );
    }

    /// Activate emergency mode. Admin-only. Sets EmergencyActivated = true and records timestamp.
    /// Transitions: Normal -> EmergencyActive.
    /// Emits EmergencyActivated event. New deposits are rejected until
    /// deactivated; normal withdrawals remain unblocked.
    pub fn activate_emergency(env: Env, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        if env.storage().instance().get(&DataKey::EmergencyActivated).unwrap_or(false) {
            panic!("emergency already active");
        }
        let now = env.ledger().timestamp();
        env.storage().instance().set(&DataKey::EmergencyActivated, &true);
        env.storage().instance().set(&DataKey::EmergencyActivatedAt, &now);
        env.events().publish(
            (Symbol::new(&env, "EmergencyActivated"),),
            EmergencyAnnouncedEvent { admin, timestamp: now },
        );
    }

    /// Deactivate emergency before the 48-hour window expires. Admin-only.
    /// Transitions: EmergencyActive (t < 48h) -> Normal.
    pub fn deactivate_emergency(env: Env, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        if !env.storage().instance().get(&DataKey::EmergencyActivated).unwrap_or(false) {
            panic!("no emergency active");
        }
        env.storage().instance().set(&DataKey::EmergencyActivated, &false);
        env.storage().instance().set(&DataKey::EmergencyActivatedAt, &0u64);
        let now = env.ledger().timestamp();
        env.events().publish(
            (Symbol::new(&env, "EmergencyCancelled"),),
            EmergencyCancelledEvent { admin, timestamp: now },
        );
    }

    /// Return full vault balance to user. Admin-only, callable only after 48h from activation.
    /// Transitions: EmergencyActive (t >= 48h) -> Closed Vault (removes vault).
    /// Pays principal + accrued interest + unclaimed yield. Normal withdrawals
    /// are NOT blocked. Emits EmergencyFundsReturned event.
    pub fn emergency_return_funds(env: Env, admin: Address, user: Address) {
        Self::bump_instance(&env);
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        if !env.storage().instance().get(&DataKey::EmergencyActivated).unwrap_or(false) {
            panic!("no emergency active");
        }
        let activated_at: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EmergencyActivatedAt)
            .unwrap_or(0);
        let now = env.ledger().timestamp();
        if now < activated_at.saturating_add(172_800) {
            panic!("emergency return not yet allowed: 48h not elapsed");
        }
        let (principal, interest, yield_amount) =
            Self::close_all_vaults(&env, &user, "No balance to return");
        env.events().publish(
            (Symbol::new(&env, "EmergencyFundsReturned"),),
            EmergencyWithdrawnEvent {
                admin,
                user,
                amount: principal + interest + yield_amount,
                principal,
                interest,
                yield_amount,
                timestamp: now,
            },
        );
    }

    /// Accrue interest for a single depositor.
    ///
    /// Calculates interest = balance * rate_bps * elapsed_seconds / (10000 * seconds_per_year)
    /// and credits it to the vault's internal balance. The contract must hold sufficient
    /// USDC to cover the increased balance when the user later withdraws.
    pub fn accrue_interest(env: Env, user: Address, vault_id: u32) {
        Self::bump_instance(&env);
        user.require_auth();
        let mut vault = Self::load_vault(&env, &user, vault_id);

        let interest = Self::accrue_interest_internal(&env, &mut vault, true);
        Self::save_vault(&env, &user, vault_id, &vault);

        if interest > 0 {
            env.events().publish(
                (Symbol::new(&env, "AccrueInterest"),),
                AccrueInterestEvent {
                    user,
                    vault_id,
                    interest,
                    new_balance: vault.balance,
                },
            );
        }
    }

    pub fn get_interest_rate(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::InterestRateBps)
            .unwrap_or(0u32)
    }

    /// Open a new, independent savings vault for `user` holding `amount` until
    /// `unlock_time`. Returns the new vault's id.
    ///
    /// Each deposit is its own vault: it never changes the unlock time (or
    /// penalty exposure) of funds the user already has in other vaults.
    ///
    /// Inflows are gated by two independent kill switches, both of which must
    /// be clear for a deposit to succeed:
    /// - the governance `pause` flag (checked first, panics with
    ///   `Contract is paused`), and
    /// - the emergency state machine (`announce_emergency` /
    ///   `activate_emergency`, checked by `assert_accepting_deposits`).
    ///
    /// Exit paths (`withdraw`, `emergency_withdraw`) are never blocked by
    /// either switch.
    pub fn deposit(env: Env, user: Address, amount: i128, unlock_time: u64) -> u32 {
        Self::bump_instance(&env);
        governance::require_not_paused(&env);
        user.require_auth();
        governance::require_not_paused(&env);
        Self::assert_accepting_deposits(&env);
        if amount <= 0 {
            panic!("Amount must be positive");
        }
        if amount > MAX_DEPOSIT_AMOUNT {
            panic!("Amount exceeds maximum deposit bound");
        }
        if unlock_time <= env.ledger().timestamp() {
            panic!("Unlock time must be in the future");
        }

        let min_lock_secs: u64 = env.storage().instance().get(&DataKey::MinLockSecs).unwrap_or(86400);
        let max_lock_secs: u64 = env.storage().instance().get(&DataKey::MaxLockSecs).unwrap_or(31536000);
        let now = env.ledger().timestamp();
        let min_unlock = now + min_lock_secs;
        let max_unlock = now + max_lock_secs;

        if unlock_time < min_unlock || unlock_time > max_unlock {
            panic!("Lock period out of allowed range (min {}s, max {}s)", min_lock_secs, max_lock_secs);
        }

        let token_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenAddress)
            .expect("Contract not initialized");

        // `user.require_auth()` above already authorises this transfer within the
        // same invocation, so no separate `approve` transaction is needed.
        token::Client::new(&env, &token_address).transfer(
            &user,
            &env.current_contract_address(),
            &amount,
        );

        let next_id_key = DataKey::NextVaultId(user.clone());
        let vault_id: u32 = env
            .storage()
            .persistent()
            .get(&next_id_key)
            .unwrap_or(0);
        let next_id = vault_id.checked_add(1).expect("vault id overflow");
        env.storage()
            .persistent()
            .set(&next_id_key, &next_id);
        Self::bump_persistent(&env, &next_id_key);

        let vault = Vault {
            balance: amount,
            unlock_time,
            last_accrue_time: now,
            accrued_interest: 0,
        };
        Self::save_vault(&env, &user, vault_id, &vault);

        let mut ids = Self::user_vault_ids(&env, &user);
        ids.push_back(vault_id);
        let ids_key = DataKey::UserVaults(user.clone());
        env.storage()
            .persistent()
            .set(&ids_key, &ids);
        Self::bump_persistent(&env, &ids_key);

        // Update total locked
        let total_locked: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);
        let new_total = total_locked.checked_add(amount).expect("total locked overflow");
        env.storage()
            .instance()
            .set(&DataKey::TotalLocked, &new_total);

        env.events().publish(
            (Symbol::new(&env, "Deposit"),),
            DepositEvent {
                user,
                vault_id,
                amount,
                unlock_time,
            },
        );
        vault_id
    }

    /// Withdraw `amount` of principal from one vault. The early-withdrawal
    /// penalty applies only if *this* vault is still locked.
    pub fn withdraw(env: Env, user: Address, vault_id: u32, amount: i128) {
        Self::bump_instance(&env);
        user.require_auth();
        governance::require_not_paused(&env);
        if amount <= 0 {
            panic!("Amount must be positive");
        }

        let mut vault = Self::load_vault(&env, &user, vault_id);

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
        if vault.balance == 0 && vault.accrued_interest == 0 {
            Self::remove_vault(&env, &user, vault_id);
        } else {
            Self::save_vault(&env, &user, vault_id, &vault);
        }

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
                vault_id,
                amount: withdraw_amount,
                penalty,
            },
        );
    }

    /// Total principal `user` holds across all of their vaults.
    pub fn get_balance(env: Env, user: Address) -> i128 {
        let mut total: i128 = 0;
        for id in Self::user_vault_ids(&env, &user).iter() {
            let vault: Vault = Self::load_vault(&env, &user, id);
            total = total.checked_add(vault.balance).expect("balance overflow");
        }
        total
    }

    /// Ids of `user`'s open vaults, in creation order.
    pub fn get_vault_ids(env: Env, user: Address) -> Vec<u32> {
        Self::user_vault_ids(&env, &user)
    }

    pub fn get_unlock_time(env: Env, user: Address, vault_id: u32) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::Vault(user, vault_id))
            .map(|v: Vault| v.unlock_time)
            .unwrap_or(0)
    }

    /// Returns the full state of one vault, or a zero-valued Vault if it doesn't exist.
    pub fn get_vault(env: Env, user: Address, vault_id: u32) -> Vault {
        env.storage()
            .persistent()
            .get(&DataKey::Vault(user, vault_id))
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

        // Authorised by `distributor.require_auth()` above; no allowance required.
        token::Client::new(&env, &token_address).transfer(
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

mod governance;
pub use governance::{CONTRACT_VERSION, UPGRADE_TIMELOCK_SECS};
