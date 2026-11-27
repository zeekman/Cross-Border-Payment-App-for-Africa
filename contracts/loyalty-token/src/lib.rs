#![no_std]

//! # AfriPay Loyalty Token — SEP-41 Compatible Fungible Token
//!
//! Issues loyalty points to users for each transaction and allows redemption
//! for fee discounts via a configurable tiered system.
//!
//! ## Earn rate
//! 1 loyalty point per 1 XLM (or XLM-equivalent) of transaction volume.
//! The backend calls [`mint`] after each successful payment.
//!
//! ## Tiers (defaults)
//! | Index | Threshold | Discount |
//! |-------|-----------|----------|
//! |   0   |    50 pts |    10 %  |
//! |   1   |   100 pts |    25 %  |
//! |   2   |   500 pts |    50 %  |
//! |   3   |  1000 pts |    75 %  |
//!
//! ## Redemption
//! Call [`redeem`] with a `tier_index` to burn that tier's threshold points
//! and record the discount entitlement. The backend calls [`get_discount`]
//! to determine the highest tier the user qualifies for without burning tokens.
//!
//! ## SEP-41 interface
//! Implements the SEP-41 token interface:
//! `allowance`, `approve`, `balance`, `burn`, `burn_from`,
//! `decimals`, `mint`, `name`, `symbol`, `total_supply`,
//! `transfer`, `transfer_from`.
//!
//! Every state-changing function emits the SEP-41-shaped events
//! (`transfer`, `mint`, `burn`, `approve`) via `env.events().publish(...)` so
//! wallets, explorers and indexers can reconstruct balances from chain data.
//! `redeem` additionally emits a `redeem` event recording the burned amount
//! and the awarded discount.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, IntoVal, String, Symbol,
    Vec,
};

// ── KYC Tier enum ────────────────────────────────────────────────────────────────
// Defined once in the shared `afripay-types` crate (SC-214); re-exported here so
// existing `loyalty_token_contract::KycTier` imports keep working.
pub use afripay_types::KycTier;

#[derive(Debug)]
#[contracttype]
pub struct AllowanceValue {
    pub amount: i128,
    pub expires_at: u64,
}

#[cfg(test)]
mod test;
mod test_allowance;

// ── Storage keys ──────────────────────────────────────────────────────────────

#[derive(Debug)]
#[contracttype]
pub enum DataKey {
    Admin,
    TotalSupply,
    MaxSupply,
    Balance(Address),
    Allowance(Address, Address), // (owner, spender)
    KycContractAddress,
    /// Snapshot counter used to assign the next snapshot id.
    SnapshotCounter,
    /// Number of active snapshots currently stored.
    SnapshotCount,
    /// Ledger sequence at which a snapshot was taken.
    SnapshotLedger(u32),
    /// Per-account checkpoint history: `Vec<(snapshot_id, balance)>` sorted by
    /// id. An entry is written only on the first balance change after a new
    /// snapshot and records the balance held at that snapshot, so the vector
    /// holds at most one entry per snapshot.
    Checkpoints(Address),
    /// Maps a tier index (0–4) to its Tier configuration.
    Tier(u32),
}

// ── Tier type ─────────────────────────────────────────────────────────────────

/// A single redemption tier: points required and the fee-discount awarded.
#[derive(Debug, Clone)]
#[contracttype]
pub struct Tier {
    /// Points the user must hold (and will burn) to redeem this tier.
    pub threshold: i128,
    /// Fee discount in basis points (e.g. 2500 = 25 %). Max 9000 (90 %).
    pub discount_bps: u32,
}

// ── Constants ─────────────────────────────────────────────────────────────────

/// Maximum number of tiers supported (indices 0 – 4).
const MAX_TIERS: u32 = 5;

/// Hard cap on discount_bps to prevent 100 % fee waivers.
const MAX_DISCOUNT_BPS: u32 = 9_000;

