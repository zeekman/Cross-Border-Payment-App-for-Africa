#![cfg(test)]
extern crate std;

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger, LedgerInfo},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, TryFromVal,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn setup() -> (Env, Address, Address, Address, Address, Address, Address) {
    setup_with_fee(0)
}

fn setup_with_fee(fee_bps: u32) -> (Env, Address, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy a mock USDC token
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone()).address();

    let admin = Address::generate(&env);

    // Deploy the recurring-payments contract
    let contract_id = env.register(RecurringPaymentsContract, ());
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id, &fee_bps);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let executor = Address::generate(&env);

    // Fund sender with 10_000 USDC (7 decimals)
    StellarAssetClient::new(&env, &token_id).mint(&sender, &10_000_0000000);

    // Approve the contract to pull from sender
    TokenClient::new(&env, &token_id).approve(
        &sender,
        &contract_id,
        &i128::MAX,
        &(env.ledger().sequence() + 10_000),
    );

    (env, contract_id, token_id, sender, recipient, executor, admin)
}

fn advance_time(env: &Env, secs: u64) {
    let info = env.ledger().get();
    env.ledger().set(LedgerInfo {
        timestamp: info.timestamp + secs,
        ..info
    });
}

fn token_balance(env: &Env, token_id: &Address, account: &Address) -> i128 {
    TokenClient::new(env, token_id).balance(account)
}

/// Create a schedule with no execution cap and default grace / miss limits.
fn create(
    client: &RecurringPaymentsContractClient,
    token_id: &Address,
    sender: &Address,
    recipient: &Address,
    amount: i128,
    interval: u64,
) -> u64 {
    client.create_recurring_payment(sender, recipient, token_id, &amount, &interval, &0, &0, &0)
}

fn set_time(env: &Env, timestamp: u64) {
    let info = env.ledger().get();
    env.ledger().set(LedgerInfo { timestamp, ..info });
}

/// Count events emitted by `contract_id` whose first topic is `name`.
/// Only sees events from the most recent contract call.
fn count_events(env: &Env, contract_id: &Address, name: &str) -> u32 {
    let wanted = soroban_sdk::Symbol::new(env, name);
    let mut n = 0;
    for (contract, topics, _) in env.events().all().iter() {
        if &contract != contract_id || topics.is_empty() {
            continue;
        }
        if let Ok(sym) = soroban_sdk::Symbol::try_from_val(env, &topics.get(0).unwrap()) {
            if sym == wanted {
                n += 1;
            }
        }
    }
    n
}

// ── initialize ────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_ok() {
    let env = Env::default();
    env.mock_all_auths();
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin).address();
    let admin = Address::generate(&env);
    let contract_id = env.register(RecurringPaymentsContract, ());
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id, &0); // must not panic
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_initialize_twice_panics() {
    let (env, contract_id, token_id, _, _, _, _) = setup();
    let admin = Address::generate(&env);
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id, &0);
}

#[test]
#[should_panic(expected = "fee_bps must be <= 10000")]
fn test_initialize_fee_bps_too_high_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin).address();
    let admin = Address::generate(&env);
    let contract_id = env.register(RecurringPaymentsContract, ());
    RecurringPaymentsContractClient::new(&env, &contract_id).initialize(&admin, &token_id, &10_001);
}

// ── create_recurring_payment ──────────────────────────────────────────────────

#[test]
fn test_create_recurring_returns_id_one() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 1_000_0000000, 86400);
    assert_eq!(id, 1);
}

#[test]
fn test_create_recurring_stores_schedule() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 500_0000000, 3600);
    let s = client.get_schedule(&id);
    assert_eq!(s.sender, sender);
    assert_eq!(s.recipient, recipient);
    assert_eq!(s.amount, 500_0000000);
    assert_eq!(s.interval, 3600);
    assert_eq!(s.status, ScheduleStatus::Active);
}

#[test]
fn test_create_recurring_ids_increment() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id1 = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    let id2 = create(&client, &token_id, &sender, &recipient, 200_0000000, 86400);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_create_zero_amount_panics() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    create(&client, &token_id, &sender, &recipient, 0, 86400);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_create_negative_amount_panics() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    create(&client, &token_id, &sender, &recipient, -1, 86400);
}

#[test]
#[should_panic(expected = "interval must be > 0")]
fn test_create_zero_interval_panics() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    create(&client, &token_id, &sender, &recipient, 100_0000000, 0);
}

// ── execute_payment ───────────────────────────────────────────────────────────

#[test]
fn test_execute_payment_transfers_funds() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 1_000_0000000i128;
    let id = create(&client, &token_id, &sender, &recipient, amount, 86400);

    advance_time(&env, 86400);

    let before = token_balance(&env, &token_id, &recipient);
    client.execute_payment(&executor, &id);
    let after = token_balance(&env, &token_id, &recipient);
    assert_eq!(after - before, amount);
}

