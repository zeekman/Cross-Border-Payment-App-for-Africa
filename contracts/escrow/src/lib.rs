#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, IntoVal, Symbol};

mod test;

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 3;

#[derive(Clone)]
#[contracttype]
pub struct EscrowCreated {
    pub escrow_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub agent: Address,
    pub amount: i128,
    pub release_fee_bps: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct EscrowReleased {
    pub escrow_id: u64,
    pub agent_amount: i128,
    pub fee_amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct EscrowPartiallyReleased {
    pub escrow_id: u64,
    pub released_amount: i128,
    pub agent_amount: i128,
    pub fee_amount: i128,
    pub remaining_amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct EscrowCancelled {
    pub escrow_id: u64,
    pub refund_amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct EscrowExpired {
    pub escrow_id: u64,
    pub sender: Address,
    pub refund_amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct EscrowBatchCreated {
    pub batch_size: u32,
    pub first_escrow_id: u64,
    pub last_escrow_id: u64,
    pub total_amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct EscrowParams {
    pub recipient: Address,
    pub agent: Address,
    pub amount: i128,
    pub release_fee_bps: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct DeliveryConfirmed {
    pub escrow_id: u64,
    pub agent: Address,
}

#[derive(Clone)]
#[contracttype]
pub struct PartialRelease {
    pub escrow_id: u64,
    pub released_amount: i128,
    pub remaining_amount: i128,
    pub fee_amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct EscrowArchived {
    pub escrow_id: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct Upgraded {
    pub new_wasm_hash: BytesN<32>,
    pub contract_version: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct Migrated {
    pub contract_version: u32,
}

#[derive(Clone, Debug)]
#[contracttype]
pub struct FeesWithdrawn {
    pub admin: Address,
    pub amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct FeeUpdated {
    pub escrow_id: u64,
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

#[derive(Clone)]
#[contracttype]
pub struct EscrowDisputed {
    pub escrow_id: u64,
    pub dispute_id: u64,
    pub opener: Address,
    pub amount: i128,
}

#[derive(Clone)]
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

#[derive(Clone, Copy, PartialEq, Eq)]
#[contracttype]
pub enum EscrowStatus {
    Pending,
    Released,
    Cancelled,
    /// Escrowed funds have been handed to the dispute-resolution contract and
    /// the escrow is awaiting (or already subject to) arbitration. In this state
    /// the escrow can no longer be released, cancelled, deposited into, or
    /// expired — the winning party is paid directly by the dispute contract.
    UnderDispute,
}

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
}

const DEFAULT_EXPIRY_SECS: u64 = 30 * 24 * 60 * 60;
const DEFAULT_RETENTION_SECS: u64 = 90 * 24 * 60 * 60;

/// Maximum allowed fee: 10% (1000 bps) per issue #766.
const MAX_FEE_BPS: u32 = 1000;

/// Minimum escrow amount in stroops to prevent integer-division rounding to zero fee.
const MIN_ESCROW_AMOUNT: i128 = 100;

// SECURITY: i128 max is ~170 trillion USDC in stroops (1.7 * 10^20).
// MAX_ESCROW_AMOUNT = 1,000,000 USDC = 10_000_000_000_000 stroops.
// Intermediate fee calc uses (amount / 10000).saturating_mul(bps) to prevent overflow.
const MAX_ESCROW_AMOUNT: i128 = 10_000_000_000_000;

fn require_admin(env: &Env, admin: &Address) {
    admin.require_auth();
    let stored_admin: Address = env
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("Contract not initialized");
    if admin != &stored_admin {
        panic!("Only admin can perform this action");
    }
}

fn retention_period(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::RetentionPeriodSecs)
        .unwrap_or(DEFAULT_RETENTION_SECS)
}

/// Helper function to check KYC verification via cross-contract call.
/// Returns true if KYC is verified or if KYC checking is disabled (zero address).
fn is_kyc_verified(env: &Env, wallet: &Address) -> bool {
    let kyc_contract: Option<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::KycContractAddress);

    match kyc_contract {
        None => true, // KYC checking disabled
        Some(addr) => {
            // Check if address is zero (all bytes are 0)
            let zero_addr = Address::from_contract_id(env, &[0u8; 32]);
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
    pub fn initialize(env: Env, admin: Address, usdc_address: Address) {
        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("Contract already initialized");
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::UsdcAddress, &usdc_address);
        env.storage().persistent().set(&DataKey::EscrowCounter, &0u64);
        env.storage()
            .persistent()
            .set(&DataKey::ContractVersion, &CONTRACT_VERSION);
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
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .persistent()
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
            .persistent()
            .get(&DataKey::ContractVersion)
            .unwrap_or(0);

        if current_version >= CONTRACT_VERSION {
            return;
        }

        env.storage()
            .persistent()
            .set(&DataKey::ContractVersion, &CONTRACT_VERSION);

        env.events().publish(
            (Symbol::new(&env, "Migrated"),),
            Migrated {
                contract_version: CONTRACT_VERSION,
            },
        );
    }

    pub fn create_escrow(
        env: Env,
        sender: Address,
        recipient: Address,
        agent: Address,
        amount: i128,
        release_fee_bps: u32,
    ) -> u64 {
        if amount < MIN_ESCROW_AMOUNT {
            panic!("Amount below minimum (100 stroops)");
        }
        if amount > MAX_ESCROW_AMOUNT {
            panic!("Amount exceeds maximum escrow amount");
        }
        if release_fee_bps == 10000 {
            panic!("Fee cannot be 100%");
        }
        if release_fee_bps > MAX_FEE_BPS {
            panic!("Fee exceeds maximum of 1000 bps (10%)");
        }
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
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

        let current_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowCounter)
            .unwrap_or(0);
        // u64::MAX is 18,446,744,073,709,551,615. At one escrow per second,
        // exhausting the counter would take ~584 billion years.
        let next_id = current_id.checked_add(1).expect("Escrow counter overflow");
        env.storage()
            .persistent()
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
        if amount <= 0 {
            panic!("Amount must be positive");
        }

        sender.require_auth();

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }

        if env.ledger().timestamp() >= escrow.expires_at {
            panic!("Escrow has expired");
        }

        let usdc_address: Address = env
            .storage()
            .persistent()
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
        agent.require_auth();

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

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

        let fee_amount = (escrow.amount / 10000).saturating_mul(escrow.release_fee_bps as i128);
        let agent_amount = escrow.amount.checked_sub(fee_amount).expect("fee exceeds escrow amount");
        if agent_amount <= 0 {
            panic!("fee cannot exceed 100% of escrow");
        }

        let usdc_address: Address = env
            .storage()
            .persistent()
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

        escrow.status = EscrowStatus::Released;
        escrow.updated_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

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
        agent.require_auth();

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

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
    /// Either the escrow sender or recipient may open a dispute — this is the
    /// sender's recourse when the agent has confirmed delivery but has not
    /// released funds (and `cancel_escrow` is therefore blocked).
    ///
    /// The full remaining escrow balance is transferred to the dispute-resolution
    /// contract, which takes custody of it for arbitration. The escrow is then
    /// marked `UnderDispute` and can no longer be released, cancelled, deposited
    /// into, or expired. The adjudicated winner is paid by the dispute contract.
    ///
    /// # Arguments
    /// * `caller`   — Must be the escrow sender or recipient (auth required).
    /// * `escrow_id` — The escrow to escalate.
    ///
    /// # Returns
    /// The dispute ID assigned by the dispute-resolution contract.
    pub fn dispute_escrow(env: Env, caller: Address, escrow_id: u64) -> u64 {
        caller.require_auth();

        let dispute_contract: Address = env
            .storage()
            .persistent()
            .get(&DataKey::DisputeContractAddress)
            .expect("Dispute resolution contract not configured");

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if caller != escrow.sender && caller != escrow.recipient {
            panic!("Only the sender or recipient can dispute escrow");
        }
        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }

        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

        // Checks-Effects-Interactions: mark the escrow BEFORE any external calls.
        escrow.status = EscrowStatus::UnderDispute;
        escrow.updated_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

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
                escrow.sender.clone().into_val(&env),
                escrow.recipient.clone().into_val(&env),
                escrow.amount.into_val(&env)
            ],
        );

        env.events().publish(
            (Symbol::new(&env, "EscrowDisputed"),),
            EscrowDisputed {
                escrow_id,
                dispute_id,
                opener: caller,
                amount: escrow.amount,
            },
        );

        dispute_id
    }

    pub fn partial_release(env: Env, agent: Address, escrow_id: u64, amount: i128) {
        agent.require_auth();

        if amount <= 0 {
            panic!("Amount must be positive");
        }

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if agent != escrow.agent {
            panic!("Only the agent can release escrow");
        }
        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }
        if amount > escrow.amount {
            panic!("Release amount exceeds escrow balance");
        }

        let fee_amount = (amount / 10000).saturating_mul(escrow.release_fee_bps as i128);
        let agent_amount = amount.checked_sub(fee_amount).expect("fee exceeds release amount");
        if agent_amount <= 0 {
            panic!("fee cannot exceed 100% of escrow");
        }

        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

        token::Client::new(&env, &usdc_address).transfer(
            &env.current_contract_address(),
            &escrow.agent,
            &agent_amount,
        );

        let current_fees: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::AccumulatedFees, &(current_fees + fee_amount));

        escrow.amount -= amount;
        if escrow.amount == 0 {
            escrow.status = EscrowStatus::Released;
        }
        escrow.updated_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

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
            .persistent()
            .set(&DataKey::RetentionPeriodSecs, &retention_secs);
    }

    /// Permissionless cleanup of released/cancelled escrows past the retention
    /// period, callable by anyone to reclaim storage rent. Mirrors the
    /// permissionless `expire_escrow` pattern to avoid adding a snooping burden
    /// on the admin as escrow volume grows.
    pub fn cleanup_escrow(env: Env, escrow_id: u64) {
        let escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if escrow.status != EscrowStatus::Released && escrow.status != EscrowStatus::Cancelled {
            panic!("Only released or cancelled escrows can be cleaned up");
        }

        let retention = retention_period(&env);
        let now = env.ledger().timestamp();
        if now < escrow.updated_at + retention {
            panic!("Escrow retention period has not elapsed");
        }

        env.storage().persistent().remove(&DataKey::Escrow(escrow_id));

        env.events().publish(
            (Symbol::new(&env, "EscrowArchived"),),
            EscrowArchived { escrow_id },
        );
    }

    pub fn cancel_escrow(env: Env, sender: Address, escrow_id: u64) {
        sender.require_auth();

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if sender != escrow.sender {
            panic!("Only the sender can cancel escrow");
        }
        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }
        if escrow.payout_confirmed {
            panic!("Cannot cancel: agent has confirmed delivery");
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

    /// Update the fee for an escrow. Only the contract admin can call this.
    ///
    /// The escrow must be in Pending status. Emits a FeeUpdated event with the
    /// old and new fee values.
    ///
    /// # Arguments
    /// * `admin`       — Must match the admin set during `initialize`.
    /// * `escrow_id`   — ID of the escrow to update.
    /// * `new_fee_bps` — New fee in basis points (0–5000).
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
            panic!("New fee exceeds maximum of 5000 bps (50%)");
        }

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
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
            if escrow_params.release_fee_bps == 10000 {
                panic!("Fee cannot be 100%");
            }
            if escrow_params.release_fee_bps > MAX_FEE_BPS {
                panic!("Fee exceeds maximum of 1000 bps (10%)");
            }
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

        for escrow_params in escrows.iter() {
            let next_id = current_id.checked_add(1).expect("Escrow counter overflow");
            current_id = next_id;

            let escrow = Escrow {
                id: next_id,
                sender: sender.clone(),
                recipient: escrow_params.recipient.clone(),
                agent: escrow_params.agent.clone(),
                amount: escrow_params.amount,
                release_fee_bps: escrow_params.release_fee_bps,
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
                    release_fee_bps: escrow_params.release_fee_bps,
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

    /// Set the KYC contract address. Only admin may call this.
    /// Pass a zero address (all bytes 0) to disable KYC checking.
    pub fn set_kyc_contract(env: Env, admin: Address, kyc_contract: Address) {
        require_admin(&env, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::KycContractAddress, &kyc_contract);
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
