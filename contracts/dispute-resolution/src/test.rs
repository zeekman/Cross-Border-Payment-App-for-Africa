#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Bytes, Env,
};

use crate::{DisputeResolutionContract, DisputeResolutionContractClient, DisputeStatus};

const DEFAULT_FILING_FEE: i128 = 50_000000;

// ── Helpers ───────────────────────────────────────────────────────────────────

fn setup() -> (
    Env,
    DisputeResolutionContractClient<'static>,
    Address, // admin
    Address, // arbitrator
    Address, // usdc_id
    Address, // super_arbitrator
) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, DisputeResolutionContract);
    let client = DisputeResolutionContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let super_arbitrator = Address::generate(&env);
    let usdc_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    client.initialize(&admin, &arbitrator, &usdc_id, &256u32, &super_arbitrator);
    (env, client, admin, arbitrator, usdc_id, super_arbitrator)
}

fn mint(env: &Env, usdc_id: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, usdc_id).mint(to, &amount);
}

/// Open a dispute and return (sender, recipient, dispute_id).
fn open(
    env: &Env,
    client: &DisputeResolutionContractClient,
    usdc_id: &Address,
    amount: i128,
) -> (Address, Address, u64) {
    let sender = Address::generate(env);
    let recipient = Address::generate(env);
    mint(env, usdc_id, &sender, amount + DEFAULT_FILING_FEE);
    let id = client.open_dispute(&sender, &sender, &recipient, &amount);
    (sender, recipient, id)
}

// ── initialize ────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_succeeds() {
    let (_, client, _, _, _, _) = setup();
    let _ = client;
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let (env, client, admin, arbitrator, usdc_id, super_arbitrator) = setup();
    client.initialize(&admin, &arbitrator, &usdc_id, &256u32, &super_arbitrator);
}

// ── open_dispute ──────────────────────────────────────────────────────────────

#[test]
fn test_open_dispute_returns_sequential_ids() {
    let (env, client, _, _, usdc_id, _) = setup();
    let amount = 500_0000000i128;
    let (_, _, id1) = open(&env, &client, &usdc_id, amount);
    let (_, _, id2) = open(&env, &client, &usdc_id, amount);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
}

#[test]
fn test_open_dispute_stores_correct_fields() {
    let (env, client, _, _, usdc_id, _) = setup();
    let amount = 1_000_0000000i128;
    let (sender, recipient, id) = open(&env, &client, &usdc_id, amount);
    let d = client.get_dispute(&id);
    assert_eq!(d.sender, sender);
    assert_eq!(d.recipient, recipient);
    assert_eq!(d.amount, amount);
    assert_eq!(d.status, DisputeStatus::Open);
    assert_eq!(d.deadline, d.opened_at + 7 * 24 * 60 * 60);
}

#[test]
fn test_open_dispute_locks_usdc_in_contract() {
    let (env, client, _, _, usdc_id, _) = setup();
    let amount = 300_0000000i128;
    let (sender, _, _) = open(&env, &client, &usdc_id, amount);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), 0);
}

#[test]
fn test_open_dispute_by_recipient() {
    let (env, client, _, _, usdc_id, _) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let amount = 200_0000000i128;
    mint(&env, &usdc_id, &recipient, amount + DEFAULT_FILING_FEE);
    let id = client.open_dispute(&recipient, &sender, &recipient, &amount);
    let d = client.get_dispute(&id);
    assert_eq!(d.status, DisputeStatus::Open);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_open_dispute_zero_amount_panics() {
    let (env, client, _, _, _, _) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.open_dispute(&sender, &sender, &recipient, &0);
}

#[test]
fn test_open_dispute_returns_filing_fee_to_opener_on_win() {
    let (env, client, _, arbitrator, usdc_id, _) = setup();
    let amount = 1_000_0000000i128;
    let (sender, _, id) = open(&env, &client, &usdc_id, amount);

    client.resolve_dispute(&arbitrator, &id, &false);
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    client.finalize_resolution(&id);

    assert_eq!(
        TokenClient::new(&env, &usdc_id).balance(&sender),
        amount + DEFAULT_FILING_FEE
    );
}

#[test]
fn test_open_dispute_sends_filing_fee_to_fee_distributor_on_loss() {
    let (env, client, admin, arbitrator, usdc_id, _) = setup();
    let amount = 1_000_0000000i128;
    let (sender, recipient, id) = open(&env, &client, &usdc_id, amount);

    client.resolve_dispute(&arbitrator, &id, &true);
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    client.finalize_resolution(&id);

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), amount);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&admin), DEFAULT_FILING_FEE);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), 0);
}