#[test]
fn test_execute_payment_advances_next_payment_at() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);

    advance_time(&env, 86400);
    let ts_before_exec = env.ledger().timestamp();
    client.execute_payment(&executor, &id);

    let s = client.get_schedule(&id);
    assert_eq!(s.next_payment_at, ts_before_exec + 86400);
}

#[test]
fn test_execute_payment_multiple_cycles() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 500_0000000i128;
    let id = create(&client, &token_id, &sender, &recipient, amount, 86400);

    for _ in 0..3 {
        advance_time(&env, 86400);
        client.execute_payment(&executor, &id);
    }

    assert_eq!(token_balance(&env, &token_id, &recipient), amount * 3);
}

#[test]
#[should_panic(expected = "payment not yet due")]
fn test_execute_payment_too_early_panics() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    // Do NOT advance time
    client.execute_payment(&executor, &id);
}

#[test]
#[should_panic(expected = "schedule not found")]
fn test_execute_payment_unknown_id_panics() {
    let (env, contract_id, _, _, _, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.execute_payment(&executor, &999);
}

#[test]
#[should_panic(expected = "schedule is not active")]
fn test_execute_payment_on_cancelled_schedule_panics() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    client.cancel_recurring_payment(&sender, &id);

    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
}

// ── cancel_recurring ──────────────────────────────────────────────────────────

#[test]
fn test_cancel_sets_status_cancelled() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    client.cancel_recurring_payment(&sender, &id);
    let s = client.get_schedule(&id);
    assert_eq!(s.status, ScheduleStatus::Cancelled);
}

#[test]
#[should_panic(expected = "only the sender can cancel")]
fn test_cancel_by_non_sender_panics() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    client.cancel_recurring_payment(&executor, &id); // executor is not the sender
}

#[test]
#[should_panic(expected = "schedule is already cancelled")]
fn test_cancel_already_cancelled_panics() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    client.cancel_recurring_payment(&sender, &id);
    client.cancel_recurring_payment(&sender, &id); // second cancel must panic
}

#[test]
#[should_panic(expected = "schedule not found")]
fn test_cancel_unknown_id_panics() {
    let (env, contract_id, _, sender, ..) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.cancel_recurring_payment(&sender, &999);
}

// ── get_schedule ──────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "schedule not found")]
fn test_get_schedule_unknown_id_panics() {
    let (env, contract_id, ..) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.get_schedule(&999);
}

// ── #550: pause / resume ──────────────────────────────────────────────────────

#[test]
fn test_pause_sets_status_paused() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    client.pause_recurring_payment(&sender, &id);
    let s = client.get_schedule(&id);
    assert_eq!(s.status, ScheduleStatus::Paused);
}

#[test]
fn test_resume_sets_status_active_and_updates_next_payment_at() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    let before = env.ledger().timestamp();
    client.pause_recurring_payment(&sender, &id);
    advance_time(&env, 86400);
    client.resume_recurring_payment(&sender, &id);
    let s = client.get_schedule(&id);
    assert_eq!(s.status, ScheduleStatus::Active);
    assert_eq!(s.next_payment_at, before + 86400 + 86400);
}

#[test]
#[should_panic(expected = "Schedule is paused")]
fn test_execute_payment_while_paused_panics() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    client.pause_recurring_payment(&sender, &id);
    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
}

#[test]
fn test_resume_allows_execution() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 100_0000000i128;
    let id = create(&client, &token_id, &sender, &recipient, amount, 86400);
    client.pause_recurring_payment(&sender, &id);
    advance_time(&env, 86400);
    client.resume_recurring_payment(&sender, &id);
    // Resuming restarts the interval, so the next payment is due one interval later.
    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
    assert_eq!(token_balance(&env, &token_id, &recipient), amount);
}

#[test]
#[should_panic(expected = "schedule is already paused")]
fn test_pause_already_paused_panics() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    client.pause_recurring_payment(&sender, &id);
    client.pause_recurring_payment(&sender, &id);
}

#[test]
#[should_panic(expected = "schedule is cancelled")]
fn test_resume_cancelled_schedule_panics() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    client.cancel_recurring_payment(&sender, &id);
    client.resume_recurring_payment(&sender, &id);
}

#[test]
#[should_panic(expected = "only the sender can pause")]
fn test_pause_by_non_sender_panics() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    client.pause_recurring_payment(&executor, &id);
}

#[test]
#[should_panic(expected = "only the sender can resume")]
fn test_resume_by_non_sender_panics() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    client.pause_recurring_payment(&sender, &id);
    client.resume_recurring_payment(&executor, &id);
}

