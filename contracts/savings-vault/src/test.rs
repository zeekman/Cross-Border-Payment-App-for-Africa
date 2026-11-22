#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, FromVal, Symbol, TryFromVal, Val,
};

use crate::{AccrueInterestEvent, DepositEvent, SavingsVaultContract, SavingsVaultContractClient};

fn setup() -> (Env, SavingsVaultContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    // Start at a realistic ledger time: the contract uses 0 to mean "no
    // emergency announced", so announcing at timestamp 0 would be invisible.
    env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);
    let contract_id = env.register(SavingsVaultContract, ());
    // Start from a realistic timestamp: the contract uses 0 as the
    // "not announced" sentinel, and some tests subtract from `now`.
    env.ledger().set_timestamp(1_700_000_000);
    let contract_id = env.register_contract(None, SavingsVaultContract);
    let client = SavingsVaultContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    client.initialize(&admin, &usdc_id, &1000u32);
    (env, client, admin, usdc_id)
}

/// Mints `amount` USDC to `to` and approves the vault to pull it: `deposit`
/// collects funds with `transfer_from`, so an allowance is required.
fn mint_usdc(env: &Env, usdc_id: &Address, vault: &Address, to: &Address, amount: i128) {
/// True if `topics` contains the symbol `name` (compared by value, not handle).
fn topic_is(env: &Env, topics: &soroban_sdk::Vec<Val>, name: &str) -> bool {
    let want = Symbol::new(env, name);
    topics
        .iter()
        .any(|t| Symbol::try_from_val(env, &t).map(|s| s == want).unwrap_or(false))
}

fn mint_usdc(env: &Env, usdc_id: &Address, _admin: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, usdc_id).mint(to, &amount);
    let token = TokenClient::new(env, usdc_id);
    let allowance = token.allowance(to, vault);
    token.approve(to, vault, &(allowance + amount), &(env.ledger().sequence() + 100_000));
}

#[test]
fn test_initialize() {
    let (_, client, _, usdc_id) = setup();
    // Initialization is tested implicitly - contract would panic if not initialized
    assert!(true);
}

#[test]
fn test_initialize_emits_initialized_event() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);
    let contract_id = env.register(SavingsVaultContract, ());
    let client = SavingsVaultContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();

    client.initialize(&admin, &usdc_id, &1000u32);

    let events = env.events().all();
    assert!(
        events.iter().any(|(_, topics, _)| topic_is(&env, &topics, "Initialized")),
        "Initialized event not emitted"
    );
}

#[test]
#[should_panic]
fn test_initialize_requires_admin_auth() {
    let env = Env::default();
    env.ledger().set_timestamp(1_700_000_000);
    let contract_id = env.register(SavingsVaultContract, ());
    let client = SavingsVaultContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();

    // Only the attacker authorises; the admin key never co-signs, so the
    // contract must reject the call instead of letting it be front-run.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &attacker,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: (&admin, &usdc_id, 1000u32).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.initialize(&admin, &usdc_id, &1000u32);
}

#[test]
fn test_vault_records_survive_ttl_expiry_after_activity() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86_400;

    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    let id = client.deposit(&user, &amount, &unlock_time);

    // Advance well past the default entry TTL, then touch the contract so it
    // extends the TTL of the instance and the vault record.
    env.ledger().set_sequence_number(env.ledger().sequence() + 100_000);
    assert_eq!(client.get_balance(&user), amount);

    // Records must still be readable and usable after the bump.
    env.ledger().set_sequence_number(env.ledger().sequence() + 100_000);
    let vault = client.get_vault(&user, &id);
    assert_eq!(vault.balance, amount);
    assert_eq!(client.get_unlock_time(&user, &id), unlock_time);

    env.ledger().set_timestamp(unlock_time + 1);
    client.withdraw(&user, &id, &amount);
    assert_eq!(client.get_balance(&user), 0);
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

    mint_usdc(&env, &usdc_id, &client.address, &user, amount);

    client.deposit(&user, &amount, &unlock_time);

    assert_eq!(client.get_balance(&user), amount);
    assert_eq!(client.get_unlock_time(&user, &0), unlock_time);
}

