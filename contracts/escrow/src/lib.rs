#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, IntoVal, String, Symbol};

#[cfg(test)]
mod test;

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

/// Strkey of the contract address whose 32 id bytes are all zero. Setting the
/// KYC contract to this address disables KYC checks.
const ZERO_CONTRACT_ADDRESS: &str = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

fn require_admin(env: &Env, admin: &Address) {
    bump_instance(env);
    admin.require_auth();
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("Contract not initialized");
    if admin != &stored_admin {
        panic!("Only admin can perform this action");
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
        panic!("Platform fee exceeds max_fee_bps");
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

/// Helper function to check KYC verification via cross-contract call.
/// Returns true when no KYC contract is configured (KYC checking disabled);
/// otherwise asks the configured kyc-attestation contract.
fn is_kyc_verified(env: &Env, wallet: &Address) -> bool {
    let kyc_contract: Option<Address> = env
        .storage()
        .instance()
        .get(&DataKey::KycContractAddress);

    match kyc_contract {
        None => true, // KYC checking disabled
        Some(addr) => {
            // Check if address is zero (all bytes are 0)
            // Strkey of the all-zero contract id.
            let zero_addr = Address::from_str(env, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4");
            // Check if address is the all-zero contract address
            let zero_addr = Address::from_string(&String::from_str(env, ZERO_CONTRACT_ADDRESS));
            if addr == zero_addr {
                true // KYC checking disabled
            } else {
                // Cross-contract call to kyc-attestation contract
                env.invoke_contract::<bool>(
                    &addr,
                    &Symbol::new(env, "is_verified"),
                    soroban_sdk::vec![env, wallet.clone().into_val(env)],
                )
            }
        }
        Some(addr) => env.invoke_contract::<bool>(
            &addr,
            &Symbol::new(env, "is_verified"),
            soroban_sdk::vec![env, wallet.clone().into_val(env)],
        ),
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
    pub fn initialize(env: Env, admin: Address, usdc_address: Address) {
        bump_instance(&env);
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialized");
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
            .expect("Contract not initialized");

        if admin != stored_admin {
            panic!("Only admin can upgrade the contract");
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
            panic!("Amount below minimum (100 stroops)");
        }
        if amount > MAX_ESCROW_AMOUNT {
            panic!("Amount exceeds maximum escrow amount");
        }
        let release_fee_bps = fee_for_new_escrow(&env, max_fee_bps);
        if sender == recipient || sender == agent || recipient == agent {
            panic!("Sender, recipient, and agent must be distinct addresses");
        }

        sender.require_auth();

        // KYC verification for sender and agent
        if !is_kyc_verified(&env, &sender) {
            panic!("KYC verification required for sender");
        }
        if !is_kyc_verified(&env, &agent) {
            panic!("KYC verification required for agent");
        }

        let usdc_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

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
            panic!("Amount must be positive");
        }

        sender.require_auth();

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }

        if env.ledger().timestamp() >= escrow.expires_at {
            panic!("Escrow has expired");
        }

        let usdc_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

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
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        if agent != escrow.agent {
            panic!("Only the agent can release escrow");
        }
        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }
        // Expiry guard: expired escrows must be cancelled by the sender via
        // cancel_escrow — the agent cannot release funds after the protection window.
        if env.ledger().timestamp() >= escrow.expires_at {
            panic!("Escrow has expired");
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
            panic!("fee cannot exceed 100% of escrow");
        }

        let usdc_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

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
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        if agent != escrow.agent {
            panic!("Only the agent can confirm delivery");
        }
        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }
        if escrow.payout_confirmed {
            panic!("Delivery has already been confirmed");
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
            .expect("Dispute resolution contract not configured");

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        if caller != escrow.sender && caller != escrow.recipient {
            panic!("Only the sender or recipient can dispute escrow");
        }
        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }
        if escrow.payout_confirmed && caller == escrow.sender {
            panic!("Delivery confirmed: only the recipient can dispute");
        }

        let usdc_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

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
        let dispute_id: u64 = env.invoke_contract::<u64>(
            &dispute_contract,
            &Symbol::new(&env, "open_escrow_dispute"),
            soroban_sdk::vec![
                &env,
                env.current_contract_address().into_val(&env),
                caller.clone().into_val(&env),
                escrow_id.into_val(&env),
                escrow.sender.clone().into_val(&env),
                escrow.recipient.clone().into_val(&env),
                escrow.agent.clone().into_val(&env),
                escrow.amount.into_val(&env),
                escrow.payout_confirmed.into_val(&env)
            ],
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
            .expect("Escrow has no dispute");
        bump_persistent(&env, &DataKey::EscrowDispute(escrow_id));
        // Only the dispute contract that took custody of the funds may report
        // the outcome; it is authorised as the direct invoker.
        record.dispute_contract.require_auth();

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));
        if escrow.status != EscrowStatus::UnderDispute {
            panic!("Escrow is not under dispute");
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
            panic!("Amount must be positive");
        }

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        if agent != escrow.agent {
            panic!("Only the agent can release escrow");
        }
        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }
        // Expiry guard: expired escrows cannot be released by the agent.
        // SC-117: This check was missing, allowing agents to release after expiry.
        if env.ledger().timestamp() >= escrow.expires_at {
            panic!("Escrow has expired");
        }
        if amount > escrow.amount {
            panic!("Release amount exceeds escrow balance");
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
            panic!("fee cannot exceed 100% of escrow");
        }

        let usdc_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

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
            panic!("Retention period must be positive");
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
            panic!("Hold period exceeds maximum of 7 days");
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
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));
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
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        if escrow.status != EscrowStatus::Released && escrow.status != EscrowStatus::Cancelled {
            panic!("Only released or cancelled escrows can be cleaned up");
        }

        let retention = retention_period(&env);
        let now = env.ledger().timestamp();
        if now < escrow.updated_at + retention {
            panic!("Escrow retention period has not elapsed");
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
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));
        bump_persistent(&env, &DataKey::Escrow(escrow_id));

        if sender != escrow.sender {
            panic!("Only the sender can cancel escrow");
        }
        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }
        if escrow.payout_confirmed {
            panic!("Cannot cancel: agent has confirmed delivery");
        }
        let cancellable_at = escrow.created_at.saturating_add(cancel_hold_period(&env));
        if env.ledger().timestamp() < cancellable_at {
            panic!("Cannot cancel: hold period has not elapsed");
        }

        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

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
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }

        let now = env.ledger().timestamp();
        if now <= escrow.expires_at {
            panic!("Escrow has not expired yet");
        }

        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

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
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id))
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
            panic!("Amount must be positive");
        }

        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");

        if admin != stored_admin {
            panic!("Only admin can withdraw fees");
        }

        let current_fees: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0);

        if amount > current_fees {
            panic!("Insufficient accumulated fees");
        }

        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

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
            .expect("Contract not initialized");

        if admin != stored_admin {
            panic!("Only admin can update escrow fees");
        }

        if new_fee_bps > MAX_FEE_BPS {
            panic!("New fee exceeds maximum of 1000 bps (10%)");
        }

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }
        if new_fee_bps > escrow.release_fee_bps {
            panic!("Fee on an existing escrow can only be lowered");
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
            panic!("Fee exceeds maximum of 1000 bps (10%)");
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
            .expect("Contract not initialized");
        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");
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
            panic!("Batch size exceeds maximum of 20");
        }
        if batch_size == 0 {
            panic!("Batch cannot be empty");
        }

        // Validate all escrows before creating any
        let mut total_amount: i128 = 0;
        for escrow_params in escrows.iter() {
            if escrow_params.amount < MIN_ESCROW_AMOUNT {
                panic!("Amount below minimum (100 stroops)");
            }
            if escrow_params.amount > MAX_ESCROW_AMOUNT {
                panic!("Amount exceeds maximum escrow amount");
            }
            fee_for_new_escrow(&env, escrow_params.max_fee_bps);
            if sender == escrow_params.recipient
                || sender == escrow_params.agent
                || escrow_params.recipient == escrow_params.agent
            {
                panic!("Sender, recipient, and agent must be distinct addresses");
            }
            total_amount += escrow_params.amount;
        }

        // Transfer total USDC once
        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

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
    /// Only admin may call this. Use `clear_kyc_contract` to disable checks.
    pub fn set_kyc_contract(env: Env, admin: Address, kyc_contract: Address) {
        require_admin(&env, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::KycContractAddress, &kyc_contract);
    }

    /// Remove the KYC contract address, disabling KYC checks.
    /// Only admin may call this.
    pub fn clear_kyc_contract(env: Env, admin: Address) {
        require_admin(&env, &admin);
        env.storage()
            .persistent()
            .remove(&DataKey::KycContractAddress);
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
}

mod governance;
pub use governance::{CONTRACT_VERSION, UPGRADE_TIMELOCK_SECS};