#[test]
#[should_panic(expected = "schedule is not paused")]
fn test_resume_active_schedule_panics() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    client.resume_recurring_payment(&sender, &id);
}

#[test]
fn test_cancel_paused_schedule() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    client.pause_recurring_payment(&sender, &id);
    client.cancel_recurring_payment(&sender, &id);
    let s = client.get_schedule(&id);
    assert_eq!(s.status, ScheduleStatus::Cancelled);
}

// ── #551: max_executions ──────────────────────────────────────────────────────

#[test]
fn test_max_executions_marks_schedule_completed() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    // grace_period_secs=3600, max_missed_executions=3 (defaults)
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &100_0000000, &86400, &2, &3600, &3,
    );

    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
    assert_eq!(client.get_schedule(&id).status, ScheduleStatus::Active);

    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
    assert_eq!(count_events(&env, &contract_id, "ScheduleCompleted"), 1);
    // Finished successfully: Completed, not Cancelled.
    assert_eq!(client.get_schedule(&id).status, ScheduleStatus::Completed);
    assert_eq!(client.get_schedule(&id).executions_completed, 2);
    assert_eq!(client.get_remaining_executions(&id), Some(0));
    assert!(client.get_active_schedules(&0, &50).is_empty());
}

#[test]
fn test_non_final_execution_does_not_emit_completed() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &100_0000000, &86400, &2, &3600, &3,
    );
    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
    assert_eq!(count_events(&env, &contract_id, "ScheduleCompleted"), 0);
}

#[test]
#[should_panic(expected = "schedule is already completed")]
fn test_cancel_completed_schedule_panics() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &100_0000000, &86400, &1, &3600, &3,
    );
    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
    client.cancel_recurring_payment(&sender, &id);
}

#[test]
#[should_panic(expected = "cannot update completed schedule")]
fn test_update_amount_on_completed_schedule_panics() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &100_0000000, &86400, &1, &3600, &3,
    );
    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
    client.update_amount(&sender, &id, &200_0000000);
}

#[test]
#[should_panic(expected = "schedule is not active")]
fn test_execute_payment_after_max_executions_panics() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &100_0000000, &86400, &1, &3600, &3,
    );

    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
    // schedule is now Completed — next call must panic
    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
}

#[test]
fn test_max_executions_zero_means_unlimited() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 100_0000000i128;
    // max_executions = 0 → unlimited
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &amount, &86400, &0, &3600, &3,
    );

    for _ in 0..5 {
        advance_time(&env, 86400);
        client.execute_payment(&executor, &id);
    }
    assert_eq!(client.get_schedule(&id).status, ScheduleStatus::Active);
    assert_eq!(token_balance(&env, &token_id, &recipient), amount * 5);
}

// ── #552: fee collection ──────────────────────────────────────────────────────

#[test]
fn test_fee_deducted_from_recipient_forwarded_to_admin() {
    let (env, contract_id, token_id, sender, recipient, executor, admin) = setup_with_fee(500); // 5 %
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 1_000_0000000i128;
    let id = create(&client, &token_id, &sender, &recipient, amount, 86400);

    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);

    let expected_fee = amount * 500 / 10_000; // 50_000_000
    let expected_net = amount - expected_fee;  // 950_000_000

    assert_eq!(token_balance(&env, &token_id, &recipient), expected_net);
    assert_eq!(token_balance(&env, &token_id, &admin), expected_fee);
}

#[test]
fn test_zero_fee_sends_full_amount_to_recipient() {
    let (env, contract_id, token_id, sender, recipient, executor, admin) = setup_with_fee(0);
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 1_000_0000000i128;
    let id = create(&client, &token_id, &sender, &recipient, amount, 86400);

    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);

    assert_eq!(token_balance(&env, &token_id, &recipient), amount);
    assert_eq!(token_balance(&env, &token_id, &admin), 0);
}

#[test]
fn test_fee_accumulates_over_multiple_executions() {
    let (env, contract_id, token_id, sender, recipient, executor, admin) = setup_with_fee(200); // 2 %
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 500_0000000i128;
    let id = create(&client, &token_id, &sender, &recipient, amount, 86400);

    let fee_per_execution = amount * 200 / 10_000;
    let net_per_execution = amount - fee_per_execution;

    for i in 1..=3u32 {
        advance_time(&env, 86400);
        client.execute_payment(&executor, &id);
        assert_eq!(token_balance(&env, &token_id, &admin), fee_per_execution * i as i128);
        assert_eq!(token_balance(&env, &token_id, &recipient), net_per_execution * i as i128);
    }
}

// ── Grace period tests ────────────────────────────────────────────────────────