#[test]
#[should_panic(expected = "Insufficient balance for dispute filing fee")]
fn test_open_dispute_insufficient_filing_fee_panics() {
    let (env, client, _, _, usdc_id, _) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &usdc_id, &sender, 10_000000);
    client.open_dispute(&sender, &sender, &recipient, &10_000000);
}

#[test]
fn test_update_filing_fee_applies_new_fee() {
    let (env, client, admin, _, usdc_id, _) = setup();
    let amount = 1_000_0000000i128;
    client.update_filing_fee(&admin, &100_000000);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &usdc_id, &sender, amount + 100_000000);
    client.open_dispute(&sender, &sender, &recipient, &amount);

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), 0);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_update_filing_fee_non_admin_panics() {
    let (env, client, _, _, _, _) = setup();
    let impostor = Address::generate(&env);
    client.update_filing_fee(&impostor, &100_000000);
}

#[test]
#[should_panic(expected = "filing fee exceeds maximum of 50 USDC")]
fn test_update_filing_fee_above_cap_panics() {
    let (_, client, admin, _, _, _) = setup();
    client.update_filing_fee(&admin, &500_000_001);
}

#[test]
#[should_panic(expected = "opener must be sender or recipient")]
fn test_open_dispute_third_party_panics() {
    let (env, client, _, _, usdc_id, _) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let third_party = Address::generate(&env);
    mint(&env, &usdc_id, &third_party, 100_0000000);
    client.open_dispute(&third_party, &sender, &recipient, &100_0000000);
}

// ── submit_evidence ───────────────────────────────────────────────────────────

#[test]
fn test_submit_evidence_by_sender() {
    let (env, client, _, _, usdc_id, _) = setup();
    let (sender, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    let evidence = Bytes::from_slice(&env, b"QmSomeCIDHash1234567890");
    client.submit_evidence(&sender, &id, &evidence);
    let d = client.get_dispute(&id);
    assert_eq!(d.sender_evidence, evidence);
}

#[test]
fn test_submit_evidence_by_recipient() {
    let (env, client, _, _, usdc_id, _) = setup();
    let (_, recipient, id) = open(&env, &client, &usdc_id, 500_0000000);
    let evidence = Bytes::from_slice(&env, b"QmRecipientCIDHash");
    client.submit_evidence(&recipient, &id, &evidence);
    let d = client.get_dispute(&id);
    assert_eq!(d.recipient_evidence, evidence);
}

#[test]
fn test_submit_evidence_overwrites_previous() {
    let (env, client, _, _, usdc_id, _) = setup();
    let (sender, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    let ev1 = Bytes::from_slice(&env, b"first");
    let ev2 = Bytes::from_slice(&env, b"second");
    client.submit_evidence(&sender, &id, &ev1);
    client.submit_evidence(&sender, &id, &ev2);
    assert_eq!(client.get_dispute(&id).sender_evidence, ev2);
}

#[test]
#[should_panic(expected = "submitter is not a party to this dispute")]
fn test_submit_evidence_third_party_panics() {
    let (env, client, _, _, usdc_id, _) = setup();
    let (_, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    let outsider = Address::generate(&env);
    client.submit_evidence(&outsider, &id, &Bytes::from_slice(&env, b"hack"));
}

#[test]
#[should_panic(expected = "evidence exceeds maximum allowed size")]
fn test_submit_evidence_too_large_panics() {
    let (env, client, _, _, usdc_id, _) = setup();
    let (sender, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    let big = Bytes::from_slice(&env, &[0u8; 257]);
    client.submit_evidence(&sender, &id, &big);
}

#[test]
#[should_panic(expected = "dispute deadline has passed")]
fn test_submit_evidence_after_deadline_panics() {
    let (env, client, _, _, usdc_id, _) = setup();
    let (sender, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    env.ledger().with_mut(|li| li.timestamp += 7 * 24 * 60 * 60 + 1);
    client.submit_evidence(&sender, &id, &Bytes::from_slice(&env, b"late"));
}

// ── resolve_dispute ───────────────────────────────────────────────────────────

#[test]
fn test_resolve_for_recipient_releases_funds() {
    let (env, client, _, arbitrator, usdc_id, _) = setup();
    let amount = 1_000_0000000i128;
    let (_, recipient, id) = open(&env, &client, &usdc_id, amount);

    client.resolve_dispute(&arbitrator, &id, &true);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::Appealing);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), 0);

    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    client.finalize_resolution(&id);

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), amount);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::ResolvedForRecipient);
}

