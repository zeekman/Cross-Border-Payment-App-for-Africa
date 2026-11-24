#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol};

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_budget;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Default grace period in seconds (1 hour).
const DEFAULT_GRACE_PERIOD_SECS: u64 = 3_600;

/// Default maximum consecutive missed executions before auto-cancel.
const DEFAULT_MAX_MISSED_EXECUTIONS: u64 = 3;

/// TTL bump amount for instance storage (~30 days at 5s ledgers).
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
/// TTL lifetime threshold for instance storage (~7 days at 5s ledgers).
const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960;
/// TTL bump amount for persistent storage (~30 days at 5s ledgers).
const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;
/// TTL lifetime threshold for persistent storage (~7 days at 5s ledgers).
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;

// ── Storage keys ──────────────────────────────────────────────────────────────

#[derive(Debug)]
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
    /// Ledger timestamp at which the contract was paused (0 = not paused).
    PausedAt,
    /// Ledger timestamp at which the contract was last unpaused.
    UnpausedAt,
    /// Two-step admin rotation: proposed new admin awaiting acceptance.
    PendingAdmin,
    /// Ledger timestamp after which the pending admin may accept.
    PendingAdminEta,
    /// Optional fee-distributor contract that receives platform fees.
    FeeDistributor,
}

// ── Data types ────────────────────────────────────────────────────────────────

/// Frequency of a recurring payment, expressed in seconds.
pub type IntervalSecs = u64;

#[derive(Debug, Clone, PartialEq, Eq)]
#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub enum ScheduleStatus {
    Active,
    /// Stopped by the sender, or auto-cancelled after too many missed windows.
    Cancelled,
    Paused,
    /// Finished successfully: all `max_executions` payments were made.
    Completed,
}

#[derive(Debug, Clone)]
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

#[derive(Debug, Clone)]
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