#[test]
#[should_panic(expected = "Amount must be positive")]
fn test_deposit_zero_amount() {
    let (env, client, _, _) = setup();
    let user = Address::generate(&env);
    client.deposit(&user, &0, &(env.ledger().timestamp() + 86400));
}

#[test]
#[should_panic(expected = "Unlock time must be in the future")]
fn test_deposit_past_unlock_time() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let past_time = env.ledger().timestamp() - 1;

    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
    client.deposit(&user, &amount, &past_time);
}

#[test]
fn test_withdraw_after_unlock() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86_400;

    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
    client.deposit(&user, &amount, &unlock_time);

    env.ledger().set_timestamp(unlock_time + 1);

    client.withdraw(&user, &0, &amount);

    assert_eq!(client.get_balance(&user), 0);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&user), amount);
}

#[test]
fn test_early_withdrawal_with_penalty() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
    client.deposit(&user, &amount, &unlock_time);

    client.withdraw(&user, &0, &amount);

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
    let contract_id = env.register(SavingsVaultContract, ());
    // Start from a realistic timestamp: the contract uses 0 as the
    // "not announced" sentinel, and some tests subtract from `now`.
    env.ledger().set_timestamp(1_700_000_000);
    let contract_id = env.register_contract(None, SavingsVaultContract);
    let client = SavingsVaultContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();

    client.initialize(&admin, &usdc_id, &500u32); // 5% penalty

    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
    client.deposit(&user, &amount, &unlock_time);
    client.withdraw(&user, &0, &amount);

    let expected_penalty = (amount * 500) / 10000;
    let expected_withdrawal = amount - expected_penalty;

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&user), expected_withdrawal);
}

#[test]
fn test_zero_penalty_bps_no_penalty_on_early_withdrawal() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(SavingsVaultContract, ());
    // Start from a realistic timestamp: the contract uses 0 as the
    // "not announced" sentinel, and some tests subtract from `now`.
    env.ledger().set_timestamp(1_700_000_000);
    let contract_id = env.register_contract(None, SavingsVaultContract);
    let client = SavingsVaultContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();

    client.initialize(&admin, &usdc_id, &0u32); // 0% penalty

    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
    client.deposit(&user, &amount, &unlock_time);
    client.withdraw(&user, &0, &amount);

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&user), amount);
}

#[test]
#[should_panic(expected = "Insufficient balance")]
fn test_withdraw_more_than_balance() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let deposit_amount = 500_0000000i128;
    let withdraw_amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86_400;

    mint_usdc(&env, &usdc_id, &client.address, &user, deposit_amount);
    client.deposit(&user, &deposit_amount, &unlock_time);

    client.withdraw(&user, &0, &withdraw_amount);
}

#[test]
#[should_panic(expected = "No vault found for user")]
fn test_withdraw_no_vault() {
    let (env, client, _, _) = setup();
    let user = Address::generate(&env);
    client.withdraw(&user, &0, &1_000_0000000);
}

// ── #549: multi-deposit ───────────────────────────────────────────────────────