/// Acceptance criterion 1: execution within the grace period succeeds.
/// Schedule has a 1-hour grace window. Advancing exactly to next_payment_at
/// + interval + grace_period_secs - 1 should still execute successfully.
#[test]
fn test_execute_within_grace_period_succeeds() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 200_0000000i128;
    let grace = 3_600u64; // 1 hour
    // Use create_recurring_payment to set an explicit grace period
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &amount, &86400, &0, &grace, &3,
    );

    // Advance to exactly next_payment_at (due window opens)
    advance_time(&env, 86400);
    // Advance a further 1 800 s — halfway through the grace period
    advance_time(&env, 1_800);

    let before = token_balance(&env, &token_id, &recipient);
    client.execute_payment(&executor, &id); // must NOT panic
    let after = token_balance(&env, &token_id, &recipient);
    assert_eq!(after - before, amount);

    // Consecutive misses must remain zero after a successful execution
    assert_eq!(client.get_missed_executions(&id), 0);
    assert_eq!(client.get_schedule(&id).consecutive_misses, 0);
}

/// Acceptance criterion 2: execution after the grace period records a miss
/// instead of paying. (It returns normally: a panic would roll back the miss.)
#[test]
fn test_execute_after_grace_period_records_miss() {
/// Acceptance criterion 2: calling after the grace period records a miss
/// instead of paying. It must not panic, or the recorded miss would be
/// rolled back.
#[test]
fn test_execute_after_grace_period_records_miss_without_paying() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 200_0000000i128;
    let grace = 3_600u64; // 1 hour
    let interval = 86_400u64;
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &amount, &interval, &0, &grace, &3,
    );
    let first_due = client.get_schedule(&id).next_payment_at;

    // Advance past next_payment_at AND the full grace window
    advance_time(&env, 86400 + grace + 1);

    client.execute_payment(&executor, &id);
    assert_eq!(client.get_missed_executions(&id), 1);
    assert_eq!(token_balance(&env, &token_id, &recipient), 0);
    advance_time(&env, interval + grace + 1);
    client.execute_payment(&executor, &id);

    assert_eq!(token_balance(&env, &token_id, &recipient), 0);
    assert_eq!(client.get_missed_executions(&id), 1);
    let s = client.get_schedule(&id);
    assert_eq!(s.consecutive_misses, 1);
    assert_eq!(s.next_payment_at, first_due + interval);
    assert_eq!(s.status, ScheduleStatus::Active);
}

/// Acceptance criterion 3: schedule is auto-cancelled after 3 consecutive
/// missed executions (max_missed_executions = 3).
#[test]
fn test_auto_cancel_after_three_consecutive_misses() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 100_0000000i128;
    let grace = 3_600u64; // 1 hour
    let max_missed = 3u64;
    let interval = 86_400u64; // daily
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &amount, &interval, &0, &grace, &max_missed,
    );

    // Each late execute_payment call records a miss and advances next_payment_at
    // (it returns normally so the recorded miss is persisted).

    // Miss 1
    advance_time(&env, interval + grace + 1);
    client.execute_payment(&executor, &id);
    assert_eq!(client.get_missed_executions(&id), 1);
    assert_eq!(client.get_schedule(&id).status, ScheduleStatus::Active);

    // Miss 2: next_payment_at was advanced by the miss handler;
    // advance past that new window + grace period again.
    advance_time(&env, interval + grace + 1);
    client.execute_payment(&executor, &id);
    assert_eq!(count_events(&env, &contract_id, "ScheduleAutoCancelled"), 0);
    assert_eq!(client.get_missed_executions(&id), 2);
    assert_eq!(client.get_schedule(&id).status, ScheduleStatus::Active);

    // Miss 3: triggers auto-cancel
    advance_time(&env, interval + grace + 1);
    client.execute_payment(&executor, &id);
    assert_eq!(count_events(&env, &contract_id, "ScheduleAutoCancelled"), 1);
    assert_eq!(client.get_missed_executions(&id), 3);
    assert_eq!(client.get_schedule(&id).status, ScheduleStatus::Cancelled);
    assert_eq!(token_balance(&env, &token_id, &recipient), 0);
}

/// A schedule nobody executed for ~six months must count every missed
/// interval, not one miss per call, so it is auto-cancelled on the first call.
#[test]
fn test_abandoned_schedule_counts_every_missed_interval_and_auto_cancels() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let interval = 86_400u64;
    let grace = 3_600u64;
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &100_0000000, &interval, &0, &grace, &3,
    );
    let first_due = client.get_schedule(&id).next_payment_at;

    // 180 daily windows have fully expired (deadline of window 179 is
    // first_due + 179 days + grace; we are one second past it).
    set_time(&env, first_due + 179 * interval + grace + 1);
    client.execute_payment(&executor, &id);
    assert_eq!(count_events(&env, &contract_id, "PaymentMissed"), 1);
    assert_eq!(count_events(&env, &contract_id, "ScheduleAutoCancelled"), 1);

    let s = client.get_schedule(&id);
    assert_eq!(s.consecutive_misses, 180);
    assert_eq!(client.get_missed_executions(&id), 180);
    assert_eq!(s.next_payment_at, first_due + 180 * interval);
    assert_eq!(s.status, ScheduleStatus::Cancelled);
    assert_eq!(token_balance(&env, &token_id, &recipient), 0);
}

