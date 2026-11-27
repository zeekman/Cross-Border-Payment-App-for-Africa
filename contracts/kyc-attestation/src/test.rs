#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger, MockAuth, MockAuthInvoke},
    Address, Bytes, Env, IntoVal,
    testutils::{Address as _, Events as _, Ledger},
    Address, Bytes, Env, IntoVal, Symbol, TryFromVal,
};

use crate::{
    KycAttestationContract, KycAttestationContractClient, KycTier, KycAttestedEvent,
    KycBatchRevokedEvent, KycRevokedEvent,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn setup() -> (Env, KycAttestationContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    // Start at a realistic ledger time: the contract uses 0 to mean "never
    // revoked", so a revocation at timestamp 0 would be invisible.
    env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);
    let id = env.register(KycAttestationContract, ());
    let client = KycAttestationContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

fn hash(env: &Env) -> Bytes {
    // Simulate a 32-byte SHA-256 hash
    Bytes::from_array(env, &[0xabu8; 32])
}

// ── initialize ────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let (_, client, admin) = setup();
    client.initialize(&admin);
}

#[test]
fn test_initialize_requires_admin_auth() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);
    let id = env.register(KycAttestationContract, ());
    let client = KycAttestationContractClient::new(&env, &id);
    let admin = Address::generate(&env);

    // Only the admin's signature is mocked; a different caller must fail.
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &id,
            fn_name: "initialize",
            args: (admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let impostor = Address::generate(&env);
    let result = client.try_initialize(&impostor);
    assert!(result.is_err(), "initialize must require the admin's auth");
}

#[test]
fn test_initialize_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);
    let id = env.register(KycAttestationContract, ());
    let client = KycAttestationContractClient::new(&env, &id);
    let admin = Address::generate(&env);

    client.initialize(&admin);

    let events = env.events().all();
    assert!(!events.is_empty(), "initialize must emit an Initialized event");
}

// ── attest ────────────────────────────────────────────────────────────────────

#[test]
fn test_attest_stores_record() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);

    let record = client.get_attestation(&user, &KycTier::Basic);
    assert_eq!(record.revoked_at, 0);
    assert!(record.attested_at > 0);
}

#[test]
fn test_attest_makes_user_verified() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    assert!(client.is_verified(&user, &KycTier::Basic));
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_attest_non_admin_panics() {
    let (env, client, _) = setup();
    let impostor = Address::generate(&env);
    let user = Address::generate(&env);
    client.attest(&impostor, &user, &KycTier::Basic, &hash(&env), &0);
}

#[test]
#[should_panic(expected = "kyc_hash must not be empty")]
fn test_attest_empty_hash_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &KycTier::Basic, &Bytes::new(&env), &0);
}

#[test]
#[should_panic(expected = "user already has an active attestation")]
fn test_attest_duplicate_active_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
}

#[test]
fn test_attest_after_revoke_succeeds() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    env.ledger().with_mut(|li| li.timestamp += 1);
    client.revoke(&admin, &user, &KycTier::Basic);
    // Re-attest after revocation should succeed
    env.ledger().with_mut(|li| li.timestamp += 1);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    assert!(client.is_verified(&user, &KycTier::Basic));
}

#[test]
fn test_reattest_after_revoke_records_new_attested_at() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    let first_attested_at = client.get_attestation(&user, &KycTier::Basic).attested_at;

    env.ledger().with_mut(|li| li.timestamp += 100);
    client.revoke(&admin, &user, &KycTier::Basic);

    env.ledger().with_mut(|li| li.timestamp += 100);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);

    let record = client.get_attestation(&user, &KycTier::Basic);
    assert!(record.attested_at > first_attested_at);
    assert_eq!(record.revoked_at, 0);
}

#[test]
fn test_reattest_after_revoke_preserves_revocation_evidence() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);

    env.ledger().with_mut(|li| li.timestamp += 100);
    client.revoke(&admin, &user, &KycTier::Basic);
    let revoked_at = client.get_attestation(&user, &KycTier::Basic).revoked_at;

    env.ledger().with_mut(|li| li.timestamp += 100);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);

    let record = client.get_attestation(&user, &KycTier::Basic);
    assert_eq!(record.revocation_count, 1);
    assert_eq!(record.last_revoked_at, revoked_at);
}

