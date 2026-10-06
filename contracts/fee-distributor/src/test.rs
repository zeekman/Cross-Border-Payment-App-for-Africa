#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal, Symbol, Val,
};

use crate::{
    EvtContractPaused, EvtContractUnpaused, EvtFeeDeposited, EvtFeesWithdrawn, EvtSplitUpdated,
    FeeDistributorContract, FeeDistributorContractClient, FeeRateUpdated,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Set up with split_bps = 0 so that 100% of fees flow into AccumulatedFees.
fn setup() -> (Env, FeeDistributorContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, FeeDistributorContract);
    let client = FeeDistributorContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    client.initialize(&admin, &0);
    (env, client, admin, usdc_id)
}

/// Set up with a custom split_bps value for split-specific tests.
fn setup_with_split(
    split_bps: u32,
) -> (Env, FeeDistributorContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, FeeDistributorContract);
    let client = FeeDistributorContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    client.initialize(&admin, &split_bps);
    (env, client, admin, usdc_id)
}

fn mint(env: &Env, token_id: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, token_id).mint(to, &amount);
}

// ── initialize ────────────────────────────────────────────────────────────────

#[test]
fn test_initial_fees_are_zero() {
    let (_, client, _, usdc_id) = setup();
    assert_eq!(client.get_accumulated_fees(&usdc_id), 0);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let (_, client, admin, _) = setup();
    client.initialize(&admin, &0);
}

// ── deposit_fee ───────────────────────────────────────────────────────────────

#[test]
fn test_deposit_fee_increments_total() {
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    client.deposit_fee(&depositor, &usdc_id, &500_0000000, &None);
    assert_eq!(client.get_accumulated_fees(&usdc_id), 500_0000000);
}

#[test]
fn test_deposit_fee_transfers_usdc_to_contract() {
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&depositor), 0);
}

#[test]
fn test_multiple_deposits_accumulate() {
    let (env, client, _, usdc_id) = setup();
    let d1 = Address::generate(&env);
    let d2 = Address::generate(&env);
    mint(&env, &usdc_id, &d1, 300_0000000);
    mint(&env, &usdc_id, &d2, 200_0000000);
    client.deposit_fee(&d1, &usdc_id, &300_0000000, &None);
    client.deposit_fee(&d2, &usdc_id, &200_0000000, &None);
    assert_eq!(client.get_accumulated_fees(&usdc_id), 500_0000000);
}

#[test]
fn test_deposit_fee_minimum_amount() {
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1);
    client.deposit_fee(&depositor, &usdc_id, &1, &None);
    assert_eq!(client.get_accumulated_fees(&usdc_id), 1);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_deposit_fee_zero_panics() {
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    client.deposit_fee(&depositor, &usdc_id, &0, &None);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_deposit_fee_negative_panics() {
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    client.deposit_fee(&depositor, &usdc_id, &-1, &None);
}

// ── #557: deposit source tracking ─────────────────────────────────────────────

#[test]
fn test_deposit_fee_with_source_emits_event() {
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    let source = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 500_0000000);
    client.deposit_fee(&depositor, &usdc_id, &500_0000000, &Some(source.clone()));

    let event_name: Val = Symbol::new(&env, "FeeDeposited").into_val(&env);
    let events = env.events().all();
    let deposit_event = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|t| t == &event_name)
    });
    assert!(deposit_event.is_some(), "FeeDeposited event not emitted");

    let (_, _, data) = deposit_event.unwrap();
    let payload: EvtFeeDeposited = soroban_sdk::from_val(&env, data);
    assert_eq!(payload.depositor, depositor);
    assert_eq!(payload.token, usdc_id);
    assert_eq!(payload.amount, 500_0000000);
    assert_eq!(payload.source, Some(source));
}

#[test]
fn test_deposit_fee_without_source_has_none() {
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 100_0000000);
    client.deposit_fee(&depositor, &usdc_id, &100_0000000, &None);

    let event_name: Val = Symbol::new(&env, "FeeDeposited").into_val(&env);
    let events = env.events().all();
    let deposit_event = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|t| t == &event_name)
    });
    assert!(deposit_event.is_some());

    let (_, _, data) = deposit_event.unwrap();
    let payload: EvtFeeDeposited = soroban_sdk::from_val(&env, data);
    assert_eq!(payload.source, None);
}

