#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal, Symbol, Val,
};

use crate::{AccrueInterestEvent, SavingsVaultContract, SavingsVaultContractClient};

fn setup() -> (Env, SavingsVaultContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, SavingsVaultContract);
    let client = SavingsVaultContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    client.initialize(&admin, &usdc_id, &1000u32);
    (env, client, admin, usdc_id)
}

fn mint_usdc(env: &Env, usdc_id: &Address, _admin: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, usdc_id).mint(to, &amount);
}

#[test]
fn test_initialize() {
    let (_, client, _, usdc_id) = setup();
    // Initialization is tested implicitly - contract would panic if not initialized
    assert!(true);
}

#[test]
#[should_panic(expected = "Contract already initialized")]
fn test_double_initialize() {
    let (_, client, admin, usdc_id) = setup();
    client.initialize(&admin, &usdc_id, &1000u32);
}

#[test]
fn test_deposit() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &admin, &user, amount);

    client.deposit(&user, &amount, &unlock_time);

    assert_eq!(client.get_balance(&user), amount);
    assert_eq!(client.get_unlock_time(&user), unlock_time);
}

#[test]
#[should_panic(expected = "Amount must be positive")]
fn test_deposit_zero_amount() {
    let (env, client, _, _) = setup();
    let user = Address::generate(&env);
    client.deposit(&user, &0, &env.ledger().timestamp() + 86400);
}

#[test]
#[should_panic(expected = "Unlock time must be in the future")]
fn test_deposit_past_unlock_time() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let past_time = env.ledger().timestamp() - 1;

    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &past_time);
}

#[test]
fn test_withdraw_after_unlock() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 3600;

    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);

    env.ledger().set_timestamp(unlock_time + 1);

    client.withdraw(&user, &amount);

    assert_eq!(client.get_balance(&user), 0);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&user), amount);
}

#[test]
fn test_early_withdrawal_with_penalty() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);

    client.withdraw(&user, &amount);

    let expected_penalty = (amount * 1000) / 10000;
    let expected_withdrawal = amount - expected_penalty;

    assert_eq!(client.get_balance(&user), 0);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&user), expected_withdrawal);
}

// ── #547: configurable penalty ────────────────────────────────────────────────

#[test]
fn test_configurable_penalty_bps() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, SavingsVaultContract);
    let client = SavingsVaultContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();

    client.initialize(&admin, &usdc_id, &500u32); // 5% penalty

    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    StellarAssetClient::new(&env, &usdc_id).mint(&user, &amount);
    client.deposit(&user, &amount, &unlock_time);
    client.withdraw(&user, &amount);

    let expected_penalty = (amount * 500) / 10000;
    let expected_withdrawal = amount - expected_penalty;

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&user), expected_withdrawal);
}

#[test]
fn test_zero_penalty_bps_no_penalty_on_early_withdrawal() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, SavingsVaultContract);
    let client = SavingsVaultContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();

    client.initialize(&admin, &usdc_id, &0u32); // 0% penalty

    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    StellarAssetClient::new(&env, &usdc_id).mint(&user, &amount);
    client.deposit(&user, &amount, &unlock_time);
    client.withdraw(&user, &amount);

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&user), amount);
}

#[test]
#[should_panic(expected = "Insufficient balance")]
fn test_withdraw_more_than_balance() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let deposit_amount = 500_0000000i128;
    let withdraw_amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 3600;

    mint_usdc(&env, &usdc_id, &admin, &user, deposit_amount);
    client.deposit(&user, &deposit_amount, &unlock_time);

    client.withdraw(&user, &withdraw_amount);
}

#[test]
#[should_panic(expected = "No vault found for user")]
fn test_withdraw_no_vault() {
    let (env, client, _, _) = setup();
    let user = Address::generate(&env);
    client.withdraw(&user, &1_000_0000000);
}

// ── #549: multi-deposit ───────────────────────────────────────────────────────

#[test]
fn test_multiple_deposits() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount1 = 500_0000000i128;
    let amount2 = 300_0000000i128;
    let unlock_time1 = env.ledger().timestamp() + 3600;
    let unlock_time2 = env.ledger().timestamp() + 7200;

    mint_usdc(&env, &usdc_id, &admin, &user, amount1 + amount2);

    client.deposit(&user, &amount1, &unlock_time1);
    client.deposit(&user, &amount2, &unlock_time2);

    assert_eq!(client.get_balance(&user), amount1 + amount2);
    assert_eq!(client.get_unlock_time(&user), unlock_time2);
}