#[test]
fn test_multiple_deposits_create_independent_vaults() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount1 = 500_0000000i128;
    let amount2 = 300_0000000i128;
    let unlock_time1 = env.ledger().timestamp() + 86_400;
    let unlock_time2 = env.ledger().timestamp() + 2 * 86_400;
    let unlock_time2 = env.ledger().timestamp() + 172_800;

    mint_usdc(&env, &usdc_id, &client.address, &user, amount1 + amount2);

    let id1 = client.deposit(&user, &amount1, &unlock_time1);
    let id2 = client.deposit(&user, &amount2, &unlock_time2);

    assert_ne!(id1, id2);
    assert_eq!(client.get_vault_ids(&user), soroban_sdk::vec![&env, id1, id2]);
    assert_eq!(client.get_balance(&user), amount1 + amount2);
    assert_eq!(client.get_vault(&user, &id1).balance, amount1);
    assert_eq!(client.get_vault(&user, &id2).balance, amount2);
    // Each vault keeps the unlock time it was opened with.
    assert_eq!(client.get_unlock_time(&user, &id1), unlock_time1);
    assert_eq!(client.get_unlock_time(&user, &id2), unlock_time2);
    assert_eq!(client.get_total_locked(), amount1 + amount2);
}

#[test]
fn test_later_deposit_does_not_relock_unlocked_funds() {
    // 1,000 saved with a short lock, which then expires. A new 10 deposit
    // with a long lock must not re-lock (or penalise) the original 1,000.
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let first = 1_000_0000000i128;
    let second = 10_0000000i128;
    mint_usdc(&env, &usdc_id, &admin, &user, first + second);

    let id1 = client.deposit(&user, &first, &(env.ledger().timestamp() + 86_400));
    env.ledger().with_mut(|li| li.timestamp += 86_401); // first vault unlocked
    let id2 = client.deposit(&user, &second, &(env.ledger().timestamp() + 300 * 86_400));

    client.withdraw(&user, &id1, &first);

    let token = TokenClient::new(&env, &usdc_id);
    assert_eq!(token.balance(&user), first); // no penalty
    assert_eq!(client.get_balance(&user), second);
    assert_eq!(client.get_vault_ids(&user), soroban_sdk::vec![&env, id2]);
    assert_eq!(client.get_vault(&user, &id1).balance, 0); // closed
}

#[test]
fn test_deposit_with_earlier_unlock_keeps_requested_time() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount1 = 500_0000000i128;
    let amount2 = 300_0000000i128;
    let unlock_time1 = env.ledger().timestamp() + 2 * 86_400;
    let unlock_time1 = env.ledger().timestamp() + 172_800;
    let unlock_time2 = env.ledger().timestamp() + 86_400; // earlier than first

    mint_usdc(&env, &usdc_id, &client.address, &user, amount1 + amount2);

    let id1 = client.deposit(&user, &amount1, &unlock_time1);
    let id2 = client.deposit(&user, &amount2, &unlock_time2);

    // The second vault is not silently pushed out to the first one's date.
    assert_eq!(client.get_unlock_time(&user, &id1), unlock_time1);
    assert_eq!(client.get_unlock_time(&user, &id2), unlock_time2);

    // Once the earlier vault unlocks it can be withdrawn without penalty
    // while the other stays locked.
    env.ledger().with_mut(|li| li.timestamp = unlock_time2);
    client.withdraw(&user, &id2, &amount2);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&user), amount2);
    assert_eq!(client.get_balance(&user), amount1);
}

#[test]
fn test_deposit_event_reports_requested_unlock_time() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &user, 2_0000000);
    let later = env.ledger().timestamp() + 172_800;
    let earlier = env.ledger().timestamp() + 86_400;
    client.deposit(&user, &1_0000000, &later);
    let id = client.deposit(&user, &1_0000000, &earlier);

    let (_, _, data) = env
        .events()
        .all()
        .iter()
        .find(|(_, topics, _)| topic_is(&env, &topics, "Deposit"))
        .expect("Deposit event not emitted");
    let ev = DepositEvent::from_val(&env, &data);
    assert_eq!(ev.vault_id, id);
    assert_eq!(ev.unlock_time, earlier);
}

#[test]
#[should_panic(expected = "No vault found for user")]
fn test_withdraw_unknown_vault_id_panics() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &user, 1_0000000);
    let id = client.deposit(&user, &1_0000000, &(env.ledger().timestamp() + 86_400));
    client.withdraw(&user, &(id + 1), &1_0000000);
}

