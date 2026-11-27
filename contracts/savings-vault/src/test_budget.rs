#![cfg(test)]
//! SC-215: resource-budget regression tests for savings-vault hot paths.
//! Baselines live in `contracts/budgets.json`; see `contracts/README.md`.
extern crate std;

#[path = "../../test-support/budget.rs"]
mod budget;

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Env,
};

use crate::{SavingsVaultContract, SavingsVaultContractClient};

const AMOUNT: i128 = 1_000_0000000;
const LOCK_SECS: u64 = 86_400;

fn setup() -> (Env, SavingsVaultContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    budget::unlimited_setup(&env);
    // The contract treats timestamp 0 as a sentinel; start somewhere realistic.
    env.ledger().set_timestamp(1_700_000_000);
    let contract_id = env.register(SavingsVaultContract, ());
    let client = SavingsVaultContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    client.initialize(&admin, &usdc_id, &1000u32);
    (env, client, usdc_id)
}

/// A user holding `vaults` existing vaults plus enough USDC for one more deposit.
fn user_with_vaults(env: &Env, client: &SavingsVaultContractClient, usdc_id: &Address, vaults: u32) -> Address {
    let user = Address::generate(env);
    StellarAssetClient::new(env, usdc_id).mint(&user, &(AMOUNT * (vaults as i128 + 1)));
    let unlock = env.ledger().timestamp() + LOCK_SECS;
    for _ in 0..vaults {
        client.deposit(&user, &AMOUNT, &unlock);
        budget::unlimited_setup(env);
    }
    user
}

#[test]
fn budget_savings_vault_deposit() {
    let (env, client, usdc_id) = setup();
    let user = user_with_vaults(&env, &client, &usdc_id, 0);
    let unlock = env.ledger().timestamp() + LOCK_SECS;
    budget::assert_budget(&env, "savings-vault::deposit", || {
        client.deposit(&user, &AMOUNT, &unlock)
    });
}

/// SC-208: the per-user vault list must not make deposits scale linearly.
#[test]
fn budget_savings_vault_deposit_large_state() {
    let (env, client, usdc_id) = setup();
    let user = user_with_vaults(&env, &client, &usdc_id, 100);
    let unlock = env.ledger().timestamp() + LOCK_SECS;
    budget::assert_budget(&env, "savings-vault::deposit[100 vaults]", || {
        client.deposit(&user, &AMOUNT, &unlock)
    });
}

#[test]
fn budget_savings_vault_withdraw() {
    let (env, client, usdc_id) = setup();
    let user = user_with_vaults(&env, &client, &usdc_id, 1);
    env.ledger().set_timestamp(env.ledger().timestamp() + LOCK_SECS + 1);
    budget::assert_budget(&env, "savings-vault::withdraw", || {
        client.withdraw(&user, &0, &AMOUNT)
    });
}

#[test]
fn budget_savings_vault_withdraw_large_state() {
    let (env, client, usdc_id) = setup();
    let user = user_with_vaults(&env, &client, &usdc_id, 100);
    env.ledger().set_timestamp(env.ledger().timestamp() + LOCK_SECS + 1);
    budget::assert_budget(&env, "savings-vault::withdraw[100 vaults]", || {
        client.withdraw(&user, &50, &AMOUNT)
    });
}
