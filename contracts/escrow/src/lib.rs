#![no_std]
use afripay_types::{DisputeResolutionClient, KycAttestationClient, KycTier};
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, Symbol};

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_budget;
#[cfg(test)]
mod test_events;

mod errors;
pub use errors::Error;
use soroban_sdk::panic_with_error;

#[derive(Clone)]
/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 3;

#[derive(Debug, Clone)]
#[contracttype]
pub struct EscrowCreated {
    pub escrow_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub agent: Address,
    pub amount: i128,
    pub release_fee_bps: u32,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EscrowReleased {
    pub escrow_id: u64,
    pub agent_amount: i128,
    pub fee_amount: i128,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EscrowPartiallyReleased {
    pub escrow_id: u64,
    pub released_amount: i128,
    pub agent_amount: i128,
    pub fee_amount: i128,
    pub remaining_amount: i128,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EscrowCancelled {
    pub escrow_id: u64,
    pub refund_amount: i128,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EscrowExpired {
    pub escrow_id: u64,
    pub sender: Address,
    pub refund_amount: i128,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EscrowBatchCreated {
    pub batch_size: u32,
    pub first_escrow_id: u64,
    pub last_escrow_id: u64,
    pub total_amount: i128,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EscrowParams {
    pub recipient: Address,
    pub agent: Address,
    pub amount: i128,
    /// Highest platform fee (bps) the sender accepts for this escrow. The
    /// escrow always uses the admin-configured fee; this is only a guard.
    pub max_fee_bps: u32,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct DeliveryConfirmed {
    pub escrow_id: u64,
    pub agent: Address,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct PartialRelease {
    pub escrow_id: u64,
    pub released_amount: i128,
    pub remaining_amount: i128,
    pub fee_amount: i128,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EscrowArchived {
    pub escrow_id: u64,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct Upgraded {
    pub new_wasm_hash: BytesN<32>,
    pub contract_version: u32,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct Migrated {
    pub contract_version: u32,
}

/// Emitted once when the contract is initialized.
#[derive(Clone)]
#[contracttype]
pub struct Initialized {
    pub admin: Address,
    pub usdc_address: Address,
}

#[derive(Clone, Debug)]
#[contracttype]
pub struct FeesWithdrawn {
    pub admin: Address,
    pub amount: i128,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct CancelHoldPeriodUpdated {
    pub old_hold_secs: u64,
    pub new_hold_secs: u64,
}

/// Emitted when the admin turns KYC enforcement off (or on) for escrow
/// creation. Turning KYC off is an explicit, auditable admin action.
#[derive(Debug, Clone)]
#[contracttype]
pub struct KycCheckDisabled {
    pub admin: Address,
}

/// Emitted when the admin turns KYC enforcement back on.
#[derive(Debug, Clone)]
#[contracttype]
pub struct KycCheckEnabled {
    pub admin: Address,
}

/// Emitted when the admin changes the KYC tier required for escrow creation.
#[derive(Debug, Clone)]
#[contracttype]
pub struct RequiredKycTierUpdated {
    pub old_tier: u32,
    pub new_tier: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct FeeUpdated {
    pub escrow_id: u64,
    pub old_fee_bps: u32,
    pub new_fee_bps: u32,
}

#[derive(Debug, Clone)]
#[derive(Clone, Debug)]
#[contracttype]
pub struct PlatformFeeUpdated {
    pub old_fee_bps: u32,
    pub new_fee_bps: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct EscrowDeposited {
    pub escrow_id: u64,
    pub depositor: Address,
    pub amount: i128,
    pub new_total: i128,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct EscrowDisputed {
    pub escrow_id: u64,
    pub dispute_id: u64,
    pub opener: Address,
    pub agent: Address,
    pub amount: i128,
    pub payout_confirmed: bool,
}

/// Emitted by `close_disputed_escrow` when the dispute contract reports the
/// outcome of a disputed escrow.
#[derive(Clone)]
#[contracttype]
pub struct EscrowDisputeClosed {
    pub escrow_id: u64,
    pub dispute_id: u64,
    pub winner: Address,
    pub status: EscrowStatus,
}

/// Link between a disputed escrow and its dispute. Kept under a separate
/// storage key so existing `Escrow` records still decode.
#[derive(Clone)]
#[contracttype]
pub struct EscrowDispute {
    /// Dispute-resolution contract that holds the funds.
    pub dispute_contract: Address,
    pub dispute_id: u64,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct Escrow {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub agent: Address,
    pub amount: i128,
    pub release_fee_bps: u32,
    pub status: EscrowStatus,
    pub payout_confirmed: bool,
    pub created_at: u64,
    pub updated_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[contracttype]
pub enum EscrowStatus {
    Pending,
    Released,
    Cancelled,
    /// Escrowed funds have been handed to the dispute-resolution contract and
    /// the escrow is awaiting arbitration. In this state the escrow can no
    /// longer be released, cancelled, deposited into, or expired — the winning
    /// party is paid directly by the dispute contract, which then calls
    /// `close_disputed_escrow` to move the escrow to `Released` (agent or
    /// recipient won) or `Cancelled` (sender won).
    UnderDispute,
}

#[derive(Debug)]
#[contracttype]
pub enum DataKey {
    Admin,
    UsdcAddress,
    EscrowCounter,
    AccumulatedFees,
    RetentionPeriodSecs,
    Escrow(u64),
    KycContractAddress,
    DisputeContractAddress,
    ContractVersion,
    /// Platform fee (bps) applied to every new escrow. Set by the admin.
    PlatformFeeBps,
    /// `EscrowDispute` record for an escrow sent to dispute.
    EscrowDispute(u64),
    /// Party the dispute paid, once the dispute is settled.
    EscrowDisputeWinner(u64),
    /// Minimum seconds an escrow must be held before the sender may cancel it.
    CancelHoldSecs,
    /// Whether KYC verification is enforced on escrow creation. Defaults to
    /// `true`; turning it off requires an explicit admin call.
    KycRequired,
    /// KYC tier (as a `u32` matching `afripay_types::KycTier`) that senders
    /// and agents must hold. Defaults to `Basic`.
    RequiredKycTier,
}

const DEFAULT_EXPIRY_SECS: u64 = 30 * 24 * 60 * 60;
const DEFAULT_RETENTION_SECS: u64 = 90 * 24 * 60 * 60;

/// TTL policy (SC-189): instance storage is bumped to ~30 days whenever it
/// drops below ~7 days; persistent records are bumped to ~30 days whenever
/// they drop below ~7 days. Ledgers are ~5 seconds, so 30 days ≈ 518_400
/// ledgers and 7 days ≈ 120_960 ledgers.
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960;
const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;

/// Extend the instance storage TTL. Called at the top of every entry point so
/// global config (`Admin`, `UsdcAddress`, counters, fee bps) is never archived.
fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Extend the TTL of a persistent record that was just read or written.
fn bump_persistent(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
}

/// Default minimum hold period before a sender may cancel (24 hours).
///
/// Gives the agent a guaranteed window to pay out fiat off-chain and land
/// `confirm_delivery` before the sender can pull the funds back. Without it a
/// sender could watch for the off-chain payout and front-run the agent's
/// confirmation with `cancel_escrow`, keeping both the fiat and the refund.
const DEFAULT_CANCEL_HOLD_SECS: u64 = 24 * 60 * 60;

/// Upper bound for the configurable hold period. Must stay below the escrow
/// expiry so the sender always gets a cancel window before expiry.
const MAX_CANCEL_HOLD_SECS: u64 = 7 * 24 * 60 * 60;

/// Maximum allowed fee: 10% (1000 bps) per issue #766.
const MAX_FEE_BPS: u32 = 1000;

/// Platform fee used until the admin calls `set_fee_bps`: 2.5% (250 bps).
const DEFAULT_PLATFORM_FEE_BPS: u32 = 250;

/// Minimum escrow amount in stroops to prevent integer-division rounding to zero fee.
const MIN_ESCROW_AMOUNT: i128 = 100;

// SECURITY: i128 max is ~170 trillion USDC in stroops (1.7 * 10^20).
// MAX_ESCROW_AMOUNT = 1,000,000 USDC = 10_000_000_000_000 stroops.
// Intermediate fee calc uses (amount / 10000).saturating_mul(bps) to prevent overflow.
const MAX_ESCROW_AMOUNT: i128 = 10_000_000_000_000;

/// Default KYC tier required for escrow creation: `afripay_types::KycTier::Basic`.
const DEFAULT_REQUIRED_KYC_TIER: u32 = 0;

fn require_admin(env: &Env, admin: &Address) {
    bump_instance(env);
    admin.require_auth();
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
    if admin != &stored_admin {
        panic_with_error!(env, Error::Unauthorized);
    }
}

fn platform_fee_bps(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::PlatformFeeBps)
        .unwrap_or(DEFAULT_PLATFORM_FEE_BPS)
}

/// Returns the configured platform fee, panicking if it is higher than the
/// sender's `max_fee_bps` guard.
fn fee_for_new_escrow(env: &Env, max_fee_bps: u32) -> u32 {
    let fee_bps = platform_fee_bps(env);
    if fee_bps > max_fee_bps {
        panic_with_error!(env, Error::PlatformFeeExceedsMax);
    }
    fee_bps
fn cancel_hold_period(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::CancelHoldSecs)
        .unwrap_or(DEFAULT_CANCEL_HOLD_SECS)
}

fn retention_period(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::RetentionPeriodSecs)
        .unwrap_or(DEFAULT_RETENTION_SECS)
}

/// Whether KYC enforcement is enabled. Defaults to `true` so a deployment
/// that never calls `set_kyc_required` fails closed.
fn kyc_required(env: &Env) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::KycRequired)
        .unwrap_or(true)
}

/// KYC tier required for escrow creation, as a `u32` matching
/// `afripay_types::KycTier`.
fn required_kyc_tier(env: &Env) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::RequiredKycTier)
        .unwrap_or(DEFAULT_REQUIRED_KYC_TIER)
}

/// Check KYC verification via the shared `afripay_types::KycAttestationClient`.
///
/// Fails closed: if KYC is required but no KYC contract is configured, the
/// check returns `false` rather than silently allowing the escrow. When KYC is
/// explicitly disabled by the admin, the check returns `true`.
fn is_kyc_verified(env: &Env, wallet: &Address) -> bool {
    if !kyc_required(env) {
        return true;
    }

    let kyc_contract: Option<Address> = env
        .storage()
        .instance()
        .get(&DataKey::KycContractAddress);

    match kyc_contract {
        None => false, // KYC required but not configured: fail closed
        Some(addr) => {
            // An unknown stored tier fails closed.
            match KycTier::from_u32(required_kyc_tier(env)) {
                None => false,
                Some(tier) => KycAttestationClient::new(env, &addr).is_valid_and_unexpired(wallet, &tier),
            }
        }
    }
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Initialize the escrow contract.
    ///
    /// SECURITY — front-running prevention (#336):
    /// This function must be called in the same transaction as deployment, or
    /// immediately after deployment with no manual steps in between. The deploy
    /// script (`contracts/deploy.sh`) handles this automatically.
    ///
    /// Re-initialization is permanently blocked by the `has(Admin)` guard.
    /// There is no mechanism to change the admin after initialization.
    ///
    /// SC-188: `admin.require_auth()` makes the admin co-sign, so a watcher
    /// cannot front-run the deploy script's `initialize` call with their own
    /// admin address.
    /// The admin can be rotated after initialization via the two-step
    /// `propose_admin` / `accept_admin` flow (see [`Self::propose_admin`]).
    pub fn initialize(env: Env, admin: Address, usdc_address: Address) {
        bump_instance(&env);
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(env, Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::UsdcAddress, &usdc_address);
        env.storage().instance().set(&DataKey::EscrowCounter, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBps, &DEFAULT_PLATFORM_FEE_BPS);
        env.storage()
            .instance()
            .persistent()
            .set(&DataKey::KycRequired, &true);
        env.storage()
            .persistent()
            .set(&DataKey::RequiredKycTier, &DEFAULT_REQUIRED_KYC_TIER);
        env.storage()
            .persistent()
            .set(&DataKey::ContractVersion, &CONTRACT_VERSION);
        env.events().publish(
            (Symbol::new(&env, "Initialized"),),
            Initialized {
                admin: admin.clone(),
                usdc_address: usdc_address.clone(),
            },
        );
        env.events().publish(
            (Symbol::new(&env, "EscrowInitialized"),),
            (env.current_contract_address(), admin, usdc_address),
        );
    }

    /// Upgrade the contract WASM. Only the admin may call this.
    ///
    /// # Irreversibility
    /// Contract upgrades are **irreversible on-chain**. Once a new WASM hash is
    /// applied, the previous bytecode cannot be restored. Always test on testnet
    /// before upgrading mainnet deployments.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) {
        bump_instance(&env);
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));

        if admin != stored_admin {
            panic_with_error!(env, Error::Unauthorized);
        }

        env.deployer().update_current_contract_wasm(new_wasm_hash.clone());

        env.events().publish(
            (Symbol::new(&env, "Upgraded"),),
            Upgraded {
                new_wasm_hash,
                contract_version: CONTRACT_VERSION,
            },
        );
    }

    pub fn migrate(env: Env, admin: Address) {
        require_admin(&env, &admin);

        let current_version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ContractVersion)
            .unwrap_or(0);

        if current_version >= CONTRACT_VERSION {
            return;
        }

        env.storage()
            .instance()
            .set(&DataKey::ContractVersion, &CONTRACT_VERSION);

        env.events().publish(
            (Symbol::new(&env, "Migrated"),),
            Migrated {
                contract_version: CONTRACT_VERSION,
            },
        );
    }

    /// Lock `amount` USDC from `sender` in a new escrow.
    ///
    /// The release fee is the admin-configured platform fee (`get_fee_bps`),
    /// never a caller-chosen value. `max_fee_bps` is a slippage guard: the
    /// call fails if the configured fee is higher than the sender accepts.
    pub fn create_escrow(
        env: Env,
        sender: Address,
        recipient: Address,
        agent: Address,
        amount: i128,
        max_fee_bps: u32,
    ) -> u64 {
        bump_instance(&env);
        governance::require_not_paused(&env);
        if amount < MIN_ESCROW_AMOUNT {
            panic_with_error!(env, Error::AmountBelowMinimum);
        }
        if amount > MAX_ESCROW_AMOUNT {
            panic_with_error!(env, Error::AmountAboveMaximum);
        }
        let release_fee_bps = fee_for_new_escrow(&env, max_fee_bps);
        if sender == recipient || sender == agent || recipient == agent {
            panic_with_error!(env, Error::PartiesNotDistinct);
        }

        sender.require_auth();

        // KYC verification for sender and agent
        if !is_kyc_verified(&env, &sender) {
            panic_with_error!(env, Error::SenderKycRequired);
        }
        if !is_kyc_verified(&env, &agent) {
            panic_with_error!(env, Error::AgentKycRequired);
        }

        let usdc_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddress)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));

        let current_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCounter)
            .unwrap_or(0);
        // u64::MAX is 18,446,744,073,709,551,615. At one escrow per second,
        // exhausting the counter would take ~584 billion years.
        let next_id = current_id.checked_add(1).expect("Escrow counter overflow");
        env.storage()
            .instance()
            .set(&DataKey::EscrowCounter, &next_id);

        let now = env.ledger().timestamp();
        let escrow = Escrow {
            id: next_id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            agent: agent.clone(),
            amount,
            release_fee_bps,
            status: EscrowStatus::Pending,
            payout_confirmed: false,
            created_at: now,
            updated_at: now,
            expires_at: now + DEFAULT_EXPIRY_SECS,
        };

        // Checks-Effects-Interactions: write escrow record to storage BEFORE the
        // token.transfer call (Interactions step).
        // Soroban prevents re-entrancy by disallowing cross-contract calls that
        // re-enter the same contract instance within a single transaction invocation.
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(next_id), &escrow);
        bump_persistent(&env, &DataKey::Escrow(next_id));

        token::Client::new(&env, &usdc_address).transfer(
            &sender,
            &env.current_contract_address(),
            &amount,
        );

        env.events().publish(
            (Symbol::new(&env, "EscrowCreated"),),
            EscrowCreated {
                escrow_id: next_id,
                sender,
                recipient,
                agent,
                amount,
                release_fee_bps,
            },
        );

        next_id
    }

    pub fn deposit(env: Env, sender: Address, escrow_id: u64, amount: i128) {
        bump_instance(&env);
        governance::require_not_paused(&env);
        if amount <= 0 {
            panic_with_error!(env, Error::InvalidAmount);
        }

        sender.require_auth();

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        if escrow.status != EscrowStatus::Pending {
            panic_with_error!(env, Error::EscrowNotPending);
        }

        if env.ledger().timestamp() >= escrow.expires_at {
            panic_with_error!(env, Error::EscrowExpired);
        }

        let usdc_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddress)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));

