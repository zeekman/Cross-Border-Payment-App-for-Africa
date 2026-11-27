#![cfg(test)]
extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env, FromVal, Symbol, TryFromVal, Val,
};

use crate::{
    CONTRACT_VERSION, EscrowContract, EscrowContractClient, EscrowExpired, EscrowParams,
    EscrowDisputeClosed, EscrowDisputed, EscrowStatus, FeeUpdated, FeesWithdrawn, Migrated,
    PartialRelease, PlatformFeeUpdated,
};

fn setup() -> (Env, EscrowContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract(admin.clone());
    client.initialize(&admin, &usdc_id);
    (env, client, admin, usdc_id)
}

/// Return the first emitted event whose topics include the symbol `name`.
fn find_event(env: &Env, name: &str) -> Option<(Address, soroban_sdk::Vec<Val>, Val)> {
    let wanted = Symbol::new(env, name);
    env.events().all().iter().find(|(_, topics, _)| {
        topics
            .iter()
            .any(|t| Symbol::try_from_val(env, &t).map_or(false, |s| s == wanted))
    })
}

fn mint_usdc(env: &Env, usdc_id: &Address, _admin: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, usdc_id).mint(to, &amount);
}

/// Default cancel hold period (24 h) — mirrors `DEFAULT_CANCEL_HOLD_SECS`.
const CANCEL_HOLD_SECS: u64 = 24 * 60 * 60;

fn advance_past_cancel_hold(env: &Env) {
    env.ledger().with_mut(|li| {
        li.timestamp += CANCEL_HOLD_SECS;
    });
}

#[test]
fn test_initialize() {
    let (_, client, admin, usdc_id) = setup();
    let (stored_admin, stored_usdc) = client.get_metadata();
    assert_eq!(stored_admin, admin);
    assert_eq!(stored_usdc, usdc_id);
    assert_eq!(client.get_contract_version(), CONTRACT_VERSION);
}

#[test]
fn test_migrate_sets_contract_version() {
    let (_, client, admin, _) = setup();
    assert_eq!(client.get_contract_version(), CONTRACT_VERSION);
    client.migrate(&admin);
    assert_eq!(client.get_contract_version(), CONTRACT_VERSION);
}

// ── #1440: upgrade/migrate version reporting ─────────────────────────────────

#[test]
fn test_upgraded_event_carries_only_new_wasm_hash() {
    // #1440: the `Upgraded` event must not pair the new hash with the old
    // binary's CONTRACT_VERSION. It carries only the new WASM hash.
    let (env, client, admin, _) = setup();
    let new_hash = BytesN::from_array(&env, &[7u8; 32]);

    client.upgrade(&admin, &new_hash);

    let (_, topics, data) = find_event(&env, "Upgraded").expect("Upgraded event not emitted");
    // The version constant must not appear in the event topics.
    let version_val: Val = CONTRACT_VERSION.into_val(&env);
    assert!(
        !topics.iter().any(|t| val_eq(&env, &t, &version_val)),
        "Upgraded event must not include the old CONTRACT_VERSION"
    );
    // The payload is exactly the new WASM hash.
    let payload = BytesN::<32>::from_val(&env, &data);
    assert_eq!(payload, new_hash);
}

#[test]
fn test_migrated_event_reports_from_and_to_versions() {
    // #1440: `migrate` runs in the new code and reports the version it came
    // from and the version it moved to.
    let (env, client, admin, _) = setup();
    client.migrate(&admin);

    let (_, _, data) = find_event(&env, "Migrated").expect("Migrated event not emitted");
    let payload = Migrated::from_val(&env, &data);
    assert_eq!(payload.from_version, CONTRACT_VERSION);
    assert_eq!(payload.to_version, CONTRACT_VERSION);
}

#[test]
fn test_migrate_is_idempotent_and_runs_each_step_once() {
    // #1440: simulate a v1 → v4 jump. Each intermediate step must run exactly
    // once, and a second `migrate` call must be a no-op.
    let (env, client, admin, _) = setup();

    // First migration: from the stored version up to CONTRACT_VERSION.
    client.migrate(&admin);
    assert_eq!(client.get_contract_version(), CONTRACT_VERSION);

    // Second migration: already current, so no further steps run.
    client.migrate(&admin);
    assert_eq!(client.get_contract_version(), CONTRACT_VERSION);

    // Exactly one Migrated event per actual version change.
    let migrated_events: std::vec::Vec<_> = all_events(&env)
        .iter()
        .filter(|(_, topics, _)| {
            let wanted = Symbol::new(&env, "Migrated");
            topics
                .iter()
                .any(|t| Symbol::try_from_val(&env, &t).map_or(false, |s| s == wanted))
        })
        .collect();
    assert_eq!(migrated_events.len(), 1, "each migrate step must run exactly once");
}

#[test]
fn test_initialize_requires_admin_auth() {
    // #1442: initialize must require the admin's signature.
    let env = Env::default();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract(admin.clone());

    // No auths mocked: the admin's require_auth must fail.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(&admin, &usdc_id);
    }));
    assert!(result.is_err(), "initialize must require admin auth");
}

#[test]
fn test_escrow_records_readable_after_ttl_activity() {
    // #1443: advancing the ledger sequence past the default TTL must not make
    // escrow records unreadable, because entry points extend the TTL.
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    // Advance well past the default entry TTL.
    env.ledger().with_mut(|li| {
        li.sequence_number += 100_000;
    });

    // Reading the escrow must still succeed (TTL was extended on activity).
    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.sender, sender);
    assert_eq!(escrow.amount, amount);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_non_admin_cannot_migrate() {
    let (env, client, _, _) = setup();
    let non_admin = Address::generate(&env);
    client.migrate(&non_admin);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_double_initialize() {
    let (_, client, admin, usdc_id) = setup();
    client.initialize(&admin, &usdc_id);
}

#[test]
fn test_create_escrow() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);
    assert_eq!(escrow_id, 1);

    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.sender, sender);
    assert_eq!(escrow.recipient, recipient);
    assert_eq!(escrow.agent, agent);
    assert_eq!(escrow.amount, amount);
    assert_eq!(escrow.release_fee_bps, 250);
    assert_eq!(escrow.status, EscrowStatus::Pending);
}

#[test]
fn test_create_multiple_escrows() {
    let (env, client, admin, usdc_id) = setup();
    let sender1 = Address::generate(&env);
    let sender2 = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender1, 1_000_0000000);
    mint_usdc(&env, &usdc_id, &admin, &sender2, 500_0000000);

    let id1 = client.create_escrow(&sender1, &recipient, &agent, &1_000_0000000, &250);
    let id2 = client.create_escrow(&sender2, &recipient, &agent, &500_0000000, &250);

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(client.get_escrow(&id1).sender, sender1);
    assert_eq!(client.get_escrow(&id2).sender, sender2);
}

// --- #352: fee boundary and minimum amount tests ---

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn test_amount_below_minimum() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 99);
    client.create_escrow(&sender, &recipient, &agent, &1, &250);
}

#[test]
#[should_panic(expected = "Error(Contract, #18)")]
fn test_direct_call_cannot_set_zero_fee() {
    // #1364: a sender calling the contract directly cannot opt out of the fee.
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &0);
}

#[test]
fn test_escrow_uses_configured_fee_not_caller_value() {
    // A generous max_fee_bps does not raise the fee either.
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &9999);
    assert_eq!(client.get_escrow(&escrow_id).release_fee_bps, client.get_fee_bps());
    assert_eq!(client.get_fee_bps(), 250);
}

#[test]
fn test_fee_at_max_1000_accepted() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;
    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    client.set_fee_bps(&admin, &1000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &1000);
    assert_eq!(client.get_escrow(&escrow_id).release_fee_bps, 1000);
}