#[test]
fn test_resolve_for_sender_refunds_sender() {
    let (env, client, _, arbitrator, usdc_id, _) = setup();
    let amount = 800_0000000i128;
    let (sender, _, id) = open(&env, &client, &usdc_id, amount);

    client.resolve_dispute(&arbitrator, &id, &false);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::Appealing);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), 0);

    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    client.finalize_resolution(&id);

    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), amount);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::ResolvedForSender);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not the arbitrator")]
fn test_resolve_non_arbitrator_panics() {
    let (env, client, _, _, usdc_id, _) = setup();
    let (_, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    let impostor = Address::generate(&env);
    client.resolve_dispute(&impostor, &id, &true);
}

#[test]
#[should_panic(expected = "dispute is not open")]
fn test_resolve_already_resolved_panics() {
    let (env, client, _, arbitrator, usdc_id, _) = setup();
    let (_, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    client.resolve_dispute(&arbitrator, &id, &true);
    client.resolve_dispute(&arbitrator, &id, &false);
}

#[test]
#[should_panic(expected = "dispute not found")]
fn test_resolve_nonexistent_dispute_panics() {
    let (_, client, _, arbitrator, _, _) = setup();
    client.resolve_dispute(&arbitrator, &999, &true);
}

// ── claim_expired ─────────────────────────────────────────────────────────────

#[test]
fn test_claim_expired_after_deadline_refunds_sender() {
    let (env, client, _, _, usdc_id, _) = setup();
    let amount = 600_0000000i128;
    let (sender, _, id) = open(&env, &client, &usdc_id, amount);
    env.ledger().with_mut(|li| li.timestamp += 7 * 24 * 60 * 60 + 1);
    client.claim_expired(&sender, &id);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), amount);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::Expired);
}

