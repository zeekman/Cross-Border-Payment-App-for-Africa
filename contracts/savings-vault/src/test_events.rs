#![cfg(test)]
//! SC-216: event snapshot for a scripted savings-vault flow. Any change to an
//! event name, topic or payload shows up as a diff of
//! `savings-vault/event_snapshots/savings_vault_flow.snap`. See `contracts/EVENTS.md`.
extern crate std;

#[path = "../../test-support/events.rs"]
mod events;

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Env,
};

use crate::{SavingsVaultContract, SavingsVaultContractClient};

const AMOUNT: i128 = 1_000_0000000;

#[test]
fn events_savings_vault_flow() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);
    let contract_id = env.register(SavingsVaultContract, ());
    let client = SavingsVaultContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &usdc_id).mint(&user, &(AMOUNT * 2));

    let mut snap = events::EventSnapshot::new(&env, &contract_id);
    snap.name(&admin, "admin").name(&usdc_id, "usdc").name(&user, "user");

    client.initialize(&admin, &usdc_id, &1000u32);
    snap.capture("initialize");

    client.update_interest_rate(&admin, &500u32);
    snap.capture("update_interest_rate");

    let unlock = env.ledger().timestamp() + 86_400;
    client.deposit(&user, &AMOUNT, &unlock);
    snap.capture("deposit#0");

    client.deposit(&user, &AMOUNT, &(unlock + 86_400));
    snap.capture("deposit#1");

    snap.assert_matches("savings_vault_flow");
}