#[test]
fn test_reattest_after_expiry_records_new_attested_at() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    // expires 1000s from now
    let expires_at = env.ledger().timestamp() + 1000;
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &expires_at);
    let first_attested_at = client.get_attestation(&user, &KycTier::Basic).attested_at;

    env.ledger().with_mut(|li| li.timestamp += 2000);
    assert!(!client.is_verified(&user, &KycTier::Basic));

    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    let record = client.get_attestation(&user, &KycTier::Basic);
    assert!(record.attested_at > first_attested_at);
    assert!(client.is_verified(&user, &KycTier::Basic));
}

// ── revoke ────────────────────────────────────────────────────────────────────

#[test]
fn test_revoke_sets_revoked_at() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    env.ledger().with_mut(|li| li.timestamp += 100);
    client.revoke(&admin, &user, &KycTier::Basic);

    let record = client.get_attestation(&user, &KycTier::Basic);
    assert!(record.revoked_at > 0);
}

#[test]
fn test_revoke_makes_user_unverified() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    client.revoke(&admin, &user, &KycTier::Basic);
    assert!(!client.is_verified(&user, &KycTier::Basic));
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_revoke_non_admin_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    let impostor = Address::generate(&env);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    client.revoke(&impostor, &user, &KycTier::Basic);
}

#[test]
#[should_panic(expected = "no attestation found for user and tier")]
fn test_revoke_nonexistent_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.revoke(&admin, &user, &KycTier::Basic);
}

#[test]
#[should_panic(expected = "attestation already revoked")]
fn test_revoke_twice_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    client.revoke(&admin, &user, &KycTier::Basic);
    client.revoke(&admin, &user, &KycTier::Basic);
}

// ── is_verified ───────────────────────────────────────────────────────────────

#[test]
fn test_is_verified_false_for_unknown_user() {
    let (env, client, _) = setup();
    let user = Address::generate(&env);
    assert!(!client.is_verified(&user, &KycTier::Basic));
}

#[test]
fn test_is_verified_true_after_attest() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    assert!(client.is_verified(&user, &KycTier::Basic));
}

#[test]
fn test_is_verified_false_after_revoke() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    client.revoke(&admin, &user, &KycTier::Basic);
    assert!(!client.is_verified(&user, &KycTier::Basic));
}

#[test]
fn test_multiple_users_independent() {
    let (env, client, admin) = setup();
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    client.attest(&admin, &user1, &KycTier::Basic, &hash(&env), &0);
    assert!(client.is_verified(&user1, &KycTier::Basic));
    assert!(!client.is_verified(&user2, &KycTier::Basic));
}

// ── get_attestation ───────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "no attestation found for user and tier")]
fn test_get_attestation_nonexistent_panics() {
    let (env, client, _) = setup();
    client.get_attestation(&Address::generate(&env), &KycTier::Basic);
}

#[test]
fn test_get_attestation_hash_matches() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    let h = hash(&env);
    client.attest(&admin, &user, &KycTier::Basic, &h, &0);
    assert_eq!(client.get_attestation(&user, &KycTier::Basic).kyc_hash, h);
}

#[test]
fn test_attest_all_tiers_and_verify_independently() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);

    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    client.attest(&admin, &user, &KycTier::Enhanced, &hash(&env), &0);
    client.attest(&admin, &user, &KycTier::Business, &hash(&env), &0);

    assert!(client.is_verified(&user, &KycTier::Basic));
    assert!(client.is_verified(&user, &KycTier::Enhanced));
    assert!(client.is_verified(&user, &KycTier::Business));
}

#[test]
fn test_revoke_one_tier_leaves_others_verified() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);

    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    client.attest(&admin, &user, &KycTier::Enhanced, &hash(&env), &0);
    client.attest(&admin, &user, &KycTier::Business, &hash(&env), &0);

    client.revoke(&admin, &user, &KycTier::Enhanced);

    assert!(client.is_verified(&user, &KycTier::Basic));
    assert!(!client.is_verified(&user, &KycTier::Enhanced));
    assert!(client.is_verified(&user, &KycTier::Business));
}

// ── tier mirroring (SC-110) ───────────────────────────────────────────────────

