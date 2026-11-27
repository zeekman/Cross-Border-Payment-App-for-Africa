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

#[cfg(test)]
mod test;

// ── Constants ─────────────────────────────────────────────────────────────────

// SECURITY: i128 max is ~170 trillion USDC in stroops.
// MAX_DEPOSIT_AMOUNT caps a single deposit at 1,000,000 USDC (10_000_000_000_000 stroops),
// consistent with the MAX_ESCROW_AMOUNT ceiling in escrow.rs.  This provides a
// contract-level backstop against caller-side unit/precision bugs (e.g. a
// decimal-precision mismatch depositing an amount 10,000× too large).
const MAX_DEPOSIT_AMOUNT: i128 = 10_000_000_000_000;

// ── TTL policy (SC-189) ───────────────────────────────────────────────────────
//
// Instance storage holds small global config (Admin, Paused, SplitBps,
// TokenList).  Persistent storage holds per-token accumulators and the
// per-token allow-list flags.  Both are bumped on every entry point so that
// active contracts never have their state archived.  Values are in ledgers
// (~5 s each): 30 days ≈ 518_400 ledgers, 7 days ≈ 120_960 ledgers.
const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960; // ~7 days
const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // ~30 days
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960; // ~7 days
const PERSISTENT_BUMP_AMOUNT: u32 = 518_400; // ~30 days

/// Extend the TTL of the contract's instance storage.  Called at the top of
/// every public entry point.
fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Extend the TTL of a persistent entry that was just read or written.
fn bump_persistent(env: &Env, key: &DataKey) {
    env.storage().persistent().extend_ttl(
        key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}
// SC-197: Maximum number of recipients accepted by a single
// `distribute_agent_pool` call.  Each recipient costs one token transfer plus
// events; 25 keeps a full batch comfortably inside the default resource limits.
const MAX_DISTRIBUTION_BATCH: u32 = 25;

// ── Storage keys ──────────────────────────────────────────────────────────────

// SC-014: Removed the duplicate, single-fee-rate design's dead storage keys
// (`UsdcAddress`, non-parameterised `AccumulatedFees`, `PlatformFeeBps`) that
// conflicted with the current split-pool model's token-keyed
// `AccumulatedFees(Address)` variant.  The canonical design is the
// split_bps/multi-token model whose storage keys are used throughout the rest
// of this file (`AccumulatedFees(Address)`, `AgentPoolFees(Address)`,
// `SplitBps`, `TokenList`).  The old single-fee-rate variants were leftover
// dead code from an earlier design iteration.
#[derive(Debug)]
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
    /// SC-190: The proposed next admin, awaiting `accept_admin` after the ETA.
    PendingAdmin,
    /// SC-190: Ledger timestamp at which the pending admin may be accepted.
    PendingAdminEta,
    /// SC-195: Never-cleared "this token has been appended to `TokenList`"
    /// flag.  Distinct from `TokenRegistered`, which is cleared by
    /// `remove_fee_token`.  Guarantees a token is pushed to `TokenList` at most
    /// once, so remove/re-add cycles cannot duplicate entries.
    TokenSeen(Address),
    /// SC-197: Admin-synced local allow-list of addresses eligible to receive
    /// agent-pool distributions.  Kept in sync by the admin via
    /// `set_agent_eligible`.
    AgentEligible(Address),
}

/// SC-190: Delay (in seconds) between `propose_admin` and `accept_admin`.
/// Gives the current admin (and any monitoring) time to notice and cancel a
/// malicious or mistaken rotation before it takes effect.
pub const ADMIN_ROTATION_DELAY_SECS: u64 = 24 * 60 * 60;

// ── Event payloads ────────────────────────────────────────────────────────────

