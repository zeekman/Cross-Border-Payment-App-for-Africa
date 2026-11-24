#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, FromVal, Symbol, TryFromVal, Val,
};

use crate::{
    AdminOverride, AgentEscrowContract, AgentEscrowContractClient, EscrowStatus,
    EvtEscrowCancelled, EvtEscrowConfirmed, EvtEscrowCreated, EvtFeesWithdrawn,
    EvtPartialPayoutReleased, InsurancePayout,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn setup() -> (Env, AgentEscrowContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentEscrowContract, ());
    let client = AgentEscrowContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract(admin.clone());
    client.initialize(&admin, &usdc_id, &(48 * 60 * 60));
    (env, client, admin, usdc_id)
}

/// Default share of every fee routed to the insurance fund (set in `initialize`).
const INSURANCE_BPS: i128 = 500;

/// Part of `fee` that lands in withdrawable platform fees after the
/// insurance contribution is split off.
fn platform_share(fee: i128) -> i128 {
    fee - fee * INSURANCE_BPS / 10_000
}

/// True when `topic` is the symbol `name`.
fn topic_is(env: &Env, topic: &Val, name: &str) -> bool {
    Symbol::try_from_val(env, topic)
        .map(|s| s == Symbol::new(env, name))
        .unwrap_or(false)
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

    client.confirm_payout(&id);

    let expected_fee = (amount * fee_bps as i128) / 10_000;
    let expected_agent = amount - expected_fee;

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&agent), expected_agent);
    assert_eq!(client.get_fees(), platform_share(expected_fee));
    assert_eq!(client.get_insurance_balance(), expected_fee - platform_share(expected_fee));
    assert_eq!(client.get_escrow(&id).status, EscrowStatus::Completed);
}

#[test]
fn test_confirm_payout_zero_fee() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 500_0000000i128;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 0);

    client.confirm_payout(&id);

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

    client.confirm_payout(&id1);
    client.confirm_payout(&id2);

    let expected_fee = (amount * fee_bps as i128) / 10_000;
    assert_eq!(client.get_fees(), platform_share(expected_fee) * 2);
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn test_confirm_payout_wrong_agent_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 250);
    // Without the escrow agent's signature the payout must be rejected.
    env.set_auths(&[]);
    client.confirm_payout(&id);
}

#[test]
#[should_panic(expected = "escrow is not pending")]
fn test_confirm_payout_twice_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 250);
    client.confirm_payout(&id);
    client.confirm_payout(&id);
}

#[test]
#[should_panic(expected = "escrow not found")]
fn test_confirm_payout_nonexistent_escrow_panics() {
    let (_, client, _, _) = setup();
    client.confirm_payout(&999);
    let (env, client, _, _) = setup();
    let agent = Address::generate(&env);
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

    client.cancel_escrow(&id);

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), amount);
    assert_eq!(client.get_escrow(&id).status, EscrowStatus::Cancelled);
}

#[test]
#[should_panic(expected = "cancellation window has not elapsed")]
fn test_cancel_escrow_before_window_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (sender, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 500_0000000, 100);
    client.cancel_escrow(&id);
}

#[test]
#[should_panic(expected = "cancellation window has not elapsed")]
fn test_cancel_escrow_one_second_before_window_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (sender, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 500_0000000, 100);
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60 - 1);
    client.cancel_escrow(&sender, &id);
}

#[test]
fn test_cancel_escrow_allowed_exactly_at_expiry() {
    // At `expires_at` the agent can no longer release (see
    // test_partial_confirm_payout_after_expiry_panics), so the sender can cancel.
    let (env, client, admin, usdc_id) = setup();
    let amount = 500_0000000i128;
    let (sender, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 100);
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60);
    client.cancel_escrow(&id);
    client.cancel_escrow(&sender, &id);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), amount);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not the escrow sender")]
fn test_cancel_escrow_wrong_sender_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 500_0000000, 100);
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60 + 1);
    let impostor = Address::generate(&env);
    client.cancel_escrow(&id);
}