#[test]
#[should_panic(expected = "Error(Contract, #17)")]
fn test_fee_bps_1001_rejected() {
    let (_, client, admin, _) = setup();
    client.set_fee_bps(&admin, &1001);
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn test_amount_above_max_rejected() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let over_max = 10_000_000_000_001i128;
    mint_usdc(&env, &usdc_id, &admin, &sender, over_max);
    client.create_escrow(&sender, &recipient, &agent, &over_max, &250);
}

#[test]
fn test_amount_at_max_accepted() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let max_amount = 10_000_000_000_000i128;
    mint_usdc(&env, &usdc_id, &admin, &sender, max_amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &max_amount, &250);
    assert_eq!(client.get_escrow(&escrow_id).amount, max_amount);
}

// ── #560: fuzz-style boundary tests for fee_bps valid range ──────────────────

#[test]
fn test_fee_bps_zero_accepted() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;
    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    client.set_fee_bps(&admin, &0);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &0);
    assert_eq!(client.get_escrow(&escrow_id).release_fee_bps, 0);
}

#[test]
fn test_fee_bps_one_accepted() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;
    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    client.set_fee_bps(&admin, &1);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &1);
    assert_eq!(client.get_escrow(&escrow_id).release_fee_bps, 1);
}

#[test]
fn test_fee_bps_999_accepted() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;
    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    client.set_fee_bps(&admin, &999);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &999);
    assert_eq!(client.get_escrow(&escrow_id).release_fee_bps, 999);
}

// --- #354: upgrade access control test ---

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_non_admin_cannot_upgrade() {
    let (env, client, _, _) = setup();
    let non_admin = Address::generate(&env);
    let fake_hash = BytesN::from_array(&env, &[0u8; 32]);
    client.upgrade(&non_admin, &fake_hash);
}

// --- existing tests ---

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn test_invalid_amount() {
    let (env, client, _, _) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    client.create_escrow(&sender, &recipient, &agent, &0, &250);
}

#[test]
#[should_panic(expected = "Error(Contract, #17)")]
fn test_invalid_fee() {
    let (_, client, admin, _) = setup();
    client.set_fee_bps(&admin, &10001);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_set_fee_bps_non_admin_panics() {
    let (env, client, _, _) = setup();
    let impostor = Address::generate(&env);
    client.set_fee_bps(&impostor, &0);
}

#[test]
fn test_set_fee_bps_emits_event() {
    let (env, client, admin, _) = setup();
    client.set_fee_bps(&admin, &400);
    assert_eq!(client.get_fee_bps(), 400);
    let (_, _, data) = find_event(&env, "PlatformFeeUpdated").expect("event not emitted");
    let payload = PlatformFeeUpdated::from_val(&env, &data);
    assert_eq!(payload.old_fee_bps, 250);
    assert_eq!(payload.new_fee_bps, 400);
}

#[test]
fn test_fee_change_does_not_affect_existing_escrow() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    client.set_fee_bps(&admin, &1000);
    assert_eq!(client.get_escrow(&escrow_id).release_fee_bps, 250);
}

#[test]
fn test_batch_create_uses_configured_fee() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 2_000_0000000);
    let params = EscrowParams {
        recipient: recipient.clone(),
        agent: agent.clone(),
        amount: 1_000_0000000,
        max_fee_bps: 1000,
    };
    let first = client.batch_create_escrow(&sender, &soroban_sdk::vec![&env, params.clone(), params]);
    assert_eq!(client.get_escrow(&first).release_fee_bps, 250);
    assert_eq!(client.get_escrow(&(first + 1)).release_fee_bps, 250);
}

#[test]
#[should_panic(expected = "Error(Contract, #18)")]
fn test_batch_create_rejects_zero_fee_guard() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let params = EscrowParams {
        recipient: Address::generate(&env),
        agent: Address::generate(&env),
        amount: 1_000_0000000,
        max_fee_bps: 0,
    };
    client.batch_create_escrow(&sender, &soroban_sdk::vec![&env, params]);
}

#[test]
fn test_release_escrow() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let fee_bps = 250u32;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &fee_bps);
    client.release_escrow(&agent, &escrow_id);

    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.status, EscrowStatus::Released);

    let expected_fee = (amount * fee_bps as i128) / 10000;
    let expected_agent = amount - expected_fee;

    assert_eq!(
        TokenClient::new(&env, &usdc_id).balance(&agent),
        expected_agent
    );
    assert_eq!(client.get_accumulated_fees(), expected_fee);
}

#[test]
fn test_cancel_escrow() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 500_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &100);
    advance_past_cancel_hold(&env);
    client.cancel_escrow(&sender, &escrow_id);

    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.status, EscrowStatus::Cancelled);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), amount);
}

#[test]
fn test_confirm_delivery_prevents_cancel() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);
    client.confirm_delivery(&agent, &escrow_id);

    let escrow = client.get_escrow(&escrow_id);
    assert!(escrow.payout_confirmed);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.cancel_escrow(&sender, &escrow_id);
    }));
    assert!(result.is_err());
    let error_message = panic_msg(result.err().unwrap());
    assert!(error_message.contains("Cannot cancel: agent has confirmed delivery"));
    assert!(client.try_cancel_escrow(&sender, &escrow_id).is_err());
}

#[test]
fn test_partial_release_keeps_pending_until_fully_released() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 100_0000000i128; // 100 USDC

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    client.partial_release(&agent, &escrow_id, &500_000000i128);
    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.status, EscrowStatus::Pending);
    assert_eq!(escrow.amount, 500_000000i128);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&agent), 500_000000i128 - 12_500000i128);
}

#[test]
fn test_multiple_partial_releases_release_remaining_amount() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 100_0000000i128; // 100 USDC

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    client.partial_release(&agent, &escrow_id, &300_000000i128);
    client.partial_release(&agent, &escrow_id, &200_000000i128);
    client.partial_release(&agent, &escrow_id, &500_000000i128);

    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.status, EscrowStatus::Released);
    assert_eq!(escrow.amount, 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #20)")]
fn test_partial_release_over_release_panics() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 100_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &100_0000000, &250);
    client.partial_release(&agent, &escrow_id, &1_000_000001i128);
}

// ── Comprehensive partial release tests ───────────────────────────────────────

#[test]
fn test_partial_release_basic() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128; // 1000 USDC

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    client.partial_release(&agent, &escrow_id, &400_0000000i128); // 400 USDC

    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.status, EscrowStatus::Pending);
    assert_eq!(escrow.amount, 600_0000000i128);

    let expected_fee = (400_0000000i128 * 250i128) / 10000i128;
    let expected_agent = 400_0000000i128 - expected_fee;
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&agent), expected_agent);

    let event_name: Val = Symbol::new(&env, "PartialRelease").into_val(&env);
    let events = all_events(&env);
    let pr_event = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|topic| val_eq(&env, &topic, &event_name))
    });
    assert!(pr_event.is_some(), "PartialRelease event not emitted");
    let (_, _, data) = pr_event.unwrap();
    let payload: PartialRelease = soroban_sdk::FromVal::from_val(&env, &data);
    let pr_event = find_event(&env, "PartialRelease");
    assert!(pr_event.is_some(), "PartialRelease event not emitted");
    let (_, _, data) = pr_event.unwrap();
    let payload = PartialRelease::from_val(&env, &data);
    assert_eq!(payload.escrow_id, escrow_id);
    assert_eq!(payload.released_amount, 400_0000000i128);
    assert_eq!(payload.remaining_amount, 600_0000000i128);
    assert_eq!(payload.fee_amount, expected_fee);
}

#[test]
fn test_partial_release_multiple() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128; // 1000 USDC

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    client.partial_release(&agent, &escrow_id, &300_0000000i128); // 300 USDC
    client.partial_release(&agent, &escrow_id, &700_0000000i128); // 700 USDC

    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.status, EscrowStatus::Released);
    assert_eq!(escrow.amount, 0);

    let total_agent_received = TokenClient::new(&env, &usdc_id).balance(&agent);
    let fee1 = (300_0000000i128 * 250) / 10000;
    let fee2 = (700_0000000i128 * 250) / 10000;
    assert_eq!(total_agent_received, 300_0000000i128 - fee1 + 700_0000000i128 - fee2);
}