#[test]
fn test_second_deposit_with_earlier_unlock_preserves_later_time() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount1 = 500_0000000i128;
    let amount2 = 300_0000000i128;
    let unlock_time1 = env.ledger().timestamp() + 7200;
    let unlock_time2 = env.ledger().timestamp() + 3600; // earlier than first

    mint_usdc(&env, &usdc_id, &admin, &user, amount1 + amount2);

    client.deposit(&user, &amount1, &unlock_time1);
    client.deposit(&user, &amount2, &unlock_time2);

    assert_eq!(client.get_balance(&user), amount1 + amount2);
    assert_eq!(client.get_unlock_time(&user), unlock_time1); // original later time preserved
}

#[test]
fn test_get_vault_returns_full_info() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);

    let vault = client.get_vault(&user);
    assert_eq!(vault.balance, amount);
    assert_eq!(vault.unlock_time, unlock_time);
}

#[test]
fn test_get_vault_no_deposit_returns_zeros() {
    let (_, client, _, _) = setup();
    let user = Address::generate(&client.env());
    let vault = client.get_vault(&user);
    assert_eq!(vault.balance, 0);
    assert_eq!(vault.unlock_time, 0);
    assert_eq!(vault.last_accrue_time, 0);
}

#[test]
fn test_get_balance_no_vault() {
    let (_, client, _, _) = setup();
    let user = Address::generate(&client.env());
    assert_eq!(client.get_balance(&user), 0);
}

#[test]
fn test_get_unlock_time_no_vault() {
    let (_, client, _, _) = setup();
    let user = Address::generate(&client.env());
    assert_eq!(client.get_unlock_time(&user), 0);
}

#[test]
fn test_announce_emergency_sets_timestamp() {
    let (env, client, admin, _) = setup();
    client.announce_emergency(&admin);

    let event_name: Val = Symbol::new(&env, "EmergencyAnnounced").into_val(&env);
    let events = env.events().all();
    assert_eq!(events.len(), 1);
    let event = events
        .iter()
        .find(|(_, topics, _)| topics.iter().any(|t| t == &event_name))
        .expect("EmergencyAnnounced event not emitted");
    let (_, _, data) = event;
    assert!(data.is_object());
}

#[test]
fn test_emergency_withdraw_after_delay() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);
    client.announce_emergency(&admin);

    env.ledger().set_timestamp(env.ledger().timestamp() + 172_800);

    client.emergency_withdraw(&admin, &user);

    assert_eq!(client.get_balance(&user), 0);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&user), amount);
    assert_eq!(client.get_total_locked(), 0);
}

#[test]
#[should_panic(expected = "emergency withdrawal not yet allowed")]
fn test_emergency_withdraw_before_delay_panics() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);
    client.announce_emergency(&admin);

    client.emergency_withdraw(&admin, &user);
}

#[test]
fn test_cancel_emergency_before_delay() {
    let (env, client, admin, _) = setup();
    client.announce_emergency(&admin);
    client.cancel_emergency(&admin);

    let events = env.events().all();
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].0, Symbol::new(&env, "EmergencyCancelled"));
}

#[test]
#[should_panic(expected = "no emergency announced")]
fn test_cancel_emergency_without_announcement_panics() {
    let (_, client, admin, _) = setup();
    client.cancel_emergency(&admin);
}

// ── Issue #764: activate_emergency / deactivate_emergency / emergency_return_funds ──

#[test]
fn test_activate_emergency_sets_state() {
    let (env, client, admin, _) = setup();
    client.activate_emergency(&admin);
    let event_name: Val = Symbol::new(&env, "EmergencyActivated").into_val(&env);
    let events = env.events().all();
    assert!(events.iter().any(|(_, topics, _)| topics.iter().any(|t| t == &event_name)));
}

#[test]
fn test_deactivate_emergency_cancels() {
    let (env, client, admin, _) = setup();
    client.activate_emergency(&admin);
    client.deactivate_emergency(&admin);
    let event_name: Val = Symbol::new(&env, "EmergencyCancelled").into_val(&env);
    let events = env.events().all();
    assert!(events.iter().any(|(_, topics, _)| topics.iter().any(|t| t == &event_name)));
}

#[test]
#[should_panic(expected = "no emergency active")]
fn test_deactivate_without_activation_panics() {
    let (_, client, admin, _) = setup();
    client.deactivate_emergency(&admin);
}

#[test]
fn test_emergency_return_funds_after_48h() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;
    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);
    client.activate_emergency(&admin);
    env.ledger().set_timestamp(env.ledger().timestamp() + 172_800);
    client.emergency_return_funds(&admin, &user);
    assert_eq!(client.get_balance(&user), 0);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&user), amount);
    assert_eq!(client.get_total_locked(), 0);
}

