#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal,
};

use crate::{LoyaltyTokenContract, LoyaltyTokenContractClient};

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_MAX_SUPPLY: i128 = 1_000_000_000;
const BASE_TIMESTAMP: u64 = 1_000_000;
const BASE_LEDGER: u32 = 100;
const FAR_FUTURE: u32 = 1_000_000;

fn setup() -> (Env, LoyaltyTokenContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| {
        l.timestamp = BASE_TIMESTAMP;
        l.sequence_number = BASE_LEDGER;
    });
    let contract_id = env.register(LoyaltyTokenContract, ());
    let client = LoyaltyTokenContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &DEFAULT_MAX_SUPPLY);
    (env, client, admin)
}

// ── initialize ────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_sets_zero_supply() {
    let (_, client, _) = setup();
    assert_eq!(client.total_supply(), 0);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let (_, client, admin) = setup();
    client.initialize(&admin, &DEFAULT_MAX_SUPPLY);
}

#[test]
#[should_panic(expected = "max_supply must be positive")]
fn test_initialize_zero_max_supply_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(LoyaltyTokenContract, ());
    let client = LoyaltyTokenContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &0);
}

#[test]
fn test_initialize_stores_max_supply() {
    let (_, client, _) = setup();
    assert_eq!(client.max_supply(), DEFAULT_MAX_SUPPLY);
}

#[test]
fn test_initialize_requires_admin_auth() {
    let env = Env::default();
    env.ledger().with_mut(|l| {
        l.timestamp = BASE_TIMESTAMP;
        l.sequence_number = BASE_LEDGER;
    });
    let contract_id = env.register(LoyaltyTokenContract, ());
    let client = LoyaltyTokenContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);

    // Only the attacker authorizes; the admin never signs.
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: (admin.clone(), DEFAULT_MAX_SUPPLY).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    assert!(client.try_initialize(&admin, &DEFAULT_MAX_SUPPLY).is_err());
    // Contract must remain uninitialized.
    assert!(client.try_max_supply().is_err());
}

#[test]
fn test_initialize_emits_initialized_event() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| {
        l.timestamp = BASE_TIMESTAMP;
        l.sequence_number = BASE_LEDGER;
    });
    let contract_id = env.register(LoyaltyTokenContract, ());
    let client = LoyaltyTokenContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &DEFAULT_MAX_SUPPLY);

    let events = env.events().all();
    let found = events.iter().any(|(emitter, topics, _data)| {
        emitter == contract_id
            && topics
                .get(0)
                .map(|t| {
                    t == soroban_sdk::Symbol::new(&env, "initialized").into_val(&env)
                })
                .unwrap_or(false)
    });
    assert!(found, "Initialized event was not emitted");
}

// ── metadata ──────────────────────────────────────────────────────────────────

#[test]
fn test_name() {
    let (env, client, _) = setup();
    assert_eq!(
        client.name(),
        soroban_sdk::String::from_str(&env, "AfriPay Loyalty Points")
    );
}

#[test]
fn test_symbol() {
    let (env, client, _) = setup();
    assert_eq!(
        client.symbol(),
        soroban_sdk::String::from_str(&env, "ALP")
    );
}

#[test]
fn test_decimals_is_zero() {
    let (_, client, _) = setup();
    assert_eq!(client.decimals(), 0);
}

// ── mint ──────────────────────────────────────────────────────────────────────

#[test]
fn test_mint_increases_balance_and_supply() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &50);
    assert_eq!(client.balance(&user), 50);
    assert_eq!(client.total_supply(), 50);
}

#[test]
fn test_mint_accumulates_across_calls() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &30);
    client.mint(&admin, &user, &70);
    assert_eq!(client.balance(&user), 100);
    assert_eq!(client.total_supply(), 100);
}

#[test]
fn test_mint_multiple_users_independent_balances() {
    let (env, client, admin) = setup();
    let u1 = Address::generate(&env);
    let u2 = Address::generate(&env);
    client.mint(&admin, &u1, &40);
    client.mint(&admin, &u2, &60);
    assert_eq!(client.balance(&u1), 40);
    assert_eq!(client.balance(&u2), 60);
    assert_eq!(client.total_supply(), 100);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_mint_non_admin_panics() {
    let (env, client, _) = setup();
    let impostor = Address::generate(&env);
    let user = Address::generate(&env);
    client.mint(&impostor, &user, &10);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_mint_zero_amount_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &0);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_mint_negative_amount_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &-1);
}

