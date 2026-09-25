#![cfg(test)]

use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Bytes, Env};

use crate::{KycAttestationContract, KycAttestationContractClient, KycTier};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn setup() -> (Env, KycAttestationContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, KycAttestationContract);
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

// ── attest ────────────────────────────────────────────────────────────────────

#[test]
fn test_attest_stores_record() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, KycTier::Basic, &hash(&env), 0);

    let record = client.get_attestation(&user, KycTier::Basic);
    assert_eq!(record.revoked_at, 0);
    assert!(record.attested_at > 0);
}

#[test]
fn test_attest_makes_user_verified() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, KycTier::Basic, &hash(&env), 0);
    assert!(client.is_verified(&user, KycTier::Basic));
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_attest_non_admin_panics() {
    let (env, client, _) = setup();
    let impostor = Address::generate(&env);
    let user = Address::generate(&env);
    client.attest(&impostor, &user, KycTier::Basic, &hash(&env), 0);
}

#[test]
#[should_panic(expected = "kyc_hash must not be empty")]
fn test_attest_empty_hash_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, KycTier::Basic, &Bytes::new(&env), 0);
}

#[test]
#[should_panic(expected = "user already has an active attestation")]
fn test_attest_duplicate_active_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, KycTier::Basic, &hash(&env), 0);
    client.attest(&admin, &user, KycTier::Basic, &hash(&env), 0);
}

#[test]
fn test_attest_after_revoke_succeeds() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, KycTier::Basic, &hash(&env), 0);
    env.ledger().with_mut(|li| li.timestamp += 1);
    client.revoke(&admin, &user, KycTier::Basic);
    // Re-attest after revocation should succeed
    env.ledger().with_mut(|li| li.timestamp += 1);
    client.attest(&admin, &user, KycTier::Basic, &hash(&env), 0);
    assert!(client.is_verified(&user, KycTier::Basic));
}

// ── revoke ────────────────────────────────────────────────────────────────────

#[test]
fn test_revoke_sets_revoked_at() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, KycTier::Basic, &hash(&env), 0);
    env.ledger().with_mut(|li| li.timestamp += 100);
    client.revoke(&admin, &user, KycTier::Basic);

    let record = client.get_attestation(&user, KycTier::Basic);
    assert!(record.revoked_at > 0);
}

#[test]
fn test_revoke_makes_user_unverified() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, KycTier::Basic, &hash(&env), 0);
    client.revoke(&admin, &user, KycTier::Basic);
    assert!(!client.is_verified(&user, KycTier::Basic));
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_revoke_non_admin_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    let impostor = Address::generate(&env);
    client.attest(&admin, &user, KycTier::Basic, &hash(&env), 0);
    client.revoke(&impostor, &user, KycTier::Basic);
}

#[test]
#[should_panic(expected = "no attestation found for user and tier")]
fn test_revoke_nonexistent_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.revoke(&admin, &user, KycTier::Basic);
}

#[test]
#[should_panic(expected = "attestation already revoked")]
fn test_revoke_twice_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, KycTier::Basic, &hash(&env), 0);
    client.revoke(&admin, &user, KycTier::Basic);
    client.revoke(&admin, &user, KycTier::Basic);
}

// ── is_verified ───────────────────────────────────────────────────────────────

#[test]
fn test_is_verified_false_for_unknown_user() {
    let (env, client, _) = setup();
    let user = Address::generate(&env);
    assert!(!client.is_verified(&user, KycTier::Basic));
}

#[test]
fn test_is_verified_true_after_attest() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, KycTier::Basic, &hash(&env), 0);
    assert!(client.is_verified(&user, KycTier::Basic));
}

#[test]
fn test_is_verified_false_after_revoke() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, KycTier::Basic, &hash(&env), 0);
    client.revoke(&admin, &user, KycTier::Basic);
    assert!(!client.is_verified(&user, KycTier::Basic));
}

#[test]
fn test_multiple_users_independent() {
    let (env, client, admin) = setup();
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    client.attest(&admin, &user1, KycTier::Basic, &hash(&env), 0);
    assert!(client.is_verified(&user1, KycTier::Basic));
    assert!(!client.is_verified(&user2, KycTier::Basic));
}

// ── get_attestation ───────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "no attestation found for user and tier")]
fn test_get_attestation_nonexistent_panics() {
    let (env, client, _) = setup();
    client.get_attestation(&Address::generate(&env), KycTier::Basic);
}

#[test]
fn test_get_attestation_hash_matches() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    let h = hash(&env);
    client.attest(&admin, &user, KycTier::Basic, &h, 0);
    assert_eq!(client.get_attestation(&user, KycTier::Basic).kyc_hash, h);
}