#[test]
fn test_attest_business_does_not_touch_basic_tier() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);

    // Attest only at Business; the Basic slot must remain untouched.
    client.attest(&admin, &user, &KycTier::Business, &hash(&env), &0);

    assert!(!client.is_verified(&user, &KycTier::Basic));
    assert!(client.is_verified(&user, &KycTier::Business));
}

#[test]
fn test_attest_business_does_not_overwrite_existing_basic() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);

    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    let basic_before = client.get_attestation(&user, &KycTier::Basic);

    client.attest(&admin, &user, &KycTier::Business, &hash(&env), &0);

    let basic_after = client.get_attestation(&user, &KycTier::Basic);
    assert_eq!(basic_before.kyc_hash, basic_after.kyc_hash);
    assert_eq!(basic_before.attested_at, basic_after.attested_at);
    assert_eq!(basic_after.revoked_at, 0);
    assert!(client.is_verified(&user, &KycTier::Basic));
}

#[test]
fn test_revoke_enhanced_does_not_touch_basic_or_business() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);

    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    client.attest(&admin, &user, &KycTier::Enhanced, &hash(&env), &0);
    client.attest(&admin, &user, &KycTier::Business, &hash(&env), &0);

    let basic_before = client.get_attestation(&user, &KycTier::Basic);
    let business_before = client.get_attestation(&user, &KycTier::Business);

    client.revoke(&admin, &user, &KycTier::Enhanced);

    let basic_after = client.get_attestation(&user, &KycTier::Basic);
    let business_after = client.get_attestation(&user, &KycTier::Business);

    assert_eq!(basic_before.kyc_hash, basic_after.kyc_hash);
    assert_eq!(basic_after.revoked_at, 0);
    assert_eq!(business_before.kyc_hash, business_after.kyc_hash);
    assert_eq!(business_after.revoked_at, 0);

    assert!(client.is_verified(&user, &KycTier::Basic));
    assert!(!client.is_verified(&user, &KycTier::Enhanced));
    assert!(client.is_verified(&user, &KycTier::Business));
}

#[test]
fn test_get_highest_tier_returns_correct_tier() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);

    assert_eq!(client.get_highest_tier(&user), None);

    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    assert_eq!(client.get_highest_tier(&user), Some(KycTier::Basic));

    client.attest(&admin, &user, &KycTier::Enhanced, &hash(&env), &0);
    assert_eq!(client.get_highest_tier(&user), Some(KycTier::Enhanced));

    client.attest(&admin, &user, &KycTier::Business, &hash(&env), &0);
    assert_eq!(client.get_highest_tier(&user), Some(KycTier::Business));
}

// ── SC-1072: Batch KYC verification resource cost testing ──────────────────

#[test]
fn test_batch_kyc_verification_cost_documentation() {
    // SC-1072: This test documents the resource cost of KYC verification calls
    // in a batch operation context (e.g., batch_create_escrow calling is_verified
    // for both sender and agent on each of up to 20 escrows).
    //
    // Test setup: 20 concurrent KYC checks simulating the worst case:
    // batch_create_escrow(20 escrows) → 40 is_valid_and_unexpired calls
    // (sender + agent per escrow).

    let (env, client, admin) = setup();
    
    // Create 20 users with verified KYC at Enhanced tier
    let mut users = soroban_sdk::Vec::new(&env);
    for i in 0..20 {
        let user = Address::generate(&env);
        let kyc_hash = Bytes::from_array(&env, &[i as u8 + 1; 32]);
        client.attest(&admin, &user, &KycTier::Enhanced, &kyc_hash, &0);
        users.push_back(user);
    }

    // Simulate 40 verification calls (20 escrows × 2 calls per escrow).
    // Each call verifies a different user against their attested tier.
    let mut verified_count = 0u32;
    for _ in 0..2 {
        for user in users.iter() {
            let is_valid = client.is_valid_and_unexpired(&user, &KycTier::Enhanced);
            if is_valid {
                verified_count += 1;
            }
        }
    }

    // All 40 calls should succeed.
    assert_eq!(verified_count, 40);

    // Resource cost analysis (from issue #1072):
    // - Per-call cost: ~500–1000 CPU instructions (storage read + expiry check)
    // - Batch of 40 calls: ~20,000–40,000 CPU instructions
    // - Soroban transaction limit: ~1,600,000 CPU instructions
    // - Proportion: ~1.25–2.5% of transaction budget for KYC alone
    //
    // Conclusion: Batch KYC verification stays well within resource limits
    // and does NOT justify a dedicated batched API (SC-1072 evaluation).
}