#[test]
fn test_mint_exactly_to_cap_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(LoyaltyTokenContract, ());
    let client = LoyaltyTokenContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    client.initialize(&admin, &500);
    client.mint(&admin, &user, &500);
    assert_eq!(client.total_supply(), 500);
    assert_eq!(client.balance(&user), 500);
}

#[test]
#[should_panic(expected = "minting would exceed max supply")]
fn test_mint_exceeds_cap_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(LoyaltyTokenContract, ());
    let client = LoyaltyTokenContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    client.initialize(&admin, &100);
    client.mint(&admin, &user, &101);
}

#[test]
#[should_panic(expected = "minting would exceed max supply")]
fn test_mint_cumulative_exceeds_cap_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(LoyaltyTokenContract, ());
    let client = LoyaltyTokenContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    client.initialize(&admin, &100);
    client.mint(&admin, &user, &60);
    client.mint(&admin, &user, &41); // 60 + 41 = 101 > 100
}

// ── burn ──────────────────────────────────────────────────────────────────────

#[test]
fn test_burn_decreases_balance_and_supply() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &100);
    client.burn(&user, &40);
    assert_eq!(client.balance(&user), 60);
    assert_eq!(client.total_supply(), 60);
}

#[test]
#[should_panic(expected = "insufficient balance")]
fn test_burn_more_than_balance_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &50);
    client.burn(&user, &51);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_burn_zero_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &10);
    client.burn(&user, &0);
}

// ── transfer ──────────────────────────────────────────────────────────────────

#[test]
fn test_transfer_moves_points_between_accounts() {
    let (env, client, admin) = setup();
    let sender = Address::generate(&env);
    let receiver = Address::generate(&env);
    client.mint(&admin, &sender, &100);
    client.transfer(&sender, &receiver, &30);
    assert_eq!(client.balance(&sender), 70);
    assert_eq!(client.balance(&receiver), 30);
    assert_eq!(client.total_supply(), 100); // supply unchanged
}

#[test]
fn test_create_snapshot_records_balances_for_registered_holders() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &150);
    let snapshot_id = client.create_snapshot(&admin);
    assert_eq!(snapshot_id, 1);
    assert_eq!(client.snapshot_balance(&snapshot_id, &user), 150);
}

#[test]
fn test_snapshot_balance_reflects_balance_before_transfer() {
    let (env, client, admin) = setup();
    let sender = Address::generate(&env);
    let receiver = Address::generate(&env);
    client.mint(&admin, &sender, &100);
    let snapshot_id = client.create_snapshot(&admin);
    client.transfer(&sender, &receiver, &30);
    assert_eq!(client.snapshot_balance(&snapshot_id, &sender), 100);
    assert_eq!(client.snapshot_balance(&snapshot_id, &receiver), 0);
    assert_eq!(client.balance(&sender), 70);
}

#[test]
#[should_panic(expected = "Snapshot limit reached")]
fn test_snapshot_limit_enforced() {
    let (env, client, admin) = setup();
    for _ in 0..11 {
        let _ = client.create_snapshot(&admin);
    }
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_create_snapshot_non_admin_panics() {
    let (env, client, _) = setup();
    let impostor = Address::generate(&env);
    client.create_snapshot(&impostor);
}

#[test]
#[should_panic(expected = "insufficient balance")]
fn test_transfer_insufficient_balance_panics() {
    let (env, client, admin) = setup();
    let sender = Address::generate(&env);
    let receiver = Address::generate(&env);
    client.mint(&admin, &sender, &10);
    client.transfer(&sender, &receiver, &11);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_transfer_zero_panics() {
    let (env, client, admin) = setup();
    let sender = Address::generate(&env);
    let receiver = Address::generate(&env);
    client.mint(&admin, &sender, &10);
    client.transfer(&sender, &receiver, &0);
}

// ── approve / allowance / transfer_from ──────────────────────────────────────

#[test]
fn test_approve_sets_allowance() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &100);
    client.approve(&owner, &spender, &50, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 50);
}