/// Emitted on every `deposit_fee`.
///
/// ## Authentication
/// - `depositor` is authenticated: `depositor.require_auth()` is enforced.
/// - `source` is authenticated **only when it is `Some`**: the contract calls
///   `source.require_auth()`, so a depositor cannot attribute a fee to an
///   address that did not authorise the attribution.  When `source` is `None`
///   no provenance is claimed.
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtFeeDeposited {
    pub depositor: Address,
    pub token: Address,
    pub amount: i128,
    pub total: i128,
    /// Authenticated originating address (authorised via `require_auth`).
    pub source: Option<Address>,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtFeesWithdrawn {
    pub admin: Address,
    pub token: Address,
    pub amount: i128,
    pub remaining: i128,
    pub timestamp: u64,
}

/// Emitted once per recipient when the agent pool is distributed.
#[derive(Debug, Clone)]
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
#[derive(Debug, Clone)]
#[contracttype]
pub struct FeeRateUpdated {
    pub old_bps: u32,
    pub new_bps: u32,
    pub updated_by: Address,
}

/// Emitted when the admin changes the fee split ratio.
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtSplitUpdated {
    pub old_split_bps: u32,
    pub new_split_bps: u32,
}

/// SC-132: Emitted when the admin adds a token to the fee-token allow-list.
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtFeeTokenAdded {
    pub admin: Address,
    pub token: Address,
}

/// SC-132: Emitted when the admin removes a token from the fee-token allow-list.
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtFeeTokenRemoved {
    pub admin: Address,
    pub token: Address,
}

/// SC-190: Emitted when the current admin proposes a new admin.
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtAdminProposed {
    pub admin: Address,
    pub new_admin: Address,
    pub eta: u64,
}

/// SC-190: Emitted when a pending admin accepts the rotation.
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtAdminChanged {
    pub old_admin: Address,
    pub new_admin: Address,
}

/// SC-190: Emitted when the current admin cancels a pending rotation.
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtAdminProposalCancelled {
    pub admin: Address,
/// SC-197: Summary event emitted once per `distribute_agent_pool` batch.
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtAgentPoolDistributedBatch {
    pub admin: Address,
    pub token: Address,
    pub count: u32,
    pub total: i128,
    pub remaining: i128,
    pub timestamp: u64,
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
        bump_persistent(env, &key);
        return;
    }
    env.storage().persistent().set(&key, &true);
    bump_persistent(env, &key);

    // SC-195: `TokenSeen` is never cleared, so a token is appended to
    // `TokenList` at most once even across remove/re-add cycles.
    let seen_key = DataKey::TokenSeen(token.clone());
    if env.storage().persistent().has(&seen_key) {
        return;
    }
    env.storage().persistent().set(&seen_key, &true);

    // Maintain the enumeration list for `get_all_accumulated_fees`.  This is
    // only touched when a genuinely new token is registered (admin-gated), so
    // it cannot be grown by an unprivileged depositor.
    let mut list: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::TokenList)
        .unwrap_or_else(|| vec![env]);
    list.push_back(token.clone());
    env.storage().instance().set(&DataKey::TokenList, &list);
}

/// SC-132: Returns true when `token` is on the admin-managed allow-list.
fn is_registered(env: &Env, token: &Address) -> bool {
    let key = DataKey::TokenRegistered(token.clone());
    let registered = env.storage().persistent().has(&key);
    if registered {
        bump_persistent(env, &key);
    }
    registered
}

/// Emitted once when the contract is initialised.
#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtInitialized {
    pub admin: Address,
    pub split_bps: u32,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EvtContractPaused {
    pub admin: Address,
    pub paused_at: u64,
}

