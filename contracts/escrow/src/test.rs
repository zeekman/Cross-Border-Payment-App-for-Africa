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
