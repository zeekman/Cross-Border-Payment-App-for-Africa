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
// Replicated from kyc-attestation contract for type safety in cross-contract calls.
#[derive(Clone, Copy)]
#[contracttype]
#[repr(u32)]
pub enum KycTier {
    Basic = 0,
    Enhanced = 1,
    Business = 2,
}

#[contracttype]
pub struct AllowanceValue {
    pub amount: i128,
    pub expires_at: u64,
}

mod test;

// ── Storage keys ──────────────────────────────────────────────────────────────

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
    /// Per-account checkpoint history: `Vec<(ledger, balance)>` written lazily
    /// on every balance change. Used to reconstruct historical balances without
    /// iterating over all holders.
    Checkpoints(Address),
    /// Maps a tier index (0–4) to its Tier configuration.
    Tier(u32),
}

// ── Tier type ─────────────────────────────────────────────────────────────────

/// A single redemption tier: points required and the fee-discount awarded.
#[derive(Clone)]
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
        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        if max_supply <= 0 {
            panic!("max_supply must be positive");
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::TotalSupply, &0i128);
        env.storage().persistent().set(&DataKey::MaxSupply, &max_supply);
        env.storage().persistent().set(&DataKey::SnapshotCounter, &0u32);
        env.storage().persistent().set(&DataKey::SnapshotCount, &0u32);

        // Install default tiers.
        env.storage().persistent().set(
            &DataKey::Tier(0),
            &Tier { threshold: 50, discount_bps: 1_000 },
        );
        env.storage().persistent().set(
            &DataKey::Tier(1),
            &Tier { threshold: 100, discount_bps: 2_500 },
        );
        env.storage().persistent().set(
            &DataKey::Tier(2),
            &Tier { threshold: 500, discount_bps: 5_000 },
        );
        env.storage().persistent().set(
            &DataKey::Tier(3),
            &Tier { threshold: 1_000, discount_bps: 7_500 },
        );
    }

    // ── SEP-41: token metadata ────────────────────────────────────────────────

    pub fn name(env: Env) -> String {
        String::from_str(&env, "AfriPay Loyalty Points")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "ALP")
    }

    /// Loyalty points have no sub-unit — decimals = 0.
    pub fn decimals(_env: Env) -> u32 {
        0
    }

    // ── SEP-41: supply & balances ─────────────────────────────────────────────

    pub fn total_supply(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    pub fn max_supply(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::MaxSupply)
            .expect("not initialized")
    }

    pub fn balance(env: Env, account: Address) -> i128 {
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
        admin.require_auth();

        let stored_admin: Address = env.storage().persistent().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let active_count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::SnapshotCount)
            .unwrap_or(0);
        if active_count >= 10 {
            panic!("Snapshot limit reached");
        }

        let snapshot_id: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::SnapshotCounter)
            .unwrap_or(0)
            + 1;
        env.storage().persistent().set(&DataKey::SnapshotCounter, &snapshot_id);
        env.storage()
            .persistent()
            .set(&DataKey::SnapshotCount, &(active_count + 1));
        env.storage()
            .persistent()
            .set(&DataKey::SnapshotLedger(snapshot_id), &env.ledger().sequence());

        snapshot_id
    }

    /// Return the balance recorded for a holder at the specified snapshot.
    ///
    /// Reconstructed from the per-account checkpoint history: the balance is the
    /// value of the latest checkpoint at or before the snapshot's ledger. Returns
    /// 0 when the account had no balance at that ledger.
    pub fn snapshot_balance(env: Env, snapshot_id: u32, account: Address) -> i128 {
        let ledger: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::SnapshotLedger(snapshot_id))
            .expect("unknown snapshot");

        let checkpoints: Vec<(u32, i128)> = env
            .storage()
            .persistent()
            .get(&DataKey::Checkpoints(account))
            .unwrap_or(Vec::new(&env));

        let mut balance: i128 = 0;
        for (cp_ledger, cp_balance) in checkpoints.iter() {
            if cp_ledger <= ledger {
                balance = cp_balance;
            } else {
                break;
            }
        }
        balance
    }

    // ── SEP-41: allowances ────────────────────────────────────────────────────

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        let key = DataKey::Allowance(from, spender);
        match env.storage().persistent().get::<DataKey, AllowanceValue>(&key) {
            Some(a) => {
                if a.expires_at != 0 && env.ledger().sequence() as u64 > a.expires_at {
                    0
                } else {
                    a.amount
                }
            }
            None => 0,
        }
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
        from.require_auth();
        if amount < 0 {
            panic!("amount must be non-negative");
        }
        let key = DataKey::Allowance(from.clone(), spender.clone());
        env.storage().persistent().set(
            &key,
            &AllowanceValue {
                amount,
                expires_at: expiration_ledger as u64,
            },
        );
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
        from.require_auth();
        if amount < 0 {
            panic!("amount must be non-negative");
        }
        let key = DataKey::Allowance(from.clone(), spender.clone());
        let current = Self::allowance(env.clone(), from.clone(), spender.clone());
        let new_amount = current + amount;
        env.storage().persistent().set(
            &key,
            &AllowanceValue {
                amount: new_amount,
                expires_at: expiration_ledger as u64,
            },
        );
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
        from.require_auth();
        if amount < 0 {
            panic!("amount must be non-negative");
        }
        let key = DataKey::Allowance(from.clone(), spender.clone());
        let current = Self::allowance(env.clone(), from.clone(), spender.clone());
        let new_amount = if amount > current { 0 } else { current - amount };
        env.storage().persistent().set(
            &key,
            &AllowanceValue {
                amount: new_amount,
                expires_at: expiration_ledger as u64,
            },
        );
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
        from.require_auth();
        if amount < 0 {
            panic!("amount must be non-negative");
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
        spender.require_auth();
        if amount < 0 {
            panic!("amount must be non-negative");
        }
        let key = DataKey::Allowance(from.clone(), spender.clone());
        let current = Self::allowance(env.clone(), from.clone(), spender.clone());
        if current < amount {
            panic!("insufficient allowance");
        }
        env.storage().persistent().set(
            &key,
            &AllowanceValue {
                amount: current - amount,
                expires_at: 0,
            },
        );
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
        admin.require_auth();
        let stored_admin: Address = env.storage().persistent().get(&DataKey::Admin).unwrap();
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
        env.events().publish(
            (symbol_short!("mint"), admin, to),
            amount,
        );
    }

    /// Burn `amount` from `from`'s own balance.
    ///
    /// Emits the SEP-41 `burn` event with topics `("burn", from)` and data `amount`.
    pub fn burn(env: Env, from: Address, amount: i128) {
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
        env.events().publish(
            (symbol_short!("burn"), from),
            amount,
        );
    }

    /// Burn `amount` from `from` using `spender`'s allowance.
    ///
    /// Emits the SEP-41 `burn` event with topics `("burn", from)` and data `amount`.
    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        if amount < 0 {
            panic!("amount must be non-negative");
        }
        let key = DataKey::Allowance(from.clone(), spender.clone());
        let current = Self::allowance(env.clone(), from.clone(), spender.clone());
        if current < amount {
            panic!("insufficient allowance");
        }
        env.storage().persistent().set(
            &key,
            &AllowanceValue {
                amount: current - amount,
                expires_at: 0,
            },
        );
        let balance = Self::balance(env.clone(), from.clone());
        if balance < amount {
            panic!("insufficient balance");
        }
        Self::set_balance(&env, &from, balance - amount);
        let total: i128 = Self::total_supply(env.clone());
        env.storage().persistent().set(&DataKey::TotalSupply, &(total - amount));
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
        user.require_auth();
        if tier_index >= MAX_TIERS {
            panic!("invalid tier index");
        }
        let tier: Tier = env
            .storage()
            .persistent()
            .get(&DataKey::Tier(tier_index))
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
        env.events().publish(
            (symbol_short!("redeem"), user),
            (tier_index, tier.threshold, tier.discount_bps),
        );
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

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

    /// Persist a balance and append a checkpoint for historical reconstruction.
    fn set_balance(env: &Env, account: &Address, balance: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::Balance(account.clone()), &balance);
        let mut checkpoints: Vec<(u32, i128)> = env
            .storage()
            .persistent()
            .get(&DataKey::Checkpoints(account.clone()))
            .unwrap_or(Vec::new(env));
        checkpoints.push_back((env.ledger().sequence(), balance));
        env.storage()
            .persistent()
            .set(&DataKey::Checkpoints(account.clone()), &checkpoints);
    }
}