// ── withdraw_fees ─────────────────────────────────────────────────────────────

#[test]
fn test_withdraw_fees_transfers_to_admin() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);

    client.withdraw_fees(&admin, &usdc_id, &1_000_0000000);

    assert_eq!(client.get_accumulated_fees(&usdc_id), 0);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&admin), 1_000_0000000);
}

#[test]
fn test_withdraw_fees_partial() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);

    client.withdraw_fees(&admin, &usdc_id, &400_0000000);

    assert_eq!(client.get_accumulated_fees(&usdc_id), 600_0000000);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&admin), 400_0000000);
}

#[test]
fn test_withdraw_fees_multiple_times() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);

    client.withdraw_fees(&admin, &usdc_id, &300_0000000);
    client.withdraw_fees(&admin, &usdc_id, &300_0000000);

    assert_eq!(client.get_accumulated_fees(&usdc_id), 400_0000000);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_withdraw_fees_non_admin_panics() {
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 500_0000000);
    client.deposit_fee(&depositor, &usdc_id, &500_0000000, &None);
    let impostor = Address::generate(&env);
    client.withdraw_fees(&impostor, &usdc_id, &100_0000000);
}

#[test]
#[should_panic(expected = "insufficient accumulated fees")]
fn test_withdraw_fees_exceeds_balance_panics() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 100_0000000);
    client.deposit_fee(&depositor, &usdc_id, &100_0000000, &None);
    client.withdraw_fees(&admin, &usdc_id, &100_0000001);
}

#[test]
#[should_panic(expected = "insufficient accumulated fees")]
fn test_withdraw_fees_when_empty_panics() {
    let (_, client, admin, usdc_id) = setup();
    client.withdraw_fees(&admin, &usdc_id, &1);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_withdraw_fees_zero_panics() {
    let (_, client, admin, usdc_id) = setup();
    client.withdraw_fees(&admin, &usdc_id, &0);
}

// ── #556: withdrawal history event includes timestamp ─────────────────────────

#[test]
fn test_withdraw_fees_event_includes_admin_amount_and_timestamp() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);

    let withdraw_at: u64 = 99_999;
    env.ledger().with_mut(|li| li.timestamp = withdraw_at);
    client.withdraw_fees(&admin, &usdc_id, &1_000_0000000);

    let event_name: Val = Symbol::new(&env, "FeesWithdrawn").into_val(&env);
    let events = env.events().all();
    let withdrawal_event = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|t| t == &event_name)
    });
    assert!(withdrawal_event.is_some(), "FeesWithdrawn event not emitted");

    let (_, _, data) = withdrawal_event.unwrap();
    let payload: EvtFeesWithdrawn = soroban_sdk::from_val(&env, data);
    assert_eq!(payload.admin, admin);
    assert_eq!(payload.token, usdc_id);
    assert_eq!(payload.amount, 1_000_0000000);
    assert_eq!(payload.remaining, 0);
    assert_eq!(payload.timestamp, withdraw_at);
}

// ── get_accumulated_fees ──────────────────────────────────────────────────────

#[test]
fn test_get_accumulated_fees_reflects_deposits_and_withdrawals() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);

    client.deposit_fee(&depositor, &usdc_id, &600_0000000, &None);
    assert_eq!(client.get_accumulated_fees(&usdc_id), 600_0000000);

    client.withdraw_fees(&admin, &usdc_id, &200_0000000);
    assert_eq!(client.get_accumulated_fees(&usdc_id), 400_0000000);

    client.deposit_fee(&depositor, &usdc_id, &400_0000000, &None);
    assert_eq!(client.get_accumulated_fees(&usdc_id), 800_0000000);
}

// ── initialize: split_bps validation ─────────────────────────────────────────

#[test]
#[should_panic(expected = "split_bps exceeds maximum of 5000")]
fn test_initialize_split_bps_above_max_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, FeeDistributorContract);
    let client = FeeDistributorContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    // 5001 exceeds the 5000 cap and must panic.
    client.initialize(&admin, &5001);
}