#[derive(Debug, Clone)]
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
        bump_instance(&env);
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        if split_bps > 5000 {
            panic!("split_bps exceeds maximum of 5000");
        }
        // SC-188: the admin must co-sign so the deploy cannot be front-run.
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::SplitBps, &split_bps);
        // Initialise an empty token list.
        let empty: Vec<Address> = vec![&env];
        env.storage().instance().set(&DataKey::TokenList, &empty);

        env.events().publish(
            (Symbol::new(&env, "Initialized"), admin.clone()),
            EvtInitialized { admin, split_bps },
        );
    }

    /// SC-132: Add `token` to the admin-managed fee-token allow-list.
    ///
    /// Only allow-listed tokens may be deposited via `deposit_fee`.  This is
    /// O(1) in storage reads/writes regardless of how many tokens are already
    /// registered.  Idempotent: re-adding an existing token is a no-op.
    pub fn add_fee_token(env: Env, token: Address) {
        bump_instance(&env);
        let admin: Address = env
            .storage()
            .instance()
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
        bump_instance(&env);
        let admin: Address = env
            .storage()
            .instance()
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
        bump_instance(&env);
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
    /// * `source`    — Optional originating address for audit purposes.  When
    ///                 `Some`, the address must authorise this call
    ///                 (`source.require_auth()`), so fees cannot be attributed
    ///                 to an address that did not consent.
    pub fn deposit_fee(
        env: Env,
        depositor: Address,
        token: Address,
        amount: i128,
        source: Option<Address>,
    ) {
        bump_instance(&env);
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

        if env.storage().instance().get(&DataKey::Paused).unwrap_or(false) {
            panic!("Contract is paused");
        }

        depositor.require_auth();

        // SC-196: an audit `source` must be authenticated by that address,
        // otherwise any depositor could spoof fee provenance.
        if let Some(ref src) = source {
            src.require_auth();
        }

        // Transfer the full amount from the depositor to this contract.
        token::Client::new(&env, &token).transfer(
            &depositor,
            &env.current_contract_address(),
            &amount,
        );

        // Compute the agent-pool portion and the platform portion.
        let split_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SplitBps)
            .unwrap_or(0);

        let agent_portion: i128 = amount * (split_bps as i128) / 10_000;
        let platform_portion: i128 = amount - agent_portion;

        // Update per-token platform treasury.
        let total: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AccumulatedFees(token.clone()))
            .unwrap_or(0)
            + platform_portion;
        env.storage()
            .persistent()
            .set(&DataKey::AccumulatedFees(token.clone()), &total);
        bump_persistent(&env, &DataKey::AccumulatedFees(token.clone()));

        // Update per-token agent reward pool.
        let pool: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AgentPoolFees(token.clone()))
            .unwrap_or(0)
            + agent_portion;
        env.storage()
            .persistent()
            .set(&DataKey::AgentPoolFees(token.clone()), &pool);
        bump_persistent(&env, &DataKey::AgentPoolFees(token.clone()));

        env.events().publish(
            (Symbol::new(&env, "FeeDeposited"), depositor.clone()),
            EvtFeeDeposited {
                depositor,
                token,
                amount,
                total,
                source,
            },
        );
    }

    /// Withdraw accumulated platform fees to the admin.
    ///
    /// Panics while the contract is paused.
    pub fn withdraw_fees(env: Env, admin: Address, token: Address, amount: i128) {
        bump_instance(&env);
        if env.storage().instance().get(&DataKey::Paused).unwrap_or(false) {
            panic!("Contract is paused");
        }

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized");
        }
        admin.require_auth();

        if amount <= 0 {
            panic!("amount must be positive");
        }

        let current: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AccumulatedFees(token.clone()))
            .unwrap_or(0);
        if amount > current {
            panic!("insufficient accumulated fees");
        }

        let remaining = current - amount;
        env.storage()
            .persistent()
            .set(&DataKey::AccumulatedFees(token.clone()), &remaining);
        bump_persistent(&env, &DataKey::AccumulatedFees(token.clone()));

        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &admin,
            &amount,
        );

        env.events().publish(
            (Symbol::new(&env, "FeesWithdrawn"), admin.clone()),
            EvtFeesWithdrawn {
                admin,
                token,
                amount,
                remaining,
                timestamp: env.ledger().timestamp(),
            },
        );
    }

    /// Distribute agent-pool funds to individual agent addresses.
    ///
    /// The admin supplies a list of `(agent, amount)` pairs; each amount is
    /// transferred from the contract to the corresponding agent address and an
    /// `AgentPoolDistributed` event is emitted per recipient.  This replaces the
    /// old admin self-withdraw path so the agent pool can no longer be drained
    /// to the admin's own address.
    ///
    /// Panics while the contract is paused.
    ///
    /// # Arguments
    /// * `admin`        — Must be the stored admin and authorise this call.
    /// * `token`        — Asset contract address for the pool token.
    /// * `recipients`   — `(agent, amount)` pairs; each amount must be > 0.
    ///                    At most `MAX_DISTRIBUTION_BATCH` (25) entries; each
    ///                    recipient must be on the admin-synced agent allow-list
    ///                    (`set_agent_eligible`), must not be a duplicate, and
    ///                    must not be the contract's own address.
    pub fn distribute_agent_pool(
        env: Env,
        admin: Address,
        token: Address,
        recipients: Vec<(Address, i128)>,
    ) {
        bump_instance(&env);
        if env.storage().instance().get(&DataKey::Paused).unwrap_or(false) {
            panic!("Contract is paused");
        }

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized");
        }
        admin.require_auth();

        if recipients.is_empty() {
            panic!("recipients must not be empty");
        }
        // SC-197: bound the batch so a large list cannot exhaust the resource
        // budget mid-loop.
        if recipients.len() > MAX_DISTRIBUTION_BATCH {
            panic!("recipients exceed MAX_DISTRIBUTION_BATCH");
        }

        let mut pool: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AgentPoolFees(token.clone()))
            .unwrap_or(0);

        let token_client = token::Client::new(&env, &token);
        let contract = env.current_contract_address();

        let mut seen: Vec<Address> = Vec::new(&env);
        let mut batch_total: i128 = 0;
        let mut count: u32 = 0;

        for (agent, amount) in recipients.iter() {
            if amount <= 0 {
                panic!("amount must be positive");
            }
            if amount > pool {
                panic!("insufficient agent pool fees");
            }
            // SC-197: reject the contract's own address.
            if agent == contract {
                panic!("recipient cannot be the contract address");
            }
            // SC-197: reject duplicate recipients within the batch.
            if seen.contains(&agent) {
                panic!("duplicate recipient");
            }
            // SC-197: only allow-listed agents may receive pool funds.
            if !env
                .storage()
                .persistent()
                .has(&DataKey::AgentEligible(agent.clone()))
            {
                panic!("recipient is not a registered agent");
            }
            seen.push_back(agent.clone());

            pool -= amount;
            batch_total += amount;
            count += 1;

            token_client.transfer(&contract, &agent, &amount);

            env.events().publish(
                (Symbol::new(&env, "AgentPoolDistributed"), agent.clone()),
                EvtAgentPoolDistributed {
                    admin: admin.clone(),
                    token: token.clone(),
                    agent,
                    amount,
                    remaining: pool,
                    timestamp: env.ledger().timestamp(),
                },
            );
        }

        env.storage()
            .persistent()
            .set(&DataKey::AgentPoolFees(token.clone()), &pool);
        bump_persistent(&env, &DataKey::AgentPoolFees(token.clone()));

        // SC-197: one summary event per batch.
        env.events().publish(
            (Symbol::new(&env, "AgentPoolDistributedBatch"),),
            EvtAgentPoolDistributedBatch {
                admin,
                token,
                count,
                total: batch_total,
                remaining: pool,
                timestamp: env.ledger().timestamp(),
            },
        );
    }

    /// SC-197: Add or remove `agent` from the local agent allow-list used by
    /// `distribute_agent_pool`.  Admin only.
    pub fn set_agent_eligible(env: Env, admin: Address, agent: Address, eligible: bool) {
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized");
        }
        admin.require_auth();

        let key = DataKey::AgentEligible(agent);
        if eligible {
            env.storage().persistent().set(&key, &true);
        } else {
            env.storage().persistent().remove(&key);
        }
    }

    /// SC-197: Returns true when `agent` is on the local agent allow-list.
    pub fn is_agent_eligible(env: Env, agent: Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::AgentEligible(agent))
    }

    /// Read the accumulated platform fees for a token.
    pub fn get_accumulated_fees(env: Env, token: Address) -> i128 {
        bump_instance(&env);
        let key = DataKey::AccumulatedFees(token);
        let amount: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if amount != 0 {
            bump_persistent(&env, &key);
        }
        amount
    }


    /// Return all non-zero per-token platform-treasury accumulators, paginated.
    ///
    /// Returns a `Vec` of `(token_address, accumulated_amount, is_active)`
    /// tuples for tokens in the `TokenList` starting at index `start` (0-based),
    /// returning at most `limit` results (capped at 100 per call — the same
    /// ceiling used by `agent-escrow::get_registered_agents`).  Only entries
    /// with a non-zero platform balance are included in the result; callers
    /// should advance `start` by the number of tokens *examined* (i.e. the raw
    /// `TokenList` slice size), not by the number of items returned.  Use
    /// `get_token_list_len` to determine when you have reached the end.
    ///
    /// SC-195: `is_active` reflects whether the token is currently on the
    /// fee-token allow-list (`TokenRegistered`).  Removed tokens that still
    /// hold a balance remain enumerable but are flagged inactive.
    ///
    /// # Arguments
    /// * `start` — 0-based index into the raw `TokenList`.
    /// * `limit` — Maximum tokens to examine in this call (capped at 100).
    pub fn get_all_accumulated_fees(env: Env, start: u32, limit: u32) -> Vec<(Address, i128)> {
        bump_instance(&env);
    pub fn get_all_accumulated_fees(
        env: Env,
        start: u32,
        limit: u32,
    ) -> Vec<(Address, i128, bool)> {
        let cap: u32 = if limit > 100 { 100 } else { limit };
        let list: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::TokenList)
            .unwrap_or_else(|| vec![&env]);

        let mut result: Vec<(Address, i128, bool)> = Vec::new(&env);
        let len = list.len();
        let mut i = start;
        while i < len && (i - start) < cap {
            let token = list.get(i).unwrap();
            let key = DataKey::AccumulatedFees(token.clone());
            let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
            if bal > 0 {
                bump_persistent(&env, &key);
                result.push_back((token, bal));
                let is_active = is_registered(&env, &token);
                result.push_back((token, bal, is_active));
            }
            i += 1;
        }
        result
    }

    /// Return the total number of distinct tokens ever registered.
    /// Use this with `get_all_accumulated_fees` to know when pagination is
    /// complete: keep calling with increasing `start` until
    /// `start >= get_token_list_len()`.
    ///
    /// SC-195: `TokenList` holds each token at most once (guarded by the
    /// never-cleared `TokenSeen` flag), so this equals the number of distinct
    /// tokens ever registered.
    pub fn get_token_list_len(env: Env) -> u32 {
        bump_instance(&env);
        let list: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::TokenList)
            .unwrap_or_else(|| vec![&env]);
        list.len()
    }

    /// Read the accumulated agent-pool fees for a token.
    pub fn get_agent_pool_fees(env: Env, token: Address) -> i128 {
        bump_instance(&env);
        let key = DataKey::AgentPoolFees(token);
        let amount: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if amount != 0 {
            bump_persistent(&env, &key);
        }
        amount
    }

    /// Update the agent-pool split ratio. Admin only.
    pub fn update_split(env: Env, admin: Address, new_split_bps: u32) {
        bump_instance(&env);
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized");
        }
        admin.require_auth();

        if new_split_bps > 5000 {
            panic!("split_bps exceeds maximum of 5000");
        }

