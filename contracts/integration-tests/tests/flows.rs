use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token, Address, Bytes, Env,
};

use dispute_resolution_contract::{DisputeResolutionContract, DisputeResolutionContractClient};
use escrow_contract::{EscrowContract, EscrowContractClient};
use fee_distributor_contract::{FeeDistributorContract, FeeDistributorContractClient};
use kyc_attestation_contract::{KycAttestationContract, KycAttestationContractClient};
use recurring_payments_contract::{RecurringPaymentsContract, RecurringPaymentsContractClient};
use savings_vault_contract::{SavingsVaultContract, SavingsVaultContractClient};

struct System<'a> {
    env: Env,
    admin: Address,
    usdc: token::Client<'a>,
    usdc_admin: token::StellarAssetClient<'a>,
    kyc: KycAttestationContractClient<'a>,
    escrow: EscrowContractClient<'a>,
    dispute: DisputeResolutionContractClient<'a>,
    fees: FeeDistributorContractClient<'a>,
    arbitrator: Address,
}

/// Deploy every contract into one `Env` and wire them to a shared USDC token.
fn setup<'a>() -> System<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract(admin.clone());

    let kyc = KycAttestationContractClient::new(&env, &env.register_contract(None, KycAttestationContract));
    let escrow = EscrowContractClient::new(&env, &env.register_contract(None, EscrowContract));
    let dispute = DisputeResolutionContractClient::new(&env, &env.register_contract(None, DisputeResolutionContract));
    let fees = FeeDistributorContractClient::new(&env, &env.register_contract(None, FeeDistributorContract));

    kyc.initialize(&admin);
    escrow.initialize(&admin, &usdc_id);
    dispute.initialize(&admin, &arbitrator, &usdc_id);
    fees.initialize(&admin, &usdc_id);

    System {
        usdc: token::Client::new(&env, &usdc_id),
        usdc_admin: token::StellarAssetClient::new(&env, &usdc_id),
        env,
        admin,
        kyc,
        escrow,
        dispute,
        fees,
        arbitrator,
    }
}

#[test]
fn kyc_escrow_release_fee_dispute_flow() {
    let s = setup();
    let (sender, recipient, agent) = (
        Address::generate(&s.env),
        Address::generate(&s.env),
        Address::generate(&s.env),
    );
    s.usdc_admin.mint(&sender, &20_000);

    // KYC gate
    assert!(!s.kyc.is_verified(&sender));
    s.kyc.attest(&s.admin, &sender, &Bytes::from_slice(&s.env, b"kyc-hash"));
    assert!(s.kyc.is_verified(&sender));

    // Escrow create → release with a 2% fee
    let id = s.escrow.create_escrow(&sender, &recipient, &agent, &10_000, &200);
    assert_eq!(s.usdc.balance(&s.escrow.address), 10_000);
    s.escrow.release_escrow(&agent, &id);
    assert_eq!(s.usdc.balance(&agent), 9_800);
    assert_eq!(s.escrow.get_accumulated_fees(), 200);
    assert!(!s.env.events().all().is_empty());

    // Fees move from escrow to the fee distributor
    s.escrow.withdraw_fees(&s.admin, &200);
    s.fees.deposit_fee(&s.admin, &200);
    assert_eq!(s.fees.get_accumulated_fees(), 200);
    assert_eq!(s.usdc.balance(&s.fees.address), 200);

    // Dispute → resolution in the recipient's favour
    let did = s.dispute.open_dispute(&sender, &sender, &recipient, &5_000);
    assert_eq!(s.usdc.balance(&s.dispute.address), 5_000);
    s.dispute.resolve_dispute(&s.arbitrator, &did, &true);
    assert_eq!(s.usdc.balance(&recipient), 5_000);
    assert_eq!(s.usdc.balance(&sender), 5_000);
}

#[test]
fn recurring_payment_with_fee_flow() {
    let s = setup();
    let recurring = RecurringPaymentsContractClient::new(
        &s.env,
        &s.env.register_contract(None, RecurringPaymentsContract),
    );
    recurring.initialize(&s.usdc.address);

    let (sender, recipient) = (Address::generate(&s.env), Address::generate(&s.env));
    s.usdc_admin.mint(&sender, &10_000);
    s.usdc.approve(&sender, &recurring.address, &10_000, &(s.env.ledger().sequence() + 1_000));

    let interval = 86_400u64;
    let sid = recurring.authorize_recurring(&sender, &recipient, &1_000, &interval);
    s.env.ledger().with_mut(|l| l.timestamp += interval);
    recurring.execute_payment(&s.admin, &sid);
    assert_eq!(s.usdc.balance(&recipient), 1_000);

    // Recipient pays the platform fee into the distributor
    s.fees.deposit_fee(&recipient, &10);
    assert_eq!(s.fees.get_accumulated_fees(), 10);
    assert_eq!(s.usdc.balance(&sender), 9_000);
}

#[test]
fn recurring_payment_fee_routes_through_fee_distributor() {
    let s = setup();
    let recurring = RecurringPaymentsContractClient::new(
        &s.env,
        &s.env.register_contract(None, RecurringPaymentsContract),
    );
    recurring.initialize(&s.usdc.address);
    // Route recurring-payment fees through the fee distributor instead of the admin EOA.
    recurring.set_fee_distributor(&s.admin, &s.fees.address);

    let (sender, recipient) = (Address::generate(&s.env), Address::generate(&s.env));
    s.usdc_admin.mint(&sender, &10_000);
    s.usdc.approve(&sender, &recurring.address, &10_000, &(s.env.ledger().sequence() + 1_000));

    let interval = 86_400u64;
    let fee_bps = 100u32; // 1%
    let sid = recurring.authorize_recurring(&sender, &recipient, &1_000, &interval, &fee_bps);
    s.env.ledger().with_mut(|l| l.timestamp += interval);
    recurring.execute_payment(&s.admin, &sid);

    // Recipient receives the full amount; the fee is pulled into the distributor.
    assert_eq!(s.usdc.balance(&recipient), 1_000);
    assert_eq!(s.usdc.balance(&sender), 8_990);
    assert_eq!(s.usdc.balance(&s.fees.address), 10);

    // The fee is recorded in the distributor's ledger and split into the agent pool.
    assert_eq!(s.fees.get_accumulated_fees(&s.usdc.address), 10);
    assert!(s.fees.get_agent_pool(&s.usdc.address) > 0);
}

#[test]
fn savings_deposit_withdraw_flow() {
    let s = setup();
    let vault = SavingsVaultContractClient::new(
        &s.env,
        &s.env.register_contract(None, SavingsVaultContract),
    );
    vault.initialize(&s.usdc.address);

    let user = Address::generate(&s.env);
    s.usdc_admin.mint(&user, &5_000);

    let unlock = s.env.ledger().timestamp() + 3_600;
    vault.deposit(&user, &5_000, &unlock);
    assert_eq!(vault.get_balance(&user), 5_000);
    assert_eq!(s.usdc.balance(&user), 0);

    s.env.ledger().with_mut(|l| l.timestamp = unlock + 1);
    vault.withdraw(&user, &5_000);
    assert_eq!(vault.get_balance(&user), 0);
    assert_eq!(s.usdc.balance(&user), 5_000);
}