/// Windows still inside their grace period are not counted as missed and
/// can be executed right after the misses are recorded.
#[test]
fn test_open_window_is_not_counted_as_missed() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 100_0000000i128;
    let interval = 86_400u64;
    let grace = 3_600u64;
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &amount, &interval, &0, &grace, &5,
    );
    let first_due = client.get_schedule(&id).next_payment_at;

    // Windows 0 and 1 expired; window 2 is due and inside its grace period.
    set_time(&env, first_due + 2 * interval + grace / 2);
    client.execute_payment(&executor, &id);

    let s = client.get_schedule(&id);
    assert_eq!(s.consecutive_misses, 2);
    assert_eq!(s.next_payment_at, first_due + 2 * interval);
    assert_eq!(s.status, ScheduleStatus::Active);

    // The open window can now be paid in a follow-up call.
    client.execute_payment(&executor, &id);
    assert_eq!(token_balance(&env, &token_id, &recipient), amount);
    assert_eq!(client.get_missed_executions(&id), 0);
}

// ── Issue #763: schedule query functions ────────────────────────────────────

#[test]
fn test_get_user_schedules_empty() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let other = Address::generate(&env);
    let ids = client.get_user_schedules(&other, &0, &50);
    assert_eq!(ids.len(), 0);
}

#[test]
fn test_get_user_schedules_three_schedules() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id1 = client.create_recurring_payment(&sender, &recipient, &token_id, &100_0000000, &86400, &0, &3600, &3);
    let id2 = client.create_recurring_payment(&sender, &recipient, &token_id, &200_0000000, &86400, &0, &3600, &3);
    let id3 = client.create_recurring_payment(&sender, &recipient, &token_id, &300_0000000, &86400, &0, &3600, &3);
    let ids = client.get_user_schedules(&sender, &0, &50);
    assert_eq!(ids.len(), 3);
    assert_eq!(ids.get(0).unwrap(), id1);
    assert_eq!(ids.get(1).unwrap(), id2);
    assert_eq!(ids.get(2).unwrap(), id3);
}

#[test]
fn test_get_active_schedules_filter() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id1 = client.create_recurring_payment(&sender, &recipient, &token_id, &100_0000000, &86400, &0, &3600, &3);
    let id2 = client.create_recurring_payment(&sender, &recipient, &token_id, &200_0000000, &86400, &0, &3600, &3);
    // Cancel id1 — only id2 should appear in active list
    client.cancel_recurring_payment(&sender, &id1);
    let active = client.get_active_schedules(&0, &50);
    assert_eq!(active.len(), 1);
    assert_eq!(active.get(0).unwrap(), id2);
}

#[test]
#[should_panic(expected = "Schedule limit per sender reached")]
fn test_per_sender_limit_enforcement() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    // Create 500 schedules to hit the limit
    for _ in 0..500 {
        client.create_recurring_payment(&sender, &recipient, &token_id, &100_0000000, &86400, &0, &3600, &3);
    }
    // 501st must panic
    client.create_recurring_payment(&sender, &recipient, &token_id, &100_0000000, &86400, &0, &3600, &3);
}

// ── SC-031: Pagination Bounds & Overflow Guard Tests ─────────────────────────

#[test]
fn test_pagination_extreme_bounds_get_user_schedules() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);

    client.create_recurring_payment(&sender, &recipient, &token_id, &100_0000000, &86400, &0, &3600, &3);

    // Test extreme start values (no overflow panic, returns empty vec)
    let res1 = client.get_user_schedules(&sender, &u32::MAX, &50);
    assert_eq!(res1.len(), 0);

    // Test extreme limit values (clamped to 50 max, does not panic)
    let res2 = client.get_user_schedules(&sender, &0, &u32::MAX);
    assert_eq!(res2.len(), 1);

    // Test start + limit overflow scenario
    let res3 = client.get_user_schedules(&sender, &(u32::MAX - 10), &u32::MAX);
    assert_eq!(res3.len(), 0);
}