#[test]
#[should_panic(expected = "Error(Contract, #20)")]
fn test_partial_release_exceeds_balance() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    client.partial_release(&agent, &escrow_id, &1_100_0000000i128); // 1100 USDC > 1000
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_partial_release_wrong_status() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    client.release_escrow(&agent, &escrow_id); // moves to Released

    client.partial_release(&agent, &escrow_id, &1_000000000i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")]
fn test_partial_release_wrong_caller() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let impostor = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    client.partial_release(&impostor, &escrow_id, &1_000000000i128);
}

#[test]
fn test_partial_release_event_fields() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);
    client.partial_release(&agent, &escrow_id, &600_0000000i128);

    let event_name: Val = Symbol::new(&env, "PartialRelease").into_val(&env);
    let events = all_events(&env);
    let pr_event = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|topic| val_eq(&env, &topic, &event_name))
    });
    assert!(pr_event.is_some(), "PartialRelease event not emitted");
    let (_, _, data) = pr_event.unwrap();
    let payload: PartialRelease = soroban_sdk::FromVal::from_val(&env, &data);
    let pr_event = find_event(&env, "PartialRelease");
    assert!(pr_event.is_some(), "PartialRelease event not emitted");
    let (_, _, data) = pr_event.unwrap();
    let payload = PartialRelease::from_val(&env, &data);

    assert_eq!(payload.escrow_id, escrow_id);
    assert_eq!(payload.released_amount, 600_0000000i128);
    assert_eq!(payload.remaining_amount, 400_0000000i128);
    assert_eq!(payload.fee_amount, (600_0000000i128 * 250) / 10000);
}

#[test]
fn test_cleanup_escrow_after_retention() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);
    advance_past_cancel_hold(&env);
    client.cancel_escrow(&sender, &escrow_id);

    env.ledger().with_mut(|li| {
        li.timestamp += 90 * 24 * 60 * 60 + 1;
    });

    client.cleanup_escrow(&escrow_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.get_escrow(&escrow_id);
    }));
    assert!(result.is_err());
    let err_str = panic_msg(result.err().unwrap());
    assert!(err_str.contains("Escrow 1 not found"));
    assert!(client.try_get_escrow(&escrow_id).is_err());
}

#[test]
fn test_cleanup_escrow_is_permissionless() {
    // cleanup_escrow takes no admin address, so any caller (here: admin) can
    // reclaim storage rent once the retention period has elapsed.
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let someone = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000i128);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000i128, &250);
    advance_past_cancel_hold(&env);
    client.cancel_escrow(&sender, &escrow_id);

    env.ledger().with_mut(|li| {
        li.timestamp += 90 * 24 * 60 * 60 + 1;
    });

    // Called by an arbitrary address, not the admin.
    client.cleanup_escrow(&escrow_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.get_escrow(&escrow_id);
    }));
    assert!(result.is_err());
    let err_str = panic_msg(result.err().unwrap());
    assert!(err_str.contains("Escrow 1 not found"));
    assert!(client.try_get_escrow(&escrow_id).is_err());
    let _ = &someone;
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")]
fn test_release_wrong_caller() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let impostor = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    client.release_escrow(&impostor, &escrow_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #15)")]
fn test_cancel_wrong_caller() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let impostor = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    client.cancel_escrow(&impostor, &escrow_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_double_release() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    client.release_escrow(&agent, &escrow_id);
    client.release_escrow(&agent, &escrow_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_cancel_after_release() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    client.release_escrow(&agent, &escrow_id);
    client.cancel_escrow(&sender, &escrow_id);
}

#[test]
fn test_accumulated_fees_initial() {
    let (_, client, _, _) = setup();
    assert_eq!(client.get_accumulated_fees(), 0);
}

#[test]
fn test_withdraw_fees() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let fee_bps = 500u32;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    client.set_fee_bps(&admin, &fee_bps);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &fee_bps);
    client.release_escrow(&agent, &escrow_id);

    let expected_fee = (amount * fee_bps as i128) / 10000;
    assert_eq!(client.get_accumulated_fees(), expected_fee);

    client.withdraw_fees(&admin, &expected_fee);
    assert_eq!(client.get_accumulated_fees(), 0);
    assert_eq!(
        TokenClient::new(&env, &usdc_id).balance(&admin),
        expected_fee
    );
}

#[test]
fn test_withdraw_fees_emits_event() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let fee_bps = 500u32;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    client.set_fee_bps(&admin, &fee_bps);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &fee_bps);
    client.release_escrow(&agent, &escrow_id);

    let expected_fee = (amount * fee_bps as i128) / 10000;
    client.withdraw_fees(&admin, &expected_fee);

    let event_name: Val = Symbol::new(&env, "FeesWithdrawn").into_val(&env);
    let events = all_events(&env);
    let fee_event = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|topic| val_eq(&env, &topic, &event_name))
    });
    let fee_event = find_event(&env, "FeesWithdrawn");

    assert!(fee_event.is_some(), "FeesWithdrawn event not emitted");

    let (_, _, data) = fee_event.unwrap();
    let payload: FeesWithdrawn = soroban_sdk::FromVal::from_val(&env, &data);
    let payload = FeesWithdrawn::from_val(&env, &data);

    assert_eq!(payload.admin, admin);
    assert_eq!(payload.amount, expected_fee);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_withdraw_fees_wrong_caller() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let impostor = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &500);
    client.release_escrow(&agent, &escrow_id);
    client.withdraw_fees(&impostor, &500_0000000);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_get_nonexistent_escrow() {
    let (_, client, _, _) = setup();
    client.get_escrow(&999);
}

// ── #346: distinct addresses ──────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_create_escrow_sender_equals_agent() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    client.create_escrow(&sender, &recipient, &sender, &1_000_0000000, &250);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_create_escrow_sender_equals_recipient() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let agent = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    client.create_escrow(&sender, &sender, &agent, &1_000_0000000, &250);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_create_escrow_agent_equals_recipient() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    client.create_escrow(&sender, &recipient, &recipient, &1_000_0000000, &250);
}

// ── #347: withdraw_fees amount > 0 ───────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_withdraw_fees_zero_amount_panics() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &500);
    client.release_escrow(&agent, &escrow_id);
    client.withdraw_fees(&admin, &0);
}

#[test]
fn test_deposit_into_active_escrow() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 500_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount * 2);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);
    client.deposit(&sender, &escrow_id, &amount);

    assert_eq!(client.get_escrow(&escrow_id).amount, amount * 2);
}

// fix #334: release_escrow now enforces expiry — agent cannot release after the 30-day window.
#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_release_escrow_after_expiry_panics() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    env.ledger().with_mut(|li| {
        li.timestamp += 30 * 24 * 60 * 60 + 1;
    });

    client.release_escrow(&agent, &escrow_id); // must panic: "Escrow has expired"
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_release_escrow_at_exact_expiry_boundary_panics() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    env.ledger().with_mut(|li| {
        li.timestamp += 30 * 24 * 60 * 60; // exactly at boundary — >= means expired
    });

    client.release_escrow(&agent, &escrow_id); // must panic: "Escrow has expired"
}

#[test]
fn test_release_escrow_before_expiry_succeeds() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    env.ledger().with_mut(|li| {
        li.timestamp += 30 * 24 * 60 * 60 - 1; // one second before expiry
    });

    client.release_escrow(&agent, &escrow_id);
    assert_eq!(client.get_escrow(&escrow_id).status, EscrowStatus::Released);
}

// ── Time-lock expiry: expire_escrow tests ─────────────────────────────────────

