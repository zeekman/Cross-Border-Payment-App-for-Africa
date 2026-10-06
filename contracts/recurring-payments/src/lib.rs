#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol};

mod test;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Default grace period in seconds (1 hour).
const DEFAULT_GRACE_PERIOD_SECS: u64 = 3_600;

/// Default maximum consecutive missed executions before auto-cancel.
const DEFAULT_MAX_MISSED_EXECUTIONS: u64 = 3;

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    TokenAddress,
    Admin,
    FeeBps,
    Schedule(u64),
    Counter,
    MaxMissedExecutions,
    MissedExecutions(u64),
    /// Vec<u64> of schedule IDs for a given sender address.
    UserSchedules(Address),
    /// Global schedule count for full enumeration.
    TotalSchedules,
}

// ── Data types ────────────────────────────────────────────────────────────────

/// Frequency of a recurring payment, expressed in seconds.
pub type IntervalSecs = u64;

#[derive(Clone, PartialEq, Eq)]
#[contracttype]
pub enum ScheduleStatus {
    Active,
    Cancelled,
    Paused,
}

#[derive(Clone)]
#[contracttype]
pub struct RecurringSchedule {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub asset: Address,
    /// Amount per payment in stroops.
    pub amount: i128,
    /// Interval between payments in seconds (e.g. 86400 = daily).
    pub interval: IntervalSecs,
    /// Ledger timestamp of the next allowed execution.
    pub next_payment_at: u64,
    /// Maximum number of payments to execute (0 = unlimited).
    pub max_executions: u64,
    /// Number of payments executed so far.
    pub executions_completed: u64,
    pub status: ScheduleStatus,
    /// Seconds after `next_payment_at` during which a late execution is still
    /// accepted. Default: 3 600 (1 hour).
    pub grace_period_secs: u64,
    /// Maximum consecutive missed executions before the schedule is
    /// automatically cancelled. Default: 3.
    pub max_missed_executions: u64,
    /// Running count of consecutive missed execution windows.
    /// Reset to 0 on every successful execution.
    pub consecutive_misses: u64,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[derive(Clone)]
#[contracttype]
pub struct ScheduleAuthorized {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub asset: Address,
    pub amount: i128,
    pub interval: u64,
    pub next_payment_at: u64,
    pub max_executions: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct PaymentExecuted {
    pub id: u64,
    pub executor: Address,
    pub amount: i128,
    pub next_payment_at: u64,
    pub executions_completed: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct ScheduleCancelled {
    pub id: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct SchedulePaused {
    pub schedule_id: u64,
    pub paused_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct ScheduleResumed {
    pub schedule_id: u64,
    pub next_payment_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct AmountUpdated {
    pub schedule_id: u64,
    pub old_amount: i128,
    pub new_amount: i128,
    pub updated_by: Address,
}

#[derive(Clone)]
#[contracttype]
pub struct RecipientUpdated {
    pub schedule_id: u64,
    pub old_recipient: Address,
    pub new_recipient: Address,
    pub updated_by: Address,
}

/// Emitted when an execution window (plus grace period) passes without a
/// successful payment. Also emitted when the caller detects a missed window
/// by calling `execute_payment` after the grace period has expired.
#[derive(Clone)]
#[contracttype]
pub struct PaymentMissed {
    pub schedule_id: u64,
    /// Ledger timestamp at which the miss was recorded.
    pub missed_at: u64,
    /// Total consecutive misses recorded for this schedule after this event.
    pub total_missed: u64,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct RecurringPaymentsContract;

#[contractimpl]
impl RecurringPaymentsContract {
    /// One-time initializer — stores the admin, token (USDC) address, and fee in basis points.
    /// `fee_bps` of 0 disables fee collection; max is 10 000 (100 %).
    pub fn initialize(env: Env, admin: Address, token_address: Address, fee_bps: u32) {
        if env.storage().persistent().has(&DataKey::TokenAddress) {
            panic!("already initialized");
        }
        if fee_bps > 10_000 {
            panic!("fee_bps must be <= 10000");
        }
        env.storage()
            .persistent()
            .set(&DataKey::TokenAddress, &token_address);
        env.storage()
            .persistent()
            .set(&DataKey::Admin, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::FeeBps, &fee_bps);
        env.storage()
            .persistent()
            .set(&DataKey::Counter, &0u64);
        env.storage()
            .persistent()
            .set(&DataKey::MaxMissedExecutions, &DEFAULT_MAX_MISSED_EXECUTIONS);
    }

    /// Sender authorizes a recurring transfer with configurable grace period and
    /// missed-execution threshold.
    ///
    /// The contract holds *no* funds — it only records the authorization.
    /// The sender must maintain sufficient token balance and allowance.
    ///
    /// # Arguments
    /// * `grace_period_secs`     — Seconds after `next_payment_at` during which a
    ///                             late execution is still accepted (default 3 600).
    /// * `max_missed_executions` — Consecutive misses before auto-cancel (default 3,
    ///                             0 means use contract default).
    ///
    /// Returns the new schedule ID.
    pub fn create_recurring_payment(
        env: Env,
        sender: Address,
        recipient: Address,
        asset: Address,
        amount: i128,
        interval: IntervalSecs,
        max_executions: u64,
        grace_period_secs: u64,
        max_missed_executions: u64,
    ) -> u64 {
        if amount <= 0 {
            panic!("amount must be positive");
        }
        if interval == 0 {
            panic!("interval must be > 0");
        }
        if max_executions == u64::MAX {
            panic!("Invalid max_executions");
        }

        sender.require_auth();

        let effective_grace = if grace_period_secs == 0 {
            DEFAULT_GRACE_PERIOD_SECS
        } else {
            grace_period_secs
        };

        let effective_max_missed = if max_missed_executions == 0 {
            DEFAULT_MAX_MISSED_EXECUTIONS
        } else {
            max_missed_executions
        };

        let id = Self::next_id(&env);
        let now = env.ledger().timestamp();

        let schedule = RecurringSchedule {
            id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            asset: asset.clone(),
            amount,
            interval,
            next_payment_at: now + interval,
            max_executions,
            executions_completed: 0,
            status: ScheduleStatus::Active,
            grace_period_secs: effective_grace,
            max_missed_executions: effective_max_missed,
            consecutive_misses: 0,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Schedule(id), &schedule);

        // Update UserSchedules for the sender (bounded to 500 per sender).
        let mut user_ids: soroban_sdk::Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::UserSchedules(sender.clone()))
            .unwrap_or(soroban_sdk::Vec::new(&env));
        if user_ids.len() >= 500 {
            panic!("Schedule limit per sender reached");
        }
        user_ids.push_back(id);
        env.storage()
            .persistent()
            .set(&DataKey::UserSchedules(sender.clone()), &user_ids);

        // Increment global TotalSchedules counter.
        let total: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalSchedules)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::TotalSchedules, &(total + 1));

        // Initialise the missed-executions counter for this schedule ID.
        env.storage()
            .persistent()
            .set(&DataKey::MissedExecutions(id), &0u64);

        env.events().publish(
            (Symbol::new(&env, "ScheduleAuthorized"),),
            ScheduleAuthorized {
                id,
                sender,
                recipient,
                asset,
                amount,
                interval,
                next_payment_at: now + interval,
                max_executions,
            },
        );

        id
    }

    /// Pre-authorization semantics, replay/expiry rules, and schedule lifecycle:
    ///
    /// - **Authorization vs Schedule Lifetime**: Pre-authorization is tied strictly
    ///   to the underlying `RecurringSchedule` identified by `schedule_id`. Cancelling the schedule
    ///   via `cancel_recurring_payment` permanently revokes execution authority; any subsequent
    ///   `execute_payment` calls will fail with `"schedule is not active"`. Pausing the schedule
    ///   via `pause_recurring_payment` immediately halts payment execution with `"Schedule is paused"`.
    ///   There is no separate authorization object that survives or outlives a cancelled or paused schedule.
    /// - **Replay Protection**: Each payment execution checks timing (`now >= next_payment_at`)
    ///   and advances `next_payment_at` monotonically by `interval`, preventing double execution
    ///   or replay attacks within the same interval window.
    /// - **Authorization Expiry**: Pre-authorization expires when `max_executions` is reached (if > 0),
    ///   when `max_missed_executions` consecutive missed windows occur (which auto-cancels the schedule),
    ///   or when the token allowance / approval granted off-chain by the sender expires or is revoked.
    ///
    /// Deprecated alias for create_recurring_payment. Use create_recurring_payment instead.
    #[deprecated]
    pub fn authorize_recurring(
        env: Env,
        sender: Address,
        recipient: Address,
        amount: i128,
        interval: IntervalSecs,
    ) -> u64 {
        // Legacy support: default to USDC asset (0-address as placeholder).
        // Uses contract defaults for grace_period_secs and max_missed_executions.
        let usdc_placeholder = Address::from_contract_id(&env, &[0u8; 32]);
        Self::create_recurring_payment(
            env,
            sender,
            recipient,
            usdc_placeholder,
            amount,
            interval,
            0,
            DEFAULT_GRACE_PERIOD_SECS,
            DEFAULT_MAX_MISSED_EXECUTIONS,
        )
    }

    /// Execute a due payment for `schedule_id`.
    /// Anyone may call this (permissionless / incentivized execution).
    ///
    /// Timing rules and Missed-execution Accounting:
    /// - `now < next_payment_at`                          → panics "payment not yet due"
    /// - `now` in `[next_payment_at, next_payment_at + grace_period_secs]`
    ///                                                    → payment executed normally and resets `consecutive_misses` to 0
    /// - `now > next_payment_at + grace_period_secs`      → miss recorded, `consecutive_misses` incremented by 1,
    ///   `PaymentMissed` emitted, schedule state persisted, and function returns early.
    ///
    /// Consecutive Miss Threshold & Auto-Cancellation:
    /// - When `consecutive_misses >= max_missed_executions`, the schedule is automatically cancelled
    ///   (`status` set to `ScheduleStatus::Cancelled`).
    /// - If `consecutive_misses < max_missed_executions`, the schedule's `next_payment_at` is skipped
    ///   forward across elapsed intervals to prevent a deadlock, remaining `Active` until the next window.
    /// - A subsequent successful execution before reaching `max_missed_executions` resets the consecutive miss counter to 0.
    pub fn execute_payment(env: Env, executor: Address, schedule_id: u64) {
        executor.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");

        if schedule.status == ScheduleStatus::Paused {
            panic!("Schedule is paused");
        }
        if schedule.status != ScheduleStatus::Active {
            panic!("schedule is not active");
        }

        let now = env.ledger().timestamp();

        if now < schedule.next_payment_at {
            panic!("payment not yet due");
        }

        // ── Grace period check ────────────────────────────────────────────────
        let grace_deadline = schedule.next_payment_at + schedule.grace_period_secs;
        if now > grace_deadline {
            // The execution window AND grace period have both passed.
            // Record the miss, emit the event, and potentially auto-cancel.
            schedule.consecutive_misses += 1;
            let total_missed = schedule.consecutive_misses;

            // Advance next_payment_at so the schedule does not get permanently stuck.
            // Skip forward by enough intervals to land in the future.
            let elapsed = now - schedule.next_payment_at;
            let intervals_missed = elapsed / schedule.interval + 1;
            schedule.next_payment_at += intervals_missed * schedule.interval;

            // Auto-cancel if the consecutive miss threshold is reached.
            if total_missed >= schedule.max_missed_executions {
                schedule.status = ScheduleStatus::Cancelled;
            }

            // Persist the updated schedule and missed-executions counter.
            env.storage()
                .persistent()
                .set(&DataKey::MissedExecutions(schedule_id), &total_missed);
            env.storage()
                .persistent()
                .set(&DataKey::Schedule(schedule_id), &schedule);

            env.events().publish(
                (Symbol::new(&env, "PaymentMissed"),),
                PaymentMissed {
                    schedule_id,
                    missed_at: now,
                    total_missed,
                },
            );

            return;
        }

        // ── Normal execution path ─────────────────────────────────────────────

        // Check if max executions would be exceeded
        if schedule.max_executions > 0 && schedule.executions_completed >= schedule.max_executions {
            panic!("maximum executions reached");
        }

        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenAddress)
            .expect("not initialized");

        let fee_bps: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::FeeBps)
            .unwrap_or(0);

        let fee_amount = if fee_bps > 0 {
            schedule.amount * fee_bps as i128 / 10_000
        } else {
            0
        };
        let net_amount = schedule.amount - fee_amount;

        let token = token::Client::new(&env, &token_address);
        token.transfer_from(
            &env.current_contract_address(),
            &schedule.sender,
            &schedule.recipient,
            &net_amount,
        );
        if fee_amount > 0 {
            let admin: Address = env
                .storage()
                .persistent()
                .get(&DataKey::Admin)
                .expect("not initialized");
            token.transfer_from(
                &env.current_contract_address(),
                &schedule.sender,
                &admin,
                &fee_amount,
            );
        }

        // Successful execution resets the consecutive miss counter.
        schedule.consecutive_misses = 0;
        env.storage()
            .persistent()
            .set(&DataKey::MissedExecutions(schedule_id), &0u64);

        schedule.next_payment_at = now + schedule.interval;
        schedule.executions_completed += 1;

        // Cancel schedule if max executions reached
        if schedule.max_executions > 0 && schedule.executions_completed >= schedule.max_executions {
            schedule.status = ScheduleStatus::Cancelled;
        }

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
                executions_completed: schedule.executions_completed,
            },
        );
    }