#[derive(Debug, Clone)]
#[contracttype]
pub struct PaymentExecuted {
    pub id: u64,
    pub executor: Address,
    pub amount: i128,
    /// Platform fee charged for this execution (0 when fees are disabled).
    pub fee_amount: i128,
    pub next_payment_at: u64,
    pub executions_completed: u64,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct ScheduleCancelled {
    pub id: u64,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct SchedulePaused {
    pub schedule_id: u64,
    pub paused_at: u64,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct ScheduleResumed {
    pub schedule_id: u64,
    pub next_payment_at: u64,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct AmountUpdated {
    pub schedule_id: u64,
    pub old_amount: i128,
    pub new_amount: i128,
    pub updated_by: Address,
}

#[derive(Debug, Clone)]
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
#[derive(Debug, Clone)]
/// Emitted when `execute_payment` finds one or more execution windows whose
/// grace period expired without a successful payment.
#[derive(Clone)]
#[contracttype]
pub struct PaymentMissed {
    pub schedule_id: u64,
    /// Ledger timestamp at which the miss was recorded.
    pub missed_at: u64,
    /// Number of windows found missed by this call (can be > 1 when nobody
    /// executed the schedule for several intervals).
    pub newly_missed: u64,
    /// Total consecutive misses recorded for this schedule after this event.
    pub total_missed: u64,
}

/// Emitted when a bounded schedule makes its final payment and becomes
/// `Completed`.
#[derive(Clone)]
#[contracttype]
pub struct ScheduleCompleted {
    pub schedule_id: u64,
    pub executions_completed: u64,
    pub completed_at: u64,
}

/// Emitted when a schedule is cancelled automatically because it reached
/// `max_missed_executions` consecutive missed windows.
#[derive(Clone)]
#[contracttype]
pub struct ScheduleAutoCancelled {
    pub schedule_id: u64,
    pub total_missed: u64,
    pub cancelled_at: u64,
}

/// Emitted once when the contract is initialized.
#[derive(Clone)]
#[contracttype]
pub struct Initialized {
    pub admin: Address,
    pub token_address: Address,
    pub fee_bps: u32,
}

/// Emitted when the contract is paused by the admin.
#[derive(Clone)]
#[contracttype]
pub struct Paused {
    pub admin: Address,
    pub paused_at: u64,
}

/// Emitted when the contract is unpaused by the admin.
#[derive(Clone)]
#[contracttype]
pub struct Unpaused {
    pub admin: Address,
    pub unpaused_at: u64,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct RecurringPaymentsContract;

#[contractimpl]
impl RecurringPaymentsContract {
    /// One-time initializer — stores the admin, token (USDC) address, and fee in basis points.
    /// `fee_bps` of 0 disables fee collection; max is 10 000 (100 %).
    pub fn initialize(env: Env, admin: Address, token_address: Address, fee_bps: u32) {
        Self::bump_instance(&env);
        if env.storage().instance().has(&DataKey::TokenAddress) {
            panic!("already initialized");
        }
        if fee_bps > 10_000 {
            panic!("fee_bps must be <= 10000");
        }
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::TokenAddress, &token_address);
        env.storage()
            .instance()
            .set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::FeeBps, &fee_bps);
        env.storage()
            .instance()
            .set(&DataKey::Counter, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::MaxMissedExecutions, &DEFAULT_MAX_MISSED_EXECUTIONS);

        env.events().publish(
            (Symbol::new(&env, "Initialized"),),
            Initialized {
                admin,
                token_address,
                fee_bps,
            },
        );
    }

    /// Configure (or clear) the fee-distributor contract that receives platform
    /// fees. Admin only.
    ///
    /// When set, `execute_payment` routes fees through
    /// `fee_distributor.deposit_fee(...)` so they are split between the
    /// platform treasury and the agent reward pool and appear in
    /// `fee-distributor::get_accumulated_fees`. When unset, fees are sent
    /// directly to the admin address (legacy behaviour).
    pub fn set_fee_distributor(env: Env, admin: Address, distributor: Option<Address>) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("only the admin can set the fee distributor");
        }
        match distributor {
            Some(addr) => env
                .storage()
                .persistent()
                .set(&DataKey::FeeDistributor, &addr),
            None => env.storage().persistent().remove(&DataKey::FeeDistributor),
        }
    }

    /// Return the configured fee-distributor address, if any.
    pub fn get_fee_distributor(env: Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::FeeDistributor)
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
    /// Authorization lives only as long as the schedule: cancelling it
    /// revokes execution, pausing halts it, and it ends after
    /// `max_executions` payments (if > 0), after `max_missed_executions`
    /// consecutive misses, or when the sender's token allowance lapses.
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
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        if amount <= 0 {
            panic!("amount must be positive");
        }
        if interval == 0 {
            panic!("interval must be > 0");
        }
        if max_executions == u64::MAX {
            panic!("Invalid max_executions");
        }
        if recipient == sender {
            panic!("recipient cannot be the sender");
        }
        if recipient == env.current_contract_address() {
            panic!("recipient cannot be the contract");
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
        Self::bump_persistent(&env, &DataKey::Schedule(id));

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
        Self::bump_persistent(&env, &DataKey::UserSchedules(sender.clone()));

        // Increment global TotalSchedules counter.
        let total: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSchedules)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalSchedules, &(total + 1));

        // Initialise the missed-executions counter for this schedule ID.
        env.storage()
            .persistent()
            .set(&DataKey::MissedExecutions(id), &0u64);
        Self::bump_persistent(&env, &DataKey::MissedExecutions(id));

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

    /// Execute a due payment for `schedule_id`. Anyone may call this.
    ///
    /// - `now < next_payment_at` → panics "payment not yet due".
    /// - `now <= next_payment_at + grace_period_secs` → payment executes and
    ///   `consecutive_misses` resets to 0.
    /// - Otherwise every window whose grace period has expired counts as a
    ///   miss (one per interval, not one per call). `next_payment_at` moves to
    ///   the first window that has not expired, `PaymentMissed` is emitted and
    ///   the call returns without paying. If the open window is already due,
    ///   a second call executes it.
    /// - When `consecutive_misses >= max_missed_executions` the schedule is
    ///   cancelled and `ScheduleAutoCancelled` is emitted.
    // Pre-authorization semantics, replay/expiry rules, and schedule lifecycle:
    //
    // - Authorization vs schedule lifetime: pre-authorization is tied strictly
    //   to the `RecurringSchedule` identified by `schedule_id`. Cancelling via
    //   `cancel_recurring_payment` permanently revokes execution authority
    //   ("schedule is not active"); pausing via `pause_recurring_payment` halts
    //   execution ("Schedule is paused"). No separate authorization object
    //   outlives a cancelled or paused schedule.
    // - Replay protection: each execution checks `now >= next_payment_at` and
    //   advances `next_payment_at` monotonically by `interval`.
    // - Expiry: when `max_executions` is reached (if > 0), when
    //   `max_missed_executions` consecutive windows are missed (auto-cancel),
    //   or when the sender's off-chain token allowance expires or is revoked.