#[test]
#[should_panic(expected = "resolution deadline has not elapsed")]
fn test_claim_expired_before_deadline_panics() {
    let (env, client, _, _, usdc_id, _) = setup();
    let (sender, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    client.claim_expired(&sender, &id);
}

#[test]
#[should_panic(expected = "resolution deadline has not elapsed")]
fn test_claim_expired_exactly_at_deadline_panics() {
    let (env, client, _, _, usdc_id, _) = setup();
    let (sender, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    env.ledger().with_mut(|li| li.timestamp += 7 * 24 * 60 * 60);
    client.claim_expired(&sender, &id);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not the dispute sender")]
fn test_claim_expired_wrong_caller_panics() {
    let (env, client, _, _, usdc_id, _) = setup();
    let (_, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    env.ledger().with_mut(|li| li.timestamp += 7 * 24 * 60 * 60 + 1);
    let impostor = Address::generate(&env);
    client.claim_expired(&impostor, &id);
}

#[test]
#[should_panic(expected = "dispute is not open")]
fn test_claim_expired_after_resolution_panics() {
    let (env, client, _, arbitrator, usdc_id, _) = setup();
    let (sender, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    client.resolve_dispute(&arbitrator, &id, &false);
    env.ledger().with_mut(|li| li.timestamp += 7 * 24 * 60 * 60 + 1);
    client.claim_expired(&sender, &id);
}

// ── get_dispute ───────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "dispute not found")]
fn test_get_dispute_nonexistent_panics() {
    let (_, client, _, _, _, _) = setup();
    client.get_dispute(&0);
}

// ── arbitrator handoff (propose + accept) ─────────────────────────────────────

#[test]
fn test_propose_and_accept_arbitrator_updates_arbitrator() {
    let (env, client, admin, _, usdc_id, _) = setup();
    let new_arb = Address::generate(&env);
    client.propose_new_arbitrator(&admin, &new_arb);
    client.accept_arbitrator(&new_arb);
    let amount = 200_0000000i128;
    let (_, recipient, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&new_arb, &id, &true);
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    client.finalize_resolution(&id);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), amount);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_propose_new_arbitrator_non_admin_panics() {
    let (env, client, _, _, _, _) = setup();
    let impostor = Address::generate(&env);
    let new_arb = Address::generate(&env);
    client.propose_new_arbitrator(&impostor, &new_arb);
}

// ── appeal ────────────────────────────────────────────────────────────────────

#[test]
fn test_appeal_by_sender_sets_under_appeal() {
    let (env, client, _, arbitrator, usdc_id, _) = setup();
    let amount = 500_0000000i128;
    let (sender, _, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&arbitrator, &id, &true);
    client.appeal(&sender, &id);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::UnderAppeal);
}

#[test]
fn test_appeal_by_recipient_sets_under_appeal() {
    let (env, client, _, arbitrator, usdc_id, _) = setup();
    let amount = 500_0000000i128;
    let (_, recipient, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&arbitrator, &id, &false);
    client.appeal(&recipient, &id);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::UnderAppeal);
}

#[test]
#[should_panic(expected = "appeal already filed")]
fn test_second_appeal_panics() {
    let (env, client, _, arbitrator, usdc_id, _) = setup();
    let amount = 500_0000000i128;
    let (sender, _, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&arbitrator, &id, &true);
    client.appeal(&sender, &id);
    client.appeal(&sender, &id);
}

#[test]
#[should_panic(expected = "caller is not a party to this dispute")]
fn test_appeal_by_third_party_panics() {
    let (env, client, _, arbitrator, usdc_id, _) = setup();
    let amount = 500_0000000i128;
    let (_, _, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&arbitrator, &id, &true);
    let outsider = Address::generate(&env);
    client.appeal(&outsider, &id);
}

#[test]
#[should_panic(expected = "appeal window has closed")]
fn test_appeal_after_deadline_panics() {
    let (env, client, _, arbitrator, usdc_id, _) = setup();
    let amount = 500_0000000i128;
    let (sender, _, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&arbitrator, &id, &true);
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    client.appeal(&sender, &id);
}

#[test]
#[should_panic(expected = "dispute is not in the appeal window")]
fn test_appeal_on_open_dispute_panics() {
    let (env, client, _, _, usdc_id, _) = setup();
    let amount = 500_0000000i128;
    let (sender, _, id) = open(&env, &client, &usdc_id, amount);
    client.appeal(&sender, &id);
}

// ── finalize_resolution ───────────────────────────────────────────────────────

#[test]
fn test_no_appeal_finalized_after_deadline() {
    let (env, client, _, arbitrator, usdc_id, _) = setup();
    let amount = 700_0000000i128;
    let (_, recipient, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&arbitrator, &id, &true);
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    client.finalize_resolution(&id);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), amount);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::ResolvedForRecipient);
}

#[test]
#[should_panic(expected = "dispute is not awaiting finalization")]
fn test_appeal_filed_blocks_finalization() {
    let (env, client, _, arbitrator, usdc_id, _) = setup();
    let amount = 700_0000000i128;
    let (sender, _, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&arbitrator, &id, &true);
    client.appeal(&sender, &id);
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    client.finalize_resolution(&id);
}

