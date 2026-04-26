#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Bytes, Env,
};

use crate::{DisputeResolutionContract, DisputeResolutionContractClient, DisputeStatus};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn setup() -> (
    Env,
    DisputeResolutionContractClient<'static>,
    Address, // admin
    Address, // arbitrator
    Address, // usdc_id
) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, DisputeResolutionContract);
    let client = DisputeResolutionContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let usdc_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    client.initialize(&admin, &arbitrator, &usdc_id);
    (env, client, admin, arbitrator, usdc_id)
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
    mint(env, usdc_id, &sender, amount);
    let id = client.open_dispute(&sender, &sender, &recipient, &amount);
    (sender, recipient, id)
}

// ── initialize ────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_succeeds() {
    let (_, client, _, _, _) = setup();
    // If we can call get_dispute on a non-existent id without "not initialized"
    // panic, the contract is live. We just verify no panic on setup.
    let _ = client;
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let (_, client, admin, arbitrator, usdc_id) = setup();
    client.initialize(&admin, &arbitrator, &usdc_id);
}

// ── open_dispute ──────────────────────────────────────────────────────────────

#[test]
fn test_open_dispute_returns_sequential_ids() {
    let (env, client, _, _, usdc_id) = setup();
    let amount = 500_0000000i128;
    let (_, _, id1) = open(&env, &client, &usdc_id, amount);
    let (_, _, id2) = open(&env, &client, &usdc_id, amount);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
}

#[test]
fn test_open_dispute_stores_correct_fields() {
    let (env, client, _, _, usdc_id) = setup();
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
    let (env, client, _, _, usdc_id) = setup();
    let amount = 300_0000000i128;
    let (sender, _, _) = open(&env, &client, &usdc_id, amount);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), 0);
}

