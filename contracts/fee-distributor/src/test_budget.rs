#![cfg(test)]
//! SC-215: resource-budget regression tests for fee-distributor hot paths.
//! Baselines live in `contracts/budgets.json`; see `contracts/README.md`.
extern crate std;

#[path = "../../test-support/budget.rs"]
mod budget;

use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env};

use crate::{FeeDistributorContract, FeeDistributorContractClient};

const AMOUNT: i128 = 10_0000000;

fn setup(split_bps: u32) -> (Env, FeeDistributorContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    budget::unlimited_setup(&env);
    let id = env.register(FeeDistributorContract, ());
    let client = FeeDistributorContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    client.initialize(&admin, &split_bps);
    client.add_fee_token(&usdc_id);
    (env, client, usdc_id)
}

fn measure_deposit(split_bps: u32, prior_deposits: u32, name: &str) {
    let (env, client, usdc_id) = setup(split_bps);
    let depositor = Address::generate(&env);
    StellarAssetClient::new(&env, &usdc_id).mint(&depositor, &(AMOUNT * (prior_deposits as i128 + 1)));
    for _ in 0..prior_deposits {
        client.deposit_fee(&depositor, &usdc_id, &AMOUNT, &None);
        budget::unlimited_setup(&env);
    }
    budget::assert_budget(&env, name, || {
        client.deposit_fee(&depositor, &usdc_id, &AMOUNT, &None)
    });
}

#[test]
fn budget_fee_distributor_deposit_fee() {
    measure_deposit(0, 0, "fee-distributor::deposit_fee");
}

/// With an agent-pool split, the deposit also updates the agent pool.
#[test]
fn budget_fee_distributor_deposit_fee_with_split() {
    measure_deposit(2_000, 0, "fee-distributor::deposit_fee[split 20%]");
}

#[test]
fn budget_fee_distributor_deposit_fee_large_state() {
    measure_deposit(2_000, 100, "fee-distributor::deposit_fee[split 20%, 100 prior deposits]");
}
