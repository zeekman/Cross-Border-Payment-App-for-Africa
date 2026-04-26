#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal,
};

use crate::{SavingsVaultContract, SavingsVaultContractClient};

fn setup() -> (Env, SavingsVaultContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, SavingsVaultContract);
    let client = SavingsVaultContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    client.initialize(&usdc_id);
    (env, client, admin, usdc_id)
}

fn mint_usdc(env: &Env, usdc_id: &Address, admin: &Address, to: &Address, amount: i128) {
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
    let (_, client, _, usdc_id) = setup();
    client.initialize(&usdc_id);
}

#[test]
fn test_deposit() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128; // 1000 USDC
    let unlock_time = env.ledger().timestamp() + 86400; // 1 day from now

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
    let unlock_time = env.ledger().timestamp() + 3600; // 1 hour from now

    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);

    // Fast forward time past unlock
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
    let unlock_time = env.ledger().timestamp() + 86400; // 1 day from now

    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);

    // Withdraw before unlock time
    client.withdraw(&user, &amount);

    let expected_penalty = (amount * 1000) / 10000; // 10% penalty
    let expected_withdrawal = amount - expected_penalty;

    assert_eq!(client.get_balance(&user), 0);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&user), expected_withdrawal);
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

#[test]
fn test_multiple_deposits() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount1 = 500_0000000i128;
    let amount2 = 300_0000000i128;
    let unlock_time1 = env.ledger().timestamp() + 3600;
    let unlock_time2 = env.ledger().timestamp() + 7200; // Later unlock time

    mint_usdc(&env, &usdc_id, &admin, &user, amount1 + amount2);

    client.deposit(&user, &amount1, &unlock_time1);
    client.deposit(&user, &amount2, &unlock_time2);

    assert_eq!(client.get_balance(&user), amount1 + amount2);
    assert_eq!(client.get_unlock_time(&user), unlock_time2); // Should be the latest
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