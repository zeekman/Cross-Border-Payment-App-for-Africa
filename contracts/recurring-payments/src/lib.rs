#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol};

mod test;

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    TokenAddress,
    Schedule(u64),
    Counter,
}

// ── Data types ────────────────────────────────────────────────────────────────

/// Frequency of a recurring payment, expressed in seconds.
pub type IntervalSecs = u64;

#[derive(Clone, PartialEq, Eq)]
#[contracttype]
pub enum ScheduleStatus {
    Active,
    Cancelled,
}

#[derive(Clone)]
#[contracttype]
pub struct RecurringSchedule {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub amount: i128,
    /// Interval between payments in seconds (e.g. 86400 = daily).
    pub interval: IntervalSecs,
    /// Ledger timestamp of the next allowed execution.
    pub next_payment_at: u64,
    pub status: ScheduleStatus,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[derive(Clone)]
#[contracttype]
pub struct ScheduleAuthorized {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub amount: i128,
    pub interval: u64,
    pub next_payment_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct PaymentExecuted {
    pub id: u64,
    pub executor: Address,
    pub amount: i128,
    pub next_payment_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct ScheduleCancelled {
    pub id: u64,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct RecurringPaymentsContract;

#[contractimpl]
impl RecurringPaymentsContract {
    /// One-time initializer — stores the token (USDC) contract address.
    pub fn initialize(env: Env, token_address: Address) {
        if env.storage().persistent().has(&DataKey::TokenAddress) {
            panic!("already initialized");
        }
        env.storage()
            .persistent()
            .set(&DataKey::TokenAddress, &token_address);
        env.storage()
            .persistent()
            .set(&DataKey::Counter, &0u64);
    }

    /// Sender authorizes a recurring transfer.
    /// The contract holds *no* funds — it only records the authorization.
    /// The sender must maintain sufficient token balance and allowance.
    ///
    /// Returns the new schedule ID.
    pub fn authorize_recurring(
        env: Env,
        sender: Address,
        recipient: Address,
        amount: i128,
        interval: IntervalSecs,
    ) -> u64 {
        if amount <= 0 {
            panic!("amount must be positive");
        }
        if interval == 0 {
            panic!("interval must be > 0");
        }

        sender.require_auth();

        let id = Self::next_id(&env);
        let now = env.ledger().timestamp();

        let schedule = RecurringSchedule {
            id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            amount,
            interval,
            next_payment_at: now + interval,
            status: ScheduleStatus::Active,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Schedule(id), &schedule);

        env.events().publish(
            (Symbol::new(&env, "ScheduleAuthorized"),),
            ScheduleAuthorized {
                id,
                sender,
                recipient,
                amount,
                interval,
                next_payment_at: now + interval,
            },
        );

        id
    }

    /// Execute a due payment for `schedule_id`.
    /// Anyone may call this (permissionless / incentivized execution).
    /// Panics if the schedule is not yet due or is not active.
    pub fn execute_payment(env: Env, executor: Address, schedule_id: u64) {
        executor.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");

        if schedule.status != ScheduleStatus::Active {
            panic!("schedule is not active");
        }

        let now = env.ledger().timestamp();
        if now < schedule.next_payment_at {
            panic!("payment not yet due");
        }

        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenAddress)
            .expect("not initialized");

        // Pull funds directly from sender → recipient (no custody).
        token::Client::new(&env, &token_address).transfer_from(
            &env.current_contract_address(),
            &schedule.sender,
            &schedule.recipient,
            &schedule.amount,
        );

        schedule.next_payment_at = now + schedule.interval;
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (Symbol::new(&env, "PaymentExecuted"),),
            PaymentExecuted {
                id: schedule_id,
                executor,
                amount: schedule.amount,
                next_payment_at: schedule.next_payment_at,
            },
        );
    }

    /// Cancel a recurring schedule. Only the original sender may cancel.
    pub fn cancel_recurring(env: Env, sender: Address, schedule_id: u64) {
        sender.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");

        if schedule.sender != sender {
            panic!("only the sender can cancel");
        }
        if schedule.status != ScheduleStatus::Active {
            panic!("schedule is not active");
        }

        schedule.status = ScheduleStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (Symbol::new(&env, "ScheduleCancelled"),),
            ScheduleCancelled { id: schedule_id },
        );
    }

    /// Read a schedule by ID.
    pub fn get_schedule(env: Env, schedule_id: u64) -> RecurringSchedule {
        env.storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found")
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    fn next_id(env: &Env) -> u64 {
        let current: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Counter)
            .unwrap_or(0);
        let next = current + 1;
        env.storage()
            .persistent()
            .set(&DataKey::Counter, &next);
        next
    }
}