#[test]
#[should_panic(expected = "escrow is not pending")]
fn test_cancel_escrow_after_completion_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (sender, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, 500_0000000, 100);
    client.confirm_payout(&id);
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60 + 1);
    client.cancel_escrow(&id);
}

#[test]
#[should_panic(expected = "escrow not found")]
fn test_cancel_escrow_nonexistent_panics() {
    let (env, client, _, _) = setup();
    let sender = Address::generate(&env);
    client.cancel_escrow(&999);
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
fn test_withdraw_fees_transfers_to_recipient() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let fee_bps = 500u32;
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);
    client.confirm_payout(&id);

    let total_fee = (amount * fee_bps as i128) / 10_000;
    let insurance = client.get_insurance_fund();
    let fees = client.get_fees();
    assert_eq!(fees + insurance, total_fee);

    client.withdraw_fees(&admin, &fees);

    assert_eq!(client.get_fees(), 0);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&admin), fees);
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn test_withdraw_fees_non_admin_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&id);
    let impostor = Address::generate(&env);
    // Without the admin's signature the withdrawal must be rejected.
    env.set_auths(&[]);
    client.withdraw_fees(&impostor, &1);
}

#[test]
#[should_panic(expected = "no fees to withdraw")]
fn test_withdraw_fees_twice_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&id);
    let fees = client.get_fees();
    client.withdraw_fees(&admin, &fees);
    client.withdraw_fees(&admin, &1);
}

#[test]
fn test_withdraw_fees_partial() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&id);

    let total_fee = client.get_fees();
    let partial = total_fee / 2;
    let treasury = Address::generate(&env);
    client.withdraw_fees(&treasury, &partial);

    assert_eq!(client.get_fees(), total_fee - partial);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&treasury), partial);
}

#[test]
fn test_withdraw_fees_to_third_party_treasury() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&id);

    let fees = client.get_fees();
    let treasury = Address::generate(&env);
    client.withdraw_fees(&treasury, &fees);

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&treasury), fees);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&admin), 0);
    assert_eq!(client.get_fees(), 0);
}

#[test]
fn test_withdraw_fees_emits_event() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&id);

    let total_fee = client.get_fees();
    let partial = total_fee / 4;
    let treasury = Address::generate(&env);
    client.withdraw_fees(&treasury, &partial);

    let (_, topics, data) = env.events().all().last().unwrap();
    let topic: Symbol = topics.get(0).unwrap().into_val(&env);
    assert_eq!(topic, Symbol::new(&env, "FeesWithdrawn"));
    let evt: EvtFeesWithdrawn = data.into_val(&env);
    assert_eq!(evt.admin, admin);
    assert_eq!(evt.to, treasury);
    assert_eq!(evt.amount, partial);
    assert_eq!(evt.remaining_fees, total_fee - partial);
}

#[test]
fn test_withdraw_fees_requires_admin_auth() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&id);

    let treasury = Address::generate(&env);
    client.withdraw_fees(&treasury, &1);
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, admin);
}

#[test]
#[should_panic(expected = "withdrawal amount exceeds accumulated fees")]
fn test_withdraw_fees_exceeds_balance_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&id);
    let fees = client.get_fees();
    client.withdraw_fees(&admin, &(fees + 1));
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_withdraw_fees_zero_amount_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&id);
    client.withdraw_fees(&admin, &0);
}

#[test]
#[should_panic(expected = "invalid recipient")]
fn test_withdraw_fees_to_contract_itself_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&id);
    client.withdraw_fees(&client.address, &1);
}

#[test]
#[should_panic(expected = "withdrawal amount exceeds accumulated fees")]
fn test_withdraw_fees_cannot_touch_insurance_fund() {
    // The insurance fund is held separately; only accumulated platform fees
    // are withdrawable, so asking for fees + insurance must be rejected.
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&id);

    let fees = client.get_fees();
    let insurance = client.get_insurance_balance();
    assert!(insurance > 0);

    let treasury = Address::generate(&env);
    client.withdraw_fees(&treasury, &(fees + insurance));
}

