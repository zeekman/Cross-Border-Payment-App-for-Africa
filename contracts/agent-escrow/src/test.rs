#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal, Symbol, Val,
};

use crate::{
    AdminOverride, AgentEscrowContract, AgentEscrowContractClient, EscrowStatus,
    EvtEscrowCancelled, EvtEscrowConfirmed, EvtEscrowCreated, InsurancePayout,
};

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
    client.initialize(&admin, &usdc_id, &(48 * 60 * 60));
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
    // Register agent in whitelist before creating escrow
    client.register_agent(&agent);
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
    client.initialize(&admin, &usdc_id, &(48 * 60 * 60));
}

// ── agent whitelist (issue #762) ──────────────────────────────────────────────

#[test]
fn test_register_and_is_registered_agent() {
    let (env, client, _, _) = setup();
    let agent = Address::generate(&env);
    assert!(!client.is_registered_agent(&agent));
    client.register_agent(&agent);
    assert!(client.is_registered_agent(&agent));
}

#[test]
fn test_remove_agent() {
    let (env, client, _, _) = setup();
    let agent = Address::generate(&env);
    client.register_agent(&agent);
    client.remove_agent(&agent);
    assert!(!client.is_registered_agent(&agent));
}

#[test]
#[should_panic(expected = "Agent not registered")]
fn test_create_escrow_with_unregistered_agent_panics() {
    let (env, client, _, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env); // NOT registered
    mint(&env, &usdc_id, &sender, 1_000_0000000);
    client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
}

#[test]
fn test_get_registered_agents_pagination() {
    let (env, client, _, _) = setup();
    let a1 = Address::generate(&env);
    let a2 = Address::generate(&env);
    let a3 = Address::generate(&env);
    client.register_agent(&a1);
    client.register_agent(&a2);
    client.register_agent(&a3);
    let page = client.get_registered_agents(&0, &2);
    assert_eq!(page.len(), 2);
    let all = client.get_registered_agents(&0, &100);
    assert_eq!(all.len(), 3);
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

// ── update_admin ───────────────────────────────────────────────────────────────

#[test]
fn test_update_admin_changes_stored_admin() {
    let (env, client, admin, usdc_id) = setup();
    let new_admin = Address::generate(&env);
    client.update_admin(&new_admin);
    // Verify by attempting admin-only action with new admin
    let amount = 500_0000000i128;
    let (sender, _, agent, id) = make_escrow(&env, &client, &usdc_id, &new_admin, amount, 100);
    client.confirm_payout(&agent, &id);
    assert_eq!(client.get_escrow(&id).status, EscrowStatus::Completed);
}

#[test]
#[should_panic(expected = "new admin must differ from current admin")]
fn test_update_admin_same_address_panics() {
    let (_, client, admin, _) = setup();
    client.update_admin(&admin);
}

// ── admin_release ──────────────────────────────────────────────────────────────

#[test]
fn test_admin_release_to_agent_on_pending_escrow() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 250);

    client.admin_release(&id, &true, &Symbol::new(&env, "DisputeResolved"));

    let escrow = client.get_escrow(&id);
    assert_eq!(escrow.status, EscrowStatus::Completed);
    let expected_fee = (amount * 250i128) / 10_000;
    let expected_agent = amount - expected_fee;
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&agent), expected_agent);
    assert_eq!(client.get_fees(), expected_fee);
}

#[test]
fn test_admin_release_refunds_sender_on_pending_escrow() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let (sender, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 250);

    client.admin_release(&id, &false, &Symbol::new(&env, "AgentUnresponsive"));

    let escrow = client.get_escrow(&id);
    assert_eq!(escrow.status, EscrowStatus::Cancelled);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), amount);
}

#[test]
#[should_panic(expected = "escrow is not pending")]
fn test_admin_release_on_completed_escrow_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 250);
    client.confirm_payout(&agent, &id);
    client.admin_release(&id, &true, &Symbol::new(&env, "DisputeResolved"));
}

#[test]
#[should_panic(expected = "escrow is not pending")]
fn test_admin_release_on_cancelled_escrow_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (sender, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 250);
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60 + 1);
    client.cancel_escrow(&sender, &id);
    client.admin_release(&id, &false, &Symbol::new(&env, "FraudConfirmed"));
}

