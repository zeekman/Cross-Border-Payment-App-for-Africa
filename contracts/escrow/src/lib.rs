#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol, Vec, String as SorobanString};

// ===== Event Types =====
#[derive(Clone)]
#[contracttype]
pub struct EscrowInitialized {
    pub contract_id: Address,
    pub admin: Address,
    pub usdc_address: Address,
}

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

// ===== Data Models =====
#[derive(Clone)]
#[contracttype]
pub struct Escrow {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub agent: Address,
    pub amount: i128,
    pub release_fee_bps: u32, // Fee in basis points (100 bps = 1%)
    pub status: EscrowStatus,
    pub created_at: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[contracttype]
#[repr(u32)]
pub enum EscrowStatus {
    Pending = 0,
    Released = 1,
    Cancelled = 2,
}

// ===== Soroban Contract =====
#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Initialize the escrow contract
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `admin` - The admin address that can configure the contract
    /// * `usdc_address` - The USDC token address on Stellar
    pub fn initialize(env: Env, admin: Address, usdc_address: Address) {
        // Verify admin is not already initialized
        let admin_key = Symbol::new(&env, "admin");
        if env.storage().persistent().has(&admin_key) {
            panic!("Contract already initialized");
        }

        // Store admin and USDC address
        env.storage().persistent().set(&admin_key, &admin);
        
        let usdc_key = Symbol::new(&env, "usdc_address");
        env.storage().persistent().set(&usdc_key, &usdc_address);

        // Initialize escrow counter
        let counter_key = Symbol::new(&env, "escrow_counter");
        env.storage().persistent().set(&counter_key, &0u64);

        // Emit initialization event
        let event = EscrowInitialized {
            contract_id: env.current_contract_address(),
            admin: admin.clone(),
            usdc_address: usdc_address.clone(),
        };
        env.events().publish((Symbol::new(&env, "EscrowInitialized"),), event);
    }

    /// Create a new escrow
    /// # Arguments
    /// * `sender` - The sender's Stellar address
    /// * `recipient` - The recipient's Stellar address
    /// * `agent` - The payout agent's Stellar address
    /// * `amount` - Amount in stroops (USDC satoshis)
    /// * `release_fee_bps` - Release fee in basis points
    /// Returns: The escrow ID
    pub fn create_escrow(
        env: Env,
        sender: Address,
        recipient: Address,
        agent: Address,
        amount: i128,
        release_fee_bps: u32,
    ) -> u64 {
        // Validate inputs
        if amount <= 0 {
            panic!("Amount must be positive");
        }
        if release_fee_bps > 10000 {
            panic!("Fee percentage cannot exceed 100%");
        }

        // Get USDC token address
        let usdc_key = Symbol::new(&env, "usdc_address");
        let usdc_address: Address = env.storage().persistent().get(&usdc_key)
            .expect("Contract not initialized");

        // Transfer USDC from sender to this contract
        // Uses Stellar's token interface
        soroban_sdk::token::Client::new(&env, &usdc_address).transfer(
            &sender,
            &env.current_contract_address(),
            &amount,
        );

        // Increment and get next escrow ID
        let counter_key = Symbol::new(&env, "escrow_counter");
        let current_id: u64 = env.storage().persistent().get(&counter_key).unwrap_or(0);
        let next_id = current_id + 1;
        env.storage().persistent().set(&counter_key, &next_id);

        // Create escrow record
        let escrow = Escrow {
            id: next_id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            agent: agent.clone(),
            amount,
            release_fee_bps,
            status: EscrowStatus::Pending,
            created_at: env.ledger().timestamp(),
        };

        // Store escrow
        let escrow_key = Symbol::new(&env, &format!("escrow_{}", next_id));
        env.storage().persistent().set(&escrow_key, &escrow);

        // Emit event
        let event = EscrowCreated {
            escrow_id: next_id,
            sender,
            recipient,
            agent,
            amount,
            release_fee_bps,
        };
        env.events().publish((Symbol::new(&env, "EscrowCreated"),), event);

        next_id
    }

    /// Release escrow funds to the agent after payout confirmation
    /// Only the agent can call this function
    /// # Arguments
    /// * `escrow_id` - The ID of the escrow to release
    pub fn release_escrow(env: Env, escrow_id: u64) {
        // Get the escrow
        let escrow_key = Symbol::new(&env, &format!("escrow_{}", escrow_id));
        let mut escrow: Escrow = env.storage().persistent().get(&escrow_key)
            .expect("Escrow not found");

        // Verify caller is the agent
        let caller = env.invoker();
        if caller != escrow.agent {
            panic!("Only the agent can release escrow");
        }

        // Verify escrow is still pending
        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }

        // Calculate fee and agent amount
        let fee_amount = (escrow.amount * escrow.release_fee_bps as i128) / 10000;
        let agent_amount = escrow.amount - fee_amount;