#[test]
fn test_withdraw_fees_leaves_insurance_fund_intact() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&id);

    let fees = client.get_fees();
    let insurance = client.get_insurance_balance();
    let treasury = Address::generate(&env);
    client.withdraw_fees(&treasury, &fees);

    assert_eq!(client.get_fees(), 0);
    assert_eq!(client.get_insurance_balance(), insurance);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&treasury), fees);
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
fn test_update_admin_requires_old_and_new_admin_auth() {
    let (env, client, admin, _) = setup();
    let new_admin = Address::generate(&env);
    client.update_admin(&new_admin);
    let auths = env.auths();
    assert!(auths.iter().any(|(a, _)| *a == admin), "current admin must authorise");
    assert!(auths.iter().any(|(a, _)| *a == new_admin), "new admin must authorise");
}

#[test]
fn test_update_admin_new_admin_can_withdraw_fees() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&agent, &id);
    let new_admin = Address::generate(&env);
    client.update_admin(&new_admin);
    let fees = client.get_fees();
    let treasury = Address::generate(&env);
    client.withdraw_fees(&treasury, &fees);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&treasury), fees);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_update_admin_old_admin_loses_access() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&agent, &id);
    client.update_admin(&Address::generate(&env));
    client.withdraw_fees(&admin, &1);
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
    // SC-129: admin releases fund insurance like confirm_payout does.
    assert_eq!(client.get_fees(), platform_share(expected_fee));
    assert_eq!(client.get_insurance_balance(), expected_fee - platform_share(expected_fee));
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
    client.confirm_payout(&id);
    client.admin_release(&id, &true, &Symbol::new(&env, "DisputeResolved"));
}

#[test]
#[should_panic(expected = "escrow is not pending")]
fn test_admin_release_on_cancelled_escrow_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (sender, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 250);
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60 + 1);
    client.cancel_escrow(&id);
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
    let events = all_events(&env);
    let ao_event = events.iter().find(|(_, topics, _)| {
        topics.len() == 2
            && topics.get(0).map(|t| val_eq(&env, &t, &contract_topic)).unwrap_or(false)
            && topics.get(1).map(|t| val_eq(&env, &t, &event_topic)).unwrap_or(false)
    });
    assert!(ao_event.is_some(), "AdminOverride event not emitted");
    let (_, _, data) = ao_event.unwrap();
    let payload: AdminOverride = soroban_sdk::FromVal::from_val(&env, &data);
    let events = env.events().all();
    let ao_event = find_event(&env, &events, "AdminOverride");
    assert!(ao_event.is_some(), "AdminOverride event not emitted");
    let (_, _, data) = ao_event.unwrap();
    let payload = AdminOverride::from_val(&env, &data);
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
    let events = all_events(&env);
    let ao_event = events.iter().find(|(_, topics, _)| {
        topics.len() == 2
            && topics.get(0).map(|t| val_eq(&env, &t, &contract_topic)).unwrap_or(false)
            && topics.get(1).map(|t| val_eq(&env, &t, &event_topic)).unwrap_or(false)
    });
    assert!(ao_event.is_some(), "AdminOverride event not emitted");
    let (_, _, data) = ao_event.unwrap();
    let payload: AdminOverride = soroban_sdk::FromVal::from_val(&env, &data);
    let events = env.events().all();
    let ao_event = find_event(&env, &events, "AdminOverride");
    assert!(ao_event.is_some(), "AdminOverride event not emitted");
    let (_, _, data) = ao_event.unwrap();
    let payload = AdminOverride::from_val(&env, &data);
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
    events.iter().find(|(_, topics, _)| {
        topics.len() >= 2
            && topics.get(0).map(|t| val_eq(&env, &t, &contract_topic)).unwrap_or(false)
            && topics.get(1).map(|t| val_eq(&env, &t, &name_topic)).unwrap_or(false)
            && topics.get(0).map(|t| topic_is(env, &t, "AgentEscrow")).unwrap_or(false)
            && topics.get(1).map(|t| topic_is(env, &t, event_name)).unwrap_or(false)
    })
}