#[test]
fn test_initialize_split_bps_at_max_does_not_panic() {
    let (_, client, _, usdc_id) = setup_with_split(5000);
    // 5000 is the boundary value; no panic expected.
    assert_eq!(client.get_agent_pool_fees(&usdc_id), 0);
}

// ── deposit_fee with split ────────────────────────────────────────────────────

#[test]
fn test_deposit_fee_splits_correctly() {
    // 2000 bps = 20% to agent pool, 80% to platform treasury.
    let (env, client, _, usdc_id) = setup_with_split(2000);
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);

    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);

    // 80% = 800_0000000 to platform treasury.
    assert_eq!(client.get_accumulated_fees(&usdc_id), 800_0000000);
    // 20% = 200_0000000 to agent pool.
    assert_eq!(client.get_agent_pool_fees(&usdc_id), 200_0000000);
}

#[test]
fn test_deposit_fee_zero_split_routes_all_to_platform() {
    // split_bps = 0: 100% must flow to AccumulatedFees, agent pool stays 0.
    let (env, client, _, usdc_id) = setup_with_split(0);
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 500_0000000);

    client.deposit_fee(&depositor, &usdc_id, &500_0000000, &None);

    assert_eq!(client.get_accumulated_fees(&usdc_id), 500_0000000);
    assert_eq!(client.get_agent_pool_fees(&usdc_id), 0);
}

#[test]
fn test_deposit_fee_full_split_routes_half_to_agent_pool() {
    // split_bps = 5000: 50% to agent pool, 50% to platform treasury.
    let (env, client, _, usdc_id) = setup_with_split(5000);
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);

    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);

    assert_eq!(client.get_accumulated_fees(&usdc_id), 500_0000000);
    assert_eq!(client.get_agent_pool_fees(&usdc_id), 500_0000000);
}

#[test]
fn test_deposit_fee_split_accumulates_across_multiple_deposits() {
    // 1000 bps = 10% to agent pool.
    let (env, client, _, usdc_id) = setup_with_split(1000);
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 2_000_0000000);

    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);
    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);

    // 90% * 2 deposits = 1_800_0000000 platform, 10% * 2 = 200_0000000 agent pool.
    assert_eq!(client.get_accumulated_fees(&usdc_id), 1_800_0000000);
    assert_eq!(client.get_agent_pool_fees(&usdc_id), 200_0000000);
}

// ── withdraw_agent_pool ───────────────────────────────────────────────────────

#[test]
fn test_withdraw_agent_pool_transfers_to_admin() {
    let (env, client, admin, usdc_id) = setup_with_split(2000);
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);

    // Agent pool = 200_0000000 (20%).
    client.withdraw_agent_pool(&admin, &usdc_id, &200_0000000);

    assert_eq!(client.get_agent_pool_fees(&usdc_id), 0);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&admin), 200_0000000);
}

#[test]
fn test_withdraw_agent_pool_partial() {
    let (env, client, admin, usdc_id) = setup_with_split(2000);
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);

    client.withdraw_agent_pool(&admin, &usdc_id, &100_0000000);

    assert_eq!(client.get_agent_pool_fees(&usdc_id), 100_0000000);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&admin), 100_0000000);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_withdraw_agent_pool_non_admin_panics() {
    let (env, client, _, usdc_id) = setup_with_split(2000);
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);
    let impostor = Address::generate(&env);
    client.withdraw_agent_pool(&impostor, &usdc_id, &100_0000000);
}

#[test]
#[should_panic(expected = "insufficient agent pool fees")]
fn test_withdraw_agent_pool_exceeds_balance_panics() {
    let (env, client, admin, usdc_id) = setup_with_split(2000);
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);

    // Pool holds 200_0000000; trying to withdraw 1 more must panic.
    client.withdraw_agent_pool(&admin, &usdc_id, &200_0000001);
}