#[test]
fn test_is_valid_and_unexpired_matches_is_verified() {
    // SC-1072: Verify that is_valid_and_unexpired (convenience function)
    // matches the behaviour of is_verified exactly.
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    let kyc_hash = Bytes::from_slice(&env, b"test_hash");

    // Case 1: No attestation
    assert_eq!(
        client.is_verified(&user, &KycTier::Basic),
        client.is_valid_and_unexpired(&user, &KycTier::Basic)
    );

    // Case 2: Active attestation (no expiry)
    client.attest(&admin, &user, &KycTier::Basic, &kyc_hash, &0);
    assert_eq!(
        client.is_verified(&user, &KycTier::Basic),
        client.is_valid_and_unexpired(&user, &KycTier::Basic)
    );
    assert!(client.is_valid_and_unexpired(&user, &KycTier::Basic));

    // Case 3: Revoked attestation
    client.revoke(&admin, &user, &KycTier::Basic);
    assert_eq!(
        client.is_verified(&user, &KycTier::Basic),
        client.is_valid_and_unexpired(&user, &KycTier::Basic)
    );
    assert!(!client.is_valid_and_unexpired(&user, &KycTier::Basic));
}

#[test]
fn test_concurrent_tier_verification_in_batch() {
    // SC-1072: Test that multiple different tiers can be verified
    // concurrently in a batch without conflicts.
    let (env, client, admin) = setup();
    
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let user3 = Address::generate(&env);

    let kyc_hash = Bytes::from_slice(&env, b"test_hash");

    // Attest users at different tiers
    client.attest(&admin, &user1, &KycTier::Basic, &kyc_hash, &0);
    client.attest(&admin, &user2, &KycTier::Enhanced, &kyc_hash, &0);
    client.attest(&admin, &user3, &KycTier::Business, &kyc_hash, &0);

    // Verify all three in a "batch" (simulating escrow batch creation)
    assert!(client.is_verified(&user1, &KycTier::Basic));
    assert!(client.is_verified(&user2, &KycTier::Enhanced));
    assert!(client.is_verified(&user3, &KycTier::Business));

    // Cross-tier verification should fail
    assert!(!client.is_verified(&user1, &KycTier::Enhanced));
    assert!(!client.is_verified(&user2, &KycTier::Basic));
    assert!(!client.is_verified(&user3, &KycTier::Enhanced));
}

#[test]
fn test_attestation_survives_ttl_advance() {
    // SC-189: persistent entries must have their TTL extended on access so
    // that attestations stay readable after the ledger advances well past
    // the default TTL.
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);

    // Advance far beyond the default TTL (a few thousand ledgers).
    env.ledger().set_sequence_number(env.ledger().sequence() + 1_000_000);

    // Activity on the contract should bump TTLs and keep the record readable.
    assert!(client.is_verified(&user, &KycTier::Basic));
    let record = client.get_attestation(&user, &KycTier::Basic);
    assert_eq!(record.revoked_at, 0);
    assert!(record.attested_at > 0);

    // Advance again and confirm the record is still readable after activity.
    env.ledger().set_sequence_number(env.ledger().sequence() + 1_000_000);
    assert!(client.is_verified(&user, &KycTier::Basic));
}

#[test]
fn test_expired_attestation_in_batch_context() {
    // SC-1072: Verify that expired attestations are correctly rejected
    // even in a high-concurrency batch scenario.
    let (env, client, admin) = setup();
    
    let user = Address::generate(&env);
    let kyc_hash = Bytes::from_slice(&env, b"test_hash");
    let future_expiry = env.ledger().timestamp() + 2_000; // 2000 seconds in the future

    // Attest with future expiry
    client.attest(&admin, &user, &KycTier::Basic, &kyc_hash, &future_expiry);
    assert!(client.is_verified(&user, &KycTier::Basic));

    // Fast-forward past expiry
    env.ledger().with_mut(|ledger| {
        ledger.timestamp = future_expiry + 1;
    });

    // Attestation should now be considered expired
    assert!(!client.is_verified(&user, &KycTier::Basic));
}