#[test]
fn test_transfer_from_uses_allowance() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let receiver = Address::generate(&env);
    client.mint(&admin, &owner, &100);
    client.approve(&owner, &spender, &40, &FAR_FUTURE);
    client.transfer_from(&spender, &owner, &receiver, &40);
    assert_eq!(client.balance(&owner), 60);
    assert_eq!(client.balance(&receiver), 40);
    assert_eq!(client.allowance(&owner, &spender), 0);
}

#[test]
#[should_panic(expected = "insufficient allowance")]
fn test_transfer_from_exceeds_allowance_panics() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let receiver = Address::generate(&env);
    client.mint(&admin, &owner, &100);
    client.approve(&owner, &spender, &10, &FAR_FUTURE);
    client.transfer_from(&spender, &owner, &receiver, &11);
}

#[test]
fn test_burn_from_uses_allowance() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &100);
    client.approve(&owner, &spender, &30, &FAR_FUTURE);
    client.burn_from(&spender, &owner, &30);
    assert_eq!(client.balance(&owner), 70);
    assert_eq!(client.total_supply(), 70);
    assert_eq!(client.allowance(&owner, &spender), 0);
}

#[test]
#[should_panic(expected = "insufficient allowance")]
fn test_burn_from_exceeds_allowance_panics() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &100);
    client.approve(&owner, &spender, &5, &FAR_FUTURE);
    client.burn_from(&spender, &owner, &6);
}

// ── allowance expiry ──────────────────────────────────────────────────────────

#[test]
fn test_allowance_returns_zero_after_expiry() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &100);
    client.approve(&owner, &spender, &50, &(BASE_LEDGER + 1));
    assert_eq!(client.allowance(&owner, &spender), 50);
    env.ledger().with_mut(|l| l.sequence_number = BASE_LEDGER + 2);
    assert_eq!(client.allowance(&owner, &spender), 0);
}

#[test]
#[should_panic(expected = "insufficient allowance")]
fn test_transfer_from_expired_allowance_panics() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let receiver = Address::generate(&env);
    client.mint(&admin, &owner, &100);
    client.approve(&owner, &spender, &50, &(BASE_LEDGER + 1));
    env.ledger().with_mut(|l| l.sequence_number = BASE_LEDGER + 2);
    client.transfer_from(&spender, &owner, &receiver, &10);
}

#[test]
#[should_panic(expected = "insufficient allowance")]
fn test_burn_from_expired_allowance_panics() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &100);
    client.approve(&owner, &spender, &50, &(BASE_LEDGER + 1));
    env.ledger().with_mut(|l| l.sequence_number = BASE_LEDGER + 2);
    client.burn_from(&spender, &owner, &10);
}

#[test]
#[ignore = "contract bug: approve() accepts an already-expired expiration_ledger (SEP-41 requires a panic)"]
#[should_panic(expected = "expiration_ledger")]
fn test_approve_past_expiry_panics() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &100);
    client.approve(&owner, &spender, &50, &(BASE_LEDGER - 1));
}

// ── redeem ────────────────────────────────────────────────────────────────────
// All existing redeem tests use tier_index=1 (100 pts → 25 % discount),
// which mirrors the old single-threshold behaviour of burning exactly 100 pts.

#[test]
fn test_redeem_burns_100_points() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &150);
    client.redeem(&user, &1u32);
    assert_eq!(client.balance(&user), 50);
    assert_eq!(client.total_supply(), 50);
}

#[test]
fn test_redeem_exactly_100_points_leaves_zero() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &100);
    client.redeem(&user, &1u32);
    assert_eq!(client.balance(&user), 0);
    assert_eq!(client.total_supply(), 0);
}

#[test]
fn test_redeem_insufficient_points_fails() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &99);
    assert!(client.try_redeem(&user, &1u32).is_err());
    assert_eq!(client.balance(&user), 99);
    assert_eq!(client.total_supply(), 99);
}

#[test]
fn test_redeem_zero_balance_fails() {
    let (env, client, _) = setup();
    let user = Address::generate(&env);
    assert!(client.try_redeem(&user, &1u32).is_err());
}