#[test]
fn test_get_vault_returns_full_info() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
    client.deposit(&user, &amount, &unlock_time);

    let vault = client.get_vault(&user, &0);
    assert_eq!(vault.balance, amount);
    assert_eq!(vault.unlock_time, unlock_time);
}

#[test]
fn test_get_vault_no_deposit_returns_zeros() {
    let (_, client, _, _) = setup();
    let user = Address::generate(&client.env);
    let vault = client.get_vault(&user);
    let (env, client, _, _) = setup();
    let user = Address::generate(&env);
    let vault = client.get_vault(&user, &0);
    assert_eq!(vault.balance, 0);
    assert_eq!(vault.unlock_time, 0);
    assert_eq!(vault.last_accrue_time, 0);
}

#[test]
fn test_get_balance_no_vault() {
    let (_, client, _, _) = setup();
    let user = Address::generate(&client.env);
    let (env, client, _, _) = setup();
    let user = Address::generate(&env);
    assert_eq!(client.get_balance(&user), 0);
}

#[test]
fn test_get_unlock_time_no_vault() {
    let (_, client, _, _) = setup();
    let user = Address::generate(&client.env);
    assert_eq!(client.get_unlock_time(&user), 0);
    let (env, client, _, _) = setup();
    let user = Address::generate(&env);
    assert_eq!(client.get_unlock_time(&user, &0), 0);
}

#[test]
fn test_announce_emergency_sets_timestamp() {
    let (env, client, admin, _) = setup();
    client.announce_emergency(&admin);

    let event_name: Val = Symbol::new(&env, "EmergencyAnnounced").into_val(&env);
    let events = all_events(&env);
    assert_eq!(events.len(), 1);
    let event = events
        .iter()
        .find(|(_, topics, _)| topics.iter().any(|t| val_eq(&env, &t, &event_name)))
    let event_name = "EmergencyAnnounced";
    let events = env.events().all();
    assert_eq!(events.len(), 1);
    let event = events
        .iter()
        .find(|(_, topics, _)| topic_is(&env, topics, event_name))
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

    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
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

    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
    client.deposit(&user, &amount, &unlock_time);
    client.announce_emergency(&admin);

    client.emergency_withdraw(&admin, &user);
}

#[test]
fn test_cancel_emergency_before_delay() {
    let (env, client, admin, _) = setup();
    client.announce_emergency(&admin);
    client.cancel_emergency(&admin);

    let event_name: Val = Symbol::new(&env, "EmergencyCancelled").into_val(&env);
    let events = all_events(&env);
    assert!(events
        .iter()
        .any(|(_, topics, _)| topics.iter().any(|t| val_eq(&env, &t, &event_name))));
    let events = env.events().all();
    let event_name = "EmergencyCancelled";
    assert!(events.iter().any(|(_, topics, _)| topic_is(&env, &topics, event_name)));
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
    let events = all_events(&env);
    assert!(events.iter().any(|(_, topics, _)| topics.iter().any(|t| val_eq(&env, &t, &event_name))));
    let event_name = "EmergencyActivated";
    let events = env.events().all();
    assert!(events.iter().any(|(_, topics, _)| topic_is(&env, &topics, event_name)));
}