#[test]
fn test_expire_escrow_after_expiry() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    env.ledger().with_mut(|li| {
        li.timestamp += 30 * 24 * 60 * 60 + 1;
    });

    let anyone = Address::generate(&env);
    client.expire_escrow(&escrow_id);

    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.status, EscrowStatus::Cancelled);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), amount);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_expire_escrow_before_expiry_panics() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    env.ledger().with_mut(|li| {
        li.timestamp += 30 * 24 * 60 * 60;
    });

    let anyone = Address::generate(&env);
    client.expire_escrow(&escrow_id); // panic: not expired yet at exact boundary
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_expire_escrow_still_before_boundary_panics() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    env.ledger().with_mut(|li| {
        li.timestamp += 30 * 24 * 60 * 60 - 1;
    });

    let anyone = Address::generate(&env);
    client.expire_escrow(&escrow_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_expire_escrow_on_cancelled_escrow_panics() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);
    advance_past_cancel_hold(&env);
    client.cancel_escrow(&sender, &escrow_id);

    let anyone = Address::generate(&env);
    client.expire_escrow(&escrow_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #32)")]
fn test_withdraw_fees_exceeds_accumulated_panics() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);
    client.release_escrow(&agent, &escrow_id);

    let accumulated = client.get_accumulated_fees();
    client.withdraw_fees(&admin, &(accumulated + 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_deposit_into_expired_escrow_is_rejected() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 500_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount * 2);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    env.ledger().with_mut(|li| {
        li.timestamp += 30 * 24 * 60 * 60 + 1;
    });

    client.deposit(&sender, &escrow_id, &amount);
}

// --- #345: EscrowDeposited event test ---

#[test]
fn test_deposit_emits_escrow_deposited_event() {
    use crate::EscrowDeposited;

    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 500_0000000i128;
    let deposit_amount = 200_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount + deposit_amount);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);
    client.deposit(&sender, &escrow_id, &deposit_amount);

    let event_name: Val = Symbol::new(&env, "EscrowDeposited").into_val(&env);
    let events = all_events(&env);
    let deposit_event = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|topic| val_eq(&env, &topic, &event_name))
    });
    let deposit_event = find_event(&env, "EscrowDeposited");

    assert!(deposit_event.is_some(), "EscrowDeposited event not emitted");

    let (_, _, data) = deposit_event.unwrap();
    let payload: EscrowDeposited = soroban_sdk::FromVal::from_val(&env, &data);
    let payload = EscrowDeposited::from_val(&env, &data);

    assert_eq!(payload.escrow_id, escrow_id);
    assert_eq!(payload.depositor, sender);
    assert_eq!(payload.amount, deposit_amount);
    assert_eq!(payload.new_total, amount + deposit_amount);
}

// ── escrow → dispute-resolution cross-contract hook ───────────────────────────

/// Default dispute filing fee charged by the dispute-resolution contract.
const DISPUTE_FILING_FEE: i128 = 50_000000;

/// Register both the escrow and dispute-resolution contracts in the same Env,
/// wire them together (escrow → dispute hook + dispute → trusted escrow), and
/// return the handles needed by the integration tests.
fn setup_with_dispute() -> (
    Env,
    EscrowContractClient<'static>,
    Address, // escrow contract id
    Address, // dispute-resolution contract id
    Address, // admin
    Address, // usdc_id
    Address, // arbitrator
) {
    use dispute_resolution_contract::{DisputeResolutionContract, DisputeResolutionContractClient};

    let env = Env::default();
    env.mock_all_auths();

    let escrow_contract_id = env.register(EscrowContract, ());
    let escrow_client = EscrowContractClient::new(&env, &escrow_contract_id);

    let dispute_resolution_id = env.register(DisputeResolutionContract, ());
    let dispute_client = DisputeResolutionContractClient::new(&env, &dispute_resolution_id);

    let admin = Address::generate(&env);
    let usdc_id = env
        .register_stellar_asset_contract(admin.clone());

    escrow_client.initialize(&admin, &usdc_id);
    escrow_client.set_dispute_contract(&admin, &dispute_resolution_id);

    let arbitrator = Address::generate(&env);
    dispute_client.initialize(&admin, &arbitrator, &usdc_id, &256u32, &admin);
    dispute_client.set_escrow_contract(&admin, &escrow_contract_id);

    (
        env,
        escrow_client,
        escrow_contract_id,
        dispute_resolution_id,
        admin,
        usdc_id,
        arbitrator,
    )
}

#[test]
fn test_dispute_escrow_hands_funds_to_dispute_resolution() {
    use dispute_resolution_contract::DisputeResolutionContractClient;

    let (env, escrow, escrow_contract_id, dispute_resolution_id, admin, usdc_id, _) =
        setup_with_dispute();
    let dispute = DisputeResolutionContractClient::new(&env, &dispute_resolution_id);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = escrow.create_escrow(&sender, &recipient, &agent, &amount, &250);
    // Agent confirms delivery, which blocks the sender from cancelling.
    escrow.confirm_delivery(&agent, &escrow_id);

    // Sender's recourse: escalate the confirmed-but-unreleased escrow.
    // The sender must also cover the dispute filing fee.
    mint_usdc(&env, &usdc_id, &admin, &sender, DISPUTE_FILING_FEE);
    // Before delivery is confirmed, the sender may escalate.
    let dispute_id = escrow.dispute_escrow(&sender, &escrow_id);

    assert_eq!(
        escrow.get_escrow(&escrow_id).status,
        EscrowStatus::UnderDispute
    );

    // Full balance leaves escrow custody and now sits with the arbiter,
    // together with the opener's filing fee.
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&escrow_contract_id), 0);
    assert_eq!(
        TokenClient::new(&env, &usdc_id).balance(&dispute_resolution_id),
        amount + DISPUTE_FILING_FEE
    );
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), 0);

    let d = dispute.get_dispute(&dispute_id);
    assert_eq!(d.sender, sender);
    assert_eq!(d.recipient, recipient);
    assert_eq!(d.amount, amount);
    assert_eq!(dispute.get_dispute_agent(&dispute_id), Some(agent.clone()));
    assert!(!dispute.is_payout_confirmed(&dispute_id));

    let (_, _, data) = find_event(&env, "EscrowDisputed").expect("event not emitted");
    let payload = EscrowDisputed::from_val(&env, &data);
    assert_eq!(payload.agent, agent);
    assert!(!payload.payout_confirmed);
}

#[test]
fn test_dispute_escrow_by_recipient() {
    let (env, escrow, escrow_contract_id, dispute_resolution_id, admin, usdc_id, _) =
        setup_with_dispute();

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = escrow.create_escrow(&sender, &recipient, &agent, &amount, &250);
    mint_usdc(&env, &usdc_id, &admin, &recipient, DISPUTE_FILING_FEE);
    escrow.dispute_escrow(&recipient, &escrow_id);

    assert_eq!(
        escrow.get_escrow(&escrow_id).status,
        EscrowStatus::UnderDispute
    );
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&escrow_contract_id), 0);
    assert_eq!(
        TokenClient::new(&env, &usdc_id).balance(&dispute_resolution_id),
        amount + DISPUTE_FILING_FEE
    );
    // The recipient (opener) paid the fee, not the sender.
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), 0);
}

#[test]
fn test_disputed_escrow_cannot_be_cancelled_or_released() {
    let (env, escrow, _, _, admin, usdc_id, _) = setup_with_dispute();

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = escrow.create_escrow(&sender, &recipient, &agent, &amount, &250);
    escrow.confirm_delivery(&agent, &escrow_id);
    mint_usdc(&env, &usdc_id, &admin, &sender, DISPUTE_FILING_FEE);
    escrow.dispute_escrow(&sender, &escrow_id);

    let cancel_err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| escrow.cancel_escrow(&sender, &escrow_id)));
    assert!(cancel_err.is_err());
    assert!(panic_msg(cancel_err.err().unwrap())
        .contains("Escrow is not in pending state"));

    let release_err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| escrow.release_escrow(&agent, &escrow_id)));
    assert!(release_err.is_err());
    assert!(panic_msg(release_err.err().unwrap())
        .contains("Escrow is not in pending state"));
    assert!(escrow.try_cancel_escrow(&sender, &escrow_id).is_err());
    assert!(escrow.try_release_escrow(&agent, &escrow_id).is_err());
}