        // Get USDC token
        let usdc_key = Symbol::new(&env, "usdc_address");
        let usdc_address: Address = env.storage().persistent().get(&usdc_key).unwrap();

        // Transfer agent amount to agent
        soroban_sdk::token::Client::new(&env, &usdc_address).transfer(
            &env.current_contract_address(),
            &escrow.agent,
            &agent_amount,
        );

        // Accumulate fees in contract
        let fees_key = Symbol::new(&env, "accumulated_fees");
        let current_fees: i128 = env.storage().persistent().get(&fees_key).unwrap_or(0);
        env.storage().persistent().set(&fees_key, &(current_fees + fee_amount));

        // Update escrow status
        escrow.status = EscrowStatus::Released;
        env.storage().persistent().set(&escrow_key, &escrow);

        // Emit event
        let event = EscrowReleased {
            escrow_id,
            agent_amount,
            fee_amount,
        };
        env.events().publish((Symbol::new(&env, "EscrowReleased"),), event);
    }

    /// Cancel an escrow and refund to sender
    /// Only the sender can initiate cancellation
    /// # Arguments
    /// * `escrow_id` - The ID of the escrow to cancel
    pub fn cancel_escrow(env: Env, escrow_id: u64) {
        // Get the escrow
        let escrow_key = Symbol::new(&env, &format!("escrow_{}", escrow_id));
        let mut escrow: Escrow = env.storage().persistent().get(&escrow_key)
            .expect("Escrow not found");

        // Verify caller is the sender
        let caller = env.invoker();
        if caller != escrow.sender {
            panic!("Only the sender can cancel escrow");
        }

        // Verify escrow is still pending
        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }

        // Get USDC token
        let usdc_key = Symbol::new(&env, "usdc_address");
        let usdc_address: Address = env.storage().persistent().get(&usdc_key).unwrap();

        // Refund sender
        soroban_sdk::token::Client::new(&env, &usdc_address).transfer(
            &env.current_contract_address(),
            &escrow.sender,
            &escrow.amount,
        );

        // Update escrow status
        escrow.status = EscrowStatus::Cancelled;
        env.storage().persistent().set(&escrow_key, &escrow);

        // Emit event
        let event = EscrowCancelled {
            escrow_id,
            refund_amount: escrow.amount,
        };
        env.events().publish((Symbol::new(&env, "EscrowCancelled"),), event);
    }

    /// Get escrow details
    /// # Arguments
    /// * `escrow_id` - The ID of the escrow to retrieve
    pub fn get_escrow(env: Env, escrow_id: u64) -> Escrow {
        let escrow_key = Symbol::new(&env, &format!("escrow_{}", escrow_id));
        env.storage().persistent().get(&escrow_key)
            .expect("Escrow not found")
    }

    /// Get accumulated platform fees
    pub fn get_accumulated_fees(env: Env) -> i128 {
        let fees_key = Symbol::new(&env, "accumulated_fees");
        env.storage().persistent().get(&fees_key).unwrap_or(0)
    }

    /// Withdraw accumulated fees (admin only)
    /// # Arguments
    /// * `amount` - Amount of fees to withdraw
    pub fn withdraw_fees(env: Env, amount: i128) {
        // Verify caller is admin
        let admin_key = Symbol::new(&env, "admin");
        let admin: Address = env.storage().persistent().get(&admin_key).unwrap();
        
        let caller = env.invoker();
        if caller != admin {
            panic!("Only admin can withdraw fees");
        }

        // Get accumulated fees
        let fees_key = Symbol::new(&env, "accumulated_fees");
        let current_fees: i128 = env.storage().persistent().get(&fees_key).unwrap_or(0);
        
        if amount > current_fees {
            panic!("Insufficient accumulated fees");
        }

        // Get USDC token
        let usdc_key = Symbol::new(&env, "usdc_address");
        let usdc_address: Address = env.storage().persistent().get(&usdc_key).unwrap();

        // Transfer fees to admin
        soroban_sdk::token::Client::new(&env, &usdc_address).transfer(
            &env.current_contract_address(),
            &admin,
            &amount,
        );

        // Update accumulated fees
        env.storage().persistent().set(&fees_key, &(current_fees - amount));
    }

    /// Get contract metadata
    pub fn get_metadata(env: Env) -> (Address, Address) {
        let admin_key = Symbol::new(&env, "admin");
        let admin: Address = env.storage().persistent().get(&admin_key).unwrap();
        
        let usdc_key = Symbol::new(&env, "usdc_address");
        let usdc_address: Address = env.storage().persistent().get(&usdc_key).unwrap();

        (admin, usdc_address)
    }
}

// ===== Tests =====
#[cfg(test)]
mod tests {
    use soroban_sdk::{testutils::Address as _, Address, Env};
    use crate::{EscrowContract, EscrowContractClient, EscrowStatus};

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let admin = Address::random(&env);
        let usdc = Address::random(&env);

        client.initialize(&admin, &usdc);

