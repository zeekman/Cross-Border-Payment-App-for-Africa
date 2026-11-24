#![cfg(test)]
//! SC-216: event snapshot for a scripted kyc-attestation flow. Any change to
//! an event name, topic or payload shows up as a diff of
//! `kyc-attestation/event_snapshots/kyc_attestation_flow.snap`. See `contracts/EVENTS.md`.
extern crate std;

#[path = "../../test-support/events.rs"]
mod events;

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Bytes, Env,
};

use crate::{KycAttestationContract, KycAttestationContractClient, KycTier};

#[test]
fn events_kyc_attestation_flow() {
    let env = Env::default();
    env.mock_all_auths();
    // The contract uses 0 to mean "never revoked"; start at a realistic time.
    env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);
    let contract_id = env.register(KycAttestationContract, ());
    let client = KycAttestationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let kyc_hash = Bytes::from_array(&env, &[0xabu8; 32]);
    let expires_at = env.ledger().timestamp() + 365 * 24 * 60 * 60;

    let mut snap = events::EventSnapshot::new(&env, &contract_id);
    snap.name(&admin, "admin").name(&alice, "alice").name(&bob, "bob");

    client.initialize(&admin);
    snap.capture("initialize");

    client.attest(&admin, &alice, &KycTier::Basic, &kyc_hash, &0);
    snap.capture("attest(alice, Basic)");

    client.attest(&admin, &bob, &KycTier::Enhanced, &kyc_hash, &expires_at);
    snap.capture("attest(bob, Enhanced)");

    client.revoke(&admin, &alice, &KycTier::Basic);
    snap.capture("revoke(alice, Basic)");

    snap.assert_matches("kyc_attestation_flow");
}