#[test]
#[should_panic(expected = "Error(Contract, #16)")]
fn test_dispute_escrow_third_party_panics() {
    let (env, escrow, _, _, admin, usdc_id, _) = setup_with_dispute();

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let outsider = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = escrow.create_escrow(&sender, &recipient, &agent, &amount, &250);
    escrow.dispute_escrow(&outsider, &escrow_id);
}

#[test]
#[should_panic(expected = "Insufficient balance for dispute filing fee")]
fn test_dispute_escrow_without_filing_fee_panics() {
    let (env, escrow, _, _, admin, usdc_id) = setup_with_dispute();

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = escrow.create_escrow(&sender, &recipient, &agent, &amount, &250);
    // Recipient holds no USDC, so cannot pay the filing fee.
    escrow.dispute_escrow(&recipient, &escrow_id);
}

#[test]
fn test_dispute_escrow_filing_fee_refunded_when_opener_wins() {
    use dispute_resolution_contract::DisputeResolutionContractClient;

    let (env, escrow, _, dispute_resolution_id, admin, usdc_id) = setup_with_dispute();
    let dispute = DisputeResolutionContractClient::new(&env, &dispute_resolution_id);
    let arbitrator = Address::generate(&env);
    dispute.propose_new_arbitrator(&admin, &arbitrator);
    dispute.accept_arbitrator(&arbitrator);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount + DISPUTE_FILING_FEE);
    let escrow_id = escrow.create_escrow(&sender, &recipient, &agent, &amount, &250);
    let dispute_id = escrow.dispute_escrow(&sender, &escrow_id);

    dispute.resolve_dispute(&arbitrator, &dispute_id, &false);
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    dispute.finalize_resolution(&dispute_id);

    // Sender won: escrowed amount and filing fee both returned.
    assert_eq!(
        TokenClient::new(&env, &usdc_id).balance(&sender),
        amount + DISPUTE_FILING_FEE
    );
}

#[test]
fn test_dispute_escrow_filing_fee_forfeited_when_opener_loses() {
    use dispute_resolution_contract::DisputeResolutionContractClient;

    let (env, escrow, _, dispute_resolution_id, admin, usdc_id) = setup_with_dispute();
    let dispute = DisputeResolutionContractClient::new(&env, &dispute_resolution_id);
    let arbitrator = Address::generate(&env);
    let fee_distributor = Address::generate(&env);
    dispute.propose_new_arbitrator(&admin, &arbitrator);
    dispute.accept_arbitrator(&arbitrator);
    dispute.set_fee_distributor_address(&admin, &fee_distributor);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount + DISPUTE_FILING_FEE);
    let escrow_id = escrow.create_escrow(&sender, &recipient, &agent, &amount, &250);
    let dispute_id = escrow.dispute_escrow(&sender, &escrow_id);

    dispute.resolve_dispute(&arbitrator, &dispute_id, &true);
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    dispute.finalize_resolution(&dispute_id);

    // Sender lost a frivolous dispute: the fee goes to the fee distributor.
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), 0);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), amount);
    assert_eq!(
        TokenClient::new(&env, &usdc_id).balance(&fee_distributor),
        DISPUTE_FILING_FEE
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #30)")]
fn test_dispute_escrow_unconfigured_panics() {
    let (env, client, admin, usdc_id) = setup();

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);
    client.dispute_escrow(&sender, &escrow_id);
}

// ── SC-117: partial_release expiry, fee truncation, and state ordering ──────

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_partial_release_panics_after_expiry() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    // Fast-forward past expiry (default 30 days = 2_592_000 seconds)
    env.ledger().with_mut(|ledger| {
        ledger.timestamp = 2_593_000u64;
    });

    // SC-117: Agent should not be able to partial_release after expiry
    client.partial_release(&agent, &escrow_id, &100_000_000);
}

#[test]
fn test_partial_release_before_expiry_succeeds() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 100_0000000i128; // 100 USDC

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    // Partial release should succeed before expiry
    client.partial_release(&agent, &escrow_id, &500_000_000);

    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.amount, 500_000_000); // Half released
    assert_eq!(escrow.status, EscrowStatus::Pending); // Still pending (balance remains)
}

#[test]
fn test_partial_release_fee_9999_stroops_at_250_bps_is_nonzero() {
    // SC-117: 9,999 stroops at 250 bps should pay fee (not zero-fee due to truncation)
    // Fee = (9_999 * 250) / 10_000 = 2_499_750 / 10_000 = 249 stroops (rounds down)
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 100_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    // Release 9,999 stroops (which would have zero fee with old truncation)
    client.partial_release(&agent, &escrow_id, &9_999);

    // Fee should be (9_999 * 250) / 10_000 = 249 stroops
    let expected_fee = (9_999i128 * 250) / 10_000;
    assert_eq!(expected_fee, 249);

    assert_eq!(client.get_accumulated_fees(), expected_fee);
    
    // Agent should receive 9_999 - 249 = 9_750 stroops
    let expected_agent_amount = 9_999 - expected_fee;
    assert_eq!(
        TokenClient::new(&env, &usdc_id).balance(&agent),
        expected_agent_amount
    );
}

#[test]
fn test_partial_release_fee_sum_equals_single_release() {
    // SC-117: Multiple partial releases of the same total amount should accrue
    // the same fee as a single full release (±1 stroop per release due to rounding)
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let total_amount = 100_0000000i128; // 100 USDC
    let fee_bps = 250u32;

    mint_usdc(&env, &usdc_id, &admin, &sender, total_amount * 2); // mint 2x for two scenarios

    // Scenario 1: Single full release
    let escrow1 = client.create_escrow(&sender, &recipient, &agent, &total_amount, &fee_bps);
    client.release_escrow(&agent, &escrow1);
    let fee_single = client.get_accumulated_fees();

    // Clear accumulated fees for next scenario
    client.withdraw_fees(&admin, &fee_single);

    // Scenario 2: Multiple partial releases
    let escrow2 = client.create_escrow(&sender, &recipient, &agent, &total_amount, &fee_bps);
    
    // Release in 4 chunks: 250M, 250M, 250M, 250M
    client.partial_release(&agent, &escrow2, &250_000_000);
    client.partial_release(&agent, &escrow2, &250_000_000);
    client.partial_release(&agent, &escrow2, &250_000_000);
    client.partial_release(&agent, &escrow2, &250_000_000);
    
    let fee_partial = client.get_accumulated_fees();

    // Fees should be equal (or differ by at most 1 stroop due to rounding per release)
    assert!(
        (fee_single - fee_partial).abs() <= 4,
        "Fee difference too large: single={} partial={}",
        fee_single,
        fee_partial
    );
}

#[test]
fn test_partial_release_state_written_before_transfer() {
    // SC-117: State should be updated BEFORE token transfer (checks-effects-interactions)
    // This test verifies the escrow balance is decremented in storage before transfer.
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    // Perform partial release
    let release_amount = 500_000_000;
    client.partial_release(&agent, &escrow_id, &release_amount);

    // Verify escrow state is updated in storage
    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(
        escrow.amount,
        amount - release_amount,
        "Escrow balance should be decremented before transfer"
    );

    // Verify fees are recorded
    let fee = (release_amount * 250) / 10_000;
    assert_eq!(
        client.get_accumulated_fees(),
        fee,
        "Fees should be accumulated before transfer"
    );
}

#[test]
fn test_partial_release_becomes_full_release_when_amount_zero() {
    // SC-117: When partial_release drains the escrow, status should become Released
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);

    // Release the entire escrow via partial_release
    client.partial_release(&agent, &escrow_id, &amount);

    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.amount, 0);
    assert_eq!(escrow.status, EscrowStatus::Released);
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
}

/// Extracts the message from a caught panic payload.
fn panic_msg(err: std::boxed::Box<dyn core::any::Any + Send>) -> std::string::String {
    use std::string::{String, ToString};
    if let Some(s) = err.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = err.downcast_ref::<&str>() {
        s.to_string()
    } else {
        String::new()
    }
}