    /// Deprecated alias for `create_recurring_payment`; use that instead.
    ///
    /// The schedule's asset is the token configured in `initialize` (USDC),
    /// with no execution cap and default grace / missed-execution settings.
    #[deprecated]
    pub fn authorize_recurring(
        env: Env,
        sender: Address,
        recipient: Address,
        amount: i128,
        interval: IntervalSecs,
    ) -> u64 {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        // Legacy support: default to USDC asset (0-address as placeholder).
        // Uses contract defaults for grace_period_secs and max_missed_executions.
        // Strkey of the all-zero contract id.
        let usdc_placeholder = Address::from_str(
            &env,
            "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        );
        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenAddress)
            .expect("not initialized");
        Self::create_recurring_payment(
            env,
            sender,
            recipient,
            token,
            amount,
            interval,
            0,
            DEFAULT_GRACE_PERIOD_SECS,
            DEFAULT_MAX_MISSED_EXECUTIONS,
        )
    }

    /// Next due date after a successful execution at `now`, kept on the
    /// original schedule grid (`next_payment_at + k * interval`).
    ///
    /// Normally this is just `next_payment_at + interval`. If the execution
    /// was so late that this is already due (only possible when the grace
    /// period is at least one interval), it skips ahead to the first grid
    /// slot after `now`, so one call never unlocks a burst of back-to-back
    /// payments.
    fn next_anchored_due(schedule: &RecurringSchedule, now: u64) -> u64 {
        let mut next = schedule.next_payment_at + schedule.interval;
        if next <= now {
            let behind = now - next;
            next += (behind / schedule.interval + 1) * schedule.interval;
        }
        next
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
    /// Auto-cancellation: once `consecutive_misses >= max_missed_executions` the schedule is
    /// cancelled; below that, `next_payment_at` skips past elapsed intervals and the schedule
    /// stays `Active`. A successful execution resets the miss counter to 0.
    pub fn execute_payment(env: Env, executor: Address, schedule_id: u64) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        executor.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");
        Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));

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
            // Count every window whose grace period has expired: window k is
            // due at next_payment_at + k * interval and expired if its
            // deadline (due + grace) is before `now`. Window 0 is known to
            // have expired, so newly_missed >= 1.
            let mut newly_missed = (now - grace_deadline - 1) / schedule.interval + 1;

            // Windows that elapsed while the contract was paused must not
            // count against the sender, otherwise a platform pause could
            // auto-cancel schedules through no fault of the sender. The
            // paused window is [paused_at, unpaused_at]; any window whose
            // grace deadline falls inside it is forgiven.
            let paused_at: u64 = env
                .storage()
                .instance()
                .get(&DataKey::PausedAt)
                .unwrap_or(0);
            let unpaused_at: u64 = env
                .storage()
                .instance()
                .get(&DataKey::UnpausedAt)
                .unwrap_or(0);
            if paused_at > 0 && unpaused_at > paused_at {
                let forgiven = Self::windows_in_range(
                    schedule.next_payment_at,
                    schedule.grace_period_secs,
                    schedule.interval,
                    paused_at,
                    unpaused_at,
                );
                newly_missed = newly_missed.saturating_sub(forgiven);
            }

            if newly_missed == 0 {
                // Every expired window fell inside the pause: advance the
                // schedule past them without recording a miss.
                let skipped = (now - grace_deadline - 1) / schedule.interval + 1;
                schedule.next_payment_at = skipped
                    .checked_mul(schedule.interval)
                    .and_then(|skip| schedule.next_payment_at.checked_add(skip))
                    .expect("next_payment_at overflow");
                env.storage()
                    .persistent()
                    .set(&DataKey::Schedule(schedule_id), &schedule);
                Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));
                return;
            }

            let total_missed = schedule.consecutive_misses.saturating_add(newly_missed);
            schedule.consecutive_misses = total_missed;

            // Move to the first window that has not expired yet.
            schedule.next_payment_at = newly_missed
                .checked_mul(schedule.interval)
                .and_then(|skip| schedule.next_payment_at.checked_add(skip))
                .expect("next_payment_at overflow");

            let auto_cancelled = total_missed >= schedule.max_missed_executions;
            if auto_cancelled {
                schedule.status = ScheduleStatus::Cancelled;
            }

            // Persist the updated schedule and missed-executions counter.
            env.storage()
                .persistent()
                .set(&DataKey::MissedExecutions(schedule_id), &total_missed);
            Self::bump_persistent(&env, &DataKey::MissedExecutions(schedule_id));
            env.storage()
                .persistent()
                .set(&DataKey::Schedule(schedule_id), &schedule);
            Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));

            env.events().publish(
                (Symbol::new(&env, "PaymentMissed"),),
                PaymentMissed {
                    schedule_id,
                    missed_at: now,
                    newly_missed,
                    total_missed,
                },
            );

            if auto_cancelled {
                env.events().publish(
                    (Symbol::new(&env, "ScheduleAutoCancelled"),),
                    ScheduleAutoCancelled {
                        schedule_id,
                        total_missed,
                        cancelled_at: now,
                    },
                );
            }

            return;
        }

        // ── Normal execution path ─────────────────────────────────────────────

        // Check if max executions would be exceeded
        if schedule.max_executions > 0 && schedule.executions_completed >= schedule.max_executions {
            panic!("maximum executions reached");
        }

        let token_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenAddress)
            .expect("not initialized");

        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FeeBps)
            .unwrap_or(0);

        let fee_amount = if fee_bps > 0 {
            schedule
                .amount
                .checked_mul(fee_bps as i128)
                .expect("fee calculation overflow")
                .checked_div(10_000)
                .expect("fee calculation overflow")
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
            let distributor: Option<Address> = env
                .storage()
                .instance()
                .get(&DataKey::Admin)
                .expect("not initialized");
            token.transfer_from(
                &env.current_contract_address(),
                &schedule.sender,
                &admin,
                &fee_amount,
            );
                .persistent()
                .get(&DataKey::FeeDistributor);
            match distributor {
                Some(distributor) => {
                    // Pull the fee into this contract, then forward it to the
                    // fee-distributor, which splits it between the platform
                    // treasury and the agent reward pool and records it in its
                    // per-token fee ledger.
                    token.transfer_from(
                        &env.current_contract_address(),
                        &schedule.sender,
                        &env.current_contract_address(),
                        &fee_amount,
                    );
                    let distributor_client =
                        fee_distributor::Client::new(&env, &distributor);
                    distributor_client.deposit_fee(
                        &env.current_contract_address(),
                        &token_address,
                        &fee_amount,
                        &Some(schedule.sender.clone()),
                    );
                }
                None => {
                    // Fallback (no fee distributor configured): preserve the
                    // legacy behaviour of sending the fee straight to the
                    // admin address.
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
            }
        }

        // Successful execution resets the consecutive miss counter.
        schedule.consecutive_misses = 0;
        env.storage()
            .persistent()
            .set(&DataKey::MissedExecutions(schedule_id), &0u64);
        Self::bump_persistent(&env, &DataKey::MissedExecutions(schedule_id));

        // Anchor the next due date to the schedule, not to when this call
        // happened. Using `now + interval` made every late (in-grace)
        // execution push the schedule later, so a "1st of the month" payment
        // drifted by days over a year and disagreed with the off-chain
        // calendar.
        schedule.next_payment_at = Self::next_anchored_due(&schedule, now);
        schedule.executions_completed += 1;

        // A bounded schedule that has made all its payments is Completed,
        // not Cancelled, so clients can tell success from cancellation.
        let completed = schedule.max_executions > 0
            && schedule.executions_completed >= schedule.max_executions;
        if completed {
            schedule.status = ScheduleStatus::Completed;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);
        Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));

        env.events().publish(
            (Symbol::new(&env, "PaymentExecuted"),),
            PaymentExecuted {
                id: schedule_id,
                executor,
                amount: schedule.amount,
                fee_amount,
                next_payment_at: schedule.next_payment_at,
                executions_completed: schedule.executions_completed,
            },
        );

        if completed {
            env.events().publish(
                (Symbol::new(&env, "ScheduleCompleted"),),
                ScheduleCompleted {
                    schedule_id,
                    executions_completed: schedule.executions_completed,
                    completed_at: now,
                },
            );
        }
    }

    /// Cancel a recurring schedule. Only the original sender may cancel.
    /// A paused schedule may also be cancelled.
    pub fn cancel_recurring_payment(env: Env, sender: Address, schedule_id: u64) {
        Self::bump_instance(&env);
        sender.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");
        Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));

        if schedule.sender != sender {
            panic!("only the sender can cancel");
        }
        if schedule.status == ScheduleStatus::Cancelled {
            panic!("schedule is already cancelled");
        }
        if schedule.status == ScheduleStatus::Completed {
            panic!("schedule is already completed");
        }

        schedule.status = ScheduleStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);
        Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));

        env.events().publish(
            (Symbol::new(&env, "ScheduleCancelled"),),
            ScheduleCancelled { id: schedule_id },
        );
    }

    /// Pause a recurring schedule. Only the original sender may pause.
    /// A paused schedule will not execute until resumed.
    pub fn pause_recurring_payment(env: Env, sender: Address, schedule_id: u64) {
        Self::bump_instance(&env);
        sender.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");
        Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));

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
        Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));

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
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        sender.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");
        Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));

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
        Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));

        env.events().publish(
            (Symbol::new(&env, "ScheduleResumed"),),
            ScheduleResumed {
                schedule_id,
                next_payment_at,
            },
        );
    }

    /// Read a schedule by ID.
    pub fn get_schedule(env: Env, schedule_id: u64) -> RecurringSchedule {
        Self::bump_instance(&env);
        Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));
        env.storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found")
    }

    /// Update the payment amount for a recurring schedule. Only the sender may update.
    /// The new amount takes effect from the next scheduled execution.
    pub fn update_amount(env: Env, sender: Address, schedule_id: u64, new_amount: i128) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        sender.require_auth();

        if new_amount <= 0 {
            panic!("Amount must be positive");
        }

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");
        Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));

        if schedule.sender != sender {
            panic!("only the sender can update amount");
        }
        if schedule.status == ScheduleStatus::Cancelled {
            panic!("cannot update cancelled schedule");
        }
        if schedule.status == ScheduleStatus::Completed {
            panic!("cannot update completed schedule");
        }

        let old_amount = schedule.amount;
        schedule.amount = new_amount;
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);
        Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));

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
        Self::bump_instance(&env);
        sender.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");
        Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));

        if schedule.sender != sender {
            panic!("only the sender can update recipient");
        }
        if schedule.status == ScheduleStatus::Cancelled {
            panic!("cannot update cancelled schedule");
        }
        if schedule.status == ScheduleStatus::Completed {
            panic!("cannot update completed schedule");
        }
        if new_recipient == sender {
            panic!("recipient cannot be the sender");
        }
        if new_recipient == env.current_contract_address() {
            panic!("recipient cannot be the contract");
        }

        let old_recipient = schedule.recipient.clone();
        schedule.recipient = new_recipient.clone();
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);
        Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));

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
        Self::bump_instance(&env);
        Self::bump_persistent(&env, &DataKey::MissedExecutions(schedule_id));
        env.storage()
            .persistent()
            .get(&DataKey::MissedExecutions(schedule_id))
            .unwrap_or(0)
    }

    /// Return the remaining executions for a schedule.
    /// Returns None for unlimited schedules (max_executions = 0).
    /// Returns Some(remaining) for bounded schedules.
    pub fn get_remaining_executions(env: Env, schedule_id: u64) -> Option<u64> {
        Self::bump_instance(&env);
        Self::bump_persistent(&env, &DataKey::Schedule(schedule_id));
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
        Self::bump_instance(&env);
        Self::bump_persistent(&env, &DataKey::UserSchedules(sender.clone()));
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

    /// Returns paginated IDs of schedules with Active status.
    ///
    /// # Arguments
    /// * `start` - 0-based offset among active schedules.
    /// * `limit` - Maximum number of IDs to return (capped at 50 to prevent excessive gas usage).
    pub fn get_active_schedules(env: Env, start: u64, limit: u64) -> soroban_sdk::Vec<u64> {
        Self::bump_instance(&env);
        let cap = if limit > 50 { 50 } else { limit };
        let total: u64 = env
            .storage()
            .instance()
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
            .instance()
            .get(&DataKey::Counter)
            .unwrap_or(0);
        let next = current.checked_add(1).expect("Schedule counter overflow");
        env.storage()
            .instance()
            .set(&DataKey::Counter, &next);
        next
    }

    /// Bump the instance storage TTL. Called from every public entry point.
    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    /// Bump the TTL of a persistent record that was read or written.
    fn bump_persistent(env: &Env, key: &DataKey) {
        env.storage().persistent().extend_ttl(
            key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
    }

    /// Number of execution windows of a schedule whose grace deadline falls
    /// inside `[from, to]`. Used to forgive windows that elapsed during a
    /// platform pause.
    fn windows_in_range(
        first_due: u64,
        grace: u64,
        interval: u64,
        from: u64,
        to: u64,
    ) -> u64 {
        if interval == 0 || to <= from {
            return 0;
        }
        // Window k has grace deadline first_due + k*interval + grace.
        // Count k >= 0 with from <= deadline <= to.
        let first_deadline = first_due.saturating_add(grace);
        if first_deadline > to {
            return 0;
        }
        let start_k = if first_deadline >= from {
            0
        } else {
            (from - first_deadline + interval - 1) / interval
        };
        let end_k = (to - first_deadline) / interval;
        if end_k < start_k {
            0
        } else {
            end_k - start_k + 1
        }
    }
}

mod governance;
pub use governance::{CONTRACT_VERSION, UPGRADE_TIMELOCK_SECS};

#[contractimpl]
impl RecurringPaymentsContract {
    /// Propose a new admin. The current admin must authorize. The proposal
    /// becomes acceptable by the new admin after `ADMIN_ROTATION_DELAY_SECS`.
    ///
    /// The admin should be a multisig account or the `multisig-approval`
    /// contract so a single lost or compromised key cannot take over.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) {
        governance::propose_admin(&env, &admin, &new_admin);
    }

    /// Accept a pending admin proposal. Requires the new admin's signature and
    /// that the rotation delay has elapsed.
    pub fn accept_admin(env: Env, new_admin: Address) {
        governance::accept_admin(&env, &new_admin);
    }

    /// Cancel a pending admin proposal. Only the current admin may cancel.
    pub fn cancel_admin_proposal(env: Env, admin: Address) {
        governance::cancel_admin_proposal(&env, &admin);
    }

    /// Return the current admin address.
    pub fn get_admin(env: Env) -> Address {
        governance::get_admin(&env)
    }

    /// Return the pending admin proposal, if any, as `(new_admin, eta)`.
    pub fn get_pending_admin(env: Env) -> Option<(Address, u64)> {
        governance::get_pending_admin(&env)
/// Minimal client interface for the fee-distributor contract.
mod fee_distributor {
    use soroban_sdk::{contractclient, Address, Env};

    #[contractclient(name = "Client")]
    pub trait FeeDistributor {
        /// Deposit `amount` of `token` as a platform fee, attributed to
        /// `source`. The caller must have transferred the tokens to itself and
        /// authorize this call.
        fn deposit_fee(
            env: Env,
            contract: Address,
            token: Address,
            amount: i128,
            source: Option<Address>,
        );
    }
}
