#![cfg(test)]
//! SC-215: resource-budget regression tests for dispute-resolution hot paths.
//! Baselines live in `contracts/budgets.json`; see `contracts/README.md`.
//!
//! `cast_vote` loops over the arbitrator panel, so it is measured on a small
//! panel and on the largest panel the contract accepts. SC-215 asked for a
//! 9-member panel, but `add_arbitrator` caps the panel at `MAX_ARBITRATORS`
//! (7); the full panel is the worst case that can occur on-chain today.
extern crate std;

#[path = "../../test-support/budget.rs"]
mod budget;

use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, vec, Address, Env, Vec};

use crate::{DisputeResolutionContract, DisputeResolutionContractClient};

const DEFAULT_FILING_FEE: i128 = 50_000000;
const AMOUNT: i128 = 1_000_0000000;
/// Mirrors `MAX_ARBITRATORS` in lib.rs.
const FULL_PANEL: u32 = 7;

/// Panel of `size` arbitrators and one open dispute.
fn setup_panel(size: u32) -> (Env, DisputeResolutionContractClient<'static>, Vec<Address>, u64) {
    let env = Env::default();
    env.mock_all_auths();
    budget::unlimited_setup(&env);
    let contract_id = env.register(DisputeResolutionContract, ());
    let client = DisputeResolutionContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let super_arbitrator = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract(admin.clone());
    client.initialize(&admin, &arbitrator, &usdc_id, &256u32, &super_arbitrator);

    let mut panel = vec![&env];
    for _ in 0..size {
        let arb = Address::generate(&env);
        client.add_arbitrator(&admin, &arb);
        panel.push_back(arb);
    }

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    StellarAssetClient::new(&env, &usdc_id).mint(&sender, &(AMOUNT + DEFAULT_FILING_FEE));
    let id = client.open_dispute(&sender, &sender, &recipient, &AMOUNT);
    (env, client, panel, id)
}

/// Votes needed for quorum at the default 6001 bps: votes * 10_000 > size * 6001.
fn quorum_votes(size: u32) -> u32 {
    (size * 6_001) / 10_000 + 1
}

/// Cast votes up to (not including) the quorum vote, then measure the vote
/// that reaches quorum and pays out — the most expensive `cast_vote` path.
fn measure_quorum_vote(size: u32, name: &str) {
    let (env, client, panel, id) = setup_panel(size);
    let needed = quorum_votes(size);
    for i in 0..needed - 1 {
        client.cast_vote(&panel.get(i).unwrap(), &id, &true);
        budget::unlimited_setup(&env);
    }
    let last = panel.get(needed - 1).unwrap();
    budget::assert_budget(&env, name, || client.cast_vote(&last, &id, &true));
}

#[test]
fn budget_dispute_resolution_cast_vote_first_vote() {
    let (env, client, panel, id) = setup_panel(FULL_PANEL);
    let first = panel.get(0).unwrap();
    budget::assert_budget(&env, "dispute-resolution::cast_vote[first vote, 7 arbitrators]", || {
        client.cast_vote(&first, &id, &true)
    });
}

#[test]
fn budget_dispute_resolution_cast_vote_quorum() {
    measure_quorum_vote(3, "dispute-resolution::cast_vote[quorum, 3 arbitrators]");
}

#[test]
fn budget_dispute_resolution_cast_vote_quorum_large_state() {
    measure_quorum_vote(FULL_PANEL, "dispute-resolution::cast_vote[quorum, 7 arbitrators]");
}