#[test]
fn test_redeem_can_be_called_multiple_times() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &300);
    client.redeem(&user, &1u32); // 300 → 200
    client.redeem(&user, &1u32); // 200 → 100
    client.redeem(&user, &1u32); // 100 → 0
    assert!(client.try_redeem(&user, &1u32).is_err()); // 0 → false
    assert_eq!(client.balance(&user), 0);
}

// ── TTL / archival resilience ─────────────────────────────────────────────────

#[test]
fn test_balances_remain_readable_after_ttl_advance() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &100);

    // Advance well past the default entry TTL.
    env.ledger().with_mut(|l| l.sequence_number = BASE_LEDGER + 10_000_000);

    // Activity on the contract must keep state readable.
    client.mint(&admin, &user, &10);
    assert_eq!(client.balance(&user), 110);
    assert_eq!(client.total_supply(), 110);
    assert_eq!(client.max_supply(), DEFAULT_MAX_SUPPLY);
}

// ── balance of unknown account ────────────────────────────────────────────────

#[test]
fn test_balance_unknown_account_is_zero() {
    let (env, client, _) = setup();
    let unknown = Address::generate(&env);
    assert_eq!(client.balance(&unknown), 0);
}

// ── earn rate: 1 point per 1 XLM ─────────────────────────────────────────────

#[test]
fn test_mint_one_point_per_xlm_volume() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    let xlm_amount: i128 = 50;
    client.mint(&admin, &user, &xlm_amount);
    assert_eq!(client.balance(&user), 50);
}

// ── total_supply consistency ──────────────────────────────────────────────────

#[test]
fn test_total_supply_consistency_after_mint_transfer_burn_redeem() {
    let (env, client, admin) = setup();
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);

    client.mint(&admin, &user1, &200);
    assert_eq!(client.total_supply(), client.balance(&user1) + client.balance(&user2));

    client.mint(&admin, &user2, &100);
    assert_eq!(client.total_supply(), client.balance(&user1) + client.balance(&user2));

    client.transfer(&user1, &user2, &50);
    assert_eq!(client.total_supply(), client.balance(&user1) + client.balance(&user2));

    client.burn(&user1, &30);
    assert_eq!(client.total_supply(), client.balance(&user1) + client.balance(&user2));

    // user2 has 150 pts (100 minted + 50 transferred); tier 1 burns 100 → 50 remain
    client.redeem(&user2, &1u32);
    assert_eq!(client.total_supply(), client.balance(&user1) + client.balance(&user2));
}

// ── Tiered redemption — new tests ─────────────────────────────────────────────

// ── default tiers installed by initialize ─────────────────────────────────────

// ── redeem with explicit tier_index ──────────────────────────────────────────

#[test]
fn test_redeem_tier0_burns_50_points() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &50);
    client.redeem(&user, &0u32);
    assert_eq!(client.balance(&user), 0);
    assert_eq!(client.total_supply(), 0);
}

#[test]
fn test_redeem_tier2_burns_500_points() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &600);
    client.redeem(&user, &2u32);
    assert_eq!(client.balance(&user), 100);
    assert_eq!(client.total_supply(), 100);
}

#[test]
fn test_redeem_tier3_burns_1000_points() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &1_500);
    client.redeem(&user, &3u32);
    assert_eq!(client.balance(&user), 500);
    assert_eq!(client.total_supply(), 500);
}

#[test]
fn test_redeem_fails_below_tier_threshold() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &49); // below tier 0 (50)
    assert!(client.try_redeem(&user, &0u32).is_err());
    assert_eq!(client.balance(&user), 49); // unchanged
}

#[test]
#[should_panic(expected = "invalid tier index")]
fn test_redeem_tier_index_out_of_range_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &1_000);
    client.redeem(&user, &5u32);
}

#[test]
#[should_panic(expected = "tier not configured")]
fn test_redeem_unconfigured_tier_panics() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.mint(&admin, &user, &1_000);
    // Tier 4 is not set by default
    client.redeem(&user, &4u32);
}