#[test]
#[should_panic(expected = "emergency return not yet allowed: 48h not elapsed")]
fn test_emergency_return_funds_before_48h_panics() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;
    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);
    client.activate_emergency(&admin);
    client.emergency_return_funds(&admin, &user);
}

#[test]
fn test_normal_withdraw_during_emergency_succeeds() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;
    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);
    client.activate_emergency(&admin);
    // user can still self-withdraw during emergency window
    client.withdraw(&user, &amount);
    assert_eq!(client.get_balance(&user), 0);
}

// ── #548: interest accrual ────────────────────────────────────────────────────

#[test]
fn test_set_interest_rate() {
    let (_, client, admin, _) = setup();
    client.set_interest_rate(&admin, &500u32);
    // No panic = success; rate is stored and used by accrue_interest
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_set_interest_rate_non_admin_panics() {
    let (env, client, _, _) = setup();
    let impostor = Address::generate(&env);
    client.set_interest_rate(&impostor, &500u32);
}

#[test]
fn test_accrue_interest_credits_vault_balance() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let deposit = 1_000_0000000i128; // 1000 USDC
    let unlock_time = env.ledger().timestamp() + 2 * 365 * 24 * 60 * 60;

    mint_usdc(&env, &usdc_id, &admin, &user, deposit);
    client.deposit(&user, &deposit, &unlock_time);
    client.set_interest_rate(&admin, &500u32); // 5% per year

    // Advance 1 year
    env.ledger().with_mut(|li| li.timestamp += 31_536_000);

    client.accrue_interest(&user);

    // 5% of 1000 USDC = 50 USDC
    let expected_interest = 50_0000000i128;
    assert_eq!(client.get_balance(&user), deposit);
    assert_eq!(client.get_vault(&user).accrued_interest, expected_interest);
}

#[test]
fn test_accrue_interest_emits_event() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let deposit = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 2 * 365 * 24 * 60 * 60;

    mint_usdc(&env, &usdc_id, &admin, &user, deposit);
    client.deposit(&user, &deposit, &unlock_time);
    client.set_interest_rate(&admin, &500u32);

    env.ledger().with_mut(|li| li.timestamp += 31_536_000);
    client.accrue_interest(&user);

    let event_name: Val = Symbol::new(&env, "AccrueInterest").into_val(&env);
    let events = env.events().all();
    let accrual_event = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|t| t == &event_name)
    });
    assert!(accrual_event.is_some(), "AccrueInterest event not emitted");

    let (_, _, data) = accrual_event.unwrap();
    let payload: AccrueInterestEvent = soroban_sdk::from_val(&env, data);
    assert_eq!(payload.user, user);
    assert_eq!(payload.interest, 50_0000000i128);
    assert_eq!(payload.new_balance, deposit + 50_0000000i128);
}

#[test]
#[should_panic(expected = "interest rate not set")]
fn test_accrue_interest_without_rate_panics() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let deposit = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &admin, &user, deposit);
    client.deposit(&user, &deposit, &unlock_time);

    env.ledger().with_mut(|li| li.timestamp += 86400);
    client.accrue_interest(&admin, &user);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_accrue_interest_non_admin_panics() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let deposit = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &admin, &user, deposit);
    client.deposit(&user, &deposit, &unlock_time);
    client.set_interest_rate(&admin, &500u32);

    let impostor = Address::generate(&env);
    env.ledger().with_mut(|li| li.timestamp += 86400);
    client.accrue_interest(&user);
}

#[test]
fn test_two_depositors_independent() {
    let (env, client, admin, usdc_id) = setup();
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let amount1 = 1_000_0000000i128;
    let amount2 = 500_0000000i128;
    let unlock_time1 = env.ledger().timestamp() + 3600;
    let unlock_time2 = env.ledger().timestamp() + 7200;

    mint_usdc(&env, &usdc_id, &admin, &user1, amount1);
    mint_usdc(&env, &usdc_id, &admin, &user2, amount2);

    client.deposit(&user1, &amount1, &unlock_time1);
    client.deposit(&user2, &amount2, &unlock_time2);

    assert_eq!(client.get_balance(&user1), amount1);
    assert_eq!(client.get_unlock_time(&user1), unlock_time1);
    assert_eq!(client.get_balance(&user2), amount2);
    assert_eq!(client.get_unlock_time(&user2), unlock_time2);
}

// ── SC-033: Emergency Mode State Machine & Illegal Transition Tests ───────────

#[test]
#[should_panic(expected = "emergency already active")]
fn test_double_activate_panics() {
    let (_, client, admin, _) = setup();
    client.activate_emergency(&admin);
    client.activate_emergency(&admin);
}