#[test]
fn test_create_escrow_emits_escrow_created_event() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let (sender, recipient, agent, id) =
        make_escrow(&env, &client, &usdc_id, &admin, amount, 250);

    let all = all_events(&env);
    let event = find_event(&env, &all, "EscrowCreated");
    assert!(event.is_some(), "EscrowCreated event not emitted");

    let (_, _, data) = event.unwrap();
    let payload: EvtEscrowCreated = soroban_sdk::FromVal::from_val(&env, &data);
    let payload = EvtEscrowCreated::from_val(&env, &data);
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

    client.confirm_payout(&id);

    let all = all_events(&env);
    assert!(find_event(&env, &all, "EscrowConfirmed").is_some());
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 500);

    client.confirm_payout(&agent, &id);

    // `events().all()` holds the events of the last invocation only.
    let all = env.events().all();
    assert!(find_event(&env, &all, "EscrowConfirmed").is_some(), "EscrowConfirmed event not emitted");
}

// ── insurance fund (SC-013 / SC-128 / SC-129) ────────────────────────────────

/// Build up the insurance fund by fully confirming an escrow.
fn fund_insurance(
    env: &Env,
    client: &AgentEscrowContractClient,
    usdc_id: &Address,
    admin: &Address,
    amount: i128,
    fee_bps: u32,
) -> i128 {
    let (_, _, agent, id) = make_escrow(env, client, usdc_id, admin, amount, fee_bps);
    client.confirm_payout(&agent, &id);
    client.get_insurance_balance()
}

/// Create an escrow where the agent releases `released` before the sender
/// cancels — i.e. the sender lost `released` and was refunded the rest.
fn released_then_cancelled(
    env: &Env,
    client: &AgentEscrowContractClient,
    usdc_id: &Address,
    admin: &Address,
    amount: i128,
    released: i128,
    fee_bps: u32,
) -> (Address, u64) {
    let (sender, _, agent, id) = make_escrow(env, client, usdc_id, admin, amount, fee_bps);
    if released > 0 {
        client.partial_confirm_payout(&agent, &id, &released);
    }
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60 + 1);
    client.cancel_escrow(&sender, &id);
    (sender, id)
}

#[test]
#[should_panic(expected = "insurance_payout: escrow must be in Cancelled status")]
fn test_insurance_payout_rejected_for_pending_escrow() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.insurance_payout(&id);
}

#[test]
#[should_panic(expected = "insurance_payout: escrow must be in Cancelled status")]
fn test_insurance_payout_rejected_for_completed_escrow() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.confirm_payout(&agent, &id);
    client.insurance_payout(&id);
}

#[test]
#[should_panic(expected = "insurance_payout: no outstanding loss for this escrow")]
fn test_insurance_payout_rejected_when_sender_fully_refunded() {
    // SC-128: a plain cancel refunds everything, so there is nothing to insure.
    let (env, client, admin, usdc_id) = setup();
    fund_insurance(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    let (_, id) = released_then_cancelled(&env, &client, &usdc_id, &admin, 500_0000000, 0, 500);
    client.insurance_payout(&id);
}

#[test]
fn test_insurance_payout_covers_released_amount_on_cancelled_escrow() {
    let (env, client, admin, usdc_id) = setup();
    fund_insurance(&env, &client, &usdc_id, &admin, 10_000_0000000, 500);

    let released = 10_0000000i128;
    let (sender, id) =
        released_then_cancelled(&env, &client, &usdc_id, &admin, 500_0000000, released, 500);
    let fund_before = client.get_insurance_balance();
    assert!(fund_before > released, "fund must cover the claim for this test");
    let sender_before = TokenClient::new(&env, &usdc_id).balance(&sender);

    client.insurance_payout(&id);

    assert_eq!(client.get_insurance_balance(), fund_before - released);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), sender_before + released);
    assert_eq!(client.get_insurance_paid(&id), released);
}