#[test]
#[should_panic(expected = "insufficient agent pool fees")]
fn test_withdraw_agent_pool_when_empty_panics() {
    let (_, client, admin, usdc_id) = setup_with_split(0);
    client.withdraw_agent_pool(&admin, &usdc_id, &1);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_withdraw_agent_pool_zero_amount_panics() {
    let (_, client, admin, usdc_id) = setup_with_split(2000);
    client.withdraw_agent_pool(&admin, &usdc_id, &0);
}

// ── update_split ──────────────────────────────────────────────────────────────

#[test]
fn test_update_split_changes_future_deposits() {
    let (env, client, admin, usdc_id) = setup_with_split(0);
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 2_000_0000000);

    // First deposit with split_bps = 0: all goes to platform.
    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);
    assert_eq!(client.get_accumulated_fees(&usdc_id), 1_000_0000000);
    assert_eq!(client.get_agent_pool_fees(&usdc_id), 0);

    // Update split to 3000 bps (30%).
    client.update_split(&admin, &3000);

    // Second deposit: 70% platform, 30% agent pool.
    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);
    assert_eq!(client.get_accumulated_fees(&usdc_id), 1_700_0000000); // 1000 + 700
    assert_eq!(client.get_agent_pool_fees(&usdc_id), 300_0000000);    // 0   + 300
}

#[test]
fn test_update_split_emits_split_updated_event() {
    let (env, client, admin, _) = setup_with_split(1000);

    client.update_split(&admin, &2500);

    let event_name: Val = Symbol::new(&env, "SplitUpdated").into_val(&env);
    let events = env.events().all();
    let split_event = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|t| t == &event_name)
    });
    assert!(split_event.is_some(), "SplitUpdated event not emitted");

    let (_, _, data) = split_event.unwrap();
    let payload: EvtSplitUpdated = soroban_sdk::from_val(&env, data);
    assert_eq!(payload.old_split_bps, 1000);
    assert_eq!(payload.new_split_bps, 2500);
}

#[test]
#[should_panic(expected = "split_bps exceeds maximum of 5000")]
fn test_update_split_above_max_panics() {
    let (_, client, admin, _) = setup_with_split(0);
    client.update_split(&admin, &5001);
}

#[test]
fn test_update_split_to_max_boundary_does_not_panic() {
    let (_, client, admin, _) = setup_with_split(0);
    // Exactly 5000 is allowed.
    client.update_split(&admin, &5000);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_update_split_non_admin_panics() {
    let (env, client, _, _) = setup_with_split(0);
    let impostor = Address::generate(&env);
    client.update_split(&impostor, &1000);
}

// ── Multi-asset: XLM deposit and withdrawal ───────────────────────────────────

#[test]
fn test_deposit_and_withdraw_xlm() {
    let (env, client, admin, _usdc_id) = setup();

    // Register a second asset to represent XLM (any SAC works in tests).
    let xlm_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let depositor = Address::generate(&env);
    mint(&env, &xlm_id, &depositor, 500_0000000);

    client.deposit_fee(&depositor, &xlm_id, &500_0000000, &None);

    assert_eq!(client.get_accumulated_fees(&xlm_id), 500_0000000);

    client.withdraw_fees(&admin, &xlm_id, &300_0000000);

    assert_eq!(client.get_accumulated_fees(&xlm_id), 200_0000000);
    assert_eq!(TokenClient::new(&env, &xlm_id).balance(&admin), 300_0000000);
}

#[test]
fn test_xlm_and_usdc_accumulators_are_independent() {
    // Depositing XLM must not touch the USDC accumulator, and vice-versa.
    let (env, client, admin, usdc_id) = setup();

    let xlm_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    mint(&env, &xlm_id, &depositor, 1_000_0000000);

    client.deposit_fee(&depositor, &usdc_id, &700_0000000, &None);
    client.deposit_fee(&depositor, &xlm_id, &300_0000000, &None);

    assert_eq!(client.get_accumulated_fees(&usdc_id), 700_0000000);
    assert_eq!(client.get_accumulated_fees(&xlm_id), 300_0000000);
}

// ── Multi-asset: two-asset deposit with selective withdrawal ──────────────────

#[test]
fn test_two_asset_selective_withdrawal() {
    // Deposit both USDC and XLM, then withdraw only USDC.
    // XLM accumulator must be unaffected.
    let (env, client, admin, usdc_id) = setup();

    let xlm_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    mint(&env, &xlm_id, &depositor, 800_0000000);

    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);
    client.deposit_fee(&depositor, &xlm_id, &800_0000000, &None);

    // Withdraw all USDC fees.
    client.withdraw_fees(&admin, &usdc_id, &1_000_0000000);

    assert_eq!(client.get_accumulated_fees(&usdc_id), 0);
    // XLM fees must be untouched.
    assert_eq!(client.get_accumulated_fees(&xlm_id), 800_0000000);
}