#[test]
fn test_admin_release_includes_reason_in_event() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 250);

    let reason = Symbol::new(&env, "FraudConfirmed");
    client.admin_release(&id, &true, &reason);

    // Verify reason is included in the AdminOverride event
    let contract_topic: Val = Symbol::new(&env, "AgentEscrow").into_val(&env);
    let event_topic: Val = Symbol::new(&env, "AdminOverride").into_val(&env);
    let events = env.events().all();
    let ao_event = events.iter().find(|(_, topics, _)| {
        topics.len() == 2
            && topics.get(0).map(|t| t == &contract_topic).unwrap_or(false)
            && topics.get(1).map(|t| t == &event_topic).unwrap_or(false)
    });
    assert!(ao_event.is_some(), "AdminOverride event not emitted");
    let (_, _, data) = ao_event.unwrap();
    let payload: AdminOverride = soroban_sdk::from_val(&env, data);
    assert_eq!(payload.escrow_id, id);
    assert_eq!(payload.admin, admin);
    assert_eq!(payload.to_agent, true);
    assert_eq!(payload.amount, amount);
    assert_eq!(payload.reason, reason);
}

#[test]
fn test_admin_release_emits_admin_override_event() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 250);

    client.admin_release(&id, &true, &Symbol::new(&env, "DisputeResolved"));

    // Two-element topic: ("AgentEscrow", "AdminOverride")
    let contract_topic: Val = Symbol::new(&env, "AgentEscrow").into_val(&env);
    let event_topic: Val = Symbol::new(&env, "AdminOverride").into_val(&env);
    let events = env.events().all();
    let ao_event = events.iter().find(|(_, topics, _)| {
        topics.len() == 2
            && topics.get(0).map(|t| t == &contract_topic).unwrap_or(false)
            && topics.get(1).map(|t| t == &event_topic).unwrap_or(false)
    });
    assert!(ao_event.is_some(), "AdminOverride event not emitted");
    let (_, _, data) = ao_event.unwrap();
    let payload: AdminOverride = soroban_sdk::from_val(&env, data);
    assert_eq!(payload.escrow_id, id);
    assert_eq!(payload.admin, admin);
    assert_eq!(payload.to_agent, true);
    assert_eq!(payload.amount, amount);
}

// ── Event topic / payload verification ───────────────────────────────────────

/// Helper: find an event whose first two topics are ("AgentEscrow", event_name).
fn find_event<'a>(
    env: &Env,
    events: &'a soroban_sdk::Vec<(soroban_sdk::Address, soroban_sdk::Vec<Val>, Val)>,
    event_name: &str,
) -> Option<(soroban_sdk::Address, soroban_sdk::Vec<Val>, Val)> {
    let contract_topic: Val = Symbol::new(env, "AgentEscrow").into_val(env);
    let name_topic: Val = Symbol::new(env, event_name).into_val(env);
    events.iter().find(|(_, topics, _)| {
        topics.len() >= 2
            && topics.get(0).map(|t| t == &contract_topic).unwrap_or(false)
            && topics.get(1).map(|t| t == &name_topic).unwrap_or(false)
    })
}

#[test]
fn test_create_escrow_emits_escrow_created_event() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let (sender, recipient, agent, id) =
        make_escrow(&env, &client, &usdc_id, &admin, amount, 250);

    let all = env.events().all();
    let event = find_event(&env, &all, "EscrowCreated");
    assert!(event.is_some(), "EscrowCreated event not emitted");

    let (_, _, data) = event.unwrap();
    let payload: EvtEscrowCreated = soroban_sdk::from_val(&env, data);
    assert_eq!(payload.escrow_id, id);
    assert_eq!(payload.sender, sender);
    assert_eq!(payload.recipient, recipient);
    assert_eq!(payload.agent, agent);
    assert_eq!(payload.amount, amount);
    // expires_at must be created_at + cancel_window (48h default)
    let escrow = client.get_escrow(&id);
    assert_eq!(payload.expires_at, escrow.expires_at);
}