#[test]
fn test_open_dispute_by_recipient() {
    let (env, client, _, _, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let amount = 200_0000000i128;
    mint(&env, &usdc_id, &recipient, amount);
    // Recipient opens the dispute
    let id = client.open_dispute(&recipient, &sender, &recipient, &amount);
    let d = client.get_dispute(&id);
    assert_eq!(d.status, DisputeStatus::Open);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_open_dispute_zero_amount_panics() {
    let (env, client, _, _, _) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.open_dispute(&sender, &sender, &recipient, &0);
}

#[test]
#[should_panic(expected = "opener must be sender or recipient")]
fn test_open_dispute_third_party_panics() {
    let (env, client, _, _, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let third_party = Address::generate(&env);
    mint(&env, &usdc_id, &third_party, 100_0000000);
    client.open_dispute(&third_party, &sender, &recipient, &100_0000000);
}

// ── submit_evidence ───────────────────────────────────────────────────────────

#[test]
fn test_submit_evidence_by_sender() {
    let (env, client, _, _, usdc_id) = setup();
    let (sender, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    let evidence = Bytes::from_slice(&env, b"QmSomeCIDHash1234567890");
    client.submit_evidence(&sender, &id, &evidence);
    let d = client.get_dispute(&id);
    assert_eq!(d.sender_evidence, evidence);
}

#[test]
fn test_submit_evidence_by_recipient() {
    let (env, client, _, _, usdc_id) = setup();
    let (_, recipient, id) = open(&env, &client, &usdc_id, 500_0000000);
    let evidence = Bytes::from_slice(&env, b"QmRecipientCIDHash");
    client.submit_evidence(&recipient, &id, &evidence);
    let d = client.get_dispute(&id);
    assert_eq!(d.recipient_evidence, evidence);
}

#[test]
fn test_submit_evidence_overwrites_previous() {
    let (env, client, _, _, usdc_id) = setup();
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
    let (env, client, _, _, usdc_id) = setup();
    let (_, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    let outsider = Address::generate(&env);
    client.submit_evidence(&outsider, &id, &Bytes::from_slice(&env, b"hack"));
}

#[test]
#[should_panic(expected = "evidence must be 256 bytes or fewer")]
fn test_submit_evidence_too_large_panics() {
    let (env, client, _, _, usdc_id) = setup();
    let (sender, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    let big = Bytes::from_slice(&env, &[0u8; 257]);
    client.submit_evidence(&sender, &id, &big);
}

#[test]
#[should_panic(expected = "dispute deadline has passed")]
fn test_submit_evidence_after_deadline_panics() {
    let (env, client, _, _, usdc_id) = setup();
    let (sender, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    env.ledger().with_mut(|li| li.timestamp += 7 * 24 * 60 * 60 + 1);
    client.submit_evidence(&sender, &id, &Bytes::from_slice(&env, b"late"));
}

// ── resolve_dispute ───────────────────────────────────────────────────────────

#[test]
fn test_resolve_for_recipient_releases_funds() {
    let (env, client, _, arbitrator, usdc_id) = setup();
    let amount = 1_000_0000000i128;
    let (_, recipient, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&arbitrator, &id, &true);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), amount);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::ResolvedForRecipient);
}

#[test]
fn test_resolve_for_sender_refunds_sender() {
    let (env, client, _, arbitrator, usdc_id) = setup();
    let amount = 800_0000000i128;
    let (sender, _, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&arbitrator, &id, &false);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), amount);
    assert_eq!(client.get_dispute(&id).status, DisputeStatus::ResolvedForSender);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not the arbitrator")]
fn test_resolve_non_arbitrator_panics() {
    let (env, client, _, _, usdc_id) = setup();
    let (_, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    let impostor = Address::generate(&env);
    client.resolve_dispute(&impostor, &id, &true);
}

#[test]
#[should_panic(expected = "dispute is not open")]
fn test_resolve_already_resolved_panics() {
    let (env, client, _, arbitrator, usdc_id) = setup();
    let (_, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    client.resolve_dispute(&arbitrator, &id, &true);
    client.resolve_dispute(&arbitrator, &id, &false);
}

#[test]
#[should_panic(expected = "dispute not found")]
fn test_resolve_nonexistent_dispute_panics() {
    let (_, client, _, arbitrator, _) = setup();
    client.resolve_dispute(&arbitrator, &999, &true);
}

// ── claim_expired ─────────────────────────────────────────────────────────────

#[test]
fn test_claim_expired_after_deadline_refunds_sender() {
    let (env, client, _, _, usdc_id) = setup();
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
    let (env, client, _, _, usdc_id) = setup();
    let (sender, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    client.claim_expired(&sender, &id);
}

#[test]
#[should_panic(expected = "resolution deadline has not elapsed")]
fn test_claim_expired_exactly_at_deadline_panics() {
    let (env, client, _, _, usdc_id) = setup();
    let (sender, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    env.ledger().with_mut(|li| li.timestamp += 7 * 24 * 60 * 60);
    client.claim_expired(&sender, &id);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not the dispute sender")]
fn test_claim_expired_wrong_caller_panics() {
    let (env, client, _, _, usdc_id) = setup();
    let (_, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    env.ledger().with_mut(|li| li.timestamp += 7 * 24 * 60 * 60 + 1);
    let impostor = Address::generate(&env);
    client.claim_expired(&impostor, &id);
}

#[test]
#[should_panic(expected = "dispute is not open")]
fn test_claim_expired_after_resolution_panics() {
    let (env, client, _, arbitrator, usdc_id) = setup();
    let (sender, _, id) = open(&env, &client, &usdc_id, 500_0000000);
    client.resolve_dispute(&arbitrator, &id, &false);
    env.ledger().with_mut(|li| li.timestamp += 7 * 24 * 60 * 60 + 1);
    client.claim_expired(&sender, &id);
}

// ── get_dispute ───────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "dispute not found")]
fn test_get_dispute_nonexistent_panics() {
    let (_, client, _, _, _) = setup();
    client.get_dispute(&0);
}

// ── set_arbitrator ────────────────────────────────────────────────────────────

#[test]
fn test_set_arbitrator_updates_arbitrator() {
    let (env, client, admin, _, usdc_id) = setup();
    let new_arb = Address::generate(&env);
    client.set_arbitrator(&admin, &new_arb);
    // New arbitrator can now resolve
    let amount = 200_0000000i128;
    let (_, recipient, id) = open(&env, &client, &usdc_id, amount);
    client.resolve_dispute(&new_arb, &id, &true);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), amount);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_set_arbitrator_non_admin_panics() {
    let (env, client, _, _, _) = setup();
    let impostor = Address::generate(&env);
    let new_arb = Address::generate(&env);
    client.set_arbitrator(&impostor, &new_arb);
}