#[test]
fn test_two_asset_both_withdrawals() {
    let (env, client, admin, usdc_id) = setup();

    let xlm_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 500_0000000);
    mint(&env, &xlm_id, &depositor, 400_0000000);

    client.deposit_fee(&depositor, &usdc_id, &500_0000000, &None);
    client.deposit_fee(&depositor, &xlm_id, &400_0000000, &None);

    client.withdraw_fees(&admin, &usdc_id, &200_0000000);
    client.withdraw_fees(&admin, &xlm_id, &400_0000000);

    assert_eq!(client.get_accumulated_fees(&usdc_id), 300_0000000);
    assert_eq!(client.get_accumulated_fees(&xlm_id), 0);
}

// ── Multi-asset: over-withdrawal panics ──────────────────────────────────────

#[test]
#[should_panic(expected = "insufficient accumulated fees")]
fn test_over_withdrawal_usdc_panics() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 100_0000000);
    client.deposit_fee(&depositor, &usdc_id, &100_0000000, &None);
    // Attempt to withdraw one stroop more than deposited.
    client.withdraw_fees(&admin, &usdc_id, &100_0000001);
}

#[test]
#[should_panic(expected = "insufficient accumulated fees")]
fn test_over_withdrawal_xlm_panics() {
    let (env, client, admin, _usdc_id) = setup();

    let xlm_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let depositor = Address::generate(&env);
    mint(&env, &xlm_id, &depositor, 50_0000000);
    client.deposit_fee(&depositor, &xlm_id, &50_0000000, &None);
    client.withdraw_fees(&admin, &xlm_id, &50_0000001);
}

#[test]
#[should_panic(expected = "insufficient accumulated fees")]
fn test_over_withdrawal_wrong_token_panics() {
    // Deposit USDC but try to withdraw XLM (which has zero balance).
    let (env, client, admin, usdc_id) = setup();

    let xlm_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 100_0000000);
    client.deposit_fee(&depositor, &usdc_id, &100_0000000, &None);

    // XLM accumulator is zero; any positive withdrawal must panic.
    client.withdraw_fees(&admin, &xlm_id, &1);
}

// ── get_all_accumulated_fees ──────────────────────────────────────────────────

#[test]
fn test_get_all_accumulated_fees_empty_before_any_deposit() {
    let (_, client, _, _) = setup();
    let all = client.get_all_accumulated_fees(&0, &100);
    assert_eq!(all.len(), 0);
}

#[test]
fn test_get_all_accumulated_fees_single_token() {
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 200_0000000);
    client.deposit_fee(&depositor, &usdc_id, &200_0000000, &None);

    let all = client.get_all_accumulated_fees(&0, &100);
    assert_eq!(all.len(), 1);
    let (addr, bal) = all.get(0).unwrap();
    assert_eq!(addr, usdc_id);
    assert_eq!(bal, 200_0000000);
}

#[test]
fn test_get_all_accumulated_fees_two_tokens() {
    let (env, client, admin, usdc_id) = setup();

    let xlm_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 300_0000000);
    mint(&env, &xlm_id, &depositor, 150_0000000);

    client.deposit_fee(&depositor, &usdc_id, &300_0000000, &None);
    client.deposit_fee(&depositor, &xlm_id, &150_0000000, &None);

    let all = client.get_all_accumulated_fees(&0, &100);
    assert_eq!(all.len(), 2);

    // Order matches insertion order: USDC first, XLM second.
    let (addr0, bal0) = all.get(0).unwrap();
    assert_eq!(addr0, usdc_id);
    assert_eq!(bal0, 300_0000000);

    let (addr1, bal1) = all.get(1).unwrap();
    assert_eq!(addr1, xlm_id);
    assert_eq!(bal1, 150_0000000);
}

