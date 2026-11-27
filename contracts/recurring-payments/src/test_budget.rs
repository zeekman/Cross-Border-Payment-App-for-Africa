#![cfg(test)]
//! SC-215: resource-budget regression tests for recurring-payments hot paths.
//! Baselines live in `contracts/budgets.json`; see `contracts/README.md`.
extern crate std;

#[path = "../../test-support/budget.rs"]
mod budget;

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

use crate::{RecurringPaymentsContract, RecurringPaymentsContractClient};

const AMOUNT: i128 = 10_0000000;
const INTERVAL: u64 = 86_400;

struct Ctx {
    env: Env,
    client: RecurringPaymentsContractClient<'static>,
    token_id: Address,
    sender: Address,
    recipient: Address,
    executor: Address,
}

fn setup() -> Ctx {
    let env = Env::default();
    env.mock_all_auths();
    budget::unlimited_setup(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin).address();
    let admin = Address::generate(&env);
    let contract_id = env.register(RecurringPaymentsContract, ());
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id, &0);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let executor = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&sender, &10_000_0000000);
    TokenClient::new(&env, &token_id).approve(
        &sender,
        &contract_id,
        &i128::MAX,
        &(env.ledger().sequence() + 10_000),
    );
    Ctx { env, client, token_id, sender, recipient, executor }
}

fn create(ctx: &Ctx) -> u64 {
    ctx.client.create_recurring_payment(
        &ctx.sender,
        &ctx.recipient,
        &ctx.token_id,
        &AMOUNT,
        &INTERVAL,
        &0,
        &0,
        &0,
    )
}

fn advance_one_interval(env: &Env) {
    env.ledger().with_mut(|li| li.timestamp += INTERVAL);
}

#[test]
fn budget_recurring_payments_execute_payment() {
    let ctx = setup();
    let id = create(&ctx);
    advance_one_interval(&ctx.env);
    budget::assert_budget(&ctx.env, "recurring-payments::execute_payment", || {
        ctx.client.execute_payment(&ctx.executor, &id)
    });
}

/// One sender at the per-sender cap of 500 schedules; executing one schedule
/// must not pay for the other 499.
#[test]
fn budget_recurring_payments_execute_payment_large_state() {
    let ctx = setup();
    let mut target = 0;
    for i in 0..500u32 {
        let id = create(&ctx);
        if i == 250 {
            target = id;
        }
        budget::unlimited_setup(&ctx.env);
    }
    advance_one_interval(&ctx.env);
    budget::assert_budget(&ctx.env, "recurring-payments::execute_payment[500 schedules]", || {
        ctx.client.execute_payment(&ctx.executor, &target)
    });
}