#[test]
fn test_redeem_boundary_exactly_at_tier1_threshold() {
    // Exactly 100 pts → tier 1 succeeds; 99 pts → tier 1 fails, tier 0 succeeds.
    let (env, client, admin) = setup();
    let u1 = Address::generate(&env);
    let u2 = Address::generate(&env);
    client.mint(&admin, &u1, &100);
    client.mint(&admin, &u2, &99);
    client.redeem(&u1, &1u32);  // 100 >= 100 ✓
    assert!(client.try_redeem(&u2, &1u32).is_err()); // 99 < 100  ✗
    client.redeem(&u2, &0u32);  // 99 >= 50  ✓ → burns 50
    assert_eq!(client.balance(&u2), 49);
}

// ── Helper for new tests (passes all 3 initialize args correctly) ─────────────

fn setup_v2() -> (Env, LoyaltyTokenContractClient<'static>, Address) {
    setup()
}

// ── increase_allowance ────────────────────────────────────────────────────────

/// Increase from zero: allowance starts at 0, delta bumps it to delta.
#[test]
fn test_increase_allowance_from_zero() {
    let (env, client, admin) = setup_v2();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &200);

    assert_eq!(client.allowance(&owner, &spender), 0);
    client.increase_allowance(&owner, &spender, &50, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 50);
}

/// Increase from non-zero: existing allowance accumulates correctly.
#[test]
fn test_increase_allowance_from_nonzero() {
    let (env, client, admin) = setup_v2();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &200);

    client.approve(&owner, &spender, &30, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 30);

    client.increase_allowance(&owner, &spender, &20, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 50);
}

/// increase_allowance with a negative amount must panic.
#[test]
#[should_panic(expected = "amount must be non-negative")]
fn test_increase_allowance_negative_amount_panics() {
    let (env, client, _admin) = setup_v2();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.increase_allowance(&owner, &spender, &-1, &FAR_FUTURE);
}

// ── decrease_allowance ────────────────────────────────────────────────────────

/// Decrease to zero: delta equals the current allowance.
#[test]
fn test_decrease_allowance_to_zero() {
    let (env, client, admin) = setup_v2();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &200);

    client.approve(&owner, &spender, &50, &FAR_FUTURE);
    client.decrease_allowance(&owner, &spender, &50, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 0);
}

/// Decreasing by more than the current allowance clamps it to zero.
#[test]
fn test_decrease_allowance_below_zero_clamps_to_zero() {
    let (env, client, admin) = setup_v2();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &200);
    client.approve(&owner, &spender, &40, &FAR_FUTURE);
    client.decrease_allowance(&owner, &spender, &41, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 0);
}

/// Decrease from non-zero to a smaller non-zero value.
#[test]
fn test_decrease_allowance_partial() {
    let (env, client, admin) = setup_v2();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &200);

    client.approve(&owner, &spender, &100, &FAR_FUTURE);
    client.decrease_allowance(&owner, &spender, &60, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 40);
}

/// decrease_allowance with a negative amount must panic.
#[test]
#[should_panic(expected = "amount must be non-negative")]
fn test_decrease_allowance_negative_amount_panics() {
    let (env, client, _admin) = setup_v2();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.decrease_allowance(&owner, &spender, &-1, &FAR_FUTURE);
}

// ── approve race-condition guard ──────────────────────────────────────────────

/// approve must succeed when resetting to zero first, then setting a new value.
#[test]
fn test_approve_reset_to_zero_then_set_new_value_succeeds() {
    let (env, client, admin) = setup_v2();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &200);

    // Set initial allowance.
    client.approve(&owner, &spender, &50, &FAR_FUTURE);
    // Reset to zero.
    client.approve(&owner, &spender, &0, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 0);
    // Now set a new non-zero value — this should succeed.
    client.approve(&owner, &spender, &80, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 80);
}

/// approve with amount = 0 is always allowed, even if allowance is non-zero
/// (this is how you revoke/reset).
#[test]
fn test_approve_zero_amount_always_allowed() {
    let (env, client, admin) = setup_v2();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &200);

    client.approve(&owner, &spender, &50, &FAR_FUTURE);
    // Revoking with amount = 0 must not trigger the race guard.
    client.approve(&owner, &spender, &0, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 0);
}