        // Verify initialization by checking metadata
        let (stored_admin, stored_usdc) = client.get_metadata();
        assert_eq!(stored_admin, admin);
        assert_eq!(stored_usdc, usdc);
    }

    #[test]
    #[should_panic(expected = "Contract already initialized")]
    fn test_double_initialize() {
        let env = Env::default();
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let admin = Address::random(&env);
        let usdc = Address::random(&env);

        client.initialize(&admin, &usdc);
        // Should panic on second initialization
        client.initialize(&admin, &usdc);
    }

    #[test]
    fn test_create_escrow() {
        let env = Env::default();
        env.budget().reset_unlimited();

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let admin = Address::random(&env);
        let usdc = Address::random(&env);
        let sender = Address::random(&env);
        let recipient = Address::random(&env);
        let agent = Address::random(&env);

        client.initialize(&admin, &usdc);

        // Create mock USDC token for testing
        env.register_stellar_asset_contract(usdc.clone());

        // Create escrow
        let amount = 1000_0000000i128; // 1000 USDC
        let fee_bps = 250; // 2.5% fee
        
        let escrow_id = client.create_escrow(
            &sender,
            &recipient,
            &agent,
            &amount,
            &fee_bps,
        );

        assert_eq!(escrow_id, 1);

        // Verify escrow details
        let escrow = client.get_escrow(&escrow_id);
        assert_eq!(escrow.id, 1);
        assert_eq!(escrow.sender, sender);
        assert_eq!(escrow.recipient, recipient);
        assert_eq!(escrow.agent, agent);
        assert_eq!(escrow.amount, amount);
        assert_eq!(escrow.release_fee_bps, fee_bps);
        assert_eq!(escrow.status, EscrowStatus::Pending);
    }

    #[test]
    fn test_create_multiple_escrows() {
        let env = Env::default();
        env.budget().reset_unlimited();

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let admin = Address::random(&env);
        let usdc = Address::random(&env);
        client.initialize(&admin, &usdc);

        let sender1 = Address::random(&env);
        let sender2 = Address::random(&env);
        let recipient = Address::random(&env);
        let agent = Address::random(&env);

        // Create first escrow
        let id1 = client.create_escrow(&sender1, &recipient, &agent, &1000_0000000i128, &250);
        assert_eq!(id1, 1);

        // Create second escrow
        let id2 = client.create_escrow(&sender2, &recipient, &agent, &500_0000000i128, &100);
        assert_eq!(id2, 2);

        // Verify both exist independently
        let escrow1 = client.get_escrow(&id1);
        let escrow2 = client.get_escrow(&id2);

        assert_eq!(escrow1.sender, sender1);
        assert_eq!(escrow2.sender, sender2);
        assert_eq!(escrow1.amount, 1000_0000000i128);
        assert_eq!(escrow2.amount, 500_0000000i128);
    }

    #[test]
    #[should_panic(expected = "Amount must be positive")]
    fn test_invalid_amount() {
        let env = Env::default();
        env.budget().reset_unlimited();

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let admin = Address::random(&env);
        let usdc = Address::random(&env);
        client.initialize(&admin, &usdc);

        let sender = Address::random(&env);
        let recipient = Address::random(&env);
        let agent = Address::random(&env);

        // Should panic with zero amount
        client.create_escrow(&sender, &recipient, &agent, &0, &250);
    }

    #[test]
    #[should_panic(expected = "Fee percentage cannot exceed 100%")]
    fn test_invalid_fee() {
        let env = Env::default();
        env.budget().reset_unlimited();

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let admin = Address::random(&env);
        let usdc = Address::random(&env);
        client.initialize(&admin, &usdc);

        let sender = Address::random(&env);
        let recipient = Address::random(&env);
        let agent = Address::random(&env);

        // Should panic with fee > 100%
        client.create_escrow(&sender, &recipient, &agent, &1000_0000000i128, &10001);
    }

    #[test]
    fn test_accumulated_fees() {
        let env = Env::default();
        env.budget().reset_unlimited();

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let admin = Address::random(&env);
        let usdc = Address::random(&env);
        client.initialize(&admin, &usdc);

        // Initial fees should be 0
        let initial_fees = client.get_accumulated_fees();
        assert_eq!(initial_fees, 0);
    }

    #[test]
    fn test_get_nonexistent_escrow() {
        let env = Env::default();
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let admin = Address::random(&env);
        let usdc = Address::random(&env);
        client.initialize(&admin, &usdc);

        // Should panic when trying to get non-existent escrow
        let _ = client.get_escrow(&999);
    }

    #[test]
    fn test_get_metadata() {
        let env = Env::default();
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let admin = Address::random(&env);
        let usdc = Address::random(&env);
        client.initialize(&admin, &usdc);

        let (stored_admin, stored_usdc) = client.get_metadata();
        assert_eq!(stored_admin, admin);
        assert_eq!(stored_usdc, usdc);
    }
}
