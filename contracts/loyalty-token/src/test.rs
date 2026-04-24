#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env};

use crate::{LoyaltyTokenContract, LoyaltyTokenContractClient};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn setup() -> (Env, LoyaltyTokenContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, LoyaltyTokenContract);
    let client = LoyaltyTokenContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

// ── initialize ────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_sets_zero_supply() {
    let (_, client, _) = setup();
    assert_eq!(client.total_supply(), 0);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let (_, client, admin) = setup();
    client.initialize(&admin);
}

// ── metadata ──────────────────────────────────────────────────────────────────

#[test]
fn test_name() {
    let (env, client, _) = setup();
    assert_eq!(
        client.name(),
        soroban_sdk::String::from_str(&env, "AfriPay Loyalty Points")
    );
}

#[test]
fn test_symbol() {
    let (env, client, _) = setup();
    assert_eq!(
        client.symbol(),
        soroban_sdk::String::from_str(&env, "ALP")
    );
}

#[test]
fn test_decimals_is_zero() {
    let (_, client, _) = setup();
    assert_eq!(client.decimals(), 0);
}

// ── mint ──────────────────────────────────────────────────────────────────────

#[test]
fn test_mint_increases_balance_and_supply() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &50);
    assert_eq!(client.balance(&user), 50);
    assert_eq!(client.total_supply(), 50);
}

#[test]
fn test_mint_accumulates_across_calls() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &30);
    client.mint(&admin, &user, &70);
    assert_eq!(client.balance(&user), 100);
    assert_eq!(client.total_supply(), 100);
}

#[test]
fn test_mint_multiple_users_independent_balances() {
    let (env, client, admin) = setup();
    let u1 = Address::generate(&env);
    let u2 = Address::generate(&env);
    client.mint(&admin, &u1, &40);
    client.mint(&admin, &u2, &60);
    assert_eq!(client.balance(&u1), 40);
    assert_eq!(client.balance(&u2), 60);
    assert_eq!(client.total_supply(), 100);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_mint_non_admin_panics() {
    let (env, client, _) = setup();
    let impostor = Address::generate(&env);
    let user = Address::generate(&env);
    client.mint(&impostor, &user, &10);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_mint_zero_amount_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &0);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_mint_negative_amount_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &-1);
}

// ── burn ──────────────────────────────────────────────────────────────────────

#[test]
fn test_burn_decreases_balance_and_supply() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &100);
    client.burn(&user, &40);
    assert_eq!(client.balance(&user), 60);
    assert_eq!(client.total_supply(), 60);
}

#[test]
#[should_panic(expected = "insufficient balance")]
fn test_burn_more_than_balance_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &50);
    client.burn(&user, &51);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_burn_zero_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &10);
    client.burn(&user, &0);
}

// ── transfer ──────────────────────────────────────────────────────────────────

#[test]
fn test_transfer_moves_points_between_accounts() {
    let (env, client, admin) = setup();
    let sender = Address::generate(&env);
    let receiver = Address::generate(&env);
    client.mint(&admin, &sender, &100);
    client.transfer(&sender, &receiver, &30);
    assert_eq!(client.balance(&sender), 70);
    assert_eq!(client.balance(&receiver), 30);
    assert_eq!(client.total_supply(), 100); // supply unchanged
}

#[test]
#[should_panic(expected = "insufficient balance")]
fn test_transfer_insufficient_balance_panics() {
    let (env, client, admin) = setup();
    let sender = Address::generate(&env);
    let receiver = Address::generate(&env);
    client.mint(&admin, &sender, &10);
    client.transfer(&sender, &receiver, &11);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_transfer_zero_panics() {
    let (env, client, admin) = setup();
    let sender = Address::generate(&env);
    let receiver = Address::generate(&env);
    client.mint(&admin, &sender, &10);
    client.transfer(&sender, &receiver, &0);
}

// ── approve / allowance / transfer_from ──────────────────────────────────────

#[test]
fn test_approve_sets_allowance() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &100);
    client.approve(&owner, &spender, &50);
    assert_eq!(client.allowance(&owner, &spender), 50);
}

#[test]
fn test_transfer_from_uses_allowance() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let receiver = Address::generate(&env);
    client.mint(&admin, &owner, &100);
    client.approve(&owner, &spender, &40);
    client.transfer_from(&spender, &owner, &receiver, &40);
    assert_eq!(client.balance(&owner), 60);
    assert_eq!(client.balance(&receiver), 40);
    assert_eq!(client.allowance(&owner, &spender), 0);
}

#[test]
#[should_panic(expected = "insufficient allowance")]
fn test_transfer_from_exceeds_allowance_panics() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let receiver = Address::generate(&env);
    client.mint(&admin, &owner, &100);
    client.approve(&owner, &spender, &10);
    client.transfer_from(&spender, &owner, &receiver, &11);
}

#[test]
fn test_burn_from_uses_allowance() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &100);
    client.approve(&owner, &spender, &30);
    client.burn_from(&spender, &owner, &30);
    assert_eq!(client.balance(&owner), 70);
    assert_eq!(client.total_supply(), 70);
    assert_eq!(client.allowance(&owner, &spender), 0);
}

#[test]
#[should_panic(expected = "insufficient allowance")]
fn test_burn_from_exceeds_allowance_panics() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &100);
    client.approve(&owner, &spender, &5);
    client.burn_from(&spender, &owner, &6);
}

// ── redeem ────────────────────────────────────────────────────────────────────

#[test]
fn test_redeem_burns_100_points_and_returns_true() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &150);
    let result = client.redeem(&user);
    assert!(result);
    assert_eq!(client.balance(&user), 50);
    assert_eq!(client.total_supply(), 50);
}

#[test]
fn test_redeem_exactly_100_points_leaves_zero() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &100);
    let result = client.redeem(&user);
    assert!(result);
    assert_eq!(client.balance(&user), 0);
    assert_eq!(client.total_supply(), 0);
}

#[test]
fn test_redeem_insufficient_points_returns_false() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &99);
    let result = client.redeem(&user);
    assert!(!result);
    // Balance unchanged
    assert_eq!(client.balance(&user), 99);
    assert_eq!(client.total_supply(), 99);
}

#[test]
fn test_redeem_zero_balance_returns_false() {
    let (env, client, _) = setup();
    let user = Address::generate(&env);
    let result = client.redeem(&user);
    assert!(!result);
}

#[test]
fn test_redeem_can_be_called_multiple_times() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &300);
    assert!(client.redeem(&user)); // 300 → 200
    assert!(client.redeem(&user)); // 200 → 100
    assert!(client.redeem(&user)); // 100 → 0
    assert!(!client.redeem(&user)); // 0 → false
    assert_eq!(client.balance(&user), 0);
}

// ── balance of unknown account ────────────────────────────────────────────────

#[test]
fn test_balance_unknown_account_is_zero() {
    let (env, client, _) = setup();
    let unknown = Address::generate(&env);
    assert_eq!(client.balance(&unknown), 0);
}

// ── earn rate: 1 point per 1 XLM ─────────────────────────────────────────────

#[test]
fn test_mint_one_point_per_xlm_volume() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    // Simulate a 50 XLM transaction → mint 50 points
    let xlm_amount: i128 = 50;
    client.mint(&admin, &user, &xlm_amount);
    assert_eq!(client.balance(&user), 50);
}
