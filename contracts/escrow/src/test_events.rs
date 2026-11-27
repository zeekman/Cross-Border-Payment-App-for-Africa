#![cfg(test)]
//! SC-216: event snapshot for a scripted escrow flow. Any change to an event
//! name, topic or payload shows up as a diff of
//! `escrow/event_snapshots/escrow_flow.snap`. See `contracts/EVENTS.md`.
extern crate std;

#[path = "../../test-support/events.rs"]
mod events;

use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env};

use crate::{EscrowContract, EscrowContractClient};

const AMOUNT: i128 = 1_000_0000000;
const FEE_BPS: u32 = 250;

#[test]
fn events_escrow_flow() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract(admin.clone());
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    StellarAssetClient::new(&env, &usdc_id).mint(&sender, &(AMOUNT * 2));

    let mut snap = events::EventSnapshot::new(&env, &contract_id);
    snap.name(&admin, "admin")
        .name(&usdc_id, "usdc")
        .name(&sender, "sender")
        .name(&recipient, "recipient")
        .name(&agent, "agent");

    client.initialize(&admin, &usdc_id);
    snap.capture("initialize");

    let released = client.create_escrow(&sender, &recipient, &agent, &AMOUNT, &FEE_BPS);
    snap.capture("create_escrow#1");

    client.confirm_delivery(&agent, &released);
    snap.capture("confirm_delivery#1");

    client.release_escrow(&agent, &released);
    snap.capture("release_escrow#1");

    client.create_escrow(&sender, &recipient, &agent, &AMOUNT, &FEE_BPS);
    snap.capture("create_escrow#2");

    snap.assert_matches("escrow_flow");
}