// ── TTL policy ────────────────────────────────────────────────────────────────
// Instance storage (Admin, MaxSupply, counters) is bumped on every entry point.
// Persistent records (balances, allowances, checkpoints, tiers) are bumped
// whenever they are read or written. Amounts are in ledgers (~5s each).

/// Bump instance storage to ~30 days when it falls below ~7 days.
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960;

/// Bump persistent records to ~30 days when they fall below ~7 days.
const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct LoyaltyTokenContract;

#[contractimpl]
impl LoyaltyTokenContract {
    // ── Admin ─────────────────────────────────────────────────────────────────

    /// Initialise the contract. Must be called once before any other function.
    ///
    /// Sets up four default tiers:
    /// * Tier 0 — 50 pts → 10 % discount (1 000 bps)
    /// * Tier 1 — 100 pts → 25 % discount (2 500 bps)
    /// * Tier 2 — 500 pts → 50 % discount (5 000 bps)
    /// * Tier 3 — 1 000 pts → 75 % discount (7 500 bps)
    ///
    /// # Arguments
    /// * `admin`      — Address authorised to mint tokens (the AfriPay backend).
    /// * `max_supply` — Hard ceiling on total points that can ever be minted (must be > 0).
    pub fn initialize(env: Env, admin: Address, max_supply: i128) {
        Self::bump_instance(&env);
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        if max_supply <= 0 {
            panic!("max_supply must be positive");
        }
        // The admin must co-sign so the contract cannot be front-run between
        // deploy and initialize.
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::MaxSupply, &max_supply);
        env.storage().instance().set(&DataKey::SnapshotCounter, &0u32);
        env.storage().instance().set(&DataKey::SnapshotCount, &0u32);
        env.storage().persistent().set(&DataKey::TotalSupply, &0i128);
        Self::bump_persistent(&env, &DataKey::TotalSupply);

        // Install default tiers.
        let tiers = [
            Tier { threshold: 50, discount_bps: 1_000 },
            Tier { threshold: 100, discount_bps: 2_500 },
            Tier { threshold: 500, discount_bps: 5_000 },
            Tier { threshold: 1_000, discount_bps: 7_500 },
        ];
        for (i, tier) in tiers.iter().enumerate() {
            let key = DataKey::Tier(i as u32);
            env.storage().persistent().set(&key, tier);
            Self::bump_persistent(&env, &key);
        }