#[test]
fn test_get_all_accumulated_fees_excludes_fully_withdrawn_tokens() {
    // After withdrawing all USDC, get_all_accumulated_fees should not include it.
    let (env, client, admin, usdc_id) = setup();

    let xlm_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 100_0000000);
    mint(&env, &xlm_id, &depositor, 200_0000000);

    client.deposit_fee(&depositor, &usdc_id, &100_0000000, &None);
    client.deposit_fee(&depositor, &xlm_id, &200_0000000, &None);

    // Drain USDC entirely.
    client.withdraw_fees(&admin, &usdc_id, &100_0000000);

    let all = client.get_all_accumulated_fees(&0, &100);
    // Only XLM remains with a non-zero balance.
    assert_eq!(all.len(), 1);
    let (addr, bal) = all.get(0).unwrap();
    assert_eq!(addr, xlm_id);
    assert_eq!(bal, 200_0000000);
}

// ── circuit-breaker pause ─────────────────────────────────────────────────────

#[test]
fn test_is_paused_false_by_default() {
    let (_, client, _, _) = setup();
    assert!(!client.is_paused());
}

#[test]
fn test_pause_sets_paused_flag() {
    let (_, client, admin, _) = setup();
    client.pause(&admin);
    assert!(client.is_paused());
}

#[test]
fn test_unpause_clears_paused_flag() {
    let (_, client, admin, _) = setup();
    client.pause(&admin);
    client.unpause(&admin);
    assert!(!client.is_paused());
}

#[test]
fn test_pause_unpause_cycle() {
    let (_, client, admin, _) = setup();
    // starts unpaused
    assert!(!client.is_paused());
    // pause
    client.pause(&admin);
    assert!(client.is_paused());
    // unpause
    client.unpause(&admin);
    assert!(!client.is_paused());
    // can pause again
    client.pause(&admin);
    assert!(client.is_paused());
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_deposit_fee_panics_when_paused() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 500_0000000);
    client.pause(&admin);
    client.deposit_fee(&depositor, &usdc_id, &500_0000000, &None);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_withdraw_fees_panics_when_paused() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 500_0000000);
    // deposit while unpaused so there are funds to attempt withdrawal
    client.deposit_fee(&depositor, &usdc_id, &500_0000000, &None);
    client.pause(&admin);
    client.withdraw_fees(&admin, &usdc_id, &500_0000000);
}

#[test]
fn test_get_accumulated_fees_readable_when_paused() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 300_0000000);
    client.deposit_fee(&depositor, &usdc_id, &300_0000000, &None);
    client.pause(&admin);
    // read-only operation must remain accessible
    assert_eq!(client.get_accumulated_fees(&usdc_id), 300_0000000);
}

#[test]
fn test_is_paused_readable_when_paused() {
    let (_, client, admin, _) = setup();
    client.pause(&admin);
    // is_paused itself must be callable when paused
    assert!(client.is_paused());
}

#[test]
fn test_deposit_succeeds_after_unpause() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 500_0000000);
    client.pause(&admin);
    client.unpause(&admin);
    // should not panic now
    client.deposit_fee(&depositor, &usdc_id, &500_0000000, &None);
    assert_eq!(client.get_accumulated_fees(&usdc_id), 500_0000000);
}

#[test]
fn test_withdraw_succeeds_after_unpause() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 500_0000000);
    client.deposit_fee(&depositor, &usdc_id, &500_0000000, &None);
    client.pause(&admin);
    client.unpause(&admin);
    // should not panic now
    client.withdraw_fees(&admin, &usdc_id, &500_0000000);
    assert_eq!(client.get_accumulated_fees(&usdc_id), 0);
}

#[test]
fn test_pause_emits_contract_paused_event() {
    let (env, client, admin, _) = setup();
    let pause_at: u64 = 12_345;
    env.ledger().with_mut(|li| li.timestamp = pause_at);
    client.pause(&admin);

    let event_name: Val = Symbol::new(&env, "ContractPaused").into_val(&env);
    let events = env.events().all();
    let pause_event = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|t| t == &event_name)
    });
    assert!(pause_event.is_some(), "ContractPaused event not emitted");

    let (_, _, data) = pause_event.unwrap();
    let payload: crate::EvtContractPaused = soroban_sdk::from_val(&env, data);
    assert_eq!(payload.admin, admin);
    assert_eq!(payload.paused_at, pause_at);
}