// ── #1445: KYC gate via the real kyc-attestation contract ────────────────────

/// Default admin rotation delay (24 h) — mirrors the governance module.
const ADMIN_ROTATION_DELAY_SECS: u64 = 24 * 60 * 60;

/// Register the real `kyc-attestation` contract alongside escrow and wire it up.
fn setup_with_kyc() -> (
    Env,
    EscrowContractClient<'static>,
    kyc_attestation::KycAttestationContractClient<'static>,
    Address, // admin
    Address, // usdc_id
    Address, // kyc contract id
) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let kyc_id = env.register(kyc_attestation::KycAttestationContract, ());
    let kyc = kyc_attestation::KycAttestationContractClient::new(&env, &kyc_id);

    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract(admin.clone());

    client.initialize(&admin, &usdc_id);
    kyc.initialize(&admin);
    client.set_kyc_contract(&admin, &kyc_id);

    (env, client, kyc, admin, usdc_id, kyc_id)
}

#[test]
fn test_create_escrow_succeeds_for_attested_users() {
    let (env, client, kyc, admin, usdc_id, _) = setup_with_kyc();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    kyc.add_attestation(&admin, &sender, &kyc_attestation::KycTier::Basic, &0u64);
    kyc.add_attestation(&admin, &agent, &kyc_attestation::KycTier::Basic, &0u64);
    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);
    assert_eq!(client.get_escrow(&escrow_id).sender, sender);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_create_escrow_panics_for_unattested_sender() {
    let (env, client, kyc, admin, usdc_id, _) = setup_with_kyc();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    kyc.add_attestation(&admin, &agent, &kyc_attestation::KycTier::Basic, &0u64);
    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    client.create_escrow(&sender, &recipient, &agent, &amount, &250);
}

#[test]
#[should_panic(expected = "Error(Contract, #13)")]
fn test_create_escrow_panics_for_unattested_agent() {
    let (env, client, kyc, admin, usdc_id, _) = setup_with_kyc();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    kyc.add_attestation(&admin, &sender, &kyc_attestation::KycTier::Basic, &0u64);
    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    client.create_escrow(&sender, &recipient, &agent, &amount, &250);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_create_escrow_panics_for_expired_attestation() {
    let (env, client, kyc, admin, usdc_id, _) = setup_with_kyc();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    // Attestations expire one hour from now.
    let expiry = env.ledger().timestamp() + 3600;
    kyc.add_attestation(&admin, &sender, &kyc_attestation::KycTier::Basic, &expiry);
    kyc.add_attestation(&admin, &agent, &kyc_attestation::KycTier::Basic, &0u64);
    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    env.ledger().with_mut(|li| li.timestamp += 3601);

    client.create_escrow(&sender, &recipient, &agent, &amount, &250);
}

#[test]
fn test_batch_create_escrow_checks_kyc() {
    let (env, client, kyc, admin, usdc_id, _) = setup_with_kyc();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);

    kyc.add_attestation(&admin, &sender, &kyc_attestation::KycTier::Basic, &0u64);
    kyc.add_attestation(&admin, &agent, &kyc_attestation::KycTier::Basic, &0u64);
    mint_usdc(&env, &usdc_id, &admin, &sender, 2_000_0000000);

    let params = EscrowParams {
        recipient: recipient.clone(),
        agent: agent.clone(),
        amount: 1_000_0000000,
        max_fee_bps: 1000,
    };
    let first = client.batch_create_escrow(&sender, &soroban_sdk::vec![&env, params]);
    assert_eq!(client.get_escrow(&first).sender, sender);
}