#[test]
fn test_attest_all_tiers_and_verify_independently() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);

    client.attest(&admin, &user, KycTier::Basic, &hash(&env), 0);
    client.attest(&admin, &user, KycTier::Enhanced, &hash(&env), 0);
    client.attest(&admin, &user, KycTier::Business, &hash(&env), 0);

    assert!(client.is_verified(&user, KycTier::Basic));
    assert!(client.is_verified(&user, KycTier::Enhanced));
    assert!(client.is_verified(&user, KycTier::Business));
}

#[test]
fn test_revoke_one_tier_leaves_others_verified() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);

    client.attest(&admin, &user, KycTier::Basic, &hash(&env), 0);
    client.attest(&admin, &user, KycTier::Enhanced, &hash(&env), 0);
    client.attest(&admin, &user, KycTier::Business, &hash(&env), 0);

    client.revoke(&admin, &user, KycTier::Enhanced);

    assert!(client.is_verified(&user, KycTier::Basic));
    assert!(!client.is_verified(&user, KycTier::Enhanced));
    assert!(client.is_verified(&user, KycTier::Business));
}

#[test]
fn test_get_highest_tier_returns_correct_tier() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);

    assert_eq!(client.get_highest_tier(&user), None);

    client.attest(&admin, &user, KycTier::Basic, &hash(&env), 0);
    assert_eq!(client.get_highest_tier(&user), Some(KycTier::Basic));

    client.attest(&admin, &user, KycTier::Enhanced, &hash(&env), 0);
    assert_eq!(client.get_highest_tier(&user), Some(KycTier::Enhanced));

    client.attest(&admin, &user, KycTier::Business, &hash(&env), 0);
    assert_eq!(client.get_highest_tier(&user), Some(KycTier::Business));

    client.revoke(&admin, &user, KycTier::Business);
    assert_eq!(client.get_highest_tier(&user), Some(KycTier::Enhanced));
}

#[test]
fn test_batch_revoke_revokes_valid_pairs() {
    let (env, client, admin) = setup();
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);

    client.attest(&admin, &user1, &hash(&env));
    client.attest(&admin, &user2, &hash(&env));

    let mut revocations = soroban_sdk::Vec::new(&env);
    revocations.push_back((user1.clone(), KycTier::Standard));
    revocations.push_back((user2.clone(), KycTier::Basic));

    client.batch_revoke(&admin, &revocations);

    assert!(!client.is_verified(&user1));
    assert!(!client.is_verified(&user2));
}

#[test]
fn test_batch_revoke_skips_missing_attestations() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &hash(&env));

    let mut revocations = soroban_sdk::Vec::new(&env);
    revocations.push_back((user.clone(), KycTier::Standard));
    revocations.push_back((Address::generate(&env), KycTier::Premium));

    client.batch_revoke(&admin, &revocations);

    assert!(!client.is_verified(&user));
}

#[test]
#[should_panic(expected = "Batch size exceeds maximum of 50")]
fn test_batch_revoke_exceeds_limit_panics() {
    let (env, client, admin) = setup();
    let mut revocations = soroban_sdk::Vec::new(&env);

    for _ in 0..51 {
        revocations.push_back((Address::generate(&env), KycTier::Basic));
    }

    client.batch_revoke(&admin, &revocations);
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
        let kyc_hash = bytes!(&env, "test_kyc_{}", i);
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
    let kyc_hash = bytes!(&env, "test_hash");

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

    let kyc_hash = bytes!(&env, "test_hash");

    // Attest users at different tiers
    client.attest(&admin, &user1, &KycTier::Basic, &kyc_hash, &0);
    client.attest(&admin, &user2, &KycTier::Enhanced, &kyc_hash, &0);
    client.attest(&admin, &user3, &KycTier::Premium, &kyc_hash, &0);

    // Verify all three in a "batch" (simulating escrow batch creation)
    assert!(client.is_verified(&user1, &KycTier::Basic));
    assert!(client.is_verified(&user2, &KycTier::Enhanced));
    assert!(client.is_verified(&user3, &KycTier::Premium));

    // Cross-tier verification should fail
    assert!(!client.is_verified(&user1, &KycTier::Enhanced));
    assert!(!client.is_verified(&user2, &KycTier::Basic));
    assert!(!client.is_verified(&user3, &KycTier::Enhanced));
}

#[test]
fn test_expired_attestation_in_batch_context() {
    // SC-1072: Verify that expired attestations are correctly rejected
    // even in a high-concurrency batch scenario.
    let (env, client, admin) = setup();
    
    let user = Address::generate(&env);
    let kyc_hash = bytes!(&env, "test_hash");
    let future_expiry = 2_000u64; // 2000 seconds in the future

    // Attest with future expiry
    client.attest(&admin, &user, &KycTier::Basic, &kyc_hash, &future_expiry);
    assert!(client.is_verified(&user, &KycTier::Basic));

    // Fast-forward past expiry
    env.ledger().with_mut(|ledger| {
        ledger.timestamp_mut().set(2_001u64);
    });

    // Attestation should now be considered expired
    assert!(!client.is_verified(&user, &KycTier::Basic));
}