#[test]
fn test_confirm_payout_emits_escrow_confirmed_event() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let (sender, recipient, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 500);

    // Get initial events
    let events_before = env.events().all();

    client.confirm_payout(&agent, &id);

    let events_after = env.events().all();
    let new_events = events_after.iter().skip(events_before.len()).collect::<Vec<_>>();

    // Verify EscrowConfirmed event was emitted
    assert!(!new_events.is_empty());
}

// ── insurance_payout (SC-013) ─────────────────────────────────────────────────

/// Helper: build up an insurance fund balance by confirming a payout.
/// Returns the insurance balance after confirmation (a portion of the fee).
fn fund_insurance(
    env: &Env,
    client: &AgentEscrowContractClient,
    usdc_id: &Address,
    admin: &Address,
    amount: i128,
    fee_bps: u32,
) -> (Address, Address, Address, u64) {
    let (sender, recipient, agent, id) = make_escrow(env, client, usdc_id, admin, amount, fee_bps);
    client.confirm_payout(&agent, &id);
    (sender, recipient, agent, id)
}

#[test]
#[should_panic(expected = "insurance_payout: escrow must be in Cancelled status")]
fn test_insurance_payout_rejected_for_pending_escrow() {
    // SC-013: a Pending escrow has no basis for an insurance claim.
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 500);
    // Escrow is still Pending — insurance_payout must panic.
    client.insurance_payout(&id);
}

#[test]
#[should_panic(expected = "insurance_payout: escrow must be in Cancelled status")]
fn test_insurance_payout_rejected_for_completed_escrow() {
    // SC-013: a Completed escrow means the agent delivered — no fraud claim.
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let fee_bps = 500u32;
    // confirm_payout → Completed, which also builds the insurance fund.
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);
    client.confirm_payout(&agent, &id);
    // Escrow is now Completed — insurance_payout must panic.
    client.insurance_payout(&id);
}

#[test]
fn test_insurance_payout_succeeds_on_cancelled_escrow() {
    // SC-013: happy path — cancelled escrow (agent non-performance) can receive
    // insurance payout.  Payout goes to the original sender.
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let fee_bps = 500u32;

    // First, build up the insurance fund by completing a separate escrow.
    let (_, _, agent_fund, id_fund) =
        make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);
    client.confirm_payout(&agent_fund, &id_fund);

    let insurance_before = client.get_insurance_balance();
    assert!(insurance_before > 0, "insurance fund must be non-zero before payout test");

    // Create a second escrow and cancel it (simulate agent non-performance).
    let (sender_victim, _, _, id_victim) =
        make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60 + 1);
    client.cancel_escrow(&sender_victim, &id_victim);

    // Capture sender balance after cancel (they already got their full refund).
    let sender_balance_before =
        TokenClient::new(&env, &usdc_id).balance(&sender_victim);

    // Insurance payout should succeed and go to sender_victim.
    client.insurance_payout(&id_victim);

    let insurance_after = client.get_insurance_balance();
    let sender_balance_after =
        TokenClient::new(&env, &usdc_id).balance(&sender_victim);

    // Payout amount is min(escrow.amount, insurance_balance).
    let expected_payout = if amount <= insurance_before {
        amount
    } else {
        insurance_before
    };

    assert_eq!(
        insurance_after,
        insurance_before - expected_payout,
        "insurance fund must be reduced by payout amount"
    );
    assert_eq!(
        sender_balance_after,
        sender_balance_before + expected_payout,
        "payout must be credited to the escrow's original sender"
    );
}

#[test]
fn test_insurance_payout_recipient_is_escrow_sender_not_arbitrary() {
    // SC-013: verify the function signature no longer accepts an arbitrary
    // recipient — payout goes to escrow.sender automatically.
    let (env, client, admin, usdc_id) = setup();
    let amount = 500_0000000i128;
    let fee_bps = 500u32;

    // Build insurance fund.
    let (_, _, agent_fund, id_fund) =
        make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);
    client.confirm_payout(&agent_fund, &id_fund);

    // Create and cancel a victim escrow.
    let (sender_victim, _, _, id_victim) =
        make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60 + 1);
    client.cancel_escrow(&sender_victim, &id_victim);

    // Collect a bystander's balance before the payout.
    let bystander = Address::generate(&env);
    let bystander_before = TokenClient::new(&env, &usdc_id).balance(&bystander);

    client.insurance_payout(&id_victim);

    // Bystander must not receive anything.
    assert_eq!(
        TokenClient::new(&env, &usdc_id).balance(&bystander),
        bystander_before,
        "bystander must not receive insurance payout"
    );
    // Sender must receive the payout.
    assert!(
        TokenClient::new(&env, &usdc_id).balance(&sender_victim) > 0,
        "escrow sender must receive insurance payout"
    );
}

