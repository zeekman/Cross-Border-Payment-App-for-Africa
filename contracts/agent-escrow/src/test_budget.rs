#![cfg(test)]
//! SC-215: resource-budget regression tests for agent-escrow hot paths.
//! Baselines live in `contracts/budgets.json`; see `contracts/README.md`.
extern crate std;

#[path = "../../test-support/budget.rs"]
mod budget;

use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env};

use crate::{AgentEscrowContract, AgentEscrowContractClient};

const AMOUNT: i128 = 1_000_0000000;
const FEE_BPS: u32 = 250;

fn setup() -> (Env, AgentEscrowContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    budget::unlimited_setup(&env);
    let contract_id = env.register(AgentEscrowContract, ());
    let client = AgentEscrowContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract(admin.clone());
    client.initialize(&admin, &usdc_id, &(48 * 60 * 60));
    (env, client, usdc_id)
}

fn measure_create(env: &Env, client: &AgentEscrowContractClient, usdc_id: &Address, agent: &Address, name: &str) {
    let sender = Address::generate(env);
    let recipient = Address::generate(env);
    StellarAssetClient::new(env, usdc_id).mint(&sender, &AMOUNT);
    budget::assert_budget(env, name, || {
        client.create_escrow(&sender, &recipient, agent, &AMOUNT, &FEE_BPS)
    });
}

#[test]
fn budget_agent_escrow_create_escrow() {
    let (env, client, usdc_id) = setup();
    let agent = Address::generate(&env);
    client.register_agent(&agent);
    measure_create(&env, &client, &usdc_id, &agent, "agent-escrow::create_escrow");
}

/// SC-011: agent lookups must not scale with the size of the agent registry.
#[test]
fn budget_agent_escrow_create_escrow_large_state() {
    let (env, client, usdc_id) = setup();
    for _ in 0..99 {
        client.register_agent(&Address::generate(&env));
        budget::unlimited_setup(&env);
    }
    let agent = Address::generate(&env);
    client.register_agent(&agent);
    measure_create(&env, &client, &usdc_id, &agent, "agent-escrow::create_escrow[100 agents]");
}

/// SC-011: `register_agent` rewrites the whole `AgentList`, so its cost grows
/// with the registry size. Track it at 100 agents.
#[test]
fn budget_agent_escrow_register_agent_large_state() {
    let (env, client, _usdc_id) = setup();
    for _ in 0..99 {
        client.register_agent(&Address::generate(&env));
        budget::unlimited_setup(&env);
    }
    let agent = Address::generate(&env);
    budget::assert_budget(&env, "agent-escrow::register_agent[100 agents]", || {
        client.register_agent(&agent)
    });
}