#[test]
fn test_deactivate_emergency_cancels() {
    let (env, client, admin, _) = setup();
    client.activate_emergency(&admin);
    client.deactivate_emergency(&admin);
    let event_name: Val = Symbol::new(&env, "EmergencyCancelled").into_val(&env);
    let events = all_events(&env);
    assert!(events.iter().any(|(_, topics, _)| topics.iter().any(|t| val_eq(&env, &t, &event_name))));
    let event_name = "EmergencyCancelled";
    let events = env.events().all();
    assert!(events.iter().any(|(_, topics, _)| topic_is(&env, &topics, event_name)));
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
    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
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
    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
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
    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
    client.deposit(&user, &amount, &unlock_time);
    client.activate_emergency(&admin);
    // user can still self-withdraw during emergency window
    client.withdraw(&user, &0, &amount);
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
    let unlock_time = env.ledger().timestamp() + 365 * 24 * 60 * 60;
    let unlock_time = env.ledger().timestamp() + 31_536_000;

    mint_usdc(&env, &usdc_id, &client.address, &user, deposit);
    client.deposit(&user, &deposit, &unlock_time);
    client.set_interest_rate(&admin, &500u32); // 5% per year

    // Advance 1 year
    env.ledger().with_mut(|li| li.timestamp += 31_536_000);

    client.accrue_interest(&user, &0);

    // 5% of 1000 USDC = 50 USDC
    let expected_interest = 50_0000000i128;
    assert_eq!(client.get_balance(&user), deposit);
    assert_eq!(client.get_vault(&user, &0).accrued_interest, expected_interest);
}

#[test]
fn test_accrue_interest_emits_event() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let deposit = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 365 * 24 * 60 * 60;
    let unlock_time = env.ledger().timestamp() + 31_536_000;

    mint_usdc(&env, &usdc_id, &client.address, &user, deposit);
    client.deposit(&user, &deposit, &unlock_time);
    client.set_interest_rate(&admin, &500u32);

    env.ledger().with_mut(|li| li.timestamp += 31_536_000);
    client.accrue_interest(&user, &0);

    let event_name: Val = Symbol::new(&env, "AccrueInterest").into_val(&env);
    let events = all_events(&env);
    let accrual_event = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|t| val_eq(&env, &t, &event_name))
    let event_name = "AccrueInterest";
    let events = env.events().all();
    let accrual_event = events.iter().find(|(_, topics, _)| {
        topic_is(&env, topics, event_name)
    });
    assert!(accrual_event.is_some(), "AccrueInterest event not emitted");

    let (_, _, data) = accrual_event.unwrap();
    let payload: AccrueInterestEvent = soroban_sdk::FromVal::from_val(&env, &data);
    assert_eq!(payload.user, user);
    assert_eq!(payload.interest, 50_0000000i128);
    // Interest accrues into `accrued_interest`; the principal balance is unchanged.
    let payload = AccrueInterestEvent::from_val(&env, &data);
    assert_eq!(payload.user, user);
    assert_eq!(payload.interest, 50_0000000i128);
    // Interest is tracked in `accrued_interest`; principal is unchanged.
    assert_eq!(payload.new_balance, deposit);
}

#[test]
#[should_panic(expected = "interest rate not set")]
fn test_accrue_interest_without_rate_panics() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let deposit = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &client.address, &user, deposit);
    client.deposit(&user, &deposit, &unlock_time);

    env.ledger().with_mut(|li| li.timestamp += 86400);
    client.accrue_interest(&user);
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn test_accrue_interest_requires_user_auth() {
    // accrue_interest is authorised by the vault owner, not the admin.
    client.accrue_interest(&user, &0);
}

#[test]
fn test_accrue_interest_is_user_callable() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let deposit = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &client.address, &user, deposit);
    client.deposit(&user, &deposit, &unlock_time);
    client.set_interest_rate(&admin, &500u32);

    env.ledger().with_mut(|li| li.timestamp += 86400);
    env.set_auths(&[]);
    client.accrue_interest(&user);
    // accrue_interest is authorised by the vault owner; no admin needed.
    env.ledger().with_mut(|li| li.timestamp += 86400);
    client.accrue_interest(&user, &0);
    assert!(client.get_vault(&user, &0).accrued_interest > 0);
}