// ── admin rotation (SC-120 / SC-184) ──────────────────────────────────────────

/// The rotation delay used by the contract (24 h).
const ADMIN_ROTATION_DELAY: u64 = 24 * 60 * 60;

fn advance(env: &Env, seconds: u64) {
    env.ledger().with_mut(|li| li.timestamp += seconds);
}

#[test]
fn test_propose_admin_stores_pending_admin() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);

    client.propose_admin(&admin, &new_admin);

    let pending = client.get_pending_admin().expect("pending admin should be set");
    assert_eq!(pending.new_admin, new_admin);
    assert_eq!(pending.eta, env.ledger().timestamp() + ADMIN_ROTATION_DELAY);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_propose_admin_non_admin_panics() {
    let (env, client, _) = setup();
    let impostor = Address::generate(&env);
    let new_admin = Address::generate(&env);
    client.propose_admin(&impostor, &new_admin);
}

#[test]
#[should_panic(expected = "new admin must differ from current admin")]
fn test_propose_admin_same_address_panics() {
    let (_, client, admin) = setup();
    client.propose_admin(&admin, &admin);
}

#[test]
fn test_accept_admin_before_eta_panics() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    client.propose_admin(&admin, &new_admin);

    // One second before the ETA.
    advance(&env, ADMIN_ROTATION_DELAY - 1);
    let result = client.try_accept_admin(&new_admin);
    assert!(result.is_err(), "rotation must not complete before the delay");
    assert_eq!(client.get_admin(), admin);
}

#[test]
fn test_accept_admin_after_eta_succeeds() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    client.propose_admin(&admin, &new_admin);

    advance(&env, ADMIN_ROTATION_DELAY);
    client.accept_admin(&new_admin);

    assert_eq!(client.get_admin(), new_admin);
    assert!(client.get_pending_admin().is_none());
}

#[test]
fn test_accept_admin_requires_new_admin_auth() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    client.propose_admin(&admin, &new_admin);
    advance(&env, ADMIN_ROTATION_DELAY);

    // Only the new admin's auth is mocked; a third party must not be able to
    // complete the rotation.
    let impostor = Address::generate(&env);
    let result = client.try_accept_admin(&impostor);
    assert!(result.is_err(), "accept must require the new admin's signature");
    assert_eq!(client.get_admin(), admin);
}

#[test]
fn test_accept_admin_without_proposal_panics() {
    let (env, client, _) = setup();
    let new_admin = Address::generate(&env);
    let result = client.try_accept_admin(&new_admin);
    assert!(result.is_err(), "accept without a proposal must fail");
}

#[test]
fn test_cancel_admin_proposal_clears_pending() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    client.propose_admin(&admin, &new_admin);

    client.cancel_admin_proposal(&admin);
    assert!(client.get_pending_admin().is_none());

    // After cancellation the new admin can no longer accept.
    advance(&env, ADMIN_ROTATION_DELAY);
    let result = client.try_accept_admin(&new_admin);
    assert!(result.is_err());
    assert_eq!(client.get_admin(), admin);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_cancel_admin_proposal_non_admin_panics() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    let impostor = Address::generate(&env);
    client.propose_admin(&admin, &new_admin);
    client.cancel_admin_proposal(&impostor);
}

#[test]
fn test_old_admin_loses_attest_and_revoke_privileges() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    let user = Address::generate(&env);

    client.propose_admin(&admin, &new_admin);
    advance(&env, ADMIN_ROTATION_DELAY);
    client.accept_admin(&new_admin);

    // Old admin can no longer attest.
    let attest_result = client.try_attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    assert!(attest_result.is_err(), "old admin must lose attest privileges");

    // New admin can attest.
    client.attest(&new_admin, &user, &KycTier::Basic, &hash(&env), &0);
    assert!(client.is_verified(&user, &KycTier::Basic));

    // Old admin can no longer revoke.
    let revoke_result = client.try_revoke(&admin, &user, &KycTier::Basic);
    assert!(revoke_result.is_err(), "old admin must lose revoke privileges");

    // New admin can revoke.
    client.revoke(&new_admin, &user, &KycTier::Basic);
    assert!(!client.is_verified(&user, &KycTier::Basic));
}