        env.events().publish(
            (symbol_short!("init"), symbol_short!("done")),
            (admin, max_supply),
        );
    }

    // ── Admin rotation (two-step, timelocked) ─────────────────────────────────

    /// Propose a new admin. The current admin must authorise.
    ///
    /// Stores the pending admin with an ETA of `now + ADMIN_ROTATION_DELAY_SECS`
    /// and emits `AdminProposed`. The proposal must be accepted by the new admin
    /// via [`accept_admin`] once the delay has elapsed.
    ///
    /// It is recommended that the admin be a multisig account or the
    /// `multisig-approval` contract.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) {
        governance::propose_admin(&env, &admin, &new_admin);
    }

    /// Accept a pending admin proposal. The new admin must authorise and the
    /// ETA must have elapsed. Emits `AdminChanged { old, new }`.
    pub fn accept_admin(env: Env, new_admin: Address) {
        governance::accept_admin(&env, &new_admin);
    }

    /// Cancel a pending admin proposal. The current admin must authorise.
    pub fn cancel_admin_proposal(env: Env, admin: Address) {
        governance::cancel_admin_proposal(&env, &admin);
    }

    /// Return the currently stored admin address.
    pub fn admin(env: Env) -> Address {
        governance::get_admin(&env)
    }

    // ── SEP-41: token metadata ────────────────────────────────────────────────

    pub fn name(env: Env) -> String {
        Self::bump_instance(&env);
        String::from_str(&env, "AfriPay Loyalty Points")
    }

    pub fn symbol(env: Env) -> String {
        Self::bump_instance(&env);
        String::from_str(&env, "ALP")
    }

    /// Loyalty points have no sub-unit — decimals = 0.
    pub fn decimals(env: Env) -> u32 {
        Self::bump_instance(&env);
        0
    }

    // ── SEP-41: supply & balances ─────────────────────────────────────────────

    pub fn total_supply(env: Env) -> i128 {
        Self::bump_instance(&env);
        Self::bump_persistent(&env, &DataKey::TotalSupply);
        env.storage()
            .persistent()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    pub fn max_supply(env: Env) -> i128 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::MaxSupply)
            .expect("not initialized")
    }

    pub fn balance(env: Env, account: Address) -> i128 {
        Self::bump_instance(&env);
        Self::bump_persistent(&env, &DataKey::Balance(account.clone()));
        env.storage()
            .persistent()
            .get(&DataKey::Balance(account))
            .unwrap_or(0)
    }

    /// Create a snapshot checkpoint. Admin only. Returns the generated snapshot id.
    ///
    /// Snapshots no longer iterate over all holders. Instead, the ledger sequence
    /// is recorded and per-account balances are reconstructed lazily from the
    /// checkpoint history written on every balance change (see [`snapshot_balance`]).
    pub fn create_snapshot(env: Env, admin: Address) -> u32 {
        Self::bump_instance(&env);
        admin.require_auth();

        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        let stored_admin: Address = governance::get_admin(&env);
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let active_count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SnapshotCount)
            .unwrap_or(0);
        if active_count >= 10 {
            panic!("Snapshot limit reached");
        }

        let snapshot_id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SnapshotCounter)
            .unwrap_or(0)
            + 1;
        env.storage().instance().set(&DataKey::SnapshotCounter, &snapshot_id);
        env.storage()
            .instance()
            .set(&DataKey::SnapshotCount, &(active_count + 1));
        let ledger_key = DataKey::SnapshotLedger(snapshot_id);
        env.storage()
            .persistent()
            .set(&ledger_key, &env.ledger().sequence());
        Self::bump_persistent(&env, &ledger_key);

        env.events().publish(
            (symbol_short!("snapshot"), symbol_short!("created")),
            (snapshot_id, env.ledger().sequence()),
        );

        snapshot_id
    }

    /// Delete a snapshot, freeing a slot under the active-snapshot limit. Admin only.
    pub fn delete_snapshot(env: Env, admin: Address, snapshot_id: u32) {
        Self::bump_instance(&env);
        admin.require_auth();

        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        let stored_admin: Address = governance::get_admin(&env);
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let key = DataKey::SnapshotLedger(snapshot_id);
        if !env.storage().persistent().has(&key) {
            panic!("unknown snapshot");
        }
        env.storage().persistent().remove(&key);

        let active_count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SnapshotCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::SnapshotCount, &active_count.saturating_sub(1));

        env.events().publish(
            (symbol_short!("snapshot"), symbol_short!("deleted")),
            snapshot_id,
        );
    }

    /// Return the balance recorded for a holder at the specified snapshot.
    ///
    /// Reconstructed from the per-account checkpoint history: the balance is the
    /// value of the first checkpoint with id >= `snapshot_id` (binary search).
    /// When none exists the balance hasn't changed since and the current balance
    /// is returned.
    pub fn snapshot_balance(env: Env, snapshot_id: u32, account: Address) -> i128 {
        Self::bump_instance(&env);
        let ledger_key = DataKey::SnapshotLedger(snapshot_id);
        if !env.storage().persistent().has(&ledger_key) {
            panic!("unknown snapshot");
        }
        Self::bump_persistent(&env, &ledger_key);

        let checkpoint_key = DataKey::Checkpoints(account.clone());
        Self::bump_persistent(&env, &checkpoint_key);
        let checkpoints: Vec<(u32, i128)> = env
            .storage()
            .persistent()
            .get(&checkpoint_key)
            .unwrap_or(Vec::new(&env));

        let (mut lo, mut hi) = (0u32, checkpoints.len());
        while lo < hi {
            let mid = (lo + hi) / 2;
            if checkpoints.get_unchecked(mid).0 < snapshot_id {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo < checkpoints.len() {
            checkpoints.get_unchecked(lo).1
        } else {
            Self::balance(env, account)
        }
    }

    // ── SEP-41: allowances ────────────────────────────────────────────────────

    /// Remaining allowance, or 0 once the current ledger is past the
    /// expiration ledger the owner set.
    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        Self::bump_instance(&env);
        Self::read_allowance(&env, &from, &spender).amount
    }

    /// Live allowance (amount + original expiration). Expired entries read as
    /// amount 0 so callers can't spend them.
    fn read_allowance(env: &Env, from: &Address, spender: &Address) -> AllowanceValue {
        let key = DataKey::Allowance(from.clone(), spender.clone());
        Self::bump_persistent(env, &key);
        match env.storage().persistent().get::<DataKey, AllowanceValue>(&key) {
            Some(a) if (env.ledger().sequence() as u64) <= a.expires_at => a,
            Some(a) => AllowanceValue { amount: 0, expires_at: a.expires_at },
            None => AllowanceValue { amount: 0, expires_at: 0 },
        }
    }

    /// SEP-41: a non-zero allowance must not already be expired.
    fn check_expiration(env: &Env, amount: i128, expiration_ledger: u32) {
        if amount > 0 && expiration_ledger < env.ledger().sequence() {
            panic!("expiration_ledger is less than ledger seq when amount > 0");
        }
    }

    /// Deduct `amount` from `spender`'s allowance, keeping the expiration
    /// ledger the owner originally granted.
    fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
        let current = Self::read_allowance(env, from, spender);
        if current.amount < amount {
            panic!("insufficient allowance");
        }
        let key = DataKey::Allowance(from.clone(), spender.clone());
        env.storage().persistent().set(
            &key,
            &AllowanceValue {
                amount: current.amount - amount,
                expires_at: current.expires_at,
            },
        );
        Self::bump_persistent(env, &key);
    }

    /// Approve `spender` to spend `amount` of `from`'s tokens until `expiration_ledger`.
    ///
    /// Emits the SEP-41 `approve` event with topics `("approve", from, spender)`
    /// and data `(amount, expiration_ledger)`.
    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        Self::bump_instance(&env);
        from.require_auth();
        if amount < 0 {
            panic!("amount must be non-negative");
        }
        Self::check_expiration(&env, amount, expiration_ledger);
        let key = DataKey::Allowance(from.clone(), spender.clone());
        env.storage().persistent().set(
            &key,
            &AllowanceValue {
                amount,
                expires_at: expiration_ledger as u64,
            },
        );
        Self::bump_persistent(&env, &key);
        env.events().publish(
            (symbol_short!("approve"), from, spender),
            (amount, expiration_ledger),
        );
    }

    /// Increase the allowance for `spender` by `amount`.
    ///
    /// Emits the SEP-41 `approve` event with the resulting allowance.
    pub fn increase_allowance(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        Self::bump_instance(&env);
        from.require_auth();
        if amount < 0 {
            panic!("amount must be non-negative");
        }
        let key = DataKey::Allowance(from.clone(), spender.clone());
        let current = Self::allowance(env.clone(), from.clone(), spender.clone());
        let new_amount = current + amount;
        Self::check_expiration(&env, new_amount, expiration_ledger);
        env.storage().persistent().set(
            &key,
            &AllowanceValue {
                amount: new_amount,
                expires_at: expiration_ledger as u64,
            },
        );
        Self::bump_persistent(&env, &key);
        env.events().publish(
            (symbol_short!("approve"), from, spender),
            (new_amount, expiration_ledger),
        );
    }

    /// Decrease the allowance for `spender` by `amount`.
    ///
    /// Emits the SEP-41 `approve` event with the resulting allowance.
    pub fn decrease_allowance(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        Self::bump_instance(&env);
        from.require_auth();
        if amount < 0 {
            panic!("amount must be non-negative");
        }
        let key = DataKey::Allowance(from.clone(), spender.clone());
        let current = Self::allowance(env.clone(), from.clone(), spender.clone());
        let new_amount = if amount > current { 0 } else { current - amount };
        Self::check_expiration(&env, new_amount, expiration_ledger);
        env.storage().persistent().set(
            &key,
            &AllowanceValue {
                amount: new_amount,
                expires_at: expiration_ledger as u64,
            },
        );
        Self::bump_persistent(&env, &key);
        env.events().publish(
            (symbol_short!("approve"), from, spender),
            (new_amount, expiration_ledger),
        );
    }

    // ── SEP-41: transfers ─────────────────────────────────────────────────────

    /// Transfer `amount` from `from` to `to`.
    ///
    /// Emits the SEP-41 `transfer` event with topics `("transfer", from, to)`
    /// and data `amount`.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        Self::bump_instance(&env);
        governance::require_not_paused(&env);
        from.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }
        Self::move_balance(&env, &from, &to, amount);
        env.events().publish(
            (symbol_short!("transfer"), from, to),
            amount,
        );
    }

    /// Transfer `amount` from `from` to `to` using `spender`'s allowance.
    ///
    /// Emits the SEP-41 `transfer` event with topics `("transfer", from, to)`
    /// and data `amount`.
    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        Self::bump_instance(&env);
        governance::require_not_paused(&env);
        spender.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }
        Self::spend_allowance(&env, &from, &spender, amount);
        Self::move_balance(&env, &from, &to, amount);
        env.events().publish(
            (symbol_short!("transfer"), from, to),
            amount,
        );
    }

    // ── SEP-41: mint / burn ───────────────────────────────────────────────────

    /// Mint `amount` new points to `to`. Admin only.
    ///
    /// Emits the SEP-41 `mint` event with topics `("mint", admin, to)` and
    /// data `amount`.
    pub fn mint(env: Env, admin: Address, to: Address, amount: i128) {
        Self::bump_instance(&env);
        governance::require_not_paused(&env);
        admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        let stored_admin: Address = governance::get_admin(&env);
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        if amount < 0 {
            panic!("amount must be non-negative");
        }
        let total: i128 = Self::total_supply(env.clone());
        let max: i128 = Self::max_supply(env.clone());
        if total + amount > max {
            panic!("max supply exceeded");
        }
        let balance = Self::balance(env.clone(), to.clone());
        Self::set_balance(&env, &to, balance + amount);
        env.storage().persistent().set(&DataKey::TotalSupply, &(total + amount));
        Self::bump_persistent(&env, &DataKey::TotalSupply);
        env.events().publish(
            (symbol_short!("mint"), admin, to),
            amount,
        );
    }

    /// Burn `amount` from `from`'s own balance.
    ///
    /// Emits the SEP-41 `burn` event with topics `("burn", from)` and data `amount`.
    pub fn burn(env: Env, from: Address, amount: i128) {
        Self::bump_instance(&env);
        from.require_auth();
        if amount < 0 {
            panic!("amount must be non-negative");
        }
        let balance = Self::balance(env.clone(), from.clone());
        if balance < amount {
            panic!("insufficient balance");
        }
        Self::set_balance(&env, &from, balance - amount);
        let total: i128 = Self::total_supply(env.clone());
        env.storage().persistent().set(&DataKey::TotalSupply, &(total - amount));
        Self::bump_persistent(&env, &DataKey::TotalSupply);
        env.events().publish(
            (symbol_short!("burn"), from),
            amount,
        );
    }

    /// Burn `amount` from `from` using `spender`'s allowance.
    ///
    /// Emits the SEP-41 `burn` event with topics `("burn", from)` and data `amount`.
    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        Self::bump_instance(&env);
        spender.require_auth();
        if amount < 0 {
            panic!("amount must be non-negative");
        }
        Self::spend_allowance(&env, &from, &spender, amount);
        let balance = Self::balance(env.clone(), from.clone());
        if balance < amount {
            panic!("insufficient balance");
        }
        Self::set_balance(&env, &from, balance - amount);
        let total: i128 = Self::total_supply(env.clone());
        env.storage().persistent().set(&DataKey::TotalSupply, &(total - amount));
        Self::bump_persistent(&env, &DataKey::TotalSupply);
        env.events().publish(
            (symbol_short!("burn"), from),
            amount,
        );
    }

    // ── Redemption ────────────────────────────────────────────────────────────

    /// Redeem a tier: burn the tier's threshold points from `user` and record
    /// the awarded discount entitlement.
    ///
    /// Emits a `redeem` event with topics `("redeem", user)` and data
    /// `(tier_index, burned, discount_bps)`.
    pub fn redeem(env: Env, user: Address, tier_index: u32) {
        Self::bump_instance(&env);
        user.require_auth();
        if tier_index >= MAX_TIERS {
            panic!("invalid tier index");
        }
        let tier_key = DataKey::Tier(tier_index);
        Self::bump_persistent(&env, &tier_key);
        let tier: Tier = env
            .storage()
            .persistent()
            .get(&tier_key)
            .expect("tier not configured");
        let balance = Self::balance(env.clone(), user.clone());
        if balance < tier.threshold {
            panic!("insufficient points for tier");
        }
        Self::set_balance(&env, &user, balance - tier.threshold);
        let total: i128 = Self::total_supply(env.clone());
        env.storage()
            .persistent()
            .set(&DataKey::TotalSupply, &(total - tier.threshold));
        Self::bump_persistent(&env, &DataKey::TotalSupply);
        env.events().publish(
            (symbol_short!("redeem"), user),
            (tier_index, tier.threshold, tier.discount_bps),
        );
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /// Extend the TTL of instance storage (global config) if it is nearing expiry.
    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    /// Extend the TTL of a persistent record if it is nearing expiry.
    fn bump_persistent(env: &Env, key: &DataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
    }

    /// Move `amount` from `from` to `to`, updating balances and checkpoints.
    fn move_balance(env: &Env, from: &Address, to: &Address, amount: i128) {
        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            panic!("insufficient balance");
        }
        Self::set_balance(env, from, from_balance - amount);
        let to_balance = Self::balance(env.clone(), to.clone());
        Self::set_balance(env, to, to_balance + amount);
    }

    /// Persist a balance. If a snapshot was taken since this account's last
    /// checkpoint, first record the pre-change balance against that snapshot.
    fn set_balance(env: &Env, account: &Address, balance: i128) {
        let latest_snapshot: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SnapshotCounter)
            .unwrap_or(0);
        if latest_snapshot > 0 {
            let key = DataKey::Checkpoints(account.clone());
            Self::bump_persistent(env, &key);
            let mut checkpoints: Vec<(u32, i128)> = env
                .storage()
                .persistent()
                .get(&key)
                .unwrap_or(Vec::new(env));
            let needs_checkpoint = match checkpoints.last() {
                Some((id, _)) => id < latest_snapshot,
                None => true,
            };
            if needs_checkpoint {
                let previous = Self::balance(env.clone(), account.clone());
                checkpoints.push_back((latest_snapshot, previous));
                env.storage().persistent().set(&key, &checkpoints);
                Self::bump_persistent(env, &key);
            }
        }
        let balance_key = DataKey::Balance(account.clone());
        env.storage().persistent().set(&balance_key, &balance);
        Self::bump_persistent(env, &balance_key);
    }
}

mod governance;
pub use governance::{CONTRACT_VERSION, UPGRADE_TIMELOCK_SECS};