/* … truncated 8814 chars — edit only what you need near the top … */

// SC-214: this contract implements its interface from `afripay-types`, so the
// compiler checks the exported signature against the one consumers call.
// Changing the entry point without updating the shared trait breaks this build;
// updating the trait breaks every consumer still using the old signature.
impl afripay_types::FeeDistributorInterface for FeeDistributorContract {
    fn deposit_fee(
        env: Env,
        depositor: Address,
        token: Address,
        amount: i128,
        source: Option<Address>,
    ) {
        FeeDistributorContract::deposit_fee(env, depositor, token, amount, source)
    }
}

mod governance;
pub use governance::{CONTRACT_VERSION, UPGRADE_TIMELOCK_SECS};
        let old_split_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SplitBps)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::SplitBps, &new_split_bps);

        env.events().publish(
            (Symbol::new(&env, "SplitUpdated"), admin.clone()),
            EvtSplitUpdated {
                old_split_bps,
                new_split_bps,
            },
        );
    }

    /// Pause the contract. Admin only.
    pub fn pause(env: Env, admin: Address) {
        bump_instance(&env);
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized");
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &true);

        env.events().publish(
            (Symbol::new(&env, "ContractPaused"), admin.clone()),
            EvtContractPaused {
                admin,
                paused_at: env.ledger().timestamp(),
            },
        );
    }

    /// Unpause the contract. Admin only.
    pub fn unpause(env: Env, admin: Address) {
        bump_instance(&env);
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized");
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &false);

        env.events().publish(
            (Symbol::new(&env, "ContractUnpaused"), admin.clone()),
            EvtContractUnpaused {
                admin,
                unpaused_at: env.ledger().timestamp(),
            },
        );
    }

    /// Whether the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        bump_instance(&env);
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    // ── Two-step admin rotation (SC-190) ──────────────────────────────────────
    //
    // The admin key controls fee withdrawal, agent-pool distribution, the split
    // ratio, the fee-token allow-list and pause/unpause.  A lost or compromised
    // key must therefore be recoverable.  Rotation is two-step and timelocked:
    //
    //   1. `propose_admin(admin, new_admin)` — current admin auth; stores the
    //      pending admin with an ETA of `ADMIN_ROTATION_DELAY_SECS` in the
    //      future and emits `AdminProposed`.
    //   2. `accept_admin(new_admin)` — new admin auth, only after the ETA;
    //      swaps `Admin` and emits `AdminChanged { old, new }`.
    //
    // `cancel_admin_proposal(admin)` lets the current admin abort a pending
    // rotation (e.g. if the proposal was made with a mistyped address).
    //
    // RECOMMENDATION: the admin should be a multisig account (or the
    // `multisig-approval` contract) so that no single key can rotate or use the
    // admin privileges.

    /// Propose `new_admin` as the next admin. Current admin only.
    ///
    /// Stores the pending admin with an ETA of `ADMIN_ROTATION_DELAY_SECS` from
    /// now.  Re-proposing overwrites any existing pending proposal and resets
    /// the ETA.  Emits `AdminProposed`.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) {
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized");
        }
        admin.require_auth();

        if new_admin == stored_admin {
            panic!("new admin is current admin");
        }

        let eta: u64 = env
            .ledger()
            .timestamp()
            .saturating_add(ADMIN_ROTATION_DELAY_SECS);
        env.storage()
            .persistent()
            .set(&DataKey::PendingAdmin, &new_admin);
        env.storage().persistent().set(&DataKey::PendingAdminEta, &eta);

        env.events().publish(
            (Symbol::new(&env, "AdminProposed"), admin.clone()),
            EvtAdminProposed {
                admin,
                new_admin,
                eta,
            },
        );
    }

    /// Accept a pending admin rotation. New admin only, after the ETA.
    ///
    /// Requires `new_admin.require_auth()` and `now >= eta`.  Swaps `Admin` to
    /// `new_admin`, clears the pending proposal and emits
    /// `AdminChanged { old, new }`.  The old admin loses every privilege
    /// immediately after this call.
    pub fn accept_admin(env: Env, new_admin: Address) {
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");

        let pending: Address = env
            .storage()
            .persistent()
            .get(&DataKey::PendingAdmin)
            .expect("no pending admin proposal");
        if pending != new_admin {
            panic!("unauthorized");
        }
        new_admin.require_auth();

        let eta: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::PendingAdminEta)
            .expect("no pending admin proposal");
        if env.ledger().timestamp() < eta {
            panic!("admin rotation timelock not elapsed");
        }

        env.storage().persistent().set(&DataKey::Admin, &new_admin);
        env.storage().persistent().remove(&DataKey::PendingAdmin);
        env.storage().persistent().remove(&DataKey::PendingAdminEta);

        env.events().publish(
            (Symbol::new(&env, "AdminChanged"), new_admin.clone()),
            EvtAdminChanged {
                old_admin: stored_admin,
                new_admin,
            },
        );
    }

    /// Cancel a pending admin rotation. Current admin only.
    pub fn cancel_admin_proposal(env: Env, admin: Address) {
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized");
        }
        admin.require_auth();

        env.storage().persistent().remove(&DataKey::PendingAdmin);
        env.storage().persistent().remove(&DataKey::PendingAdminEta);

        env.events().publish(
            (Symbol::new(&env, "AdminProposalCancelled"), admin.clone()),
            EvtAdminProposalCancelled { admin },
        );
    }

    /// Return the pending admin and its ETA, if a rotation is in flight.
    pub fn get_pending_admin(env: Env) -> Option<(Address, u64)> {
        let pending: Option<Address> = env.storage().persistent().get(&DataKey::PendingAdmin);
        let eta: Option<u64> = env.storage().persistent().get(&DataKey::PendingAdminEta);
        match (pending, eta) {
            (Some(p), Some(e)) => Some((p, e)),
            _ => None,
        }
    }
}
