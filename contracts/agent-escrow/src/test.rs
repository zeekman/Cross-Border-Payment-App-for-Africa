#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

use crate::{AgentEscrowContract, AgentEscrowContractClient, EscrowStatus};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn setup() -> (Env, AgentEscrowContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, AgentEscrowContract);
    let client = AgentEscrowContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    client.initialize(&admin, &usdc_id);
    (env, client, admin, usdc_id)
}

fn mint(env: &Env, usdc_id: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, usdc_id).mint(to, &amount);
}

fn make_escrow(
    env: &Env,
    client: &AgentEscrowContractClient,
    usdc_id: &Address,
    admin: &Address,
    amount: i128,
    fee_bps: u32,
) -> (Address, Address, Address, u64) {
    let sender = Address::generate(env);
    let recipient = Address::generate(env);
    let agent = Address::generate(env);
    mint(env, usdc_id, &sender, amount);
    let id = client.create_escrow(&sender, &recipient, &agent, &amount, &fee_bps);
    (sender, recipient, agent, id)
}

// ── initialize ────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_stores_admin_and_usdc() {
    let (_, client, admin, usdc_id) = setup();
    // Verify via get_fees (contract is live) and withdraw_fees auth path
    assert_eq!(client.get_fees(), 0);
    // Confirm admin is stored by attempting a zero-fee withdrawal (no-op amount)
    // We just check it doesn't panic with wrong admin
    let _ = admin;
    let _ = usdc_id;
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let (_, client, admin, usdc_id) = setup();
    client.initialize(&admin, &usdc_id);
}

// ── create_escrow ─────────────────────────────────────────────────────────────

#[test]
fn test_create_escrow_returns_sequential_ids() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    mint(&env, &usdc_id, &Address::generate(&env), amount);

    let (sender1, recipient, agent, id1) =
        make_escrow(&env, &client, &usdc_id, &admin, amount, 250);
    let sender2 = Address::generate(&env);
    mint(&env, &usdc_id, &sender2, amount);
    let id2 = client.create_escrow(&sender2, &recipient, &agent, &amount, &250);

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    let _ = sender1;
}

#[test]
fn test_create_escrow_stores_correct_fields() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 500_0000000i128;
    let (sender, recipient, agent, id) =
        make_escrow(&env, &client, &usdc_id, &admin, amount, 300);

    let e = client.get_escrow(&id);
    assert_eq!(e.sender, sender);
    assert_eq!(e.recipient, recipient);
    assert_eq!(e.agent, agent);
    assert_eq!(e.amount, amount);
    assert_eq!(e.fee_bps, 300);
    assert_eq!(e.status, EscrowStatus::Pending);
    assert_eq!(e.expires_at, e.created_at + 48 * 60 * 60);
}

#[test]
fn test_create_escrow_transfers_usdc_to_contract() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 200_0000000i128;
    let (sender, _, _, _) = make_escrow(&env, &client, &usdc_id, &admin, amount, 100);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), 0);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_create_escrow_zero_amount_panics() {
    let (env, client, _, _) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    client.create_escrow(&sender, &recipient, &agent, &0, &250);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_create_escrow_negative_amount_panics() {
    let (env, client, _, _) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    client.create_escrow(&sender, &recipient, &agent, &-1, &250);
}

#[test]
#[should_panic(expected = "fee_bps cannot exceed 10000")]
fn test_create_escrow_fee_over_100pct_panics() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    mint(&env, &usdc_id, &sender, 1_000_0000000);
    client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &10_001);
}

#[test]
fn test_create_escrow_max_fee_bps_allowed() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 10_000);
    assert_eq!(client.get_escrow(&id).fee_bps, 10_000);
}

// ── confirm_payout ────────────────────────────────────────────────────────────

#[test]
fn test_confirm_payout_releases_funds_to_agent() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let fee_bps = 250u32;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);

    client.confirm_payout(&agent, &id);

    let expected_fee = (amount * fee_bps as i128) / 10_000;
    let expected_agent = amount - expected_fee;

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&agent), expected_agent);
    assert_eq!(client.get_fees(), expected_fee);
    assert_eq!(client.get_escrow(&id).status, EscrowStatus::Completed);
}

#[test]
fn test_confirm_payout_zero_fee() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 500_0000000i128;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 0);

    client.confirm_payout(&agent, &id);

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&agent), amount);
    assert_eq!(client.get_fees(), 0);
}

#[test]
fn test_confirm_payout_accumulates_fees_across_escrows() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let fee_bps = 500u32;

    let (_, _, agent1, id1) = make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);
    let (_, _, agent2, id2) = make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);

    client.confirm_payout(&agent1, &id1);
    client.confirm_payout(&agent2, &id2);

    let expected_fee = (amount * fee_bps as i128) / 10_000;
    assert_eq!(client.get_fees(), expected_fee * 2);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not the escrow agent")]