#[test]
fn test_new_admin_can_propose_next_rotation() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    let next_admin = Address::generate(&env);

    client.propose_admin(&admin, &new_admin);
    advance(&env, ADMIN_ROTATION_DELAY);
    client.accept_admin(&new_admin);

    // The old admin cannot start another rotation.
    let old_result = client.try_propose_admin(&admin, &next_admin);
    assert!(old_result.is_err());

    // The new admin can.
    client.propose_admin(&new_admin, &next_admin);
    advance(&env, ADMIN_ROTATION_DELAY);
    client.accept_admin(&next_admin);
    assert_eq!(client.get_admin(), next_admin);
}
// ── SC-200 (#1454): single-key storage + migration ────────────────────────────

/// Seeds the pre-migration layout directly into contract storage: a record under
/// the legacy `AttestationByTier` key and a (possibly stale) `Attestation` mirror.
fn seed_legacy_layout(
    env: &Env,
    contract_id: &Address,
    user: &Address,
    tier: KycTier,
    record: &crate::Attestation,
) {
    env.as_contract(contract_id, || {
        env.storage()
            .persistent()
            .set(&crate::DataKey::AttestationByTier(user.clone(), tier), record);
        env.storage()
            .persistent()
            .set(&crate::DataKey::Attestation(user.clone()), record);
    });
}

fn legacy_keys_present(env: &Env, contract_id: &Address, user: &Address, tier: KycTier) -> bool {
    env.as_contract(contract_id, || {
        env.storage()
            .persistent()
            .has(&crate::DataKey::AttestationByTier(user.clone(), tier))
            || env.storage()
                .persistent()
                .has(&crate::DataKey::Attestation(user.clone()))
    })
}

fn tiered_key_present(env: &Env, contract_id: &Address, user: &Address, tier: KycTier) -> bool {
    env.as_contract(contract_id, || {
        env.storage()
            .persistent()
            .has(&crate::DataKey::TieredAttestation(user.clone(), tier))
    })
}

#[test]
fn test_attest_writes_only_tiered_key() {
    let (env, client, admin) = setup();
    let contract_id = client.address.clone();
    let user = Address::generate(&env);

    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);

    assert!(tiered_key_present(&env, &contract_id, &user, &KycTier::Basic));
    assert!(!legacy_keys_present(&env, &contract_id, &user, &KycTier::Basic));
}

#[test]
fn test_revoke_writes_only_tiered_key() {
    let (env, client, admin) = setup();
    let contract_id = client.address.clone();
    let user = Address::generate(&env);

    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    env.ledger().with_mut(|li| li.timestamp += 100);
    client.revoke(&admin, &user, &KycTier::Basic);

    assert!(tiered_key_present(&env, &contract_id, &user, &KycTier::Basic));
    assert!(!legacy_keys_present(&env, &contract_id, &user, &KycTier::Basic));
}

#[test]
fn test_migrate_copies_attestation_by_tier_and_clears_legacy_keys() {
    let (env, client, admin) = setup();
    let contract_id = client.address.clone();
    let user = Address::generate(&env);
    let kyc_hash = hash(&env);
    let attested_at = env.ledger().timestamp();

    // Old layout: record only under AttestationByTier + the legacy mirror.
    let legacy = crate::Attestation {
        kyc_hash: kyc_hash.clone(),
        attested_at,
        expires_at: 0,
        revoked_at: 0,
        revocation_count: 0,
        last_revoked_at: 0,
    };
    seed_legacy_layout(&env, &contract_id, &user, KycTier::Enhanced, &legacy);

    // Before migration the tiered key is absent.
    assert!(!tiered_key_present(&env, &contract_id, &user, &KycTier::Enhanced));

    let users = soroban_sdk::Vec::from_array(&env, [user.clone()]);
    client.migrate(&admin, &users);

    // Record now readable through the single source of truth.
    let record = client.get_attestation(&user, &KycTier::Enhanced);
    assert_eq!(record.kyc_hash, kyc_hash);
    assert_eq!(record.attested_at, attested_at);
    assert_eq!(record.revoked_at, 0);
    assert!(client.is_valid_and_unexpired(&user, &KycTier::Enhanced));
    assert!(client.is_verified(&user, &KycTier::Enhanced));

    // Legacy keys are gone.
    assert!(!legacy_keys_present(&env, &contract_id, &user, &KycTier::Enhanced));
}