        token::Client::new(&env, &usdc_address).transfer(
            &sender,
            &env.current_contract_address(),
            &amount,
        );

        escrow.amount += amount;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        env.events().publish(
            (Symbol::new(&env, "EscrowDeposited"),),
            EscrowDeposited {
                escrow_id,
                depositor: sender,
                amount,
                new_total: escrow.amount,
            },
        );
    }

    pub fn release_escrow(env: Env, agent: Address, escrow_id: u64) {
        bump_instance(&env);
        agent.require_auth();

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        if agent != escrow.agent {
            panic_with_error!(env, Error::NotAgent);
        }
        if escrow.status != EscrowStatus::Pending {
            panic_with_error!(env, Error::EscrowNotPending);
        }
        // Expiry guard: expired escrows must be cancelled by the sender via
        // cancel_escrow — the agent cannot release funds after the protection window.
        if env.ledger().timestamp() >= escrow.expires_at {
            panic_with_error!(env, Error::EscrowExpired);
        }

        // SC-117: Fix fee truncation by using checked arithmetic.
        // Old: (amount / 10000).saturating_mul(bps) — truncates for amounts < 10_000.
        // New: (amount * bps) / 10_000 — rounds down in platform's favour.
        let fee_amount = escrow
            .amount
            .checked_mul(escrow.release_fee_bps as i128)
            .expect("fee calc overflow")
            .checked_div(10_000)
            .expect("fee calc underflow");
        let agent_amount = escrow.amount.checked_sub(fee_amount).expect("fee exceeds escrow amount");
        if agent_amount <= 0 {
            panic_with_error!(env, Error::FeeTooHigh);
        }

        let usdc_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddress)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));

        // Checks-Effects-Interactions: update state BEFORE external token calls.
        // Soroban prevents re-entrancy by disallowing cross-contract calls that
        // re-enter the same contract instance within a single transaction invocation.
        let current_fees: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::AccumulatedFees, &(current_fees + fee_amount));
        bump_persistent(&env, &DataKey::AccumulatedFees);

        escrow.status = EscrowStatus::Released;
        escrow.updated_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        // External calls after state is committed (Interactions step).
        token::Client::new(&env, &usdc_address).transfer(
            &env.current_contract_address(),
            &escrow.agent,
            &agent_amount,
        );

        env.events().publish(
            (Symbol::new(&env, "EscrowReleased"),),
            EscrowReleased {
                escrow_id,
                agent_amount,
                fee_amount,
            },
        );
    }

    pub fn confirm_delivery(env: Env, agent: Address, escrow_id: u64) {
        bump_instance(&env);
        agent.require_auth();

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        if agent != escrow.agent {
            panic_with_error!(env, Error::NotAgent);
        }
        if escrow.status != EscrowStatus::Pending {
            panic_with_error!(env, Error::EscrowNotPending);
        }
        if escrow.payout_confirmed {
            panic_with_error!(env, Error::DeliveryAlreadyConfirmed);
        }

        escrow.payout_confirmed = true;
        escrow.updated_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        env.events().publish(
            (Symbol::new(&env, "DeliveryConfirmed"),),
            DeliveryConfirmed {
                escrow_id,
                agent,
            },
        );
    }

    /// Escalate a pending escrow to the configured dispute-resolution contract.
    ///
    /// Before the agent confirms delivery, either the sender or the recipient
    /// may open a dispute. After `confirm_delivery` the agent has already paid
    /// out fiat, so only the recipient (who would know the payout never
    /// arrived) may dispute; the sender may not (#1366). The agent is
    /// registered as a dispute party and can be awarded the funds, and a
    /// post-confirmation dispute that expires unresolved pays the agent.
    ///
    /// The full remaining escrow balance is transferred to the dispute-resolution
    /// contract, which takes custody of it for arbitration. The escrow is then
    /// marked `UnderDispute` and can no longer be released, cancelled, deposited
    /// into, or expired. The adjudicated winner is paid by the dispute contract.
    ///
    /// The `caller` pays the dispute contract's filing fee from their own
    /// balance (not from the escrowed funds). It is refunded if they win and
    /// forfeited if they lose, which deters frivolous disputes.
    ///
    /// # Arguments
    /// * `caller`   — The escrow recipient, or the sender before delivery is
    ///                confirmed (auth required).
    /// * `escrow_id` — The escrow to escalate.
    ///
    /// # Returns
    /// The dispute ID assigned by the dispute-resolution contract.
    pub fn dispute_escrow(env: Env, caller: Address, escrow_id: u64) -> u64 {
        bump_instance(&env);
        caller.require_auth();

        let dispute_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::DisputeContractAddress)
            .unwrap_or_else(|| panic_with_error!(env, Error::DisputeContractNotSet));

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        if caller != escrow.sender && caller != escrow.recipient {
            panic_with_error!(env, Error::NotParty);
        }
        if escrow.status != EscrowStatus::Pending {
            panic_with_error!(env, Error::EscrowNotPending);
        }
        if escrow.payout_confirmed && caller == escrow.sender {
            panic_with_error!(env, Error::RecipientOnlyDispute);
        }

        let usdc_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddress)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));

        // Checks-Effects-Interactions: mark the escrow BEFORE any external calls.
        escrow.status = EscrowStatus::UnderDispute;
        escrow.updated_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        // Hand the full remaining balance over to the dispute-resolution contract,
        // which holds it in its own custody until the conflict is adjudicated.
        token::Client::new(&env, &usdc_address).transfer(
            &env.current_contract_address(),
            &dispute_contract,
            &escrow.amount,
        );

        // Record the dispute on-chain with the dispute-resolution contract.
        let dispute_id: u64 = DisputeResolutionClient::new(&env, &dispute_contract)
            .open_escrow_dispute(
                &env.current_contract_address(),
                &caller,
                &escrow_id,
                &escrow.sender,
                &escrow.recipient,
                &escrow.agent,
                &escrow.amount,
                &escrow.payout_confirmed,
            );

        env.storage().persistent().set(
            &DataKey::EscrowDispute(escrow_id),
            &EscrowDispute {
                dispute_contract,
                dispute_id,
            },
        );
        bump_persistent(&env, &DataKey::EscrowDispute(escrow_id));

        env.events().publish(
            (Symbol::new(&env, "EscrowDisputed"),),
            EscrowDisputed {
                escrow_id,
                dispute_id,
                opener: caller,
                agent: escrow.agent.clone(),
                amount: escrow.amount,
                payout_confirmed: escrow.payout_confirmed,
            },
        );

        dispute_id
    }

    /// Record the outcome of a disputed escrow. Called by the dispute-resolution
    /// contract that holds the escrow's funds, after it has paid `winner`.
    ///
    /// Moves the escrow from `UnderDispute` to `Cancelled` if the sender won
    /// (refund) or `Released` otherwise, so it can later be archived with
    /// `cleanup_escrow` (#1367). Emits `EscrowDisputeClosed`.
    pub fn close_disputed_escrow(env: Env, escrow_id: u64, winner: Address) {
        bump_instance(&env);
        let record: EscrowDispute = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowDispute(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::DisputeNotFound));
        bump_persistent(&env, &DataKey::EscrowDispute(escrow_id));
        // Only the dispute contract that took custody of the funds may report
        // the outcome; it is authorised as the direct invoker.
        record.dispute_contract.require_auth();

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));
        if escrow.status != EscrowStatus::UnderDispute {
            panic_with_error!(env, Error::NotUnderDispute);
        }

        escrow.status = if winner == escrow.sender {
            EscrowStatus::Cancelled
        } else {
            EscrowStatus::Released
        };
        escrow.updated_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        env.storage()
            .persistent()
            .set(&DataKey::EscrowDisputeWinner(escrow_id), &winner);
        bump_persistent(&env, &DataKey::EscrowDisputeWinner(escrow_id));

        env.events().publish(
            (Symbol::new(&env, "EscrowDisputeClosed"),),
            EscrowDisputeClosed {
                escrow_id,
                dispute_id: record.dispute_id,
                winner,
                status: escrow.status,
            },
        );
    }

    /// Dispute record for an escrow sent to dispute, or `None` if never disputed.
    pub fn get_escrow_dispute(env: Env, escrow_id: u64) -> Option<EscrowDispute> {
        bump_instance(&env);
        let result = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowDispute(escrow_id));
        if result.is_some() {
            bump_persistent(&env, &DataKey::EscrowDispute(escrow_id));
        }
        result
    }

    /// Party a disputed escrow's dispute paid, or `None` if not yet settled.
    pub fn get_escrow_dispute_winner(env: Env, escrow_id: u64) -> Option<Address> {
        bump_instance(&env);
        let result = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowDisputeWinner(escrow_id));
        if result.is_some() {
            bump_persistent(&env, &DataKey::EscrowDisputeWinner(escrow_id));
        }
        result
    }

    pub fn partial_release(env: Env, agent: Address, escrow_id: u64, amount: i128) {
        bump_instance(&env);
        agent.require_auth();

        if amount <= 0 {
            panic_with_error!(env, Error::InvalidAmount);
        }

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        if agent != escrow.agent {
            panic_with_error!(env, Error::NotAgent);
        }
        if escrow.status != EscrowStatus::Pending {
            panic_with_error!(env, Error::EscrowNotPending);
        }
        // Expiry guard: expired escrows cannot be released by the agent.
        // SC-117: This check was missing, allowing agents to release after expiry.
        if env.ledger().timestamp() >= escrow.expires_at {
            panic_with_error!(env, Error::EscrowExpired);
        }
        if amount > escrow.amount {
            panic_with_error!(env, Error::ReleaseExceedsBalance);
        }

        // SC-117: Fix fee truncation by using checked arithmetic.
        // Old: (amount / 10000).saturating_mul(bps) — truncates for amounts < 10_000.
        // New: (amount * bps) / 10_000 — rounds down in platform's favour.
        let fee_amount = amount
            .checked_mul(escrow.release_fee_bps as i128)
            .expect("fee calc overflow")
            .checked_div(10_000)
            .expect("fee calc underflow");
        let agent_amount = amount.checked_sub(fee_amount).expect("fee exceeds release amount");
        if agent_amount <= 0 {
            panic_with_error!(env, Error::FeeTooHigh);
        }

        let usdc_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddress)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));

        // SC-117: Checks-Effects-Interactions: write state BEFORE token transfers.
        // Soroban prevents re-entrancy by disallowing cross-contract calls that
        // re-enter the same contract instance within a single transaction invocation.
        let current_fees: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::AccumulatedFees, &(current_fees + fee_amount));
        bump_persistent(&env, &DataKey::AccumulatedFees);

        escrow.amount -= amount;
        if escrow.amount == 0 {
            escrow.status = EscrowStatus::Released;
        }
        escrow.updated_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        // External calls after state is committed (Interactions step).
        token::Client::new(&env, &usdc_address).transfer(
            &env.current_contract_address(),
            &escrow.agent,
            &agent_amount,
        );

        env.events().publish(
            (Symbol::new(&env, "PartialRelease"),),
            PartialRelease {
                escrow_id,
                released_amount: amount,
                remaining_amount: escrow.amount,
                fee_amount,
            },
        );
    }

    pub fn set_retention_period(env: Env, admin: Address, retention_secs: u64) {
        require_admin(&env, &admin);
        if retention_secs == 0 {
            panic_with_error!(env, Error::InvalidRetentionPeriod);
        }
        env.storage()
            .instance()
            .set(&DataKey::RetentionPeriodSecs, &retention_secs);
    }

    /// Set the minimum hold period (seconds) before a sender may cancel an
    /// escrow. Admin only. Applies to all pending escrows, measured from each
    /// escrow's `created_at`. Must be at most 7 days.
    pub fn set_cancel_hold_period(env: Env, admin: Address, hold_secs: u64) {
        require_admin(&env, &admin);
        if hold_secs > MAX_CANCEL_HOLD_SECS {
            panic_with_error!(env, Error::HoldPeriodTooLong);
        }
        let old_hold_secs = cancel_hold_period(&env);
        env.storage()
            .instance()
            .set(&DataKey::CancelHoldSecs, &hold_secs);
        env.events().publish(
            (Symbol::new(&env, "CancelHoldPeriodUpdated"),),
            CancelHoldPeriodUpdated {
                old_hold_secs,
                new_hold_secs: hold_secs,
            },
        );
    }

    /// Returns the current cancel hold period in seconds.
    pub fn get_cancel_hold_period(env: Env) -> u64 {
        bump_instance(&env);
        cancel_hold_period(&env)
    }

    /// Returns the earliest ledger timestamp at which the sender may cancel
    /// `escrow_id`.
    pub fn get_cancellable_at(env: Env, escrow_id: u64) -> u64 {
        bump_instance(&env);
        let escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));
        escrow.created_at.saturating_add(cancel_hold_period(&env))
    }

    /// Permissionless cleanup of released/cancelled escrows past the retention
    /// period, callable by anyone to reclaim storage rent. Mirrors the
    /// permissionless `expire_escrow` pattern to avoid adding a snooping burden
    /// on the admin as escrow volume grows.
    pub fn cleanup_escrow(env: Env, escrow_id: u64) {
        bump_instance(&env);
        let escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        if escrow.status != EscrowStatus::Released && escrow.status != EscrowStatus::Cancelled {
            panic_with_error!(env, Error::NotCleanable);
        }

        let retention = retention_period(&env);
        let now = env.ledger().timestamp();
        if now < escrow.updated_at + retention {
            panic_with_error!(env, Error::RetentionNotElapsed);
        }

        env.storage().persistent().remove(&DataKey::Escrow(escrow_id));
        env.storage()
            .persistent()
            .remove(&DataKey::EscrowDispute(escrow_id));
        env.storage()
            .persistent()
            .remove(&DataKey::EscrowDisputeWinner(escrow_id));

        env.events().publish(
            (Symbol::new(&env, "EscrowArchived"),),
            EscrowArchived { escrow_id },
        );
    }

    /// Sender cancels a pending escrow and receives a full refund.
    ///
    /// Only allowed once the cancel hold period (default 24 h, see
    /// [`Self::set_cancel_hold_period`]) has elapsed since creation, and only
    /// while the agent has not yet confirmed delivery. The hold period stops a
    /// sender from front-running an agent who is paying out fiat off-chain.
    pub fn cancel_escrow(env: Env, sender: Address, escrow_id: u64) {
        bump_instance(&env);
        sender.require_auth();

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        if sender != escrow.sender {
            panic_with_error!(env, Error::NotSender);
        }
        if escrow.status != EscrowStatus::Pending {
            panic_with_error!(env, Error::EscrowNotPending);
        }
        if escrow.payout_confirmed {
            panic_with_error!(env, Error::DeliveryConfirmed);
        }
        let cancellable_at = escrow.created_at.saturating_add(cancel_hold_period(&env));
        if env.ledger().timestamp() < cancellable_at {
            panic_with_error!(env, Error::HoldPeriodActive);
        }

        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));

        // Checks-Effects-Interactions: update state BEFORE external token call.
        // Soroban prevents re-entrancy by disallowing cross-contract calls that
        // re-enter the same contract instance within a single transaction invocation.
        escrow.status = EscrowStatus::Cancelled;
        escrow.updated_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        // External call after state is committed (Interactions step).
        token::Client::new(&env, &usdc_address).transfer(
            &env.current_contract_address(),
            &escrow.sender,
            &escrow.amount,
        );

        env.events().publish(
            (Symbol::new(&env, "EscrowCancelled"),),
            EscrowCancelled {
                escrow_id,
                refund_amount: escrow.amount,
            },
        );
    }

    /// Permissionless auto-refund triggered by anyone once the escrow expiry timestamp
    /// has passed. Refunds the full remaining balance to the original sender.
    pub fn expire_escrow(env: Env, escrow_id: u64) {
        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));

        if escrow.status != EscrowStatus::Pending {
            panic_with_error!(env, Error::EscrowNotPending);
        }

        let now = env.ledger().timestamp();
        if now <= escrow.expires_at {
            panic_with_error!(env, Error::EscrowNotExpired);
        }

        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));

        token::Client::new(&env, &usdc_address).transfer(
            &env.current_contract_address(),
            &escrow.sender,
            &escrow.amount,
        );

        escrow.status = EscrowStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "EscrowExpired"),),
            EscrowExpired {
                escrow_id,
                sender: escrow.sender.clone(),
                refund_amount: escrow.amount,
            },
        );
    }

    pub fn get_escrow(env: Env, escrow_id: u64) -> Escrow {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound))
    }

    pub fn get_accumulated_fees(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0)
    }

    pub fn withdraw_fees(env: Env, admin: Address, amount: i128) {
        admin.require_auth();

        if amount <= 0 {
            panic_with_error!(env, Error::InvalidAmount);
        }

        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));

        if admin != stored_admin {
            panic_with_error!(env, Error::Unauthorized);
        }

        let current_fees: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0);

        if amount > current_fees {
            panic_with_error!(env, Error::InsufficientFees);
        }

        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));

        token::Client::new(&env, &usdc_address).transfer(
            &env.current_contract_address(),
            &admin,
            &amount,
        );

        env.storage()
            .persistent()
            .set(&DataKey::AccumulatedFees, &(current_fees - amount));

        env.events().publish(
            (Symbol::new(&env, "FeesWithdrawn"),),
            FeesWithdrawn {
                admin: admin.clone(),
                amount,
            },
        );
    }

    /// Lower the fee of a pending escrow. Only the contract admin can call this.
    ///
    /// The sender agreed to the fee recorded at creation, so the admin may only
    /// reduce it — never raise it after funds are locked (#1365). Emits a
    /// FeeUpdated event with the old and new fee values.
    ///
    /// # Arguments
    /// * `admin`       — Must match the admin set during `initialize`.
    /// * `escrow_id`   — ID of the escrow to update.
    /// * `new_fee_bps` — New fee in basis points; at most the current fee and
    ///                   never above `MAX_FEE_BPS` (1000).
    pub fn update_fee(env: Env, admin: Address, escrow_id: u64, new_fee_bps: u32) {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));

        if admin != stored_admin {
            panic_with_error!(env, Error::Unauthorized);
        }

        if new_fee_bps > MAX_FEE_BPS {
            panic_with_error!(env, Error::FeeTooHigh);
        }

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));

        if escrow.status != EscrowStatus::Pending {
            panic_with_error!(env, Error::EscrowNotPending);
        }
        if new_fee_bps > escrow.release_fee_bps {
            panic_with_error!(env, Error::FeeCanOnlyDecrease);
        }

        let old_fee_bps = escrow.release_fee_bps;
        escrow.release_fee_bps = new_fee_bps;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "FeeUpdated"),),
            FeeUpdated {
                escrow_id,
                old_fee_bps,
                new_fee_bps,
            },
        );
    }

    /// Set the platform fee applied to new escrows. Admin only.
    ///
    /// Bounded by `MAX_FEE_BPS` (10%). Existing escrows keep the fee they were
    /// created with. Emits `PlatformFeeUpdated`.
    pub fn set_fee_bps(env: Env, admin: Address, fee_bps: u32) {
        require_admin(&env, &admin);
        if fee_bps > MAX_FEE_BPS {
            panic_with_error!(env, Error::FeeTooHigh);
        }
        let old_fee_bps = platform_fee_bps(&env);
        env.storage()
            .persistent()
            .set(&DataKey::PlatformFeeBps, &fee_bps);
        env.events().publish(
            (Symbol::new(&env, "PlatformFeeUpdated"),),
            PlatformFeeUpdated {
                old_fee_bps,
                new_fee_bps: fee_bps,
            },
        );
    }

    /// The platform fee (bps) that new escrows will use.
    pub fn get_fee_bps(env: Env) -> u32 {
        platform_fee_bps(&env)
    }

    pub fn get_contract_version(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::ContractVersion)
            .unwrap_or(0)
    }

    pub fn get_metadata(env: Env) -> (Address, Address) {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
        (admin, usdc_address)
    }

    /// Batch create multiple escrows in a single transaction.
    ///
    /// # Arguments
    /// * `sender`  — Payer; must authorise this call.
    /// * `escrows` — Vector of escrow parameters (max 20).
    ///
    /// # Returns
    /// First escrow ID created.
    ///
    /// # Panics
    /// * If batch size exceeds 20
    /// * If any escrow has invalid parameters
    /// * If sender doesn't have sufficient USDC for total amount
    pub fn batch_create_escrow(
        env: Env,
        sender: Address,
        escrows: soroban_sdk::Vec<EscrowParams>,
    ) -> u64 {
        governance::require_not_paused(&env);
        sender.require_auth();

        let batch_size = escrows.len();
        if batch_size > 20 {
            panic_with_error!(env, Error::BatchTooLarge);
        }
        if batch_size == 0 {
            panic_with_error!(env, Error::BatchEmpty);
        }

        // Validate all escrows before creating any
        let mut total_amount: i128 = 0;
        for escrow_params in escrows.iter() {
            if escrow_params.amount < MIN_ESCROW_AMOUNT {
                panic_with_error!(env, Error::AmountBelowMinimum);
            }
            if escrow_params.amount > MAX_ESCROW_AMOUNT {
                panic_with_error!(env, Error::AmountAboveMaximum);
            }
            fee_for_new_escrow(&env, escrow_params.max_fee_bps);
            if sender == escrow_params.recipient
                || sender == escrow_params.agent
                || escrow_params.recipient == escrow_params.agent
            {
                panic_with_error!(env, Error::PartiesNotDistinct);
            }
            total_amount += escrow_params.amount;
        }

        // Transfer total USDC once
        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));

        token::Client::new(&env, &usdc_address).transfer(
            &sender,
            &env.current_contract_address(),
            &total_amount,
        );

        // Create all escrows
        let mut current_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowCounter)
            .unwrap_or(0);

        let first_id = current_id + 1;
        let now = env.ledger().timestamp();
        let release_fee_bps = platform_fee_bps(&env);

        for escrow_params in escrows.iter() {
            let next_id = current_id.checked_add(1).expect("Escrow counter overflow");
            current_id = next_id;

            let escrow = Escrow {
                id: next_id,
                sender: sender.clone(),
                recipient: escrow_params.recipient.clone(),
                agent: escrow_params.agent.clone(),
                amount: escrow_params.amount,
                release_fee_bps,
                status: EscrowStatus::Pending,
                payout_confirmed: false,
                created_at: now,
                updated_at: now,
                expires_at: now + DEFAULT_EXPIRY_SECS,
            };

            env.storage()
                .persistent()
                .set(&DataKey::Escrow(next_id), &escrow);

            env.events().publish(
                (Symbol::new(&env, "EscrowCreated"),),
                EscrowCreated {
                    escrow_id: next_id,
                    sender: sender.clone(),
                    recipient: escrow_params.recipient.clone(),
                    agent: escrow_params.agent.clone(),
                    amount: escrow_params.amount,
                    release_fee_bps,
                },
            );
        }

        env.storage()
            .persistent()
            .set(&DataKey::EscrowCounter, &current_id);

        env.events().publish(
            (Symbol::new(&env, "EscrowBatchCreated"),),
            EscrowBatchCreated {
                batch_size: batch_size as u32,
                first_escrow_id: first_id,
                last_escrow_id: current_id,
                total_amount,
            },
        );

        first_id
    }

    /// Set the KYC contract address, enabling KYC checks on escrow creation.
    /// Only admin may call this. Use `set_kyc_required(false)` to disable
    /// enforcement.
    pub fn set_kyc_contract(env: Env, admin: Address, kyc_contract: Address) {
        require_admin(&env, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::KycContractAddress, &kyc_contract);
    }

    /// Remove the KYC contract address. Only admin may call this.
    ///
    /// If KYC is still required, escrow creation fails closed until a new KYC
    /// contract is configured or KYC is explicitly disabled with
    /// `set_kyc_required(false)`.
    pub fn clear_kyc_contract(env: Env, admin: Address) {
        require_admin(&env, &admin);
        env.storage()
            .persistent()
            .remove(&DataKey::KycContractAddress);
    }

    /// Enable or disable KYC enforcement on escrow creation. Admin only.
    ///
    /// Turning KYC off is an explicit, auditable action: it emits
    /// `KycCheckDisabled`. Turning it back on emits `KycCheckEnabled`.
    pub fn set_kyc_required(env: Env, admin: Address, required: bool) {
        require_admin(&env, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::KycRequired, &required);
        if required {
            env.events().publish(
                (Symbol::new(&env, "KycCheckEnabled"),),
                KycCheckEnabled { admin },
            );
        } else {
            env.events().publish(
                (Symbol::new(&env, "KycCheckDisabled"),),
                KycCheckDisabled { admin },
            );
        }
    }

    /// Whether KYC enforcement is currently enabled.
    pub fn get_kyc_required(env: Env) -> bool {
        kyc_required(&env)
    }

    /// Set the KYC tier required for escrow creation. Admin only.
    ///
    /// `tier` is the `u32` discriminant of `afripay_types::KycTier`.
    pub fn set_required_kyc_tier(env: Env, admin: Address, tier: u32) {
        require_admin(&env, &admin);
        let old_tier = required_kyc_tier(&env);
        env.storage()
            .persistent()
            .set(&DataKey::RequiredKycTier, &tier);
        env.events().publish(
            (Symbol::new(&env, "RequiredKycTierUpdated"),),
            RequiredKycTierUpdated {
                old_tier,
                new_tier: tier,
            },
        );
    }

    /// The KYC tier required for escrow creation, as a `u32`.
    pub fn get_required_kyc_tier(env: Env) -> u32 {
        required_kyc_tier(&env)
    }

    /// Set the dispute-resolution contract address. Only admin may call this.
    pub fn set_dispute_contract(env: Env, admin: Address, dispute_contract: Address) {
        require_admin(&env, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::DisputeContractAddress, &dispute_contract);
    }

    /// Get the dispute-resolution contract address, or None if not set.
    pub fn get_dispute_contract(env: Env) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::DisputeContractAddress)
    }

    /// Get the KYC contract address, or None if not set.
    pub fn get_kyc_contract(env: Env) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::KycContractAddress)
    }

    /// Propose a new admin. The current admin must authorise this call.
    ///
    /// The proposal only takes effect after `UPGRADE_TIMELOCK_SECS` and once
    /// the proposed admin calls [`Self::accept_admin`]. Emits `AdminProposed`.
    ///
    /// It is strongly recommended that the admin be a multisig account or the
    /// `multisig-approval` contract, so a single lost or compromised key cannot
    /// take over governance.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) {
        governance::propose_admin(&env, &admin, &new_admin);
    }

    /// Accept a pending admin proposal. The proposed admin must authorise this
    /// call, and the timelock must have elapsed. Emits `AdminChanged`.
    pub fn accept_admin(env: Env, new_admin: Address) {
        governance::accept_admin(&env, &new_admin);
    }

    /// Cancel a pending admin proposal. Only the current admin may call this.
    pub fn cancel_admin_proposal(env: Env, admin: Address) {
        governance::cancel_admin_proposal(&env, &admin);
    }

    /// The pending admin proposal, if any.
    pub fn get_pending_admin(env: Env) -> Option<governance::PendingAdmin> {
        governance::get_pending_admin(&env)
    }

    /// The current admin address.
    pub fn get_admin(env: Env) -> Address {
        governance::get_admin(&env)
    }
}

// SC-214: this contract implements its interface from `afripay-types`, so the
// compiler checks the exported signature against the one consumers call.
// Changing the entry point without updating the shared trait breaks this build;
// updating the trait breaks every consumer still using the old signature.
impl afripay_types::EscrowInterface for EscrowContract {
    fn close_disputed_escrow(env: Env, escrow_id: u64, winner: Address) {
        EscrowContract::close_disputed_escrow(env, escrow_id, winner)
    }
}

mod governance;
pub use governance::{CONTRACT_VERSION, UPGRADE_TIMELOCK_SECS};
