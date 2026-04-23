#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env,
};

// ── helpers ──────────────────────────────────────────────────────────────────

fn setup(quorum: u32, n_approvers: usize) -> (Env, Address, soroban_sdk::Vec<Address>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let mut approvers = soroban_sdk::Vec::new(&env);
    for _ in 0..n_approvers {
        approvers.push_back(Address::generate(&env));
    }
    let contract_id = env.register_contract(None, MultisigContract);
    MultisigContractClient::new(&env, &contract_id).initialize(&admin, &approvers, &quorum);
    (env, contract_id, approvers, admin)
}

fn propose(env: &Env, contract_id: &Address, proposer: &Address) -> u64 {
    let client = MultisigContractClient::new(env, contract_id);
    let recipient = Address::generate(env);
    client.propose_transaction(proposer, &1_000_000, &recipient)
}

// ── initialization ────────────────────────────────────────────────────────────

#[test]
fn test_initialize_ok() {
    let (env, contract_id, approvers, _) = setup(2, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    // propose succeeds — contract is initialized
    let id = propose(&env, &contract_id, &approvers.get(0).unwrap());
    assert_eq!(id, 0);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let (env, contract_id, approvers, admin) = setup(2, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    let mut v = soroban_sdk::Vec::new(&env);
    for a in approvers.iter() { v.push_back(a.clone()); }
    client.initialize(&admin, &v, &2);
}

#[test]
#[should_panic(expected = "invalid quorum")]
fn test_quorum_zero_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let a1 = Address::generate(&env);
    let mut v = soroban_sdk::Vec::new(&env);
    v.push_back(a1);
    let contract_id = env.register_contract(None, MultisigContract);
    MultisigContractClient::new(&env, &contract_id).initialize(&admin, &v, &0);
}

#[test]
#[should_panic(expected = "invalid quorum")]
fn test_quorum_exceeds_approvers_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let a1 = Address::generate(&env);
    let mut v = soroban_sdk::Vec::new(&env);
    v.push_back(a1);
    let contract_id = env.register_contract(None, MultisigContract);
    MultisigContractClient::new(&env, &contract_id).initialize(&admin, &v, &2);
}

// ── propose_transaction ───────────────────────────────────────────────────────

#[test]
fn test_propose_increments_counter() {
    let (env, contract_id, approvers, _) = setup(2, 3);
    let proposer = approvers.get(0).unwrap();
    assert_eq!(propose(&env, &contract_id, &proposer), 0);
    assert_eq!(propose(&env, &contract_id, &proposer), 1);
}

#[test]
#[should_panic(expected = "not an approver")]
fn test_propose_non_approver_panics() {
    let (env, contract_id, _, _) = setup(2, 3);
    let outsider = Address::generate(&env);
    propose(&env, &contract_id, &outsider);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_propose_zero_amount_panics() {
    let (env, contract_id, approvers, _) = setup(2, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    client.propose_transaction(&approvers.get(0).unwrap(), &0, &Address::generate(&env));
}

// ── approve / quorum ──────────────────────────────────────────────────────────

#[test]
fn test_approve_reaches_quorum_executes() {
    let (env, contract_id, approvers, _) = setup(2, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());

    client.approve(&approvers.get(0).unwrap(), &tx_id);
    assert_eq!(client.get_proposal(&tx_id).status, TxStatus::Pending);

    client.approve(&approvers.get(1).unwrap(), &tx_id);
    assert_eq!(client.get_proposal(&tx_id).status, TxStatus::Executed);
}

#[test]
fn test_approve_quorum_1_of_1() {
    let (env, contract_id, approvers, _) = setup(1, 1);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());
    client.approve(&approvers.get(0).unwrap(), &tx_id);
    assert_eq!(client.get_proposal(&tx_id).status, TxStatus::Executed);
}

#[test]
fn test_approve_all_3_of_3() {
    let (env, contract_id, approvers, _) = setup(3, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());
    for i in 0..3u32 {
        client.approve(&approvers.get(i).unwrap(), &tx_id);
    }
    assert_eq!(client.get_proposal(&tx_id).status, TxStatus::Executed);
}

#[test]
#[should_panic(expected = "not an approver")]
fn test_approve_non_approver_panics() {
    let (env, contract_id, approvers, _) = setup(2, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());
    client.approve(&Address::generate(&env), &tx_id);
}

#[test]
#[should_panic(expected = "already voted")]
fn test_double_approve_panics() {
    let (env, contract_id, approvers, _) = setup(2, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());
    let approver = approvers.get(0).unwrap();
    client.approve(&approver, &tx_id);
    client.approve(&approver, &tx_id);
}

#[test]
#[should_panic(expected = "not pending")]
fn test_approve_executed_proposal_panics() {
    let (env, contract_id, approvers, _) = setup(1, 2);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());
    client.approve(&approvers.get(0).unwrap(), &tx_id);
    // already Executed — second approver tries to approve
    client.approve(&approvers.get(1).unwrap(), &tx_id);
}