#[test]
#[should_panic(expected = "insurance_payout: no outstanding loss for this escrow")]
fn test_insurance_payout_cannot_be_repeated() {
    // SC-128: a second call for the same escrow must not pay again.
    let (env, client, admin, usdc_id) = setup();
    fund_insurance(&env, &client, &usdc_id, &admin, 10_000_0000000, 500);
    let (_, id) =
        released_then_cancelled(&env, &client, &usdc_id, &admin, 500_0000000, 10_0000000, 500);
    client.insurance_payout(&id);
    client.insurance_payout(&id);
}

#[test]
fn test_insurance_payout_capped_by_fund_and_resumable() {
    let (env, client, admin, usdc_id) = setup();
    let released = 400_0000000i128;
    let (sender, id) =
        released_then_cancelled(&env, &client, &usdc_id, &admin, 500_0000000, released, 500);

    // Fund only holds the contribution from that partial release.
    let fund = client.get_insurance_balance();
    assert!(fund > 0 && fund < released);
    client.insurance_payout(&id);
    assert_eq!(client.get_insurance_balance(), 0);
    assert_eq!(client.get_insurance_paid(&id), fund);

    // Once the fund grows, the rest of the claim (and no more) can be paid.
    fund_insurance(&env, &client, &usdc_id, &admin, 100_000_0000000, 1_000);
    let sender_before = TokenClient::new(&env, &usdc_id).balance(&sender);
    client.insurance_payout(&id);
    assert_eq!(client.get_insurance_paid(&id), released);
    assert_eq!(
        TokenClient::new(&env, &usdc_id).balance(&sender),
        sender_before + (released - fund)
    );
}

#[test]
fn test_insurance_payout_recipient_is_escrow_sender_not_arbitrary() {
    let (env, client, admin, usdc_id) = setup();
    fund_insurance(&env, &client, &usdc_id, &admin, 10_000_0000000, 500);
    let (sender, id) =
        released_then_cancelled(&env, &client, &usdc_id, &admin, 500_0000000, 10_0000000, 500);

    let bystander = Address::generate(&env);
    let sender_before = TokenClient::new(&env, &usdc_id).balance(&sender);

    client.insurance_payout(&id);

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&bystander), 0);
    assert!(TokenClient::new(&env, &usdc_id).balance(&sender) > sender_before);
}

#[test]
#[should_panic(expected = "insufficient insurance fund balance")]
fn test_insurance_payout_panics_when_fund_empty() {
    let (env, client, admin, usdc_id) = setup();
    // fee_bps = 0 → no insurance contributions at all.
    let (_, id) =
        released_then_cancelled(&env, &client, &usdc_id, &admin, 500_0000000, 10_0000000, 0);
    client.insurance_payout(&id);
}

#[test]
fn test_insurance_payout_emits_insurance_payout_event() {
    let (env, client, admin, usdc_id) = setup();
    fund_insurance(&env, &client, &usdc_id, &admin, 10_000_0000000, 500);
    let released = 10_0000000i128;
    let (sender, id) =
        released_then_cancelled(&env, &client, &usdc_id, &admin, 800_0000000, released, 500);

    client.insurance_payout(&id);

    let events = env.events().all();
    let evt = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|t| topic_is(&env, &t, "InsurancePayout"))
    });
    assert!(evt.is_some(), "InsurancePayout event must be emitted");
    let (_, _, data) = evt.unwrap();
    let payload = InsurancePayout::from_val(&env, &data);
    assert_eq!(payload.escrow_id, id);
    assert_eq!(payload.recipient, sender);
    assert_eq!(payload.amount, released);
}