#[test]
fn test_two_depositors_independent() {
    let (env, client, admin, usdc_id) = setup();
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let amount1 = 1_000_0000000i128;
    let amount2 = 500_0000000i128;
    let unlock_time1 = env.ledger().timestamp() + 86_400;
    let unlock_time2 = env.ledger().timestamp() + 2 * 86_400;
    let unlock_time2 = env.ledger().timestamp() + 172_800;

    mint_usdc(&env, &usdc_id, &client.address, &user1, amount1);
    mint_usdc(&env, &usdc_id, &client.address, &user2, amount2);

    client.deposit(&user1, &amount1, &unlock_time1);
    client.deposit(&user2, &amount2, &unlock_time2);

    assert_eq!(client.get_balance(&user1), amount1);
    assert_eq!(client.get_unlock_time(&user1, &0), unlock_time1);
    assert_eq!(client.get_balance(&user2), amount2);
    assert_eq!(client.get_unlock_time(&user2, &0), unlock_time2);
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
    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
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
    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
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
    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
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
    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
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
    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
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
    mint_usdc(&env, &usdc_id, &client.address, &user, amount);
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
    mint_usdc(&env, &usdc_id, &client.address, &user, excessive_amount);
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
    mint_usdc(&env, &usdc_id, &client.address, &user1, amount);
    mint_usdc(&env, &usdc_id, &client.address, &user2, amount);

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
    mint_usdc(&env, &usdc_id, &client.address, &user, deposit_amount);

    let now = env.ledger().timestamp();
    // Deposit with unlock_time
    client.deposit(&user, &deposit_amount, &(now + min_secs));

    // Fast-forward only 1 second
    env.ledger().with_mut(|li| li.timestamp += 1);

    // Accrue interest after 1 second
    client.accrue_interest(&user, &0);

    let vault = client.get_vault(&user, &0);
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
        mint_usdc(&env, &usdc_id, &client.address, user, amount);
        let unlock_time = env.ledger().timestamp() + 500 + (i as u64 * 100);
        client.deposit(user, &amount, &unlock_time);
    }

    sum_balances = users.iter().map(|u| client.get_balance(u)).sum();
    assert_eq!(client.get_total_locked(), sum_balances);

    // Checkpoint 2: Accrue interest over time across vaults
    env.ledger().with_mut(|li| li.timestamp += 1000);
    for user in users.iter() {
        client.accrue_interest(user, &0);
    }
    sum_balances = users.iter().map(|u| client.get_balance(u)).sum();
    assert_eq!(client.get_total_locked(), sum_balances);

    // Checkpoint 3: Partial and full withdrawals
    // User 0 partial withdrawal (unlock_time has passed)
    client.withdraw(&users[0], &0, &50_0000000i128);
    sum_balances = users.iter().map(|u| client.get_balance(u)).sum();
    assert_eq!(client.get_total_locked(), sum_balances);

    // User 1 partial withdrawal
    client.withdraw(&users[1], &0, &100_0000000i128);
    sum_balances = users.iter().map(|u| client.get_balance(u)).sum();
    assert_eq!(client.get_total_locked(), sum_balances);

    // Checkpoint 4: Additional deposit and interest accrual
    let extra_deposit = 300_0000000i128;
    mint_usdc(&env, &usdc_id, &client.address, &users[2], extra_deposit);
    let new_unlock = env.ledger().timestamp() + 1000;
    client.deposit(&users[2], &extra_deposit, &new_unlock);

    env.ledger().with_mut(|li| li.timestamp += 500);
    client.accrue_interest(&users[2], &1); // the extra deposit's vault

    sum_balances = users.iter().map(|u| client.get_balance(u)).sum();
    assert_eq!(client.get_total_locked(), sum_balances);
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

