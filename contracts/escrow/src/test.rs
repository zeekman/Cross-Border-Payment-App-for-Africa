#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal,
};

use crate::{EscrowContract, EscrowContractClient, EscrowStatus};

fn setup() -> (Env, EscrowContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    client.initialize(&admin, &usdc_id);
    (env, client, admin, usdc_id)
}

fn mint_usdc(env: &Env, usdc_id: &Address, admin: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, usdc_id).mint(to, &amount);
    let _ = admin; // admin used as issuer implicitly via register_stellar_asset_contract_v2
}

#[test]
fn test_initialize() {
    let (_, client, admin, usdc_id) = setup();
    let (stored_admin, stored_usdc) = client.get_metadata();
    assert_eq!(stored_admin, admin);
    assert_eq!(stored_usdc, usdc_id);
}

#[test]
#[should_panic(expected = "Contract already initialized")]
fn test_double_initialize() {
    let (_, client, admin, usdc_id) = setup();
    client.initialize(&admin, &usdc_id);
}

#[test]
fn test_create_escrow() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &250);
    assert_eq!(escrow_id, 1);

    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.sender, sender);
    assert_eq!(escrow.recipient, recipient);
    assert_eq!(escrow.agent, agent);
    assert_eq!(escrow.amount, amount);
    assert_eq!(escrow.release_fee_bps, 250);
    assert_eq!(escrow.status, EscrowStatus::Pending);
}

#[test]
fn test_create_multiple_escrows() {
    let (env, client, admin, usdc_id) = setup();
    let sender1 = Address::generate(&env);
    let sender2 = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender1, 1_000_0000000);
    mint_usdc(&env, &usdc_id, &admin, &sender2, 500_0000000);

    let id1 = client.create_escrow(&sender1, &recipient, &agent, &1_000_0000000, &250);
    let id2 = client.create_escrow(&sender2, &recipient, &agent, &500_0000000, &100);

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(client.get_escrow(&id1).sender, sender1);
    assert_eq!(client.get_escrow(&id2).sender, sender2);
}

#[test]
#[should_panic(expected = "Amount must be positive")]
fn test_invalid_amount() {
    let (env, client, _, _) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    client.create_escrow(&sender, &recipient, &agent, &0, &250);
}

#[test]
#[should_panic(expected = "Fee percentage cannot exceed 100%")]
fn test_invalid_fee() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &10001);
}

#[test]
fn test_release_escrow() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let fee_bps = 250u32;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &fee_bps);
    client.release_escrow(&agent, &escrow_id);

    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.status, EscrowStatus::Released);

    let expected_fee = (amount * fee_bps as i128) / 10000;
    let expected_agent = amount - expected_fee;

    assert_eq!(
        TokenClient::new(&env, &usdc_id).balance(&agent),
        expected_agent
    );
    assert_eq!(client.get_accumulated_fees(), expected_fee);
}

#[test]
fn test_cancel_escrow() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 500_0000000i128;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);

    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &100);
    client.cancel_escrow(&sender, &escrow_id);

    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.status, EscrowStatus::Cancelled);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&sender), amount);
}

#[test]
#[should_panic(expected = "Only the agent can release escrow")]
fn test_release_wrong_caller() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let impostor = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    client.release_escrow(&impostor, &escrow_id);
}

#[test]
#[should_panic(expected = "Only the sender can cancel escrow")]
fn test_cancel_wrong_caller() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let impostor = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    client.cancel_escrow(&impostor, &escrow_id);
}

#[test]
#[should_panic(expected = "Escrow is not in pending state")]
fn test_double_release() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    client.release_escrow(&agent, &escrow_id);
    client.release_escrow(&agent, &escrow_id);
}

#[test]
#[should_panic(expected = "Escrow is not in pending state")]
fn test_cancel_after_release() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &250);
    client.release_escrow(&agent, &escrow_id);
    client.cancel_escrow(&sender, &escrow_id);
}

#[test]
fn test_accumulated_fees_initial() {
    let (_, client, _, _) = setup();
    assert_eq!(client.get_accumulated_fees(), 0);
}

#[test]
fn test_withdraw_fees() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let fee_bps = 500u32;

    mint_usdc(&env, &usdc_id, &admin, &sender, amount);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &amount, &fee_bps);
    client.release_escrow(&agent, &escrow_id);

    let expected_fee = (amount * fee_bps as i128) / 10000;
    assert_eq!(client.get_accumulated_fees(), expected_fee);

    client.withdraw_fees(&admin, &expected_fee);
    assert_eq!(client.get_accumulated_fees(), 0);
    assert_eq!(
        TokenClient::new(&env, &usdc_id).balance(&admin),
        expected_fee
    );
}

#[test]
#[should_panic(expected = "Only admin can withdraw fees")]
fn test_withdraw_fees_wrong_caller() {
    let (env, client, admin, usdc_id) = setup();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let agent = Address::generate(&env);
    let impostor = Address::generate(&env);

    mint_usdc(&env, &usdc_id, &admin, &sender, 1_000_0000000);
    let escrow_id = client.create_escrow(&sender, &recipient, &agent, &1_000_0000000, &500);
    client.release_escrow(&agent, &escrow_id);
    client.withdraw_fees(&impostor, &500_0000000);
}

#[test]
#[should_panic(expected = "Escrow not found")]
fn test_get_nonexistent_escrow() {
    let (_, client, _, _) = setup();
    client.get_escrow(&999);
}