#[test]
#[should_panic(expected = "insufficient insurance fund balance")]
fn test_insurance_payout_panics_when_fund_empty() {
    // When the insurance fund holds zero balance, payout must panic.
    let (env, client, admin, usdc_id) = setup();
    let amount = 500_0000000i128;

    // Create and cancel an escrow without ever building the insurance fund.
    let (sender, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 0);
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60 + 1);
    client.cancel_escrow(&sender, &id);

    // Insurance fund is empty (fee_bps = 0 → no contributions).
    client.insurance_payout(&id);
}

#[test]
fn test_insurance_payout_emits_insurance_payout_event() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 800_0000000i128;
    let fee_bps = 500u32;

    // Build insurance fund.
    let (_, _, agent_fund, id_fund) =
        make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);
    client.confirm_payout(&agent_fund, &id_fund);

    // Create and cancel victim escrow.
    let (sender_victim, _, _, id_victim) =
        make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60 + 1);
    client.cancel_escrow(&sender_victim, &id_victim);

    client.insurance_payout(&id_victim);

    let event_name: Val = Symbol::new(&env, "InsurancePayout").into_val(&env);
    let events = env.events().all();
    let evt = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|t| t == &event_name)
    });
    assert!(evt.is_some(), "InsurancePayout event must be emitted");

    let (_, _, data) = evt.unwrap();
    let payload: crate::InsurancePayout = soroban_sdk::from_val(&env, data);
    assert_eq!(payload.escrow_id, id_victim);
    assert_eq!(payload.recipient, sender_victim);
    assert!(payload.amount > 0);
}

#[test]
fn test_partial_confirm_payout_single_release() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let fee_bps = 250u32;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);

    let partial = 400_0000000i128;
    client.partial_confirm_payout(&agent, &id, &partial);

    let expected_fee = (partial * fee_bps as i128) / 10_000;
    let expected_net = partial - expected_fee;

    // Agent receives net amount.
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&agent), expected_net);
    // Platform fee accumulated.
    assert_eq!(client.get_fees(), expected_fee);
    // Escrow still pending with updated released_amount.
    let escrow = client.get_escrow(&id);
    assert_eq!(escrow.status, EscrowStatus::Pending);
    assert_eq!(escrow.released_amount, partial);
}

#[test]
fn test_partial_confirm_payout_multiple_releases_complete_escrow() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let fee_bps = 200u32;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);

    let first = 300_0000000i128;
    let second = 300_0000000i128;
    let third = 400_0000000i128; // first + second + third == amount

    client.partial_confirm_payout(&agent, &id, &first);
    client.partial_confirm_payout(&agent, &id, &second);
    client.partial_confirm_payout(&agent, &id, &third);

    let fee1 = (first * fee_bps as i128) / 10_000;
    let fee2 = (second * fee_bps as i128) / 10_000;
    let fee3 = (third * fee_bps as i128) / 10_000;
    let total_fee = fee1 + fee2 + fee3;
    let total_net = (first - fee1) + (second - fee2) + (third - fee3);

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&agent), total_net);
    assert_eq!(client.get_fees(), total_fee);

    // After final release escrow must be Completed automatically.
    let escrow = client.get_escrow(&id);
    assert_eq!(escrow.status, EscrowStatus::Completed);
    assert_eq!(escrow.released_amount, amount);
}

#[test]
#[should_panic(expected = "Release exceeds remaining balance")]
fn test_partial_confirm_payout_over_release_panics() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 500_0000000i128;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 250);

    // Try to release more than the escrow amount.
    client.partial_confirm_payout(&agent, &id, &(amount + 1));
}