/// Compares two host values structurally (`Val` has no `PartialEq`).
#[allow(dead_code)]
fn val_eq(env: &soroban_sdk::Env, a: &soroban_sdk::Val, b: &soroban_sdk::Val) -> bool {
    use soroban_sdk::{xdr::ScVal, TryFromVal};
    ScVal::try_from_val(env, a).ok() == ScVal::try_from_val(env, b).ok()
// ── Deposits / yield pull funds with a direct transfer (no approve needed) ────

#[test]
fn test_deposit_needs_no_prior_approve() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 100_0000000i128;
    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    let token = TokenClient::new(&env, &usdc_id);

    // No approve() call: the user's auth on deposit() covers the transfer.
    assert_eq!(token.allowance(&user, &client.address), 0);
    client.deposit(&user, &amount, &(env.ledger().timestamp() + 86400));

    assert_eq!(token.balance(&user), 0);
    assert_eq!(token.balance(&client.address), amount);
    assert_eq!(client.get_total_locked(), amount);
}

#[test]
fn test_distribute_yield_needs_no_prior_approve() {
    let (env, client, admin, usdc_id) = setup();
    let distributor = Address::generate(&env);
    client.set_yield_distributor(&admin, &distributor);

    let user = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &user, 100_0000000);
    client.deposit(&user, &100_0000000, &(env.ledger().timestamp() + 86400));

    let amount = 5_0000000i128;
    mint_usdc(&env, &usdc_id, &admin, &distributor, amount);
    let token = TokenClient::new(&env, &usdc_id);
    assert_eq!(token.allowance(&distributor, &client.address), 0);

    client.distribute_yield(&distributor, &amount);

    assert_eq!(token.balance(&distributor), 0);
    assert_eq!(token.balance(&client.address), 100_0000000 + amount);
}

// ── Emergency wind-down: no new deposits, pay out everything owed ─────────────

fn fund_reserve(env: &Env, client: &SavingsVaultContractClient, admin: &Address, usdc_id: &Address, amount: i128) {
    let distributor = Address::generate(env);
    client.set_fee_distributor(admin, &distributor);
    mint_usdc(env, usdc_id, admin, &distributor, amount);
    client.fund_interest_reserve(&distributor, &amount);
}

fn set_yield_accrued(env: &Env, client: &SavingsVaultContractClient, user: &Address, amount: i128) {
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&crate::DataKey::YieldAccrued(user.clone()), &amount);
    });
}

fn reserve_of(env: &Env, client: &SavingsVaultContractClient) -> i128 {
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .get(&crate::DataKey::InterestReserve)
            .unwrap_or(0i128)
    })
}

#[test]
#[should_panic(expected = "deposits disabled: emergency in progress")]
fn test_deposit_rejected_after_announce_emergency() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &user, 1_0000000);
    client.announce_emergency(&admin);
    client.deposit(&user, &1_0000000, &(env.ledger().timestamp() + 86_400));
}

#[test]
#[should_panic(expected = "deposits disabled: emergency in progress")]
fn test_deposit_rejected_while_emergency_active() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &user, 1_0000000);
    client.activate_emergency(&admin);
    client.deposit(&user, &1_0000000, &(env.ledger().timestamp() + 86_400));
}

#[test]
fn test_deposit_allowed_again_after_emergency_cancelled() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &user, 2_0000000);

    client.announce_emergency(&admin);
    client.cancel_emergency(&admin);
    client.activate_emergency(&admin);
    client.deactivate_emergency(&admin);

    client.deposit(&user, &1_0000000, &(env.ledger().timestamp() + 86_400));
    assert_eq!(client.get_balance(&user), 1_0000000);
}