#[test]
fn test_unpause_emits_contract_unpaused_event() {
    let (env, client, admin, _) = setup();
    client.pause(&admin);

    let unpause_at: u64 = 99_000;
    env.ledger().with_mut(|li| li.timestamp = unpause_at);
    client.unpause(&admin);

    let event_name: Val = Symbol::new(&env, "ContractUnpaused").into_val(&env);
    let events = env.events().all();
    let unpause_event = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|t| t == &event_name)
    });
    assert!(unpause_event.is_some(), "ContractUnpaused event not emitted");

    let (_, _, data) = unpause_event.unwrap();
    let payload: crate::EvtContractUnpaused = soroban_sdk::from_val(&env, data);
    assert_eq!(payload.admin, admin);
    assert_eq!(payload.unpaused_at, unpause_at);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_pause_non_admin_panics() {
    let (env, client, _, _) = setup();
    let impostor = Address::generate(&env);
    client.pause(&impostor);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_unpause_non_admin_panics() {
    let (env, client, admin, _) = setup();
    client.pause(&admin);
    let impostor = Address::generate(&env);
    client.unpause(&impostor);
}

// ── SC-017: deposit_fee upper-bound cap ───────────────────────────────────────

#[test]
#[should_panic(expected = "amount exceeds maximum deposit limit")]
fn test_deposit_fee_above_max_cap_panics() {
    // MAX_DEPOSIT_AMOUNT = 10_000_000_000_000 stroops (1 000 000 USDC).
    // Depositing MAX + 1 must be rejected at the contract level, providing a
    // backstop against caller-side unit/precision bugs (SC-017).
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    // Mint MAX + 1 so the token balance is sufficient; the contract check fires first.
    mint(&env, &usdc_id, &depositor, 10_000_000_000_001);
    client.deposit_fee(&depositor, &usdc_id, &10_000_000_000_001, &None);
}

#[test]
fn test_deposit_fee_at_max_cap_succeeds() {
    // Exactly MAX_DEPOSIT_AMOUNT must be accepted (boundary value).
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 10_000_000_000_000);
    client.deposit_fee(&depositor, &usdc_id, &10_000_000_000_000, &None);
    assert_eq!(client.get_accumulated_fees(&usdc_id), 10_000_000_000_000);
}

// ── SC-018: get_all_accumulated_fees pagination ───────────────────────────────

#[test]
fn test_get_all_accumulated_fees_pagination_returns_correct_page() {
    // Register 4 tokens, then fetch them two at a time and confirm both pages
    // together equal the full result returned with limit=100.
    let (env, client, admin, usdc_id) = setup();

    let tok2 = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let tok3 = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let tok4 = env.register_stellar_asset_contract_v2(admin.clone()).address();

    let depositor = Address::generate(&env);
    for tok in [&usdc_id, &tok2, &tok3, &tok4] {
        mint(&env, tok, &depositor, 100_0000000);
        client.deposit_fee(&depositor, tok, &100_0000000, &None);
    }

    // Full result with a single call.
    let all = client.get_all_accumulated_fees(&0, &100);
    assert_eq!(all.len(), 4);

    // Page 1: indices 0..1 (limit 2).
    let page1 = client.get_all_accumulated_fees(&0, &2);
    assert_eq!(page1.len(), 2);

    // Page 2: indices 2..3 (start 2, limit 2).
    let page2 = client.get_all_accumulated_fees(&2, &2);
    assert_eq!(page2.len(), 2);

    // Both pages together must cover all 4 tokens in order.
    let (a0, _) = page1.get(0).unwrap();
    let (a1, _) = page1.get(1).unwrap();
    let (a2, _) = page2.get(0).unwrap();
    let (a3, _) = page2.get(1).unwrap();

    let (b0, _) = all.get(0).unwrap();
    let (b1, _) = all.get(1).unwrap();
    let (b2, _) = all.get(2).unwrap();
    let (b3, _) = all.get(3).unwrap();

    assert_eq!(a0, b0);
    assert_eq!(a1, b1);
    assert_eq!(a2, b2);
    assert_eq!(a3, b3);
}

#[test]
fn test_get_all_accumulated_fees_limit_capped_at_100() {
    // Requesting limit > 100 must be silently capped: only 100 tokens examined.
    // With fewer than 100 tokens the result is simply the full list.
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 50_0000000);
    client.deposit_fee(&depositor, &usdc_id, &50_0000000, &None);

    // limit=200 should behave identically to limit=100.
    let result = client.get_all_accumulated_fees(&0, &200);
    assert_eq!(result.len(), 1);
}