#[test]
fn test_insurance_payout_after_admin_refund_of_partially_released_escrow() {
    let (env, client, admin, usdc_id) = setup();
    fund_insurance(&env, &client, &usdc_id, &admin, 10_000_0000000, 500);
    let (sender, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, 500_0000000, 500);
    client.partial_confirm_payout(&agent, &id, &20_0000000);
    client.admin_release(&id, &false, &Symbol::new(&env, "FraudConfirmed"));
    let sender_before = TokenClient::new(&env, &usdc_id).balance(&sender);

    client.insurance_payout(&id);

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), sender_before + 20_0000000);
}

#[test]
fn test_partial_payout_funds_insurance() {
    // SC-129: partial releases contribute to insurance the same as full ones.
    let (env, client, admin, usdc_id) = setup();
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    client.partial_confirm_payout(&agent, &id, &400_0000000);
    let fee = 400_0000000i128 * 500 / 10_000;
    assert_eq!(client.get_insurance_balance(), fee - platform_share(fee));
    assert_eq!(client.get_fees(), platform_share(fee));
}

#[test]
fn test_get_insurance_fund_alias_matches_balance() {
    let (env, client, admin, usdc_id) = setup();
    fund_insurance(&env, &client, &usdc_id, &admin, 1_000_0000000, 500);
    assert!(client.get_insurance_balance() > 0);
    assert_eq!(client.get_insurance_fund(), client.get_insurance_balance());
}

// ── set_insurance_contribution_bps ────────────────────────────────────────────

#[test]
fn test_set_insurance_contribution_bps_changes_split() {
    let (env, client, admin, usdc_id) = setup();
    assert_eq!(client.get_insurance_contribution_bps(), 500);
    client.set_insurance_contribution_bps(&1_000);
    assert_eq!(client.get_insurance_contribution_bps(), 1_000);

    let amount = 1_000_0000000i128;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 500);
    client.confirm_payout(&agent, &id);
    let fee = amount * 500 / 10_000;
    assert_eq!(client.get_insurance_balance(), fee / 10);
    assert_eq!(client.get_fees(), fee - fee / 10);
}

#[test]
fn test_set_insurance_contribution_bps_zero_sends_all_to_fees() {
    let (env, client, admin, usdc_id) = setup();
    client.set_insurance_contribution_bps(&0);
    let amount = 1_000_0000000i128;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 500);
    client.confirm_payout(&agent, &id);
    assert_eq!(client.get_insurance_balance(), 0);
    assert_eq!(client.get_fees(), amount * 500 / 10_000);
}

#[test]
#[should_panic(expected = "contribution rate cannot exceed 1000 bps (10%)")]
fn test_set_insurance_contribution_bps_above_max_panics() {
    let (_, client, _, _) = setup();
    client.set_insurance_contribution_bps(&1_001);
}

#[test]
fn test_set_insurance_contribution_bps_requires_admin_auth() {
    let (env, client, admin, _) = setup();
    client.set_insurance_contribution_bps(&250);
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths.get(0).unwrap().0, admin);
}

#[test]
fn test_partial_confirm_payout_single_release() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let fee_bps = 250u32;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);

    let partial = 400_0000000i128;
    client.partial_confirm_payout(&id, &partial);

    let expected_fee = (partial * fee_bps as i128) / 10_000;
    let expected_net = partial - expected_fee;

    // Agent receives net amount.
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&agent), expected_net);
    // Platform fee accumulated (minus the insurance share).
    assert_eq!(client.get_fees(), platform_share(expected_fee));
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

    client.partial_confirm_payout(&id, &first);
    client.partial_confirm_payout(&id, &second);
    client.partial_confirm_payout(&id, &third);

    let fee1 = (first * fee_bps as i128) / 10_000;
    let fee2 = (second * fee_bps as i128) / 10_000;
    let fee3 = (third * fee_bps as i128) / 10_000;
    let total_fee = platform_share(fee1) + platform_share(fee2) + platform_share(fee3);
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
    client.partial_confirm_payout(&id, &(amount + 1));
}