    /// Cancel a recurring schedule. Only the original sender may cancel.
    /// A paused schedule may also be cancelled.
    pub fn cancel_recurring_payment(env: Env, sender: Address, schedule_id: u64) {
        sender.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");

        if schedule.sender != sender {
            panic!("only the sender can cancel");
        }
        if schedule.status == ScheduleStatus::Cancelled {
            panic!("schedule is already cancelled");
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

    /// Pause a recurring schedule. Only the original sender may pause.
    /// A paused schedule will not execute until resumed.
    pub fn pause_recurring_payment(env: Env, sender: Address, schedule_id: u64) {
        sender.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");

        if schedule.sender != sender {
            panic!("only the sender can pause");
        }
        if schedule.status == ScheduleStatus::Cancelled {
            panic!("schedule is cancelled");
        }
        if schedule.status == ScheduleStatus::Paused {
            panic!("schedule is already paused");
        }
        if schedule.status != ScheduleStatus::Active {
            panic!("schedule is not active");
        }

        schedule.status = ScheduleStatus::Paused;
        let paused_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (Symbol::new(&env, "SchedulePaused"),),
            SchedulePaused {
                schedule_id,
                paused_at,
            },
        );
    }

    /// Resume a paused recurring schedule. Only the original sender may resume.
    pub fn resume_recurring_payment(env: Env, sender: Address, schedule_id: u64) {
        sender.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");

        if schedule.sender != sender {
            panic!("only the sender can resume");
        }
        if schedule.status == ScheduleStatus::Cancelled {
            panic!("schedule is cancelled");
        }
        if schedule.status != ScheduleStatus::Paused {
            panic!("schedule is not paused");
        }

        let next_payment_at = env.ledger().timestamp() + schedule.interval;
        schedule.status = ScheduleStatus::Active;
        schedule.next_payment_at = next_payment_at;
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (Symbol::new(&env, "ScheduleResumed"),),
            ScheduleResumed {
                schedule_id,
                next_payment_at,
            },
        );
    }