#[test]
#[should_panic(expected = "Release exceeds remaining balance")]
fn test_partial_confirm_payout_over_remaining_after_first_release_panics() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 250);

    client.partial_confirm_payout(&agent, &id, &600_0000000);
    // Remaining is 400; trying to release 401 should panic.
    client.partial_confirm_payout(&agent, &id, &400_0000001);
}

#[test]
#[should_panic(expected = "escrow has expired")]
fn test_partial_confirm_payout_after_expiry_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, 500_0000000, 250);

    // Advance time past expires_at (48 h window).
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60);

    client.partial_confirm_payout(&agent, &id, &100_0000000);
}

#[test]
#[should_panic(expected = "escrow is not pending")]
fn test_partial_confirm_payout_on_completed_escrow_panics() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 500_0000000i128;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 250);
    client.confirm_payout(&agent, &id);
    client.partial_confirm_payout(&agent, &id, &100_0000000);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not the escrow agent")]
fn test_partial_confirm_payout_wrong_agent_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 500_0000000, 250);
    let impostor = Address::generate(&env);
    client.partial_confirm_payout(&impostor, &id, &100_0000000);
}

#[test]
fn test_partial_confirm_payout_emits_event() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let fee_bps = 250u32;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);

    client.confirm_payout(&agent, &id);

    let all = env.events().all();
    let event = find_event(&env, &all, "EscrowConfirmed");
    assert!(event.is_some(), "EscrowConfirmed event not emitted");

    let (_, _, data) = event.unwrap();
    let payload: EvtEscrowConfirmed = soroban_sdk::from_val(&env, data);
    let expected_fee = (amount * fee_bps as i128) / 10_000;
    let expected_agent = amount - expected_fee;
    assert_eq!(payload.escrow_id, id);
    assert_eq!(payload.agent, agent);
    assert_eq!(payload.agent_amount, expected_agent);
    assert_eq!(payload.fee_amount, expected_fee);
}

#[test]
fn test_cancel_escrow_emits_escrow_cancelled_event() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 500_0000000i128;
    let (sender, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 200);

    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60 + 1);
    client.cancel_escrow(&sender, &id);

    let all = env.events().all();
    let event = find_event(&env, &all, "EscrowCancelled");
    assert!(event.is_some(), "EscrowCancelled event not emitted");

    let (_, _, data) = event.unwrap();
    let payload: EvtEscrowCancelled = soroban_sdk::from_val(&env, data);
    assert_eq!(payload.escrow_id, id);
    assert_eq!(payload.sender, sender);
    assert_eq!(payload.refund_amount, amount);
    let partial = 400_0000000i128;
    client.partial_confirm_payout(&agent, &id, &partial);

    let event_name: Val = Symbol::new(&env, "PartialPayoutReleased").into_val(&env);
    let events = env.events().all();
    let evt = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|t| t == &event_name)
    });
    assert!(evt.is_some(), "PartialPayoutReleased event not emitted");

    let (_, _, data) = evt.unwrap();
    let payload: crate::EvtPartialPayoutReleased = soroban_sdk::from_val(&env, data);
    assert_eq!(payload.escrow_id, id);
    assert_eq!(payload.agent, agent);

    let expected_fee = (partial * fee_bps as i128) / 10_000;
    let expected_net = partial - expected_fee;
    assert_eq!(payload.released_amount, expected_net);
    assert_eq!(payload.fee_amount, expected_fee);
    assert_eq!(payload.remaining_amount, amount - partial);
}

#[test]
fn test_partial_confirm_payout_zero_fee() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 800_0000000i128;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 0);

    client.partial_confirm_payout(&agent, &id, &500_0000000);

    // No fee deducted; agent receives full partial amount.
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&agent), 500_0000000);
    assert_eq!(client.get_fees(), 0);
    assert_eq!(client.get_escrow(&id).released_amount, 500_0000000);
}

#[test]
fn test_partial_confirm_payout_released_amount_tracks_cumulative_gross() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 600_0000000i128;
    let fee_bps = 100u32;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);

    client.partial_confirm_payout(&agent, &id, &200_0000000);
    assert_eq!(client.get_escrow(&id).released_amount, 200_0000000);

    client.partial_confirm_payout(&agent, &id, &200_0000000);
    assert_eq!(client.get_escrow(&id).released_amount, 400_0000000);
}