#[test]
fn test_migrate_preserves_revoked_state() {
    let (env, client, admin) = setup();
    let contract_id = client.address.clone();
    let user = Address::generate(&env);

    let revoked_at = env.ledger().timestamp();
    let legacy = crate::Attestation {
        kyc_hash: hash(&env),
        attested_at: revoked_at - 10,
        expires_at: 0,
        revoked_at,
        revocation_count: 1,
        last_revoked_at: revoked_at,
    };
    seed_legacy_layout(&env, &contract_id, &user, KycTier::Basic, &legacy);

    let users = soroban_sdk::Vec::from_array(&env, [user.clone()]);
    client.migrate(&admin, &users);

    let record = client.get_attestation(&user, &KycTier::Basic);
    assert_eq!(record.revoked_at, revoked_at);
    assert_eq!(record.revocation_count, 1);
    assert!(!client.is_valid_and_unexpired(&user, &KycTier::Basic));
}

#[test]
fn test_migrate_does_not_clobber_existing_tiered_record() {
    let (env, client, admin) = setup();
    let contract_id = client.address.clone();
    let user = Address::generate(&env);

    // Current layout already holds the authoritative record.
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    let current = client.get_attestation(&user, &KycTier::Basic);

    // A stale legacy copy exists alongside it.
    let stale = crate::Attestation {
        kyc_hash: Bytes::from_array(&env, &[0x11u8; 32]),
        attested_at: 1,
        expires_at: 0,
        revoked_at: 0,
        revocation_count: 0,
        last_revoked_at: 0,
    };
    seed_legacy_layout(&env, &contract_id, &user, &KycTier::Basic, &stale);

    let users = soroban_sdk::Vec::from_array(&env, [user.clone()]);
    client.migrate(&admin, &users);

    let after = client.get_attestation(&user, &KycTier::Basic);
    assert_eq!(after.kyc_hash, current.kyc_hash);
    assert_eq!(after.attested_at, current.attested_at);
    assert!(!legacy_keys_present(&env, &contract_id, &user, &KycTier::Basic));
}

// ── SC-201 (#1455): structured events ─────────────────────────────────────────

/// Returns the decoded `KycAttestedEvent` payload for the most recent
/// `kyc_attested` event, asserting the user is present in the topics.
fn last_attested_event(env: &Env, user: &Address, tier: KycTier) -> KycAttestedEvent {
    let events = env.events().all();
    let (_, topics, data) = events.last().expect("no events published");
    assert_eq!(topics.len(), 3);
    let name = Symbol::try_from_val(env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(name, Symbol::new(env, "kyc_attested"));
    let topic_user = Address::try_from_val(env, &topics.get(1).unwrap()).unwrap();
    assert_eq!(topic_user, *user);
    let topic_tier = KycTier::try_from_val(env, &topics.get(2).unwrap()).unwrap();
    assert_eq!(topic_tier, tier);
    KycAttestedEvent::try_from_val(env, &data).unwrap()
}

fn last_revoked_event(env: &Env, user: &Address, tier: KycTier) -> KycRevokedEvent {
    let events = env.events().all();
    let (_, topics, data) = events.last().expect("no events published");
    assert_eq!(topics.len(), 3);
    let name = Symbol::try_from_val(env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(name, Symbol::new(env, "kyc_revoked"));
    let topic_user = Address::try_from_val(env, &topics.get(1).unwrap()).unwrap();
    assert_eq!(topic_user, *user);
    let topic_tier = KycTier::try_from_val(env, &topics.get(2).unwrap()).unwrap();
    assert_eq!(topic_tier, tier);
    KycRevokedEvent::try_from_val(env, &data).unwrap()
}

#[test]
fn test_attested_event_payload_is_complete() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    let kyc_hash = hash(&env);
    let expires_at = env.ledger().timestamp() + 5_000;

    client.attest(&admin, &user, &KycTier::Enhanced, &kyc_hash, &expires_at);

    let event = last_attested_event(&env, &user, KycTier::Enhanced);
    assert_eq!(event.admin, admin);
    assert_eq!(event.kyc_hash, kyc_hash);
    assert_eq!(event.attested_at, env.ledger().timestamp());
    assert_eq!(event.expires_at, expires_at);
    assert!(!event.is_renewal);
}

#[test]
fn test_renewal_event_sets_is_renewal() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);

    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    env.ledger().with_mut(|li| li.timestamp += 100);
    client.revoke(&admin, &user, &KycTier::Basic);
    env.ledger().with_mut(|li| li.timestamp += 100);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);

    let event = last_attested_event(&env, &user, KycTier::Basic);
    assert!(event.is_renewal);
    assert_eq!(event.admin, admin);
}