    /// Deprecated alias for cancel_recurring_payment. Use cancel_recurring_payment instead.
    #[deprecated]
    pub fn cancel_recurring(env: Env, sender: Address, schedule_id: u64) {
        Self::cancel_recurring_payment(env, sender, schedule_id)
    }

    /// Read a schedule by ID.
    pub fn get_schedule(env: Env, schedule_id: u64) -> RecurringSchedule {
        env.storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found")
    }

    /// Deprecated alias for get_schedule. Use get_schedule instead.
    #[deprecated]
    pub fn get_recurring_payment(env: Env, schedule_id: u64) -> RecurringSchedule {
        Self::get_schedule(env, schedule_id)
    }

    /// Update the payment amount for a recurring schedule. Only the sender may update.
    /// The new amount takes effect from the next scheduled execution.
    pub fn update_amount(env: Env, sender: Address, schedule_id: u64, new_amount: i128) {
        sender.require_auth();

        if new_amount <= 0 {
            panic!("Amount must be positive");
        }

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");

        if schedule.sender != sender {
            panic!("only the sender can update amount");
        }
        if schedule.status == ScheduleStatus::Cancelled {
            panic!("cannot update cancelled schedule");
        }

        let old_amount = schedule.amount;
        schedule.amount = new_amount;
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (Symbol::new(&env, "AmountUpdated"),),
            AmountUpdated {
                schedule_id,
                old_amount,
                new_amount,
                updated_by: sender,
            },
        );
    }

    /// Update the recipient address for a recurring schedule. Only the sender may update.
    /// The new recipient takes effect from the next scheduled execution.
    ///
    /// # Design & Consent Semantics:
    /// - `update_recipient` is intended for sender-managed payment streams and legitimate
    ///   operational updates (e.g. recipient's rotated operational wallet or bank withdrawal partner,
    ///   communicated off-chain).
    /// - To ensure transparency and avoid silent redirection without recipient awareness, this
    ///   function emits the `RecipientUpdated` event containing both `old_recipient` and
    ///   `new_recipient`. Off-chain listening infrastructure (e.g. notification pipelines and
    ///   scheduled job daemons) should monitor `RecipientUpdated` to proactively notify both parties.
    pub fn update_recipient(env: Env, sender: Address, schedule_id: u64, new_recipient: Address) {
        sender.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");

        if schedule.sender != sender {
            panic!("only the sender can update recipient");
        }
        if schedule.status == ScheduleStatus::Cancelled {
            panic!("cannot update cancelled schedule");
        }

        let old_recipient = schedule.recipient.clone();
        schedule.recipient = new_recipient.clone();
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (Symbol::new(&env, "RecipientUpdated"),),
            RecipientUpdated {
                schedule_id,
                old_recipient,
                new_recipient,
                updated_by: sender,
            },
        );
    }

    /// Return the current consecutive missed-execution count for a schedule.
    pub fn get_missed_executions(env: Env, schedule_id: u64) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::MissedExecutions(schedule_id))
            .unwrap_or(0)
    }

    /// Return the remaining executions for a schedule.
    /// Returns None for unlimited schedules (max_executions = 0).
    /// Returns Some(remaining) for bounded schedules.
    pub fn get_remaining_executions(env: Env, schedule_id: u64) -> Option<u64> {
        let schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");
        if schedule.max_executions == 0 {
            None
        } else if schedule.executions_completed >= schedule.max_executions {
            Some(0)
        } else {
            Some(schedule.max_executions - schedule.executions_completed)
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /// Returns paginated schedule IDs for a given sender.
    ///
    /// # Arguments
    /// * `start` - 0-based offset into the sender's schedule list.
    /// * `limit` - Maximum number of IDs to return (capped at 50 to prevent excessive gas usage).
    pub fn get_user_schedules(env: Env, sender: Address, start: u32, limit: u32) -> soroban_sdk::Vec<u64> {
        let cap = if limit > 50 { 50 } else { limit };
        let ids: soroban_sdk::Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::UserSchedules(sender))
            .unwrap_or(soroban_sdk::Vec::new(&env));
        let mut result: soroban_sdk::Vec<u64> = soroban_sdk::Vec::new(&env);
        let len = ids.len();
        let end = start.saturating_add(cap);
        let mut i = start;
        while i < len && i < end {
            result.push_back(ids.get(i).unwrap());
            i = i.saturating_add(1);
        }
        result
    }

    /// Returns the full schedule struct for a given ID.
    pub fn get_schedule_by_id(env: Env, schedule_id: u64) -> RecurringSchedule {
        env.storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found")
    }

    /// Returns paginated IDs of schedules with Active status.
    ///
    /// # Arguments
    /// * `start` - 0-based offset among active schedules.
    /// * `limit` - Maximum number of IDs to return (capped at 50 to prevent excessive gas usage).
    pub fn get_active_schedules(env: Env, start: u64, limit: u64) -> soroban_sdk::Vec<u64> {
        let cap = if limit > 50 { 50 } else { limit };
        let total: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalSchedules)
            .unwrap_or(0);
        let mut result: soroban_sdk::Vec<u64> = soroban_sdk::Vec::new(&env);
        let mut scanned: u64 = 0;
        let mut id: u64 = 1;
        let end = start.saturating_add(cap);
        while id <= total && scanned < end {
            if let Some(s) = env
                .storage()
                .persistent()
                .get::<DataKey, RecurringSchedule>(&DataKey::Schedule(id))
            {
                if s.status == ScheduleStatus::Active {
                    if scanned >= start {
                        result.push_back(id);
                    }
                    scanned = scanned.saturating_add(1);
                }
            }
            id = id.saturating_add(1);
        }
        result
    }

    fn next_id(env: &Env) -> u64 {
        let current: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Counter)
            .unwrap_or(0);
        let next = current.checked_add(1).expect("Schedule counter overflow");
        env.storage()
            .persistent()
            .set(&DataKey::Counter, &next);
        next
    }
}