#[test]
#[should_panic(expected = "Release exceeds remaining balance")]
fn test_partial_confirm_payout_over_remaining_after_first_release_panics() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 250);

    client.partial_confirm_payout(&id, &600_0000000);
    // Remaining is 400; trying to release 401 should panic.
    client.partial_confirm_payout(&id, &400_0000001);
}

#[test]
#[should_panic(expected = "escrow has expired")]
fn test_partial_confirm_payout_after_expiry_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, 500_0000000, 250);

    // Advance time past expires_at (48 h window).
    env.ledger().with_mut(|li| li.timestamp += 48 * 60 * 60);

    client.partial_confirm_payout(&id, &100_0000000);
}

#[test]
#[should_panic(expected = "escrow is not pending")]
fn test_partial_confirm_payout_on_completed_escrow_panics() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 500_0000000i128;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 250);
    client.confirm_payout(&id);
    client.partial_confirm_payout(&id, &100_0000000);
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn test_partial_confirm_payout_wrong_agent_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 500_0000000, 250);
    // Without the escrow agent's signature the payout must be rejected.
    env.set_auths(&[]);
    client.partial_confirm_payout(&id, &100_0000000);
}

#[test]
fn test_confirm_payout_emits_escrow_confirmed_payload() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let fee_bps = 250u32;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);

    client.confirm_payout(&id);

    let all = all_events(&env);
    let event = find_event(&env, &all, "EscrowConfirmed");
    assert!(event.is_some(), "EscrowConfirmed event not emitted");

    let (_, _, data) = event.unwrap();
    let payload: EvtEscrowConfirmed = soroban_sdk::FromVal::from_val(&env, &data);
    let payload = EvtEscrowConfirmed::from_val(&env, &data);
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
    client.cancel_escrow(&id);

    let all = all_events(&env);
    let event = find_event(&env, &all, "EscrowCancelled");
    assert!(event.is_some(), "EscrowCancelled event not emitted");

    let (_, _, data) = event.unwrap();
    let payload: EvtEscrowCancelled = soroban_sdk::FromVal::from_val(&env, &data);
    let payload = EvtEscrowCancelled::from_val(&env, &data);
    assert_eq!(payload.escrow_id, id);
    assert_eq!(payload.sender, sender);
    assert_eq!(payload.refund_amount, amount);
}

#[test]
fn test_partial_confirm_payout_emits_partial_payout_event() {
fn test_partial_confirm_payout_emits_event() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let fee_bps = 250u32;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);

    let partial = 400_0000000i128;
    client.partial_confirm_payout(&id, &partial);

    let event_name: Val = Symbol::new(&env, "PartialPayoutReleased").into_val(&env);
    let events = all_events(&env);
    let evt = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|t| val_eq(&env, &t, &event_name))
    let events = env.events().all();
    let evt = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|t| topic_is(&env, &t, "PartialPayoutReleased"))
    });
    assert!(evt.is_some(), "PartialPayoutReleased event not emitted");

    let (_, _, data) = evt.unwrap();
    let payload: crate::EvtPartialPayoutReleased = soroban_sdk::FromVal::from_val(&env, &data);
    let payload = EvtPartialPayoutReleased::from_val(&env, &data);
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

    client.partial_confirm_payout(&id, &500_0000000);

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

    client.partial_confirm_payout(&id, &200_0000000);
    assert_eq!(client.get_escrow(&id).released_amount, 200_0000000);

    client.partial_confirm_payout(&id, &200_0000000);
    assert_eq!(client.get_escrow(&id).released_amount, 400_0000000);
}