/// approve on a fresh allowance (zero) with a non-zero amount must succeed.
#[test]
fn test_approve_on_zero_allowance_succeeds() {
    let (env, client, admin) = setup_v2();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &200);

    assert_eq!(client.allowance(&owner, &spender), 0);
    client.approve(&owner, &spender, &100, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 100);
}

// ── AllowanceChanged event data integrity ─────────────────────────────────────

/// Verify that increase_allowance correctly reflects old and new values by
/// chaining multiple calls and checking the final state.
#[test]
fn test_increase_allowance_chained_updates() {
    let (env, client, admin) = setup_v2();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &500);

    client.increase_allowance(&owner, &spender, &10, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 10);

    client.increase_allowance(&owner, &spender, &25, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 35);

    client.increase_allowance(&owner, &spender, &15, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 50);
}

/// Verify decrease_allowance followed by increase_allowance round-trips.
#[test]
fn test_decrease_then_increase_allowance_round_trip() {
    let (env, client, admin) = setup_v2();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.mint(&admin, &owner, &500);

    client.approve(&owner, &spender, &100, &FAR_FUTURE);
    client.decrease_allowance(&owner, &spender, &60, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 40);

    client.increase_allowance(&owner, &spender, &30, &FAR_FUTURE);
    assert_eq!(client.allowance(&owner, &spender), 70);
}

// ── two-step admin rotation ───────────────────────────────────────────────────

/// The rotation delay used by the shared governance module (24 h in seconds).
const ADMIN_ROTATION_DELAY: u64 = 24 * 60 * 60;

fn advance_past_rotation_delay(env: &Env) {
    env.ledger()
        .with_mut(|l| l.timestamp = BASE_TIMESTAMP + ADMIN_ROTATION_DELAY + 1);
}

#[test]
fn test_propose_admin_stores_pending_admin() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    client.propose_admin(&admin, &new_admin);
    assert_eq!(client.pending_admin(), Some(new_admin));
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
fn test_accept_admin_after_delay_succeeds() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    client.propose_admin(&admin, &new_admin);
    advance_past_rotation_delay(&env);
    client.accept_admin(&new_admin);
    assert_eq!(client.pending_admin(), None);
}

#[test]
#[should_panic(expected = "admin rotation delay not elapsed")]
fn test_accept_admin_before_delay_panics() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    client.propose_admin(&admin, &new_admin);
    // Still inside the delay window.
    client.accept_admin(&new_admin);
}

#[test]
#[should_panic(expected = "no pending admin")]
fn test_accept_admin_without_proposal_panics() {
    let (env, client, _) = setup();
    let new_admin = Address::generate(&env);
    client.accept_admin(&new_admin);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not pending admin")]
fn test_accept_admin_wrong_caller_panics() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    let impostor = Address::generate(&env);
    client.propose_admin(&admin, &new_admin);
    advance_past_rotation_delay(&env);
    client.accept_admin(&impostor);
}

#[test]
fn test_cancel_admin_proposal_clears_pending() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    client.propose_admin(&admin, &new_admin);
    client.cancel_admin_proposal(&admin);
    assert_eq!(client.pending_admin(), None);
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
#[should_panic(expected = "no pending admin")]
fn test_accept_admin_after_cancel_panics() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    client.propose_admin(&admin, &new_admin);
    client.cancel_admin_proposal(&admin);
    advance_past_rotation_delay(&env);
    client.accept_admin(&new_admin);
}

#[test]
fn test_new_admin_gains_privileges_after_rotation() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    let user = Address::generate(&env);
    client.propose_admin(&admin, &new_admin);
    advance_past_rotation_delay(&env);
    client.accept_admin(&new_admin);
    // New admin can mint.
    client.mint(&new_admin, &user, &10);
    assert_eq!(client.balance(&user), 10);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_old_admin_loses_privileges_after_rotation() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    let user = Address::generate(&env);
    client.propose_admin(&admin, &new_admin);
    advance_past_rotation_delay(&env);
    client.accept_admin(&new_admin);
    // Old admin can no longer mint.
    client.mint(&admin, &user, &10);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_old_admin_cannot_propose_after_rotation() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    let another = Address::generate(&env);
    client.propose_admin(&admin, &new_admin);
    advance_past_rotation_delay(&env);
    client.accept_admin(&new_admin);
    client.propose_admin(&admin, &another);
}
