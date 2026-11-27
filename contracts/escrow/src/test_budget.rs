#![cfg(test)]
//! SC-215: resource-budget regression tests for escrow hot paths.
//! Baselines live in `contracts/budgets.json`; see `contracts/README.md`.
extern crate std;

#[path = "../../test-support/budget.rs"]
mod budget;

use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env};

use crate::{EscrowContract, EscrowContractClient};

const AMOUNT: i128 = 1_000_0000000;
const FEE_BPS: u32 = 250;

fn setup() -> (Env, EscrowContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    budget::unlimited_setup(&env);
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract(admin.clone());
    client.initialize(&admin, &usdc_id);
    (env, client, usdc_id)
}

fn funded_sender(env: &Env, usdc_id: &Address) -> Address {
    let sender = Address::generate(env);
    StellarAssetClient::new(env, usdc_id).mint(&sender, &AMOUNT);
    sender
}

/// Pre-populate `n` pending escrows so the measured call runs against a
/// non-trivial ledger state.
fn seed_escrows(env: &Env, client: &EscrowContractClient, usdc_id: &Address, n: u32) {
    for _ in 0..n {
        let sender = funded_sender(env, usdc_id);
        let recipient = Address::generate(env);
        let agent = Address::generate(env);
        client.create_escrow(&sender, &recipient, &agent, &AMOUNT, &FEE_BPS);
        budget::unlimited_setup(env);
    }
}

#[test]
fn budget_escrow_create_escrow() {
    let (env, client, usdc_id) = setup();
    let sender = funded_sender(&env, &usdc_id);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    budget::assert_budget(&env, "escrow::create_escrow", || {
        client.create_escrow(&sender, &recipient, &agent, &AMOUNT, &FEE_BPS)
    });
}

#[test]
fn budget_escrow_create_escrow_large_state() {
    let (env, client, usdc_id) = setup();
    seed_escrows(&env, &client, &usdc_id, 100);
    let sender = funded_sender(&env, &usdc_id);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    budget::assert_budget(&env, "escrow::create_escrow[100 escrows]", || {
        client.create_escrow(&sender, &recipient, &agent, &AMOUNT, &FEE_BPS)
    });
}

#[test]
fn budget_escrow_release_escrow() {
    let (env, client, usdc_id) = setup();
    let sender = funded_sender(&env, &usdc_id);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let id = client.create_escrow(&sender, &recipient, &agent, &AMOUNT, &FEE_BPS);
    budget::assert_budget(&env, "escrow::release_escrow", || {
        client.release_escrow(&agent, &id)
    });
}

#[test]
fn budget_escrow_release_escrow_large_state() {
    let (env, client, usdc_id) = setup();
    seed_escrows(&env, &client, &usdc_id, 100);
    let sender = funded_sender(&env, &usdc_id);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let id = client.create_escrow(&sender, &recipient, &agent, &AMOUNT, &FEE_BPS);
    budget::assert_budget(&env, "escrow::release_escrow[100 escrows]", || {
        client.release_escrow(&agent, &id)
    });
}