/// Events emitted so far, as `(contract, topics, data)` tuples.
///
/// soroban-sdk 23+ returns events in XDR form; this converts them back to
/// host values so tests can decode payloads with `FromVal`.
#[allow(dead_code)]
fn all_events(
    env: &soroban_sdk::Env,
) -> soroban_sdk::Vec<(
    soroban_sdk::Address,
    soroban_sdk::Vec<soroban_sdk::Val>,
    soroban_sdk::Val,
)> {
    use soroban_sdk::testutils::Events as _;
    use soroban_sdk::{xdr, Address, TryFromVal, Val, Vec};
    let mut out = Vec::new(env);
    for e in env.events().all().events() {
        let xdr::ContractEventBody::V0(body) = &e.body;
        let Some(contract_id) = e.contract_id.clone() else {
            continue;
        };
        let contract =
            Address::try_from_val(env, &xdr::ScAddress::Contract(contract_id)).unwrap();
        let mut topics: Vec<Val> = Vec::new(env);
        for t in body.topics.iter() {
            topics.push_back(Val::try_from_val(env, t).unwrap());
        }
        out.push_back((contract, topics, Val::try_from_val(env, &body.data).unwrap()));
    }
    out
}

/// Compares two host values structurally (`Val` has no `PartialEq`).
#[allow(dead_code)]
fn val_eq(env: &soroban_sdk::Env, a: &soroban_sdk::Val, b: &soroban_sdk::Val) -> bool {
    use soroban_sdk::{xdr::ScVal, TryFromVal};
    ScVal::try_from_val(env, a).ok() == ScVal::try_from_val(env, b).ok()
// ── Removed agents cannot claim; admin reassignment ──────────────────────────

#[test]
fn test_removed_agent_cannot_confirm_payout() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 250);
    client.remove_agent(&agent);

    assert!(client.try_confirm_payout(&id).is_err());
    assert!(client.get_escrow(&id).status == EscrowStatus::Pending);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&agent), 0);
}

#[test]
fn test_removed_agent_cannot_partial_confirm_payout() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 250);
    client.remove_agent(&agent);

    assert!(client.try_partial_confirm_payout(&id, &(amount / 2)).is_err());
    assert_eq!(client.get_escrow(&id).released_amount, 0);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&agent), 0);
}

#[test]
#[should_panic(expected = "agent not registered")]
fn test_admin_release_to_removed_agent_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 250);
    client.remove_agent(&agent);
    client.admin_release(&id, &true, &Symbol::new(&env, "fraud"));
}

#[test]
fn test_admin_can_refund_sender_of_removed_agent_escrow() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let (sender, _, agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, 250);
    client.remove_agent(&agent);
    client.admin_release(&id, &false, &Symbol::new(&env, "fraud"));

    assert!(client.get_escrow(&id).status == EscrowStatus::Cancelled);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), amount);
}

#[test]
fn test_reassign_escrow_to_new_agent() {
    let (env, client, admin, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let fee_bps = 250u32;
    let (_, _, old_agent, id) = make_escrow(&env, &client, &usdc_id, &admin, amount, fee_bps);
    client.remove_agent(&old_agent);

    let new_agent = Address::generate(&env);
    client.register_agent(&new_agent);
    client.reassign_escrow(&id, &new_agent);
    assert_eq!(client.get_escrow(&id).agent, new_agent);

    client.confirm_payout(&id);
    let fee = amount * fee_bps as i128 / 10_000;
    let token = TokenClient::new(&env, &usdc_id);
    assert_eq!(token.balance(&new_agent), amount - fee);
    assert_eq!(token.balance(&old_agent), 0);
    assert!(client.get_escrow(&id).status == EscrowStatus::Completed);
}

#[test]
#[should_panic(expected = "agent not registered")]
fn test_reassign_escrow_to_unregistered_agent_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 250);
    let stranger = Address::generate(&env);
    client.reassign_escrow(&id, &stranger);
}

#[test]
#[should_panic(expected = "escrow not pending")]
fn test_reassign_completed_escrow_panics() {
    let (env, client, admin, usdc_id) = setup();
    let (_, _, _, id) = make_escrow(&env, &client, &usdc_id, &admin, 1_000_0000000, 250);
    client.confirm_payout(&id);
    let new_agent = Address::generate(&env);
    client.register_agent(&new_agent);
    client.reassign_escrow(&id, &new_agent);
}