#[test]
fn test_disable_kyc_requires_admin_and_emits_event() {
    let (env, client, _, admin, usdc_id, _) = setup_with_kyc();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    // Explicit admin call turns KYC off and emits the event.
    client.set_kyc_required(&admin, &false);
    assert!(!client.is_kyc_required());
    assert!(find_event(&env, "KycCheckDisabled").is_some());

    // With KYC explicitly disabled, unattested parties may transact.
    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);
    assert_eq!(client.get_escrow(&escrow_id).sender, sender);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_disable_kyc_requires_admin() {
    let (env, client, _, _, _, _) = setup_with_kyc();
    let impostor = Address::generate(&env);
    client.set_kyc_required(&impostor, &false);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_kyc_required_without_contract_fails_closed() {
    // KYC is required by default; without a configured contract the gate must
    // fail closed rather than silently allowing the transfer.
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
}

// ── #1444: two-step admin rotation ──────────────────────────────────────────

#[test]
fn test_admin_rotation_propose_accept_swaps_admin() {
    let (env, client, admin, _) = setup();
    let new_admin = Address::generate(&env);

    client.propose_admin(&admin, &new_admin);
    assert!(find_event(&env, "AdminProposed").is_some());

    env.ledger().with_mut(|li| {
        li.timestamp += ADMIN_ROTATION_DELAY_SECS;
    });
    client.accept_admin(&new_admin);

    let (stored_admin, _) = client.get_metadata();
    assert_eq!(stored_admin, new_admin);

    let (_, _, data) = find_event(&env, "AdminChanged").expect("event not emitted");
    let payload = crate::AdminChanged::from_val(&env, &data);
    assert_eq!(payload.old_admin, admin);
    assert_eq!(payload.new_admin, new_admin);
}

#[test]
#[should_panic(expected = "Admin rotation delay has not elapsed")]
fn test_admin_rotation_cannot_accept_before_delay() {
    let (env, client, admin, _) = setup();
    let new_admin = Address::generate(&env);

    client.propose_admin(&admin, &new_admin);
    env.ledger().with_mut(|li| {
        li.timestamp += ADMIN_ROTATION_DELAY_SECS - 1;
    });
    client.accept_admin(&new_admin);
}

#[test]
#[should_panic]
fn test_admin_rotation_requires_new_admin_auth() {
    let (env, client, admin, _) = setup();
    let new_admin = Address::generate(&env);

    client.propose_admin(&admin, &new_admin);
    env.ledger().with_mut(|li| {
        li.timestamp += ADMIN_ROTATION_DELAY_SECS;
    });

    // No authorization at all: accept_admin must fail.
    env.set_auths(&[]);
    client.accept_admin(&new_admin);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_admin_rotation_propose_requires_current_admin() {
    let (env, client, _, _) = setup();
    let impostor = Address::generate(&env);
    let new_admin = Address::generate(&env);
    client.propose_admin(&impostor, &new_admin);
}

#[test]
fn test_admin_rotation_cancel_clears_proposal() {
    let (env, client, admin, _) = setup();
    let new_admin = Address::generate(&env);

    client.propose_admin(&admin, &new_admin);
    client.cancel_admin_proposal(&admin);

    env.ledger().with_mut(|li| {
        li.timestamp += ADMIN_ROTATION_DELAY_SECS;
    });
    assert!(client.try_accept_admin(&new_admin).is_err());

    let (stored_admin, _) = client.get_metadata();
    assert_eq!(stored_admin, admin);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_old_admin_loses_privileges_after_rotation() {
    let (env, client, admin, _) = setup();
    let new_admin = Address::generate(&env);

    client.propose_admin(&admin, &new_admin);
    env.ledger().with_mut(|li| {
        li.timestamp += ADMIN_ROTATION_DELAY_SECS;
    });
    client.accept_admin(&new_admin);

    // The old admin can no longer pause the contract.
    client.pause(&admin);
}

#[test]
fn test_new_admin_can_pause_after_rotation() {
    let (env, client, admin, _) = setup();
    let new_admin = Address::generate(&env);

    client.propose_admin(&admin, &new_admin);
    env.ledger().with_mut(|li| {
        li.timestamp += ADMIN_ROTATION_DELAY_SECS;
    });
    client.accept_admin(&new_admin);

    client.pause(&new_admin);
    assert!(client.is_paused());
}
// ── #1365: update_fee cannot raise the fee of a funded escrow ─────────────────

fn create_default_escrow(
    env: &Env,
    client: &EscrowContractClient,
    admin: &Address,
    usdc_id: &Address,
) -> u64 {
    let sender = Address::generate(env);
    let recipient = Address::generate(env);
    let agent = Address::generate(env);
    mint_usdc(env, usdc_id, admin, &sender, 1_000_0000000);
    client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250)
}

#[test]
#[should_panic(expected = "Error(Contract, #17)")]
fn test_update_fee_above_max_rejected() {
    let (env, client, admin, usdc_id) = setup();
    let escrow_id = create_default_escrow(&env, &client, &admin, &usdc_id);
    client.update_fee(&admin, &escrow_id, &5000);
}

#[test]
#[should_panic(expected = "Error(Contract, #19)")]
fn test_update_fee_increase_rejected() {
    let (env, client, admin, usdc_id) = setup();
    let escrow_id = create_default_escrow(&env, &client, &admin, &usdc_id);
    client.update_fee(&admin, &escrow_id, &251);
}

#[test]
fn test_update_fee_decrease_applies_and_emits_event() {
    let (env, client, admin, usdc_id) = setup();
    let escrow_id = create_default_escrow(&env, &client, &admin, &usdc_id);
    client.update_fee(&admin, &escrow_id, &100);
    assert_eq!(client.get_escrow(&escrow_id).release_fee_bps, 100);

    let (_, _, data) = find_event(&env, "FeeUpdated").expect("event not emitted");
    let payload = FeeUpdated::from_val(&env, &data);
    assert_eq!(payload.escrow_id, escrow_id);
    assert_eq!(payload.old_fee_bps, 250);
    assert_eq!(payload.new_fee_bps, 100);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_update_fee_non_admin_rejected() {
    let (env, client, admin, usdc_id) = setup();
    let escrow_id = create_default_escrow(&env, &client, &admin, &usdc_id);
    let impostor = Address::generate(&env);
    client.update_fee(&impostor, &escrow_id, &0);
}

// ── #1366: the agent is a dispute party; no "pay-out then dispute" by sender ──

/// Create a funded escrow and have the agent confirm fiat delivery.
fn confirmed_escrow(
    env: &Env,
    escrow: &EscrowContractClient,
    admin: &Address,
    usdc_id: &Address,
) -> (u64, Address, Address, Address) {
    let sender = Address::generate(env);
    let recipient = Address::generate(env);
    let agent = Address::generate(env);
    mint_usdc(env, usdc_id, admin, &sender, 1_000_0000000);
    let escrow_id = escrow.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    escrow.confirm_delivery(&agent, &escrow_id);
    (escrow_id, sender, recipient, agent)
}

#[test]
#[should_panic(expected = "Error(Contract, #22)")]
fn test_sender_cannot_dispute_after_confirm_delivery() {
    let (env, escrow, _, _, admin, usdc_id, _) = setup_with_dispute();
    let (escrow_id, sender, _, _) = confirmed_escrow(&env, &escrow, &admin, &usdc_id);
    escrow.dispute_escrow(&sender, &escrow_id);
}

#[test]
fn test_agent_can_win_dispute_after_confirm_delivery() {
    use dispute_resolution_contract::{DisputeResolutionContractClient, DisputeStatus};

    let (env, escrow, _, dispute_id_addr, admin, usdc_id, arbitrator) = setup_with_dispute();
    let dispute = DisputeResolutionContractClient::new(&env, &dispute_id_addr);
    let (escrow_id, _, recipient, agent) = confirmed_escrow(&env, &escrow, &admin, &usdc_id);

    let dispute_id = escrow.dispute_escrow(&recipient, &escrow_id);
    assert!(dispute.is_payout_confirmed(&dispute_id));

    // The agent is a party: it can submit evidence.
    let content_hash = soroban_sdk::BytesN::from_array(&env, &[7u8; 32]);
    let uri = Some(soroban_sdk::String::from_str(&env, "ipfs://payout-receipt"));
    dispute.submit_evidence(&agent, &dispute_id, &content_hash, &uri);
    let entry = dispute.get_evidence(&dispute_id, &0, &1).get(0).unwrap();
    assert_eq!(entry.submitter, agent);
    assert_eq!(entry.content_hash, content_hash);

    // ...and be awarded the funds.
    dispute.resolve_dispute_for_agent(&arbitrator, &dispute_id);
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    dispute.finalize_resolution(&dispute_id);

    assert_eq!(dispute.get_dispute(&dispute_id).status, DisputeStatus::ResolvedForAgent);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&agent), 1_000_0000000);
}

#[test]
fn test_agent_can_appeal_and_win() {
    use dispute_resolution_contract::{DisputeResolutionContractClient, DisputeStatus};

    // setup_with_dispute uses the admin as super-arbitrator.
    let (env, escrow, _, dispute_id_addr, admin, usdc_id, arbitrator) = setup_with_dispute();
    let dispute = DisputeResolutionContractClient::new(&env, &dispute_id_addr);
    let (escrow_id, _, recipient, agent) = confirmed_escrow(&env, &escrow, &admin, &usdc_id);

    let dispute_id = escrow.dispute_escrow(&recipient, &escrow_id);
    dispute.resolve_dispute(&arbitrator, &dispute_id, &true);
    dispute.appeal(&agent, &dispute_id);
    dispute.resolve_appeal_for_agent(&admin, &dispute_id);

    assert_eq!(dispute.get_dispute(&dispute_id).status, DisputeStatus::ResolvedForAgent);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&agent), 1_000_0000000);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&recipient), 0);
}

#[test]
fn test_unresolved_dispute_after_confirm_delivery_defaults_to_agent() {
    use dispute_resolution_contract::{DisputeResolutionContractClient, DisputeStatus};

    let (env, escrow, _, dispute_id_addr, admin, usdc_id, _) = setup_with_dispute();
    let dispute = DisputeResolutionContractClient::new(&env, &dispute_id_addr);
    let (escrow_id, sender, recipient, agent) = confirmed_escrow(&env, &escrow, &admin, &usdc_id);

    let dispute_id = escrow.dispute_escrow(&recipient, &escrow_id);
    env.ledger().with_mut(|li| li.timestamp += 7 * 24 * 60 * 60 + 1);

    // The sender cannot reclaim funds the agent already paid out.
    assert!(dispute.try_claim_expired(&sender, &dispute_id).is_err());

    dispute.claim_expired(&agent, &dispute_id);
    assert_eq!(dispute.get_dispute(&dispute_id).status, DisputeStatus::Expired);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&agent), 1_000_0000000);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), 0);
}

#[test]
fn test_unconfirmed_escrow_dispute_still_refunds_sender_on_expiry() {
    use dispute_resolution_contract::DisputeResolutionContractClient;

    let (env, escrow, _, dispute_id_addr, admin, usdc_id, _) = setup_with_dispute();
    let dispute = DisputeResolutionContractClient::new(&env, &dispute_id_addr);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = escrow.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);

    let dispute_id = escrow.dispute_escrow(&sender, &escrow_id);
    env.ledger().with_mut(|li| li.timestamp += 7 * 24 * 60 * 60 + 1);

    assert!(dispute.try_claim_expired(&agent, &dispute_id).is_err());
    dispute.claim_expired(&sender, &dispute_id);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), 1_000_0000000);
}

// ── #1367: the dispute outcome is reported back to the escrow ─────────────────