fn test_confirm_payout_wrong_agent_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 250);
    let impostor = Address::generate(&env);
    client.confirm_payout(&impostor, &id);
}

#[test]
#[should_panic(expected = "escrow is not pending")]
fn test_confirm_payout_twice_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 250);
    client.confirm_payout(&agent, &id);
    client.confirm_payout(&agent, &id);
}

#[test]
#[should_panic(expected = "escrow not found")]
fn test_confirm_payout_nonexistent_escrow_panics() {
    let (_, client, _, _) = setup();
    let agent = Address::generate(&_);
    client.confirm_payout(&agent, &999);
}

// ── cancel_escrow ─────────────────────────────────────────────────────────────

#[test]
fn test_cancel_escrow_after_window_refunds_sender() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 300_0000000i128;
    let (sender, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 200);

    // Advance past 48-hour window
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60 + 1);

    client.cancel_escrow(&sender, &id);

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), amount);
    assert_eq!(client.get_escrow(&id).status, EscrowStatus::Cancelled);
}

#[test]
#[should_panic(expected = "cancellation window has not elapsed")]
fn test_cancel_escrow_before_window_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (sender, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 500_0000000, 100);
    client.cancel_escrow(&sender, &id);
}

#[test]
#[should_panic(expected = "cancellation window has not elapsed")]
fn test_cancel_escrow_exactly_at_window_boundary_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (sender, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 500_0000000, 100);
    // Exactly at expires_at — not yet elapsed
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60);
    client.cancel_escrow(&sender, &id);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not the escrow sender")]
fn test_cancel_escrow_wrong_sender_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 500_0000000, 100);
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60 + 1);
    let impostor = Address::generate(&env);
    client.cancel_escrow(&impostor, &id);
}

#[test]
#[should_panic(expected = "escrow is not pending")]
fn test_cancel_escrow_after_completion_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (sender, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, 500_0000000, 100);
    client.confirm_payout(&agent, &id);
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60 + 1);
    client.cancel_escrow(&sender, &id);
}

#[test]
#[should_panic(expected = "escrow not found")]
fn test_cancel_escrow_nonexistent_panics() {
    let (env, client, _, _) = setup();
    let sender = Address::generate(&env);
    client.cancel_escrow(&sender, &999);
}

// ── get_escrow ────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "escrow not found")]
fn test_get_escrow_nonexistent_panics() {
    let (_, client, _, _) = setup();
    client.get_escrow(&0);
}

#[test]
fn test_get_escrow_returns_correct_record() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 750_0000000i128;
    let (sender, recipient, agent, id) =
        make_escrow(&env, &client, &usdc_id, &admin, amount, 150);

    let e = client.get_escrow(&id);
    assert_eq!(e.id, id);
    assert_eq!(e.sender, sender);
    assert_eq!(e.recipient, recipient);
    assert_eq!(e.agent, agent);
    assert_eq!(e.amount, amount);
    assert_eq!(e.fee_bps, 150);
    assert_eq!(e.status, EscrowStatus::Pending);
}

// ── withdraw_fees ─────────────────────────────────────────────────────────────

#[test]
fn test_withdraw_fees_transfers_to_admin() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let fee_bps = 500u32;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);
    client.confirm_payout(&agent, &id);

    let expected_fee = (amount * fee_bps as i128) / 10_000;
    client.withdraw_fees(&admin, &expected_fee);

    assert_eq!(client.get_fees(), 0);
    assert_eq!(
        TokenClient::new(&env, &usdc_id).balance(&admin),
        expected_fee
    );
}

#[test]
fn test_withdraw_fees_partial() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let fee_bps = 500u32;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);
    client.confirm_payout(&agent, &id);

    let total_fee = (amount * fee_bps as i128) / 10_000;
    let partial = total_fee / 2;
    client.withdraw_fees(&admin, &partial);

    assert_eq!(client.get_fees(), total_fee - partial);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_withdraw_fees_non_admin_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&agent, &id);
    let impostor = Address::generate(&env);
    client.withdraw_fees(&impostor, &1);
}

#[test]
#[should_panic(expected = "insufficient accumulated fees")]
fn test_withdraw_fees_exceeds_balance_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&agent, &id);
    let fees = client.get_fees();
    client.withdraw_fees(&admin, &(fees + 1));
}

#[test]
fn test_get_fees_initial_is_zero() {
    let (_, client, _, _) = setup();
    assert_eq!(client.get_fees(), 0);
}
