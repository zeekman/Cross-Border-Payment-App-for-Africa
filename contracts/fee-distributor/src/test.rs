#![cfg(test)]

use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

use crate::{FeeDistributorContract, FeeDistributorContractClient};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn setup() -> (Env, FeeDistributorContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, FeeDistributorContract);
    let client = FeeDistributorContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    client.initialize(&admin, &usdc_id);
    (env, client, admin, usdc_id)
}

fn mint(env: &Env, usdc_id: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, usdc_id).mint(to, &amount);
}

// ── initialize ────────────────────────────────────────────────────────────────

#[test]
fn test_initial_fees_are_zero() {
    let (_, client, _, _) = setup();
    assert_eq!(client.get_accumulated_fees(), 0);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let (_, client, admin, usdc_id) = setup();
    client.initialize(&admin, &usdc_id);
}

// ── deposit_fee ───────────────────────────────────────────────────────────────

#[test]
fn test_deposit_fee_increments_total() {
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    client.deposit_fee(&depositor, &500_0000000);
    assert_eq!(client.get_accumulated_fees(), 500_0000000);
}

#[test]
fn test_deposit_fee_transfers_usdc_to_contract() {
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    client.deposit_fee(&depositor, &1_000_0000000);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&depositor), 0);
}

#[test]
fn test_multiple_deposits_accumulate() {
    let (env, client, _, usdc_id) = setup();
    let d1 = Address::generate(&env);
    let d2 = Address::generate(&env);
    mint(&env, &usdc_id, &d1, 300_0000000);
    mint(&env, &usdc_id, &d2, 200_0000000);
    client.deposit_fee(&d1, &300_0000000);
    client.deposit_fee(&d2, &200_0000000);
    assert_eq!(client.get_accumulated_fees(), 500_0000000);
}

#[test]
fn test_deposit_fee_minimum_amount() {
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1);
    client.deposit_fee(&depositor, &1);
    assert_eq!(client.get_accumulated_fees(), 1);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_deposit_fee_zero_panics() {
    let (env, client, _, _) = setup();
    let depositor = Address::generate(&env);
    client.deposit_fee(&depositor, &0);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_deposit_fee_negative_panics() {
    let (env, client, _, _) = setup();
    let depositor = Address::generate(&env);
    client.deposit_fee(&depositor, &-1);
}

// ── withdraw_fees ─────────────────────────────────────────────────────────────

#[test]
fn test_withdraw_fees_transfers_to_admin() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    client.deposit_fee(&depositor, &1_000_0000000);

    client.withdraw_fees(&admin, &1_000_0000000);

    assert_eq!(client.get_accumulated_fees(), 0);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&admin), 1_000_0000000);
}

#[test]
fn test_withdraw_fees_partial() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    client.deposit_fee(&depositor, &1_000_0000000);

    client.withdraw_fees(&admin, &400_0000000);

    assert_eq!(client.get_accumulated_fees(), 600_0000000);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&admin), 400_0000000);
}

#[test]
fn test_withdraw_fees_multiple_times() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);
    client.deposit_fee(&depositor, &1_000_0000000);

    client.withdraw_fees(&admin, &300_0000000);
    client.withdraw_fees(&admin, &300_0000000);

    assert_eq!(client.get_accumulated_fees(), 400_0000000);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_withdraw_fees_non_admin_panics() {
    let (env, client, _, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 500_0000000);
    client.deposit_fee(&depositor, &500_0000000);
    let impostor = Address::generate(&env);
    client.withdraw_fees(&impostor, &100_0000000);
}

#[test]
#[should_panic(expected = "insufficient accumulated fees")]
fn test_withdraw_fees_exceeds_balance_panics() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 100_0000000);
    client.deposit_fee(&depositor, &100_0000000);
    client.withdraw_fees(&admin, &100_0000001);
}

#[test]
#[should_panic(expected = "insufficient accumulated fees")]
fn test_withdraw_fees_when_empty_panics() {
    let (_, client, admin, _) = setup();
    client.withdraw_fees(&admin, &1);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_withdraw_fees_zero_panics() {
    let (_, client, admin, _) = setup();
    client.withdraw_fees(&admin, &0);
}

// ── get_accumulated_fees ──────────────────────────────────────────────────────

#[test]
fn test_get_accumulated_fees_reflects_deposits_and_withdrawals() {
    let (env, client, admin, usdc_id) = setup();
    let depositor = Address::generate(&env);
    mint(&env, &usdc_id, &depositor, 1_000_0000000);

    client.deposit_fee(&depositor, &600_0000000);
    assert_eq!(client.get_accumulated_fees(), 600_0000000);

    client.withdraw_fees(&admin, &200_0000000);
    assert_eq!(client.get_accumulated_fees(), 400_0000000);

    client.deposit_fee(&depositor, &400_0000000);
    assert_eq!(client.get_accumulated_fees(), 800_0000000);
}