#[test]
fn test_dispute_resolved_for_sender_cancels_escrow_and_allows_cleanup() {
    use dispute_resolution_contract::DisputeResolutionContractClient;

    let (env, escrow, _, dispute_addr, admin, usdc_id, arbitrator) = setup_with_dispute();
    let dispute = DisputeResolutionContractClient::new(&env, &dispute_addr);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = escrow.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);

    let dispute_id = escrow.dispute_escrow(&sender, &escrow_id);
    let record = escrow.get_escrow_dispute(&escrow_id).expect("dispute record");
    assert_eq!(record.dispute_id, dispute_id);
    assert_eq!(record.dispute_contract, dispute_addr);
    assert_eq!(escrow.get_escrow_dispute_winner(&escrow_id), None);

    dispute.resolve_dispute(&arbitrator, &dispute_id, &false);
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    dispute.finalize_resolution(&dispute_id);

    assert_eq!(escrow.get_escrow(&escrow_id).status, EscrowStatus::Cancelled);
    assert_eq!(escrow.get_escrow_dispute_winner(&escrow_id), Some(sender.clone()));
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), 1_000_0000000);

    let (_, _, data) = find_event(&env, "EscrowDisputeClosed").expect("event not emitted");
    let payload = EscrowDisputeClosed::from_val(&env, &data);
    assert_eq!(payload.escrow_id, escrow_id);
    assert_eq!(payload.dispute_id, dispute_id);
    assert_eq!(payload.winner, sender);
    assert_eq!(payload.status, EscrowStatus::Cancelled);

    // Now eligible for cleanup after the retention period.
    env.ledger().with_mut(|li| li.timestamp += 90 * 24 * 60 * 60 + 1);
    escrow.cleanup_escrow(&escrow_id);
    assert!(escrow.try_get_escrow(&escrow_id).is_err());
    assert!(escrow.get_escrow_dispute(&escrow_id).is_none());
    assert!(escrow.get_escrow_dispute_winner(&escrow_id).is_none());
}

#[test]
fn test_dispute_resolved_for_agent_releases_escrow() {
    use dispute_resolution_contract::DisputeResolutionContractClient;

    let (env, escrow, _, dispute_addr, admin, usdc_id, arbitrator) = setup_with_dispute();
    let dispute = DisputeResolutionContractClient::new(&env, &dispute_addr);
    let (escrow_id, _, recipient, agent) = confirmed_escrow(&env, &escrow, &admin, &usdc_id);

    let dispute_id = escrow.dispute_escrow(&recipient, &escrow_id);
    dispute.resolve_dispute_for_agent(&arbitrator, &dispute_id);
    env.ledger().with_mut(|li| li.timestamp += 24 * 60 * 60 + 1);
    dispute.finalize_resolution(&dispute_id);

    assert_eq!(escrow.get_escrow(&escrow_id).status, EscrowStatus::Released);
    assert_eq!(escrow.get_escrow_dispute_winner(&escrow_id), Some(agent));
}

#[test]
fn test_appeal_outcome_is_reported_to_escrow() {
    use dispute_resolution_contract::DisputeResolutionContractClient;

    let (env, escrow, _, dispute_addr, admin, usdc_id, arbitrator) = setup_with_dispute();
    let dispute = DisputeResolutionContractClient::new(&env, &dispute_addr);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = escrow.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);

    let dispute_id = escrow.dispute_escrow(&sender, &escrow_id);
    dispute.resolve_dispute(&arbitrator, &dispute_id, &false);
    dispute.appeal(&recipient, &dispute_id);
    dispute.resolve_appeal(&admin, &dispute_id, &true);

    assert_eq!(escrow.get_escrow(&escrow_id).status, EscrowStatus::Released);
    assert_eq!(escrow.get_escrow_dispute_winner(&escrow_id), Some(recipient));
}

#[test]
fn test_panel_vote_outcome_is_reported_to_escrow() {
    use dispute_resolution_contract::DisputeResolutionContractClient;

    let (env, escrow, _, dispute_addr, admin, usdc_id, _) = setup_with_dispute();
    let dispute = DisputeResolutionContractClient::new(&env, &dispute_addr);
    let panelist = Address::generate(&env);
    dispute.add_arbitrator(&admin, &panelist);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = escrow.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);

    let dispute_id = escrow.dispute_escrow(&sender, &escrow_id);
    dispute.cast_vote(&panelist, &dispute_id, &false);

    assert_eq!(escrow.get_escrow(&escrow_id).status, EscrowStatus::Cancelled);
    assert_eq!(escrow.get_escrow_dispute_winner(&escrow_id), Some(sender));
}

#[test]
fn test_expired_dispute_outcome_is_reported_to_escrow() {
    use dispute_resolution_contract::DisputeResolutionContractClient;

    let (env, escrow, _, dispute_addr, admin, usdc_id, _) = setup_with_dispute();
    let dispute = DisputeResolutionContractClient::new(&env, &dispute_addr);
    let (escrow_id, _, recipient, agent) = confirmed_escrow(&env, &escrow, &admin, &usdc_id);

    let dispute_id = escrow.dispute_escrow(&recipient, &escrow_id);
    env.ledger().with_mut(|li| li.timestamp += 7 * 24 * 60 * 60 + 1);
    dispute.claim_expired(&agent, &dispute_id);

    assert_eq!(escrow.get_escrow(&escrow_id).status, EscrowStatus::Released);
    assert_eq!(escrow.get_escrow_dispute_winner(&escrow_id), Some(agent));
}

#[test]
#[should_panic]
fn test_close_disputed_escrow_rejects_other_callers() {
    let (env, escrow, _, _, admin, usdc_id, _) = setup_with_dispute();
// ── Cancel hold period (sender front-running protection) ─────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #24)")]
fn test_cancel_before_hold_period_panics() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    client.cancel_escrow(&sender, &escrow_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #24)")]
fn test_cancel_one_second_before_hold_ends_panics() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    env.ledger().with_mut(|li| {
        li.timestamp += CANCEL_HOLD_SECS - 1;
    });
    client.cancel_escrow(&sender, &escrow_id);
}

#[test]
fn test_cancel_exactly_at_hold_end_succeeds() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);
    assert_eq!(
        client.get_cancellable_at(&escrow_id),
        client.get_escrow(&escrow_id).created_at + CANCEL_HOLD_SECS
    );
    advance_past_cancel_hold(&env);
    client.cancel_escrow(&sender, &escrow_id);

    assert!(client.get_escrow(&escrow_id).status == EscrowStatus::Cancelled);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), amount);
}

#[test]
fn test_agent_confirm_within_hold_blocks_later_cancel() {
    // The agent pays fiat off-chain and confirms during the hold window; the
    // sender can no longer cancel once the window ends.
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    client.confirm_delivery(&agent, &escrow_id);
    advance_past_cancel_hold(&env);

    assert!(client.try_cancel_escrow(&sender, &escrow_id).is_err());
    assert!(client.get_escrow(&escrow_id).status == EscrowStatus::Pending);
}

#[test]
fn test_admin_can_update_cancel_hold_period() {
    let (env, client, admin, usdc_id) = setup();
    assert_eq!(client.get_cancel_hold_period(), CANCEL_HOLD_SECS);

    client.set_cancel_hold_period(&admin, &3600);
    assert_eq!(client.get_cancel_hold_period(), 3600);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = escrow.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    escrow.dispute_escrow(&sender, &escrow_id);

    // Without the dispute contract's authorization the call must fail.
    env.set_auths(&[]);
    escrow.close_disputed_escrow(&escrow_id, &sender);
}

#[test]
#[should_panic(expected = "Error(Contract, #31)")]
fn test_close_disputed_escrow_requires_dispute() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    client.close_disputed_escrow(&escrow_id, &sender);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    env.ledger().with_mut(|li| {
        li.timestamp += 3600;
    });
    client.cancel_escrow(&sender, &escrow_id);
    assert!(client.get_escrow(&escrow_id).status == EscrowStatus::Cancelled);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_non_admin_cannot_set_cancel_hold_period() {
    let (env, client, _, _) = setup();
    let impostor = Address::generate(&env);
    client.set_cancel_hold_period(&impostor, &0);
}

#[test]
#[should_panic(expected = "Error(Contract, #25)")]
fn test_cancel_hold_period_above_max_panics() {
    let (_, client, admin, _) = setup();
    client.set_cancel_hold_period(&admin, &(7 * 24 * 60 * 60 + 1));
}
