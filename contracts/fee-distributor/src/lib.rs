#![no_std]

//! # Fee Distributor Contract
//!
//! On-chain platform fee accumulation and withdrawal for AfriPay.
//! Makes the fee model fully transparent and auditable on Stellar.
//!
//! ## Access control
//! - `deposit_fee`           — any caller (typically the backend service account)
//! - `get_accumulated_fees`  — public
//! - `get_all_accumulated_fees` — public
//! - `get_agent_pool_fees`   — public
//! - `withdraw_fees`         — admin only
//! - `distribute_agent_pool` — admin only
//! - `update_split`          — admin only
//! - `add_fee_token`         — admin only
//! - `remove_fee_token`      — admin only
//!
//! ## Agent pool lifecycle
//! Each `deposit_fee` splits the deposit into a platform portion
//! (`AccumulatedFees(token)`) and an agent reward portion
//! (`AgentPoolFees(token)`) according to `split_bps`.  The agent pool is
//! distributed to individual agent addresses via `distribute_agent_pool`, which
//! transfers the requested amounts to each recipient and emits an
//! `AgentPoolDistributed` event per recipient.  There is no admin self-withdraw
//! path for the agent pool: funds can only leave it to the agent addresses
//! supplied by the admin.  Every outbound transfer (`withdraw_fees` and
//! `distribute_agent_pool`) panics while the contract is `Paused`.
//!
//! ## Fee-token allow-list (SC-132)
//! `deposit_fee` is permissionless, so it only accepts tokens the admin has
//! explicitly allow-listed via `add_fee_token`.  Registration is O(1): each
//! token is stored under its own `TokenRegistered(Address)` key rather than
//! loading and rewriting a whole `TokenList` vector on every deposit.  This
//! prevents an attacker from growing unbounded state (and the per-deposit cost)
//! by depositing throwaway SEP-41 tokens.

use soroban_sdk::{
    contract, contractimpl, contracttype, token, vec, Address, Env, Symbol, Vec,
};

mod test;

// ── Constants ─────────────────────────────────────────────────────────────────

// SECURITY: i128 max is ~170 trillion USDC in stroops.
// MAX_DEPOSIT_AMOUNT caps a single deposit at 1,000,000 USDC (10_000_000_000_000 stroops),
// consistent with the MAX_ESCROW_AMOUNT ceiling in escrow.rs.  This provides a
// contract-level backstop against caller-side unit/precision bugs (e.g. a
// decimal-precision mismatch depositing an amount 10,000× too large).
const MAX_DEPOSIT_AMOUNT: i128 = 10_000_000_000_000;

// ── Storage keys ──────────────────────────────────────────────────────────────

// SC-014: Removed the duplicate, single-fee-rate design's dead storage keys
// (`UsdcAddress`, non-parameterised `AccumulatedFees`, `PlatformFeeBps`) that
// conflicted with the current split-pool model's token-keyed
// `AccumulatedFees(Address)` variant.  The canonical design is the
// split_bps/multi-token model whose storage keys are used throughout the rest
// of this file (`AccumulatedFees(Address)`, `AgentPoolFees(Address)`,
// `SplitBps`, `TokenList`).  The old single-fee-rate variants were leftover
// dead code from an earlier design iteration.
#[contracttype]
pub enum DataKey {
    /// The admin address authorised to withdraw fees and update settings.
    Admin,
    /// Per-token platform treasury accumulator.
    AccumulatedFees(Address),
    /// Per-token agent reward pool accumulator.
    AgentPoolFees(Address),
    /// Basis points allocated to the agent reward pool (0–5000).
    SplitBps,
    /// Ordered list of every token address that has ever received a deposit.
    /// Used by `get_all_accumulated_fees` to enumerate per-token balances.
    TokenList,
    /// Whether the contract is currently paused.
    Paused,
    /// SC-132: O(1) per-token registration flag.  Set when a token is added to
    /// the admin-managed fee-token allow-list.  Replaces the O(n) `TokenList`
    /// scan/rewrite that `deposit_fee` used to perform on every call.
    TokenRegistered(Address),
}

// ── Event payloads ────────────────────────────────────────────────────────────

#[derive(Clone)]
#[contracttype]
pub struct EvtFeeDeposited {
    pub depositor: Address,
    pub token: Address,
    pub amount: i128,
    pub total: i128,
    pub source: Option<Address>,
}

#[derive(Clone)]
#[contracttype]
pub struct EvtFeesWithdrawn {
    pub admin: Address,
    pub token: Address,
    pub amount: i128,
    pub remaining: i128,
    pub timestamp: u64,
}

/// Emitted once per recipient when the agent pool is distributed.
#[derive(Clone)]
#[contracttype]
pub struct EvtAgentPoolDistributed {
    pub admin: Address,
    pub token: Address,
    pub agent: Address,
    pub amount: i128,
    pub remaining: i128,
    pub timestamp: u64,
}

// SC-016 fix: `FeeRateUpdated` struct was missing its closing brace.
// Added `}` after `updated_by` field.
#[derive(Clone)]
#[contracttype]
pub struct FeeRateUpdated {
    pub old_bps: u32,
    pub new_bps: u32,
    pub updated_by: Address,
}

/// Emitted when the admin changes the fee split ratio.
#[derive(Clone)]
#[contracttype]
pub struct EvtSplitUpdated {
    pub old_split_bps: u32,
    pub new_split_bps: u32,
}

/// SC-132: Emitted when the admin adds a token to the fee-token allow-list.
#[derive(Clone)]
#[contracttype]
pub struct EvtFeeTokenAdded {
    pub admin: Address,
    pub token: Address,
}

