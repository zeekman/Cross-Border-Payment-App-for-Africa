#![cfg(test)]
//! SEP-41 allowance semantics: expiration is preserved across partial
//! spends, and a non-zero allowance can't be approved already expired.

use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env};

use crate::{LoyaltyTokenContract, LoyaltyTokenContractClient};

const START_LEDGER: u32 = 1_000;

fn setup() -> (Env, LoyaltyTokenContractClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = START_LEDGER);
    let contract_id = env.register_contract(None, LoyaltyTokenContract);
    let client = LoyaltyTokenContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &1_000_000);
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &1_000);
    (env, client, owner, spender, admin)
}

fn set_ledger(env: &Env, seq: u32) {
    env.ledger().with_mut(|l| l.sequence_number = seq);
}

#[test]
fn test_partial_transfer_from_keeps_expiration() {
    let (env, client, owner, spender, _) = setup();
    let receiver = Address::generate(&env);
    let expires = START_LEDGER + 100;
    client.approve(&owner, &spender, &100, &expires);

    client.transfer_from(&spender, &owner, &receiver, &40);
    assert_eq!(client.allowance(&owner, &spender), 60);

    // Still usable up to and including the expiration ledger...
    set_ledger(&env, expires);
    assert_eq!(client.allowance(&owner, &spender), 60);

    // ...but not after it: the remainder must not become permanent.
    set_ledger(&env, expires + 1);
    assert_eq!(client.allowance(&owner, &spender), 0);
}

#[test]
fn test_partial_burn_from_keeps_expiration() {
    let (env, client, owner, spender, _) = setup();
    let expires = START_LEDGER + 10;
    client.approve(&owner, &spender, &50, &expires);

    client.burn_from(&spender, &owner, &20);
    assert_eq!(client.allowance(&owner, &spender), 30);

    set_ledger(&env, expires + 1);
    assert_eq!(client.allowance(&owner, &spender), 0);
}

#[test]
#[should_panic(expected = "insufficient allowance")]
fn test_transfer_from_remainder_unusable_after_expiry() {
    let (env, client, owner, spender, _) = setup();
    let receiver = Address::generate(&env);
    let expires = START_LEDGER + 5;
    client.approve(&owner, &spender, &100, &expires);
    client.transfer_from(&spender, &owner, &receiver, &10);

    set_ledger(&env, expires + 1);
    client.transfer_from(&spender, &owner, &receiver, &10);
}

#[test]
#[should_panic(expected = "insufficient allowance")]
fn test_burn_from_remainder_unusable_after_expiry() {
    let (env, client, owner, spender, _) = setup();
    let expires = START_LEDGER + 5;
    client.approve(&owner, &spender, &100, &expires);
    client.burn_from(&spender, &owner, &10);

    set_ledger(&env, expires + 1);
    client.burn_from(&spender, &owner, &10);
}

#[test]
#[should_panic(expected = "expiration_ledger is less than ledger seq when amount > 0")]
fn test_approve_nonzero_with_past_expiration_panics() {
    let (_, client, owner, spender, _) = setup();
    client.approve(&owner, &spender, &50, &(START_LEDGER - 1));
}

#[test]
fn test_approve_zero_with_past_expiration_clears_allowance() {
    let (_, client, owner, spender, _) = setup();
    client.approve(&owner, &spender, &50, &(START_LEDGER + 10));
    // Revoking with amount 0 is allowed regardless of expiration.
    client.approve(&owner, &spender, &0, &0);
    assert_eq!(client.allowance(&owner, &spender), 0);
}

#[test]
fn test_approve_expiring_at_current_ledger_is_valid() {
    let (_, client, owner, spender, _) = setup();
    client.approve(&owner, &spender, &50, &START_LEDGER);
    assert_eq!(client.allowance(&owner, &spender), 50);
}

#[test]
#[should_panic(expected = "expiration_ledger is less than ledger seq when amount > 0")]
fn test_increase_allowance_with_past_expiration_panics() {
    let (_, client, owner, spender, _) = setup();
    client.increase_allowance(&owner, &spender, &50, &(START_LEDGER - 1));
}
