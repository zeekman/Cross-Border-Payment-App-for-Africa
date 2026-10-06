#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
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
    let token_id = env.register_stellar_asset_contract(token_admin.clone());

    let admin = Address::generate(&env);

    // Deploy the recurring-payments contract
    let contract_id = env.register_contract(None, RecurringPaymentsContract);
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

// ── initialize ────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_ok() {
    let env = Env::default();
    env.mock_all_auths();
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin);
    let admin = Address::generate(&env);
    let contract_id = env.register_contract(None, RecurringPaymentsContract);
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
    let token_id = env.register_stellar_asset_contract(token_admin);
    let admin = Address::generate(&env);
    let contract_id = env.register_contract(None, RecurringPaymentsContract);
    RecurringPaymentsContractClient::new(&env, &contract_id).initialize(&admin, &token_id, &10_001);
}

// ── authorize_recurring ───────────────────────────────────────────────────────

#[test]
fn test_authorize_recurring_returns_id_one() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &1_000_0000000, &86400);
    assert_eq!(id, 1);
}

#[test]
fn test_authorize_recurring_stores_schedule() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &500_0000000, &3600);
    let s = client.get_schedule(&id);
    assert_eq!(s.sender, sender);
    assert_eq!(s.recipient, recipient);
    assert_eq!(s.amount, 500_0000000);
    assert_eq!(s.interval, 3600);
    assert_eq!(s.status, ScheduleStatus::Active);
}

#[test]
fn test_authorize_recurring_ids_increment() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id1 = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    let id2 = client.authorize_recurring(&sender, &recipient, &200_0000000, &86400);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_authorize_zero_amount_panics() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.authorize_recurring(&sender, &recipient, &0, &86400);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_authorize_negative_amount_panics() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.authorize_recurring(&sender, &recipient, &-1, &86400);
}

#[test]
#[should_panic(expected = "interval must be > 0")]
fn test_authorize_zero_interval_panics() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.authorize_recurring(&sender, &recipient, &100_0000000, &0);
}

// ── execute_payment ───────────────────────────────────────────────────────────

#[test]
fn test_execute_payment_transfers_funds() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 1_000_0000000i128;
    let id = client.authorize_recurring(&sender, &recipient, &amount, &86400);

    advance_time(&env, 86400);

    let before = token_balance(&env, &token_id, &recipient);
    client.execute_payment(&executor, &id);
    let after = token_balance(&env, &token_id, &recipient);
    assert_eq!(after - before, amount);
}

#[test]
fn test_execute_payment_advances_next_payment_at() {
    let (env, contract_id, _, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);

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
    let id = client.authorize_recurring(&sender, &recipient, &amount, &86400);

    for _ in 0..3 {
        advance_time(&env, 86400);
        client.execute_payment(&executor, &id);
    }

    assert_eq!(token_balance(&env, &token_id, &recipient), amount * 3);
}

#[test]
#[should_panic(expected = "payment not yet due")]
fn test_execute_payment_too_early_panics() {
    let (env, contract_id, _, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
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
    let (env, contract_id, _, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.cancel_recurring(&sender, &id);

    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
}

// ── cancel_recurring ──────────────────────────────────────────────────────────

#[test]
fn test_cancel_sets_status_cancelled() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.cancel_recurring(&sender, &id);
    let s = client.get_schedule(&id);
    assert_eq!(s.status, ScheduleStatus::Cancelled);
}

#[test]
#[should_panic(expected = "only the sender can cancel")]
fn test_cancel_by_non_sender_panics() {
    let (env, contract_id, _, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.cancel_recurring(&executor, &id); // executor is not the sender
}

#[test]
#[should_panic(expected = "schedule is already cancelled")]
fn test_cancel_already_cancelled_panics() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.cancel_recurring(&sender, &id);
    client.cancel_recurring(&sender, &id); // second cancel must panic
}

#[test]
#[should_panic(expected = "schedule not found")]
fn test_cancel_unknown_id_panics() {
    let (env, contract_id, _, sender, ..) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.cancel_recurring(&sender, &999);
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
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.pause_recurring_payment(&sender, &id);
    let s = client.get_recurring_payment(&id);
    assert_eq!(s.status, ScheduleStatus::Paused);
}

#[test]
fn test_resume_sets_status_active_and_updates_next_payment_at() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    let before = env.ledger().timestamp();
    client.pause_recurring_payment(&sender, &id);
    advance_time(&env, 86400);
    client.resume_recurring_payment(&sender, &id);
    let s = client.get_recurring_payment(&id);
    assert_eq!(s.status, ScheduleStatus::Active);
    assert_eq!(s.next_payment_at, before + 86400 + 86400);
}

