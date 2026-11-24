#![cfg(test)]
//! SC-216: event snapshot for a scripted agent-escrow flow. Any change to an
//! event name, topic or payload shows up as a diff of
//! `agent-escrow/event_snapshots/agent_escrow_flow.snap`. See `contracts/EVENTS.md`.
extern crate std;

#[path = "../../test-support/events.rs"]
mod events;

use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env};

use crate::{AgentEscrowContract, AgentEscrowContractClient};

const AMOUNT: i128 = 1_000_0000000;
const FEE_BPS: u32 = 250;

#[test]
fn events_agent_escrow_flow() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentEscrowContract, ());
    let client = AgentEscrowContractClient::new(&env, &contract_id);
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

    client.initialize(&admin, &usdc_id, &(48 * 60 * 60));
    snap.capture("initialize");

    client.register_agent(&agent);
    snap.capture("register_agent");

    let first = client.create_escrow(&sender, &recipient, &agent, &AMOUNT, &FEE_BPS);
    snap.capture("create_escrow#1");

    client.confirm_payout(&agent, &first);
    snap.capture("confirm_payout#1");

    let second = client.create_escrow(&sender, &recipient, &agent, &AMOUNT, &FEE_BPS);
    snap.capture("create_escrow#2");

    client.partial_confirm_payout(&agent, &second, &(AMOUNT / 2));
    snap.capture("partial_confirm_payout#2");

    client.remove_agent(&agent);
    snap.capture("remove_agent");

    snap.assert_matches("agent_escrow_flow");
}
