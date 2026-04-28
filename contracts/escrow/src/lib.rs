#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol};

mod test;

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
pub struct EscrowCancelled {
    pub escrow_id: u64,
    pub refund_amount: i128,
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
    pub created_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[contracttype]
pub enum EscrowStatus {
    Pending,
    Released,
    Cancelled,
}

#[contracttype]
pub enum DataKey {
    Admin,
    UsdcAddress,
    EscrowCounter,
    AccumulatedFees,
    Escrow(u64),
}

const DEFAULT_EXPIRY_SECS: u64 = 30 * 24 * 60 * 60;

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    pub fn initialize(env: Env, admin: Address, usdc_address: Address) {
        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("Contract already initialized");
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::UsdcAddress, &usdc_address);
        env.storage().persistent().set(&DataKey::EscrowCounter, &0u64);
        env.events().publish(
            (Symbol::new(&env, "EscrowInitialized"),),
            (env.current_contract_address(), admin, usdc_address),
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
        if amount <= 0 {
            panic!("Amount must be positive");
        }
        if release_fee_bps > 10000 {
            panic!("Fee percentage cannot exceed 100%");
        }
        if sender == recipient || sender == agent || recipient == agent {
            panic!("Sender, recipient, and agent must be distinct addresses");
        }

        sender.require_auth();

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

        let current_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowCounter)
            .unwrap_or(0);
        let next_id = current_id + 1;
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
            created_at: now,
            expires_at: now + DEFAULT_EXPIRY_SECS,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(next_id), &escrow);

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

        let fee_amount = (escrow.amount * escrow.release_fee_bps as i128) / 10000;
        let agent_amount = escrow.amount - fee_amount;

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

        escrow.status = EscrowStatus::Released;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "EscrowReleased"),),
            EscrowReleased {
                escrow_id,
                agent_amount,
                fee_amount,
            },
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
            (Symbol::new(&env, "EscrowCancelled"),),
            EscrowCancelled {
                escrow_id,
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
}