#[test]
fn test_pagination_extreme_bounds_get_active_schedules() {
    let (env, contract_id, token_id, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);

    client.create_recurring_payment(&sender, &recipient, &token_id, &100_0000000, &86400, &0, &3600, &3);

    // Test extreme start values (no overflow panic, returns empty vec)
    let res1 = client.get_active_schedules(&u64::MAX, &50);
    assert_eq!(res1.len(), 0);

    // Test extreme limit values (clamped to 50 max, does not panic)
    let res2 = client.get_active_schedules(&0, &u64::MAX);
    assert_eq!(res2.len(), 1);

    // Test start + limit overflow scenario
    let res3 = client.get_active_schedules(&(u64::MAX - 10), &u64::MAX);
    assert_eq!(res3.len(), 0);
}

// ── SC-030: Circuit Breaker / Cadence Enforcement Against Compromised Executor ──

#[test]
#[should_panic(expected = "payment not yet due")]
fn test_execute_payment_immediate_succession_rejected() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);

    let interval = 86400u64;
    let id = client.create_recurring_payment(
        &sender,
        &recipient,
        &token_id,
        &100_0000000,
        &interval,
        &0,
        &3600,
        &3,
    );

    // Advance to due time
    advance_time(&env, interval);

    // First execution succeeds
    client.execute_payment(&executor, &id);

    // Immediate second execution must panic with "payment not yet due"
    client.execute_payment(&executor, &id);
}

#[test]
fn test_compromised_executor_rapid_calls_cannot_drain_funds() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);

    let initial_balance = 10_000_0000000i128;
    let payment_amount = 100_0000000i128;
    let interval = 86400u64;

    let id = client.create_recurring_payment(
        &sender,
        &recipient,
        &token_id,
        &payment_amount,
        &interval,
        &0,
        &3600,
        &3,
    );

    // Advance to first payment due date
    advance_time(&env, interval);

    // Executor executes the valid payment
    client.execute_payment(&executor, &id);
    assert_eq!(token_balance(&env, &token_id, &recipient), payment_amount);
    assert_eq!(token_balance(&env, &token_id, &sender), initial_balance - payment_amount);

    // Simulated rogue/compromised executor attempts rapid repeated calls in a loop
    for _ in 0..20 {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.execute_payment(&executor, &id);
        }));
        assert!(result.is_err(), "rapid repeated call must be rejected");
    }

    // Total funds moved must still strictly equal exactly 1 payment amount
    assert_eq!(token_balance(&env, &token_id, &recipient), payment_amount);
    assert_eq!(token_balance(&env, &token_id, &sender), initial_balance - payment_amount);

    // Advance halfway through interval (12 hours) — rogue calls must still fail
    advance_time(&env, 43200);
    for _ in 0..10 {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.execute_payment(&executor, &id);
        }));
        assert!(result.is_err(), "call before interval elapsed must be rejected");
    }
    assert_eq!(token_balance(&env, &token_id, &recipient), payment_amount);

    // Advance remaining 12 hours (full interval elapsed) — next execution now succeeds
    advance_time(&env, 43200);
    client.execute_payment(&executor, &id);
    assert_eq!(token_balance(&env, &token_id, &recipient), payment_amount * 2);
    assert_eq!(token_balance(&env, &token_id, &sender), initial_balance - payment_amount * 2);
}

// ── SC-029: Pre-authorization semantics, replay/expiry tests ─────────────────

#[test]
#[should_panic(expected = "schedule is not active")]
fn test_create_then_cancel_schedule_fails_execution() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);

    // Cancel the schedule
    client.cancel_recurring_payment(&sender, &id);

    // Attempting to execute must fail because cancellation revokes authorization
    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
}

#[test]
#[should_panic(expected = "schedule is not active")]
fn test_authorization_expiry_when_max_executions_reached() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    // 1 execution max
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &100_0000000, &86400, &1, &3600, &3,
    );

    // Execute first (and only) allowed execution
    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);

    // Next execution should fail as authorization has expired
    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
}

// ── SC-028: RecipientUpdated event transparency and consent tests ─────────────

#[test]
fn test_update_recipient_emits_event_with_old_and_new_addresses() {
    let (env, contract_id, token_id, sender, old_recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &old_recipient, 100_0000000, 86400);

    let new_recipient = Address::generate(&env);
    client.update_recipient(&sender, &id, &new_recipient);
    // Events are only kept for the most recent invocation, so read them first.
    let events = all_events(&env);

    // Verify recipient has been updated in schedule
    let schedule = client.get_schedule(&id);
    assert_eq!(schedule.recipient, new_recipient);

    // Verify event publication with both old and new addresses for notification
    let mut found_event = false;
    for i in 0..events.len() {
        let (contract, topics, data) = events.get(i).unwrap();
        if contract == contract_id && topics.len() > 0 {
            if let Ok(sym) = soroban_sdk::Symbol::try_from_val(&env, &topics.get(0).unwrap()) {
                if sym == soroban_sdk::Symbol::new(&env, "RecipientUpdated") {
                    if let Ok(event) = RecipientUpdated::try_from_val(&env, &data) {
                        assert_eq!(event.schedule_id, id);
                        assert_eq!(event.old_recipient, old_recipient);
                        assert_eq!(event.new_recipient, new_recipient);
                        assert_eq!(event.updated_by, sender);
                        found_event = true;
                    }
                }
            }
        }
    }
    assert!(found_event, "RecipientUpdated event with old and new recipient was not emitted");
}

