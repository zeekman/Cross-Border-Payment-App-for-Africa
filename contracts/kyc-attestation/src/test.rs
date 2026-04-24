#![cfg(test)]

use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Bytes, Env};

use crate::{KycAttestationContract, KycAttestationContractClient};

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
    client.attest(&admin, &user, &hash(&env));

    let record = client.get_attestation(&user);
    assert_eq!(record.revoked_at, 0);
    assert!(record.attested_at > 0);
}

#[test]
fn test_attest_makes_user_verified() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &hash(&env));
    assert!(client.is_verified(&user));
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_attest_non_admin_panics() {
    let (env, client, _) = setup();
    let impostor = Address::generate(&env);
    let user = Address::generate(&env);
    client.attest(&impostor, &user, &hash(&env));
}

#[test]
#[should_panic(expected = "kyc_hash must not be empty")]
fn test_attest_empty_hash_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &Bytes::new(&env));
}

#[test]
#[should_panic(expected = "user already has an active attestation")]
fn test_attest_duplicate_active_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &hash(&env));
    client.attest(&admin, &user, &hash(&env));
}

#[test]
fn test_attest_after_revoke_succeeds() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &hash(&env));
    env.ledger().with_mut(|li| li.timestamp += 1);
    client.revoke(&admin, &user);
    // Re-attest after revocation should succeed
    env.ledger().with_mut(|li| li.timestamp += 1);
    client.attest(&admin, &user, &hash(&env));
    assert!(client.is_verified(&user));
}

// ── revoke ────────────────────────────────────────────────────────────────────

#[test]
fn test_revoke_sets_revoked_at() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &hash(&env));
    env.ledger().with_mut(|li| li.timestamp += 100);
    client.revoke(&admin, &user);

    let record = client.get_attestation(&user);
    assert!(record.revoked_at > 0);
}

#[test]
fn test_revoke_makes_user_unverified() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &hash(&env));
    client.revoke(&admin, &user);
    assert!(!client.is_verified(&user));
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_revoke_non_admin_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    let impostor = Address::generate(&env);
    client.attest(&admin, &user, &hash(&env));
    client.revoke(&impostor, &user);
}

#[test]
#[should_panic(expected = "no attestation found for user")]
fn test_revoke_nonexistent_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.revoke(&admin, &user);
}

#[test]
#[should_panic(expected = "attestation already revoked")]
fn test_revoke_twice_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &hash(&env));
    client.revoke(&admin, &user);
    client.revoke(&admin, &user);
}

// ── is_verified ───────────────────────────────────────────────────────────────

#[test]
fn test_is_verified_false_for_unknown_user() {
    let (env, client, _) = setup();
    let user = Address::generate(&env);
    assert!(!client.is_verified(&user));
}

#[test]
fn test_is_verified_true_after_attest() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &hash(&env));
    assert!(client.is_verified(&user));
}

#[test]
fn test_is_verified_false_after_revoke() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.attest(&admin, &user, &hash(&env));
    client.revoke(&admin, &user);
    assert!(!client.is_verified(&user));
}

#[test]
fn test_multiple_users_independent() {
    let (env, client, admin) = setup();
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    client.attest(&admin, &user1, &hash(&env));
    assert!(client.is_verified(&user1));
    assert!(!client.is_verified(&user2));
}

// ── get_attestation ───────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "no attestation found for user")]
fn test_get_attestation_nonexistent_panics() {
    let (env, client, _) = setup();
    client.get_attestation(&Address::generate(&env));
}

#[test]
fn test_get_attestation_hash_matches() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    let h = hash(&env);
    client.attest(&admin, &user, &h);
    assert_eq!(client.get_attestation(&user).kyc_hash, h);
}