#[test]
fn test_get_all_accumulated_fees_start_beyond_end_returns_empty() {
    // start >= token list length must return an empty vec, not panic.
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 50_0000000);
    client.deposit_fee(&depositor, &usdc_id, &50_0000000, &None);

    // Only 1 token; start=1 is beyond the list.
    let result = client.get_all_accumulated_fees(&1, &100);
    assert_eq!(result.len(), 0);
}

#[test]
fn test_get_token_list_len_reflects_registered_tokens() {
    // get_token_list_len should match the number of distinct deposited tokens.
    let (env, client, admin, usdc_id) = setup();

    assert_eq!(client.get_token_list_len(), 0);

    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 100_0000000);
    client.deposit_fee(&depositor, &usdc_id, &100_0000000, &None);
    assert_eq!(client.get_token_list_len(), 1);

    let tok2 = env.register_stellar_asset_contract_v2(admin.clone()).address();
    mint(&env, &tok2, &depositor, 100_0000000);
    client.deposit_fee(&depositor, &tok2, &100_0000000, &None);
    assert_eq!(client.get_token_list_len(), 2);

    // Depositing the same token again must not increment the count.
    mint(&env, &usdc_id, &depositor, 100_0000000);
    client.deposit_fee(&depositor, &usdc_id, &100_0000000, &None);
    assert_eq!(client.get_token_list_len(), 2);
}

// ── SC-019: pause blocks mutating ops; read-only getters remain accessible ────

#[test]
fn test_pause_blocks_deposit_fee_and_withdraw_fees_but_not_getters() {
    // Comprehensive regression: after pause()
    //   - deposit_fee       → must panic "Contract is paused"
    //   - withdraw_fees     → must panic "Contract is paused"
    //   - get_accumulated_fees        → must succeed
    //   - get_all_accumulated_fees    → must succeed
    //   - get_agent_pool_fees         → must succeed
    //   - is_paused                   → must succeed (returns true)
    let (env, client, admin, usdc_id) = setup_with_split(2000);
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);

    // Deposit while unpaused to build up balances.
    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);
    client.pause(&admin);

    // ── Read-only getters must remain callable while paused ──────────────────
    assert_eq!(client.get_accumulated_fees(&usdc_id), 800_0000000); // 80% platform (split 2000 bps)
    assert_eq!(client.get_agent_pool_fees(&usdc_id), 200_0000000);  // 20% agent pool
    let all = client.get_all_accumulated_fees(&0, &100);
    assert_eq!(all.len(), 1);
    assert!(client.is_paused());
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_pause_blocks_deposit_fee() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 100_0000000);
    client.pause(&admin);
    client.deposit_fee(&depositor, &usdc_id, &100_0000000, &None);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_pause_blocks_withdraw_fees() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 100_0000000);
    client.deposit_fee(&depositor, &usdc_id, &100_0000000, &None);
    client.pause(&admin);
    client.withdraw_fees(&admin, &usdc_id, &100_0000000);
}

#[test]
fn test_withdraw_agent_pool_not_blocked_by_pause() {
    // withdraw_agent_pool deliberately has no Paused check (by design —
    // agent-pool withdrawals must remain available to honour pending agent
    // payouts even during an incident that warrants pausing new deposits).
    // This test locks in that deliberate omission as regression coverage
    // (SC-019 acceptance criterion: "deliberate decision, not an oversight").
    let (env, client, admin, usdc_id) = setup_with_split(2000);
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);

    // Build up agent pool balance while unpaused.
    client.deposit_fee(&depositor, &usdc_id, &1_000_0000000, &None);
    // Agent pool = 200_0000000 (20% of 1_000_0000000 with split 2000 bps).
    assert_eq!(client.get_agent_pool_fees(&usdc_id), 200_0000000);

    client.pause(&admin);

    // withdraw_agent_pool must NOT panic when contract is paused — this is
    // intentional: agent-pool withdrawals are not gated by the pause flag.
    client.withdraw_agent_pool(&admin, &usdc_id, &200_0000000);
    assert_eq!(client.get_agent_pool_fees(&usdc_id), 0);
}