// ── SC-027: Consecutive-miss and execution accounting tests ───────────────────

#[test]
fn test_consecutive_misses_mix_with_successful_execution_and_counter_accuracy() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 100_0000000i128;
    let grace = 3_600u64;
    let max_missed = 3u64;
    let interval = 86_400u64;
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &amount, &interval, &5, &grace, &max_missed,
    );

    assert_eq!(client.get_remaining_executions(&id), Some(5));
    assert_eq!(client.get_missed_executions(&id), 0);

    // Miss 1
    advance_time(&env, interval + grace + 1);
    client.execute_payment(&executor, &id);
    assert_eq!(client.get_missed_executions(&id), 1);
    assert_eq!(client.get_remaining_executions(&id), Some(5));

    // Miss 2
    advance_time(&env, interval + grace + 1);
    client.execute_payment(&executor, &id);
    assert_eq!(client.get_missed_executions(&id), 2);
    assert_eq!(client.get_remaining_executions(&id), Some(5));

    // Now execute successfully at the start of the next window
    let now = env.ledger().timestamp();
    advance_time(&env, client.get_schedule(&id).next_payment_at - now);
    // Now execute successfully inside the next window
    set_time(&env, client.get_schedule(&id).next_payment_at);
    client.execute_payment(&executor, &id);

    // Successful execution must reset consecutive_misses to 0 and reduce remaining executions
    assert_eq!(client.get_missed_executions(&id), 0);
    assert_eq!(client.get_remaining_executions(&id), Some(4));
    assert_eq!(client.get_schedule(&id).status, ScheduleStatus::Active);

    // Miss 1 again after reset
    advance_time(&env, interval + grace + 1);
    client.execute_payment(&executor, &id);
    assert_eq!(client.get_missed_executions(&id), 1);
    assert_eq!(client.get_remaining_executions(&id), Some(4));
}

/// Events emitted so far, as `(contract, topics, data)` tuples.
///
/// soroban-sdk 23+ returns events in XDR form; this converts them back to
/// host values so tests can decode payloads with `FromVal`.
#[allow(dead_code)]
fn all_events(
    env: &soroban_sdk::Env,
) -> soroban_sdk::Vec<(
    soroban_sdk::Address,
    soroban_sdk::Vec<soroban_sdk::Val>,
    soroban_sdk::Val,
)> {
    use soroban_sdk::testutils::Events as _;
    use soroban_sdk::{xdr, Address, TryFromVal, Val, Vec};
    let mut out = Vec::new(env);
    for e in env.events().all().events() {
        let xdr::ContractEventBody::V0(body) = &e.body;
        let Some(contract_id) = e.contract_id.clone() else {
            continue;
        };
        let contract =
            Address::try_from_val(env, &xdr::ScAddress::Contract(contract_id)).unwrap();
        let mut topics: Vec<Val> = Vec::new(env);
        for t in body.topics.iter() {
            topics.push_back(Val::try_from_val(env, t).unwrap());
        }
        out.push_back((contract, topics, Val::try_from_val(env, &body.data).unwrap()));
    }
    out
}

// ── SC-187: emergency pause ──────────────────────────────────────────────────

#[test]
fn test_contract_pause_blocks_execute_payment() {
    let (env, contract_id, token_id, sender, recipient, executor, admin) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);

    client.pause(&admin);
    assert!(client.is_paused());

    advance_time(&env, 86400);
    let res = client.try_execute_payment(&executor, &id);
    assert!(res.is_err());
    assert_eq!(token_balance(&env, &token_id, &recipient), 0);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_execute_payment_panics_while_contract_paused() {
    let (env, contract_id, token_id, sender, recipient, executor, admin) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);

    client.pause(&admin);
    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
}

#[test]
fn test_pause_emits_paused_and_unpaused_events() {
    let (env, contract_id, _, _, _, _, admin) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);

    client.pause(&admin);
    assert_eq!(count_events(&env, &contract_id, "Paused"), 1);

    client.unpause(&admin);
    assert_eq!(count_events(&env, &contract_id, "Unpaused"), 1);
    assert!(!client.is_paused());
}