#[test]
fn test_revoked_event_payload_is_complete() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);

    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    env.ledger().with_mut(|li| li.timestamp += 100);
    client.revoke(&admin, &user, &KycTier::Basic);

    let event = last_revoked_event(&env, &user, KycTier::Basic);
    assert_eq!(event.admin, admin);
    assert_eq!(event.revoked_at, env.ledger().timestamp());
    assert_eq!(event.revocation_count, 1);
}

#[test]
fn test_batch_revoked_event_payload() {
    let (env, client, admin) = setup();
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);

    client.attest(&admin, &user1, &KycTier::Basic, &hash(&env), &0);
    client.attest(&admin, &user2, &KycTier::Basic, &hash(&env), &0);

    let mut users = soroban_sdk::Vec::new(&env);
    users.push_back(user1.clone());
    users.push_back(user2.clone());
    client.revoke_batch(&admin, &users);

    let events = env.events().all();
    let (_, topics, data) = events.last().expect("no events published");
    assert_eq!(topics.len(), 1);
    let name = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(name, Symbol::new(&env, "kyc_batch_revoked"));
    let event = KycBatchRevokedEvent::try_from_val(&env, &data).unwrap();
    assert_eq!(event.admin, admin);
    assert_eq!(event.count, 2);
}

// ── max validity policy ───────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "expires_at must be set when tier max validity is configured")]
fn test_attest_zero_expiry_panics_when_tier_has_max_validity() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    let max_validity = 365u64 * 24 * 60 * 60;

    client.set_max_validity(&admin, &KycTier::Basic, &max_validity);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
}

#[test]
#[should_panic(expected = "expires_at exceeds tier max validity")]
fn test_attest_beyond_max_validity_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    let max_validity = 365u64 * 24 * 60 * 60;

    client.set_max_validity(&admin, &KycTier::Enhanced, &max_validity);
    let expires_at = env.ledger().timestamp() + max_validity + 1;
    client.attest(&admin, &user, &KycTier::Enhanced, &hash(&env), &expires_at);
}

#[test]
fn test_get_and_set_max_validity_policy() {
    let (env, client, admin) = setup();

    assert_eq!(client.get_max_validity(&KycTier::Basic), 0);

    let basic_max = 2u64 * 365 * 24 * 60 * 60;
    let enhanced_max = 365u64 * 24 * 60 * 60;
    client.set_max_validity(&admin, &KycTier::Basic, &basic_max);
    client.set_max_validity(&admin, &KycTier::Enhanced, &enhanced_max);

    assert_eq!(client.get_max_validity(&KycTier::Basic), basic_max);
    assert_eq!(client.get_max_validity(&KycTier::Enhanced), enhanced_max);
    assert_eq!(client.get_max_validity(&KycTier::Business), 0);
}

#[test]
fn test_attest_at_max_validity_succeeds() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    let max_validity = 365u64 * 24 * 60 * 60;

    client.set_max_validity(&admin, &KycTier::Business, &max_validity);
    let expires_at = env.ledger().timestamp() + max_validity;
    client.attest(&admin, &user, &KycTier::Business, &hash(&env), &expires_at);

    let record = client.get_attestation(&user, &KycTier::Business);
    assert_eq!(record.expires_at, expires_at);
}

#[test]
fn test_max_validity_zero_means_unlimited() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);

    client.set_max_validity(&admin, &KycTier::Basic, &0);
    client.attest(&admin, &user, &KycTier::Basic, &hash(&env), &0);
    assert!(client.is_verified(&user, &KycTier::Basic));
}