// ── reject ────────────────────────────────────────────────────────────────────

#[test]
fn test_reject_makes_quorum_impossible() {
    // 3 approvers, quorum 2. If 2 reject, remaining approvals can never reach 2.
    let (env, contract_id, approvers, _) = setup(2, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());

    client.reject(&approvers.get(0).unwrap(), &tx_id);
    assert_eq!(client.get_proposal(&tx_id).status, TxStatus::Pending);

    client.reject(&approvers.get(1).unwrap(), &tx_id);
    assert_eq!(client.get_proposal(&tx_id).status, TxStatus::Rejected);
}

#[test]
fn test_reject_unanimous_3_of_3() {
    let (env, contract_id, approvers, _) = setup(3, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());
    for i in 0..3u32 {
        client.reject(&approvers.get(i).unwrap(), &tx_id);
    }
    assert_eq!(client.get_proposal(&tx_id).status, TxStatus::Rejected);
}

#[test]
#[should_panic(expected = "already voted")]
fn test_double_reject_panics() {
    let (env, contract_id, approvers, _) = setup(2, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());
    let approver = approvers.get(0).unwrap();
    client.reject(&approver, &tx_id);
    client.reject(&approver, &tx_id);
}

#[test]
#[should_panic(expected = "already voted")]
fn test_approve_then_reject_same_voter_panics() {
    let (env, contract_id, approvers, _) = setup(2, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());
    let approver = approvers.get(0).unwrap();
    client.approve(&approver, &tx_id);
    client.reject(&approver, &tx_id);
}

#[test]
#[should_panic(expected = "not an approver")]
fn test_reject_non_approver_panics() {
    let (env, contract_id, approvers, _) = setup(2, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());
    client.reject(&Address::generate(&env), &tx_id);
}

// ── expiry ────────────────────────────────────────────────────────────────────

#[test]
fn test_execute_marks_expired() {
    let (env, contract_id, approvers, _) = setup(2, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());

    // advance ledger past 24 hours
    env.ledger().with_mut(|l| l.timestamp += 86_401);
    client.execute(&tx_id);
    assert_eq!(client.get_proposal(&tx_id).status, TxStatus::Expired);
}

#[test]
#[should_panic(expected = "not yet expired")]
fn test_execute_before_expiry_panics() {
    let (env, contract_id, approvers, _) = setup(2, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());
    client.execute(&tx_id);
}

#[test]
#[should_panic(expected = "proposal expired")]
fn test_approve_after_expiry_panics() {
    let (env, contract_id, approvers, _) = setup(2, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());
    env.ledger().with_mut(|l| l.timestamp += 86_401);
    client.approve(&approvers.get(0).unwrap(), &tx_id);
}

#[test]
#[should_panic(expected = "proposal expired")]
fn test_reject_after_expiry_panics() {
    let (env, contract_id, approvers, _) = setup(2, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());
    env.ledger().with_mut(|l| l.timestamp += 86_401);
    client.reject(&approvers.get(0).unwrap(), &tx_id);
}

// ── get_proposal ──────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "proposal not found")]
fn test_get_nonexistent_proposal_panics() {
    let (env, contract_id, _, _) = setup(2, 3);
    MultisigContractClient::new(&env, &contract_id).get_proposal(&99);
}

#[test]
fn test_proposal_fields_correct() {
    let (env, contract_id, approvers, _) = setup(2, 3);
    let client = MultisigContractClient::new(&env, &contract_id);
    let proposer = approvers.get(0).unwrap();
    let recipient = Address::generate(&env);
    let tx_id = client.propose_transaction(&proposer, &500_000, &recipient);
    let p = client.get_proposal(&tx_id);
    assert_eq!(p.amount, 500_000);
    assert_eq!(p.recipient, recipient);
    assert_eq!(p.proposer, proposer);
    assert_eq!(p.approvals, 0);
    assert_eq!(p.rejections, 0);
    assert_eq!(p.status, TxStatus::Pending);
}

// ── mixed approve/reject ──────────────────────────────────────────────────────

#[test]
fn test_mixed_votes_pending_until_decided() {
    // 5 approvers, quorum 3. 2 approve + 1 reject → still pending (3 remain, 2+3=5 >= 3)
    let (env, contract_id, approvers, _) = setup(3, 5);
    let client = MultisigContractClient::new(&env, &contract_id);
    let tx_id = propose(&env, &contract_id, &approvers.get(0).unwrap());

    client.approve(&approvers.get(0).unwrap(), &tx_id);
    client.approve(&approvers.get(1).unwrap(), &tx_id);
    client.reject(&approvers.get(2).unwrap(), &tx_id);
    assert_eq!(client.get_proposal(&tx_id).status, TxStatus::Pending);

    // third approval reaches quorum
    client.approve(&approvers.get(3).unwrap(), &tx_id);
    assert_eq!(client.get_proposal(&tx_id).status, TxStatus::Executed);
}
