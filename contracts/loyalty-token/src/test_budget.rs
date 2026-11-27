#![cfg(test)]
//! SC-215: resource-budget regression tests for loyalty-token hot paths.
//! Baselines live in `contracts/budgets.json`; see `contracts/README.md`.
//!
//! `transfer` has to record pre-transfer balances for every active snapshot
//! (SC-168), so it is measured with snapshots active.
extern crate std;

#[path = "../../test-support/budget.rs"]
mod budget;

use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env};

use crate::{LoyaltyTokenContract, LoyaltyTokenContractClient};

const MAX_SUPPLY: i128 = 1_000_000_000;
/// Mirrors the contract's snapshot limit (an 11th `create_snapshot` panics).
const MAX_SNAPSHOTS: u32 = 10;

fn setup() -> (Env, LoyaltyTokenContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    budget::unlimited_setup(&env);
    env.ledger().with_mut(|l| {
        l.timestamp = 1_000_000;
        l.sequence_number = 100;
    });
    let contract_id = env.register(LoyaltyTokenContract, ());
    let client = LoyaltyTokenContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &MAX_SUPPLY);
    (env, client, admin)
}

/// Mint to `holders` extra accounts, then open `snapshots` snapshots. Returns
/// a funded sender and a receiver for the measured transfer.
fn seed(env: &Env, client: &LoyaltyTokenContractClient, admin: &Address, holders: u32, snapshots: u32) -> (Address, Address) {
    let sender = Address::generate(env);
    let receiver = Address::generate(env);
    client.mint(admin, &sender, &1_000);
    for _ in 0..holders {
        client.mint(admin, &Address::generate(env), &10);
        budget::unlimited_setup(env);
    }
    for _ in 0..snapshots {
        client.create_snapshot(admin);
        budget::unlimited_setup(env);
    }
    (sender, receiver)
}

#[test]
fn budget_loyalty_token_transfer_with_snapshot() {
    let (env, client, admin) = setup();
    let (sender, receiver) = seed(&env, &client, &admin, 0, 1);
    budget::assert_budget(&env, "loyalty-token::transfer[1 snapshot]", || {
        client.transfer(&sender, &receiver, &30)
    });
}

/// SC-133 / SC-168: 100 holders and the maximum number of active snapshots.
#[test]
fn budget_loyalty_token_transfer_large_state() {
    let (env, client, admin) = setup();
    let (sender, receiver) = seed(&env, &client, &admin, 100, MAX_SNAPSHOTS);
    budget::assert_budget(&env, "loyalty-token::transfer[100 holders, 10 snapshots]", || {
        client.transfer(&sender, &receiver, &30)
    });
}