#[test]
#[should_panic(expected = "appeal window has not yet closed")]
fn test_finalize_before_deadline_panics() {
    let (env, client, _, arbitrator, usdc_id, _) = setup();
    let amount = 500_0000000i128;
    let (_, _, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&arbitrator, &id, &true);
    client.finalize_resolution(&id);
}

#[test]
#[should_panic(expected = "dispute is not awaiting finalization")]
fn test_finalize_open_dispute_panics() {
    let (env, client, _, _, usdc_id, _) = setup();
    let amount = 500_0000000i128;
    let (_, _, id) = open(&env, &client, &usdc_id, amount);
    client.finalize_resolution(&id);
}

// ── resolve_appeal ────────────────────────────────────────────────────────────

#[test]
fn test_super_arbitrator_resolution_for_recipient() {
    let (env, client, _, arbitrator, usdc_id, super_arbitrator) = setup();
    let amount = 900_0000000i128;
    let (sender, recipient, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&arbitrator, &id, &false);
    client.appeal(&sender, &id);
    client.resolve_appeal(&super_arbitrator, &id, &true);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), amount);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::ResolvedForRecipient);
}

#[test]
fn test_super_arbitrator_resolution_for_sender() {
    let (env, client, _, arbitrator, usdc_id, super_arbitrator) = setup();
    let amount = 900_0000000i128;
    let (sender, recipient, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&arbitrator, &id, &true);
    client.appeal(&recipient, &id);
    client.resolve_appeal(&super_arbitrator, &id, &false);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), amount);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::ResolvedForSender);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not the super arbitrator")]
fn test_resolve_appeal_non_super_arbitrator_panics() {
    let (env, client, _, arbitrator, usdc_id, _) = setup();
    let amount = 500_0000000i128;
    let (sender, _, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&arbitrator, &id, &true);
    client.appeal(&sender, &id);
    let impostor = Address::generate(&env);
    client.resolve_appeal(&impostor, &id, &false);
}

#[test]
#[should_panic(expected = "dispute is not under appeal")]
fn test_resolve_appeal_without_appeal_panics() {
    let (env, client, _, arbitrator, usdc_id, super_arbitrator) = setup();
    let amount = 500_0000000i128;
    let (_, _, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&arbitrator, &id, &true);
    client.resolve_appeal(&super_arbitrator, &id, &false);
}

// ── set_super_arbitrator ──────────────────────────────────────────────────────

#[test]
fn test_set_super_arbitrator_updates_address() {
    let (env, client, admin, arbitrator, usdc_id, _) = setup();
    let new_super = Address::generate(&env);
    client.set_super_arbitrator(&admin, &new_super);
    let amount = 300_0000000i128;
    let (sender, recipient, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&arbitrator, &id, &false);
    client.appeal(&sender, &id);
    client.resolve_appeal(&new_super, &id, &true);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), amount);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_set_super_arbitrator_non_admin_panics() {
    let (env, client, _, _, _, _) = setup();
    let impostor = Address::generate(&env);
    let new_super = Address::generate(&env);
    client.set_super_arbitrator(&impostor, &new_super);
}

// ── cast_vote / multi-arbitrator panel ───────────────────────────────────────
//
// Panel setup: 3 arbitrators, quorum = 6001 bps (>60%).
// Quorum math: votes_for_side * 10_000 > quorum_bps * panel_size
//   2 of 3 votes → 20_000 > 18_003  ✓ quorum reached
//   1 of 3 votes → 10_000 < 18_003  ✗ no quorum

/// Helper: build a client, add 3 panel arbitrators, open a dispute.
/// Returns (env, client, usdc_id, arb1, arb2, arb3, sender, recipient, dispute_id).
fn setup_panel() -> (
    Env,
    DisputeResolutionContractClient<'static>,
    Address, // usdc_id
    Address, // arb1
    Address, // arb2
    Address, // arb3
    Address, // sender
    Address, // recipient
    u64,     // dispute_id
) {
    let (env, client, admin, _, usdc_id, _) = setup();

    let arb1 = Address::generate(&env);
    let arb2 = Address::generate(&env);
    let arb3 = Address::generate(&env);

    client.add_arbitrator(&admin, &arb1);
    client.add_arbitrator(&admin, &arb2);
    client.add_arbitrator(&admin, &arb3);

    // Default quorum is already 6001 bps — matches our requirement.

    let amount = 1_000_0000000i128;
    let (sender, recipient, id) = open(&env, &client, &usdc_id, amount);

    (env, client, usdc_id, arb1, arb2, arb3, sender, recipient, id)
}