#[test]
#[should_panic(expected = "Schedule is paused")]
fn test_execute_payment_while_paused_panics() {
    let (env, contract_id, _, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.pause_recurring_payment(&sender, &id);
    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
}

#[test]
fn test_resume_allows_execution() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 100_0000000i128;
    let id = client.authorize_recurring(&sender, &recipient, &amount, &86400);
    client.pause_recurring_payment(&sender, &id);
    advance_time(&env, 86400);
    client.resume_recurring_payment(&sender, &id);
    client.execute_payment(&executor, &id);
    assert_eq!(token_balance(&env, &token_id, &recipient), amount);
}

#[test]
#[should_panic(expected = "schedule is already paused")]
fn test_pause_already_paused_panics() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.pause_recurring_payment(&sender, &id);
    client.pause_recurring_payment(&sender, &id);
}

#[test]
#[should_panic(expected = "schedule is cancelled")]
fn test_resume_cancelled_schedule_panics() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.cancel_recurring_payment(&sender, &id);
    client.resume_recurring_payment(&sender, &id);
}

#[test]
#[should_panic(expected = "only the sender can pause")]
fn test_pause_by_non_sender_panics() {
    let (env, contract_id, _, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.pause_recurring_payment(&executor, &id);
}

#[test]
#[should_panic(expected = "only the sender can resume")]
fn test_resume_by_non_sender_panics() {
    let (env, contract_id, _, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.pause_recurring_payment(&sender, &id);
    client.resume_recurring_payment(&executor, &id);
}

#[test]
#[should_panic(expected = "schedule is not paused")]
fn test_resume_active_schedule_panics() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.resume_recurring_payment(&sender, &id);
}

#[test]
fn test_cancel_paused_schedule() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.pause_recurring_payment(&sender, &id);
    client.cancel_recurring_payment(&sender, &id);
    let s = client.get_recurring_payment(&id);
    assert_eq!(s.status, ScheduleStatus::Cancelled);
}

// ── #551: max_executions ──────────────────────────────────────────────────────

#[test]
fn test_max_executions_auto_cancels_schedule() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    // grace_period_secs=3600, max_missed_executions=3 (defaults)
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &100_0000000, &86400, &2, &3600, &3,
    );

    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
    assert_eq!(client.get_recurring_payment(&id).status, ScheduleStatus::Active);

    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
    assert_eq!(client.get_recurring_payment(&id).status, ScheduleStatus::Cancelled);
    assert_eq!(client.get_recurring_payment(&id).executions_completed, 2);
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
    // schedule is now Cancelled — next call must panic
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
    assert_eq!(client.get_recurring_payment(&id).status, ScheduleStatus::Active);
    assert_eq!(token_balance(&env, &token_id, &recipient), amount * 5);
}

// ── #552: fee collection ──────────────────────────────────────────────────────

#[test]
fn test_fee_deducted_from_recipient_forwarded_to_admin() {
    let (env, contract_id, token_id, sender, recipient, executor, admin) = setup_with_fee(500); // 5 %
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 1_000_0000000i128;
    let id = client.authorize_recurring(&sender, &recipient, &amount, &86400);

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
    let id = client.authorize_recurring(&sender, &recipient, &amount, &86400);

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
    let id = client.authorize_recurring(&sender, &recipient, &amount, &86400);

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
    assert_eq!(client.get_recurring_payment(&id).consecutive_misses, 0);
}