/// SC-132: Emitted when the admin removes a token from the fee-token allow-list.
#[derive(Clone)]
#[contracttype]
pub struct EvtFeeTokenRemoved {
    pub admin: Address,
    pub token: Address,
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// SC-132: Register `token` in the fee-token allow-list in O(1) storage
/// reads/writes.  Each token is stored under its own `TokenRegistered(Address)`
/// key, so the cost of this call does not grow with the number of registered
/// tokens.  The `TokenList` vector is only appended to when the token is new,
/// and is never scanned on the deposit hot path.
fn register_token(env: &Env, token: &Address) {
    let key = DataKey::TokenRegistered(token.clone());
    if env.storage().persistent().has(&key) {
        return;
    }
    env.storage().persistent().set(&key, &true);

    // Maintain the enumeration list for `get_all_accumulated_fees`.  This is
    // only touched when a genuinely new token is registered (admin-gated), so
    // it cannot be grown by an unprivileged depositor.
    let mut list: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::TokenList)
        .unwrap_or_else(|| vec![env]);
    list.push_back(token.clone());
    env.storage().persistent().set(&DataKey::TokenList, &list);
}

/// SC-132: Returns true when `token` is on the admin-managed allow-list.
fn is_registered(env: &Env, token: &Address) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::TokenRegistered(token.clone()))
}

#[derive(Clone)]
#[contracttype]
pub struct EvtContractPaused {
    pub admin: Address,
    pub paused_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct EvtContractUnpaused {
    pub admin: Address,
    pub unpaused_at: u64,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct FeeDistributorContract;

#[contractimpl]
impl FeeDistributorContract {
    /// Initialise the contract. Must be called once.
    ///
    /// SC-014: Removed the duplicate `initialize(env, admin, usdc_address,
    /// platform_fee_bps)` overload that was left over from an earlier
    /// single-fee-rate design.  It conflicted with this function
    /// (`error[E0592]: duplicate definitions with name 'initialize'`) and used
    /// dead storage keys (`UsdcAddress`, non-parameterised `AccumulatedFees`,
    /// `PlatformFeeBps`) that are not used anywhere else in the file.
    ///
    /// # Arguments
    /// * `admin`     — Address authorised to withdraw accumulated fees.
    /// * `split_bps` — Basis points (0–5000) of each deposit routed to the
    ///                 agent reward pool. E.g. 2000 = 20 %. Must not exceed 5000.
    pub fn initialize(env: Env, admin: Address, split_bps: u32) {
        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        if split_bps > 5000 {
            panic!("split_bps exceeds maximum of 5000");
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::SplitBps, &split_bps);
        // Initialise an empty token list.
        let empty: Vec<Address> = vec![&env];
        env.storage().persistent().set(&DataKey::TokenList, &empty);
    }

    /// SC-132: Add `token` to the admin-managed fee-token allow-list.
    ///
    /// Only allow-listed tokens may be deposited via `deposit_fee`.  This is
    /// O(1) in storage reads/writes regardless of how many tokens are already
    /// registered.  Idempotent: re-adding an existing token is a no-op.
    pub fn add_fee_token(env: Env, token: Address) {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        if is_registered(&env, &token) {
            return;
        }
        register_token(&env, &token);
        env.events().publish(
            (Symbol::new(&env, "fee_token_added"),),
            EvtFeeTokenAdded { admin, token },
        );
    }

    /// SC-132: Remove `token` from the admin-managed fee-token allow-list.
    ///
    /// After removal, `deposit_fee` rejects the token.  Existing accumulated
    /// balances remain withdrawable by the admin.  O(1) in storage reads/writes.
    pub fn remove_fee_token(env: Env, token: Address) {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        env.storage()
            .persistent()
            .remove(&DataKey::TokenRegistered(token.clone()));
        env.events().publish(
            (Symbol::new(&env, "fee_token_removed"),),
            EvtFeeTokenRemoved { admin, token },
        );
    }

    /// SC-132: Returns true when `token` is on the fee-token allow-list.
    pub fn is_fee_token(env: Env, token: Address) -> bool {
        is_registered(&env, &token)
    }

    /// Deposit a platform fee into the contract for a specific token.
    ///
    /// Transfers `amount` of `token` from `depositor` into the contract and
    /// splits the deposit between the platform treasury
    /// (`AccumulatedFees(token)`) and the agent reward pool
    /// (`AgentPoolFees(token)`) according to the current `split_bps`.
    /// Emits a `FeeDeposited` event where `total` reflects the platform portion.
    ///
    /// SC-132: `token` must be on the admin-managed allow-list; deposits of
    /// unlisted tokens are rejected.  The allow-list check is O(1) and does not
    /// grow with the number of registered tokens.
    ///
    /// # Arguments
    /// * `depositor` — Address sending the fee (must authorise this call).
    /// * `token`     — Asset contract address for the fee token (e.g. USDC or XLM).
    /// * `amount`    — Fee amount in token stroops (must be > 0).
    /// * `source`    — Optional originating address for audit purposes.
    pub fn deposit_fee(
        env: Env,
        depositor: Address,
        token: Address,
        amount: i128,
        source: Option<Address>,
    ) {
        if amount <= 0 {
            panic!("amount must be positive");
        }
        if amount > MAX_DEPOSIT_AMOUNT {
            panic!("amount exceeds maximum deposit limit");
        }

        // SC-132: reject tokens that are not on the admin-managed allow-list.
        if !is_registered(&env, &token) {
            panic!("token not on fee allow-list");
        }

        if env.storage().persistent().get(&DataKey::Paused).unwrap_or(false) {
        

/* … truncated 8814 chars — edit only what you need near the top … */