/// Acceptance criterion: quorum for recipient — 2-of-3 vote for_recipient=true
/// → funds immediately released to recipient, status = ResolvedForRecipient.
#[test]
fn test_cast_vote_quorum_for_recipient() {
    let (env, client, usdc_id, arb1, arb2, _arb3, _sender, recipient, id) = setup_panel();
    let amount = 1_000_0000000i128;

    // First vote: no quorum yet.
    client.cast_vote(&arb1, &id, &true);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::Open);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), 0);

    // Second vote: 2-of-3 → quorum reached, funds released.
    client.cast_vote(&arb2, &id, &true);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::ResolvedForRecipient);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), amount);
}

/// Acceptance criterion: quorum for sender — 2-of-3 vote for_recipient=false
/// → funds refunded to sender, status = ResolvedForSender.
#[test]
fn test_cast_vote_quorum_for_sender() {
    let (env, client, usdc_id, arb1, arb2, _arb3, sender, _recipient, id) = setup_panel();
    let amount = 1_000_0000000i128;

    // First vote: no quorum yet.
    client.cast_vote(&arb1, &id, &false);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::Open);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), 0);

    // Second vote: 2-of-3 → quorum reached, funds refunded.
    client.cast_vote(&arb2, &id, &false);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::ResolvedForSender);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), amount);
}

/// Acceptance criterion: no quorum — only 1-of-3 votes cast, split 1-for-recipient
/// and 1-for-sender → neither side exceeds quorum, funds remain locked.
#[test]
fn test_cast_vote_no_quorum_funds_stay_locked() {
    let (env, client, usdc_id, arb1, arb2, _arb3, _sender, _recipient, id) = setup_panel();

    // Split votes: 1 for recipient, 1 for sender → neither reaches 2-of-3.
    client.cast_vote(&arb1, &id, &true);
    client.cast_vote(&arb2, &id, &false);

    // Dispute still open, funds remain locked in contract (both balances = 0).
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::Open);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&_recipient), 0);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&_sender), 0);
}

/// Acceptance criterion: duplicate vote rejected — an arbitrator cannot vote twice.
#[test]
#[should_panic(expected = "arbitrator has already voted")]
fn test_cast_vote_duplicate_rejected() {
    let (_, client, _, arb1, _arb2, _arb3, _, _, id) = setup_panel();

    client.cast_vote(&arb1, &id, &true);
    // Second call from the same arbitrator must panic.
    client.cast_vote(&arb1, &id, &false);
}

// ── escrow cross-contract hook ────────────────────────────────────────────────

#[test]
fn test_set_and_get_escrow_contract() {
    let (env, client, admin, _, _, _) = setup();
    let escrow = Address::generate(&env);
    assert!(client.get_escrow_contract().is_none());
    client.set_escrow_contract(&admin, &escrow);
    assert_eq!(client.get_escrow_contract().unwrap(), escrow);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_set_escrow_contract_non_admin_panics() {
    let (env, client, _, _, _, _) = setup();
    let impostor = Address::generate(&env);
    let escrow = Address::generate(&env);
    client.set_escrow_contract(&impostor, &escrow);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not the escrow contract")]
fn test_open_escrow_dispute_non_escrow_caller_panics() {
    let (env, client, admin, _, _, _) = setup();
    let escrow = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.set_escrow_contract(&admin, &escrow);
    // A top-level caller is not the escrow contract, so this must be rejected.
    client.open_escrow_dispute(&escrow, &sender, &recipient, &500_0000000);
}