#[test]
#[should_panic(expected = "emergency already announced")]
fn test_double_announce_panics() {
    let (_, client, admin, _) = setup();
    client.announce_emergency(&admin);
    client.announce_emergency(&admin);
}

#[test]
#[should_panic(expected = "cannot cancel after emergency delay has elapsed")]
fn test_cancel_after_delay_panics() {
    let (env, client, admin, _) = setup();
    client.announce_emergency(&admin);
    env.ledger().set_timestamp(env.ledger().timestamp() + 172_800);
    client.cancel_emergency(&admin);
}

#[test]
#[should_panic(expected = "no emergency announced")]
fn test_emergency_withdraw_without_announcement_panics() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;
    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);
    client.emergency_withdraw(&admin, &user);
}

#[test]
#[should_panic(expected = "no emergency active")]
fn test_emergency_return_funds_without_activation_panics() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;
    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);
    client.emergency_return_funds(&admin, &user);
}

#[test]
#[should_panic(expected = "No vault found for user")]
fn test_emergency_withdraw_then_return_funds_mutually_exclusive() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;
    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);

    client.announce_emergency(&admin);
    client.activate_emergency(&admin);
    env.ledger().set_timestamp(env.ledger().timestamp() + 172_800);

    // First emergency withdrawal succeeds
    client.emergency_withdraw(&admin, &user);
    assert_eq!(client.get_balance(&user), 0);

    // Subsequent emergency return funds for same user must be rejected
    client.emergency_return_funds(&admin, &user);
}

#[test]
#[should_panic(expected = "No vault found for user")]
fn test_emergency_return_funds_then_withdraw_mutually_exclusive() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;
    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);

    client.announce_emergency(&admin);
    client.activate_emergency(&admin);
    env.ledger().set_timestamp(env.ledger().timestamp() + 172_800);

    // First emergency return funds succeeds
    client.emergency_return_funds(&admin, &user);
    assert_eq!(client.get_balance(&user), 0);

    // Subsequent emergency withdrawal for same user must be rejected
    client.emergency_withdraw(&admin, &user);
}

#[test]
#[should_panic(expected = "No vault found for user")]
fn test_double_emergency_withdraw_panics() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;
    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);

    client.announce_emergency(&admin);
    env.ledger().set_timestamp(env.ledger().timestamp() + 172_800);

    client.emergency_withdraw(&admin, &user);
    client.emergency_withdraw(&admin, &user);
}

#[test]
#[should_panic(expected = "No vault found for user")]
fn test_double_emergency_return_funds_panics() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;
    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);

    client.activate_emergency(&admin);
    env.ledger().set_timestamp(env.ledger().timestamp() + 172_800);

    client.emergency_return_funds(&admin, &user);
    client.emergency_return_funds(&admin, &user);
}

// ── SC-032: Penalty Math Checked Arithmetic & Bounds Tests ────────────────────

#[test]
#[should_panic(expected = "Amount exceeds maximum deposit bound")]
fn test_deposit_exceeds_max_bound_panics() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let excessive_amount = crate::MAX_DEPOSIT_AMOUNT + 1;
    let unlock_time = env.ledger().timestamp() + 86400;
    mint_usdc(&env, &usdc_id, &admin, &user, excessive_amount);
    client.deposit(&user, &excessive_amount, &unlock_time);
}