/// Acceptance criterion 2: execution after grace period panics with the
/// correct message.
#[test]
#[should_panic(expected = "Execution window and grace period have both passed")]
fn test_execute_after_grace_period_panics() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 200_0000000i128;
    let grace = 3_600u64; // 1 hour
    let id = client.create_recurring_payment(
        &sender, &recipient, &token_id, &amount, &86400, &0, &grace, &3,
    );

    // Advance past next_payment_at AND the full grace window
    advance_time(&env, 86400 + grace + 1);

    // Must panic because both the execution window and grace period have passed
    client.execute_payment(&executor, &id);
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

    // Miss 1: advance past first window + grace, call execute_payment to trigger miss recording
    // Each call panics but also records the miss and advances next_payment_at.
    // We use std::panic::catch_unwind equivalent — in Soroban test env we rely on
    // the fact that the schedule IS mutated before the panic; so we call the
    // panicking functions and just verify state afterwards.

    // Miss 1
    advance_time(&env, interval + grace + 1);
    let result1 = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_payment(&executor, &id);
    }));
    assert!(result1.is_err(), "expected panic for miss 1");
    assert_eq!(client.get_missed_executions(&id), 1);
    assert_eq!(client.get_recurring_payment(&id).status, ScheduleStatus::Active);

    // Miss 2: the schedule's next_payment_at was advanced by the miss handler;
    // advance past that new window + grace period again.
    advance_time(&env, interval + grace + 1);
    let result2 = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_payment(&executor, &id);
    }));
    assert!(result2.is_err(), "expected panic for miss 2");
    assert_eq!(client.get_missed_executions(&id), 2);
    assert_eq!(client.get_recurring_payment(&id).status, ScheduleStatus::Active);

    // Miss 3: triggers auto-cancel
    advance_time(&env, interval + grace + 1);
    let result3 = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_payment(&executor, &id);
    }));
    assert!(result3.is_err(), "expected panic for miss 3");
    assert_eq!(client.get_missed_executions(&id), 3);
    // After 3 consecutive misses the schedule must be Cancelled
    assert_eq!(
        client.get_recurring_payment(&id).status,
        ScheduleStatus::Cancelled
    );
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
// ── SC-029: Pre-authorization semantics, replay/expiry tests ─────────────────

#[test]
#[should_panic(expected = "schedule is not active")]
fn test_authorize_then_cancel_schedule_fails_execution() {
    let (env, contract_id, _, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);

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
    let (env, contract_id, _, sender, old_recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &old_recipient, &100_0000000, &86400);

    let new_recipient = Address::generate(&env);
    client.update_recipient(&sender, &id, &new_recipient);

    // Verify recipient has been updated in schedule
    let schedule = client.get_schedule(&id);
    assert_eq!(schedule.recipient, new_recipient);

    // Verify event publication with both old and new addresses for notification
    let events = env.events().all();
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
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_payment(&executor, &id);
    }));
    assert_eq!(client.get_missed_executions(&id), 1);
    assert_eq!(client.get_remaining_executions(&id), Some(5));

    // Miss 2
    advance_time(&env, interval + grace + 1);
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_payment(&executor, &id);
    }));
    assert_eq!(client.get_missed_executions(&id), 2);
    assert_eq!(client.get_remaining_executions(&id), Some(5));

    // Now execute successfully in the next window
    advance_time(&env, interval);
    client.execute_payment(&executor, &id);

    // Successful execution must reset consecutive_misses to 0 and reduce remaining executions
    assert_eq!(client.get_missed_executions(&id), 0);
    assert_eq!(client.get_remaining_executions(&id), Some(4));
    assert_eq!(client.get_schedule(&id).status, ScheduleStatus::Active);

    // Miss 1 again after reset
    advance_time(&env, interval + grace + 1);
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_payment(&executor, &id);
    }));
    assert_eq!(client.get_missed_executions(&id), 1);
    assert_eq!(client.get_remaining_executions(&id), Some(4));
}