#[test]
fn test_user_can_cancel_and_pause_schedule_while_contract_paused() {
    let (env, contract_id, token_id, sender, recipient, _, admin) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id1 = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);
    let id2 = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);

    client.pause(&admin);

    // Users can always opt out while the contract is paused.
    client.cancel_recurring_payment(&sender, &id1);
    assert_eq!(client.get_schedule(&id1).status, ScheduleStatus::Cancelled);

    client.pause_recurring_payment(&sender, &id2);
    assert_eq!(client.get_schedule(&id2).status, ScheduleStatus::Paused);
}

#[test]
fn test_window_passing_during_pause_does_not_auto_cancel() {
    let (env, contract_id, token_id, sender, recipient, executor, admin) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let interval = 86_400u64;
    let grace = 3_600u64;
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &100_0000000, &interval, &0, &grace, &1,
    );

    client.pause(&admin);
    // Several windows elapse entirely during the pause.
    advance_time(&env, 5 * interval + grace + 1);
    client.unpause(&admin);

    // The schedule must still be active and must not have accumulated misses.
    let s = client.get_schedule(&id);
    assert_eq!(s.status, ScheduleStatus::Active);
    assert_eq!(s.consecutive_misses, 0);
    assert_eq!(client.get_missed_executions(&id), 0);

    // And it can be executed once due again.
    set_time(&env, s.next_payment_at);
    client.execute_payment(&executor, &id);
    assert_eq!(token_balance(&env, &token_id, &recipient), 100_0000000);
}

// ── SC-188: initialize requires the admin's signature ────────────────────────

#[test]
fn test_initialize_requires_admin_auth() {
    let env = Env::default();
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin).address();
    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let contract_id = env.register(RecurringPaymentsContract, ());
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);

    // Only the attacker authorizes; the admin key does not co-sign.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &attacker,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: (&admin, &token_id, &0u32).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_initialize(&admin, &token_id, &0);
    assert!(res.is_err(), "initialize must require the admin's signature");
}

// ── SC-189: TTL extension ────────────────────────────────────────────────────

#[test]
fn test_schedule_readable_after_ttl_advance() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = create(&client, &token_id, &sender, &recipient, 100_0000000, 86400);

    // Advance the ledger sequence far past the default entry TTL.
    let start = env.ledger().sequence();
    env.ledger().set_sequence_number(start + 5_000_000);

    // Activity bumps the TTLs, so the record stays readable.
    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);

    let s = client.get_schedule(&id);
    assert_eq!(s.sender, sender);
    assert_eq!(s.executions_completed, 1);
    assert_eq!(client.get_user_schedules(&sender, &0, &50).len(), 1);
}

// ── Due-date anchoring: late executions must not drift the schedule ──────────

#[test]
fn test_late_execution_within_grace_keeps_schedule_anchor() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let interval = 30 * 86400u64;
    let grace = 86400u64;
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &100_0000000, &interval, &0, &grace, &3,
    );
    let first_due = client.get_schedule(&id).next_payment_at;

    // Execute 20 hours late — inside the 24 h grace window.
    advance_time(&env, interval + 20 * 3600);
    client.execute_payment(&executor, &id);

    let s = client.get_schedule(&id);
    assert_eq!(s.next_payment_at, first_due + interval);
}

#[test]
fn test_repeated_late_executions_do_not_drift() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let interval = 30 * 86400u64;
    let grace = 86400u64;
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &10_0000000, &interval, &0, &grace, &3,
    );
    let first_due = client.get_schedule(&id).next_payment_at;

    // Twelve cycles, each executed 20 hours after its due date.
    for k in 0..12u64 {
        let due = first_due + k * interval;
        let now = env.ledger().timestamp();
        advance_time(&env, due + 20 * 3600 - now);
        client.execute_payment(&executor, &id);
        assert_eq!(client.get_schedule(&id).next_payment_at, due + interval);
    }

    let s = client.get_schedule(&id);
    assert_eq!(s.executions_completed, 12);
    assert_eq!(s.next_payment_at, first_due + 12 * interval);
    assert_eq!(token_balance(&env, &token_id, &recipient), 10_0000000 * 12);
}

#[test]
fn test_very_late_execution_skips_to_next_grid_slot() {
    // Grace (1 h) longer than the interval (10 min): a payment executed 25 min
    // late must land on the next slot of the original grid after `now`, not
    // allow a burst of back-to-back executions.
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let interval = 600u64;
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &10_0000000, &interval, &0, &3600, &3,
    );
    let first_due = client.get_schedule(&id).next_payment_at;

    advance_time(&env, interval + 25 * 60);
    client.execute_payment(&executor, &id);

    let next = client.get_schedule(&id).next_payment_at;
    assert_eq!(next, first_due + 3 * interval);
    assert!(next > env.ledger().timestamp());
    assert!(client.try_execute_payment(&executor, &id).is_err());
}