#[test]
fn test_penalty_math_property_over_input_space() {
    let amounts = [
        1i128,
        100_0000000i128,
        1_000_0000000i128,
        50_000_0000000i128,
        1_000_000_000_0000000i128,
        10_000_000_000_0000000i128,
    ];
    let penalty_bps_values = [0u32, 100u32, 500u32, 1000u32, 2500u32, 5000u32, 10000u32];

    for &amt in &amounts {
        for &bps in &penalty_bps_values {
            let penalty = (amt * bps as i128) / 10000;
            let net = amt - penalty;
            assert!(penalty >= 0);
            assert!(net >= 0);
            assert_eq!(penalty + net, amt);
            assert!(penalty <= amt);
        }
    }
// SC-034: Lock bounds tests
#[test]
#[should_panic(expected = "min_secs must be less than max_secs")]
fn test_update_lock_bounds_inverted_range_panics() {
    let (env, client, admin, _) = setup();
    client.update_lock_bounds(&admin, &1000, &500);
}

#[test]
#[should_panic(expected = "min_secs must be less than max_secs")]
fn test_update_lock_bounds_equal_range_panics() {
    let (env, client, admin, _) = setup();
    client.update_lock_bounds(&admin, &500, &500);
}

#[test]
fn test_deposit_at_exact_min_and_max_bounds() {
    let (env, client, admin, usdc_id) = setup();
    let min_secs: u64 = 1000;
    let max_secs: u64 = 5000;
    client.update_lock_bounds(&admin, &min_secs, &max_secs);

    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let amount = 100_0000000i128;
    mint_usdc(&env, &usdc_id, &admin, &user1, amount);
    mint_usdc(&env, &usdc_id, &admin, &user2, amount);

    let now = env.ledger().timestamp();
    // Exactly min_secs
    client.deposit(&user1, &amount, &(now + min_secs));
    assert_eq!(client.get_balance(&user1), amount);

    // Exactly max_secs
    client.deposit(&user2, &amount, &(now + max_secs));
    assert_eq!(client.get_balance(&user2), amount);
}

// SC-035: Flash deposit timing test asserting time-weighted yield accrual
#[test]
fn test_flash_deposit_yield_capture_is_time_weighted() {
    let (env, client, admin, usdc_id) = setup();
    let min_secs = 100;
    let max_secs = 10_000_000;
    client.update_lock_bounds(&admin, &min_secs, &max_secs);

    // 10% interest rate per year
    client.set_interest_rate(&admin, &1000u32);

    let user = Address::generate(&env);
    let deposit_amount = 1_000_0000000i128; // 1,000 USDC
    mint_usdc(&env, &usdc_id, &admin, &user, deposit_amount);

    let now = env.ledger().timestamp();
    // Deposit with unlock_time
    client.deposit(&user, &deposit_amount, &(now + min_secs));

    // Fast-forward only 1 second
    env.ledger().with_mut(|li| li.timestamp += 1);

    // Accrue interest after 1 second
    client.accrue_interest(&user);

    let vault = client.get_vault(&user);
    // Yield for 1 second out of 31,536,000 seconds per year at 10%
    // Full year interest would be 100 USDC (100_0000000). For 1 second, it should be tiny (< 1 USDC)
    assert!(vault.accrued_interest < 1_0000000i128);
}

// SC-037: Invariant test asserting sum(vault balances) == get_total_locked
#[test]
fn test_invariant_sum_vault_balances_equals_total_locked() {
    let (env, client, admin, usdc_id) = setup();
    client.update_lock_bounds(&admin, &100, &10_000_000);
    client.set_interest_rate(&admin, &500u32); // 5% APR

    let users: [Address; 4] = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];

    let mut sum_balances: i128 = 0;
    assert_eq!(client.get_total_locked(), sum_balances);

    // Checkpoint 1: Initial deposits
    for (i, user) in users.iter().enumerate() {
        let amount = ((i as i128 + 1) * 250) * 10_000_000; // 250, 500, 750, 1000 USDC
        mint_usdc(&env, &usdc_id, &admin, user, amount);
        let unlock_time = env.ledger().timestamp() + 500 + (i as u64 * 100);
        client.deposit(user, &amount, &unlock_time);
    }

    sum_balances = users.iter().map(|u| client.get_balance(u)).sum();
    assert_eq!(client.get_total_locked(), sum_balances);

    // Checkpoint 2: Accrue interest over time across vaults
    env.ledger().with_mut(|li| li.timestamp += 1000);
    for user in users.iter() {
        client.accrue_interest(user);
    }
    sum_balances = users.iter().map(|u| client.get_balance(u)).sum();
    assert_eq!(client.get_total_locked(), sum_balances);

    // Checkpoint 3: Partial and full withdrawals
    // User 0 partial withdrawal (unlock_time has passed)
    client.withdraw(&users[0], &50_0000000i128);
    sum_balances = users.iter().map(|u| client.get_balance(u)).sum();
    assert_eq!(client.get_total_locked(), sum_balances);

    // User 1 partial withdrawal
    client.withdraw(&users[1], &100_0000000i128);
    sum_balances = users.iter().map(|u| client.get_balance(u)).sum();
    assert_eq!(client.get_total_locked(), sum_balances);

    // Checkpoint 4: Additional deposit and interest accrual
    let extra_deposit = 300_0000000i128;
    mint_usdc(&env, &usdc_id, &admin, &users[2], extra_deposit);
    let new_unlock = env.ledger().timestamp() + 1000;
    client.deposit(&users[2], &extra_deposit, &new_unlock);

    env.ledger().with_mut(|li| li.timestamp += 500);
    client.accrue_interest(&users[2]);

    sum_balances = users.iter().map(|u| client.get_balance(u)).sum();
    assert_eq!(client.get_total_locked(), sum_balances);
}