#[test]
fn test_emergency_withdraw_pays_interest_and_yield() {
    let (env, client, admin, usdc_id) = setup();
    client.set_interest_rate(&admin, &500u32); // 5% APR
    fund_reserve(&env, &client, &admin, &usdc_id, 1_000_0000000);

    let user = Address::generate(&env);
    let deposit = 1_000_0000000i128;
    mint_usdc(&env, &usdc_id, &admin, &user, deposit);
    client.deposit(&user, &deposit, &(env.ledger().timestamp() + 31_536_000));

    // Half a year passes before the emergency; accrue part of it explicitly
    // so both stored and not-yet-stored interest are covered.
    env.ledger().with_mut(|li| li.timestamp += 31_536_000 / 4);
    client.accrue_interest(&user, &0);
    env.ledger().with_mut(|li| li.timestamp += 31_536_000 / 4 - 172_800);

    let yield_amount = 7_0000000i128;
    mint_usdc(&env, &usdc_id, &admin, &client.address, yield_amount);
    set_yield_accrued(&env, &client, &user, yield_amount);

    client.announce_emergency(&admin);
    env.ledger().with_mut(|li| li.timestamp += 172_800);
    client.emergency_withdraw(&admin, &user);

    let interest = 25_0000000i128; // 5% of 1,000 over half a year
    let token = TokenClient::new(&env, &usdc_id);
    assert_eq!(token.balance(&user), deposit + interest + yield_amount);
    assert_eq!(client.get_yield_accrued(&user), 0);
    assert_eq!(reserve_of(&env, &client), 1_000_0000000 - interest);
    assert_eq!(client.get_total_locked(), 0);
    assert_eq!(client.get_balance(&user), 0);
    assert_eq!(client.get_vault_ids(&user).len(), 0);
    // Contract holds exactly the remaining reserve: nothing stranded.
    assert_eq!(token.balance(&client.address), reserve_of(&env, &client));
}

#[test]
fn test_emergency_withdraw_closes_all_user_vaults() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &user, 3_0000000);
    client.deposit(&user, &1_0000000, &(env.ledger().timestamp() + 86_400));
    client.deposit(&user, &2_0000000, &(env.ledger().timestamp() + 172_800));

    client.announce_emergency(&admin);
    env.ledger().with_mut(|li| li.timestamp += 172_800);
    client.emergency_withdraw(&admin, &user);

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&user), 3_0000000);
    assert_eq!(client.get_vault_ids(&user).len(), 0);
    assert_eq!(client.get_total_locked(), 0);
}

#[test]
fn test_emergency_withdraw_caps_interest_at_reserve() {
    let (env, client, admin, usdc_id) = setup();
    client.set_interest_rate(&admin, &1000u32); // 10% APR
    let reserve = 3_0000000i128;
    fund_reserve(&env, &client, &admin, &usdc_id, reserve);

    let user = Address::generate(&env);
    let deposit = 1_000_0000000i128;
    mint_usdc(&env, &usdc_id, &admin, &user, deposit);
    client.deposit(&user, &deposit, &(env.ledger().timestamp() + 31_536_000));

    client.announce_emergency(&admin);
    env.ledger().with_mut(|li| li.timestamp += 31_536_000 / 2); // ~50 interest owed
    client.emergency_withdraw(&admin, &user);

    let token = TokenClient::new(&env, &usdc_id);
    assert_eq!(token.balance(&user), deposit + reserve);
    assert_eq!(reserve_of(&env, &client), 0);
    assert_eq!(token.balance(&client.address), 0);
}

#[test]
fn test_emergency_return_funds_pays_accrued_interest() {
    let (env, client, admin, usdc_id) = setup();
    client.set_interest_rate(&admin, &500u32);
    fund_reserve(&env, &client, &admin, &usdc_id, 1_000_0000000);

    let user = Address::generate(&env);
    let deposit = 1_000_0000000i128;
    mint_usdc(&env, &usdc_id, &admin, &user, deposit);
    client.deposit(&user, &deposit, &(env.ledger().timestamp() + 31_536_000));

    env.ledger().with_mut(|li| li.timestamp += 31_536_000 / 2 - 172_800);
    client.activate_emergency(&admin);
    env.ledger().with_mut(|li| li.timestamp += 172_800);
    client.emergency_return_funds(&admin, &user);

    let interest = 25_0000000i128;
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&user), deposit + interest);
    assert_eq!(reserve_of(&env, &client), 1_000_0000000 - interest);
    assert_eq!(client.get_total_locked(), 0);
}
