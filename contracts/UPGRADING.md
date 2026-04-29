# Soroban Contract Upgrade Process

## Overview

Soroban smart contracts are immutable once deployed, but the WASM bytecode can be upgraded via the `uploadContractWasm` and `updateContractInstance` functions. This document outlines the process for safely upgrading AfriPay's Soroban contracts with a 48-hour timelock mechanism to allow the community to review pending upgrades.

## Upgrade Mechanism

### How Contract Upgrades Work

1. **Upload new WASM**: Call `uploadContractWasm` to upload the new contract bytecode to the Stellar ledger
2. **Update Contract Instance**: Call `updateContractInstance` with the new WASM hash to activate the upgrade
3. **Emit Event**: An on-chain event is emitted with the new WASM hash, recording the upgrade on the ledger

### Timelock Protection

All contract upgrades go through a 48-hour timelock mechanism:

- **Announcement Phase**: When an upgrade is initiated, it is announced with the new WASM hash
- **Waiting Period**: The upgrade cannot be executed for 48 hours
- **Execution Phase**: After 48 hours, the upgrade can be executed
- **Event Logging**: The upgrade is recorded as an on-chain event with the WASM hash

This ensures that the community has time to review and react to proposed upgrades before they are finalized.

## Upgrade Process

### Prerequisites

- Access to the Soroban contract admin keypair
- Compiled and tested WASM binary for the new contract version
- Updated contract source code
- Test suite passing on the new contract version

### Step 1: Build New Contract

```bash
cd contracts/<contract-name>
cargo build --target wasm32-unknown-unknown --release
```

This produces the compiled WASM binary at `target/wasm32-unknown-unknown/release/<contract-name>.wasm`.

### Step 2: Generate WASM Hash

```bash
sha256sum target/wasm32-unknown-unknown/release/<contract-name>.wasm
```

Record this hash for the upgrade announcement.

### Step 3: Announce Upgrade

Use the AfriPay admin API to announce the upgrade:

```bash
POST /api/admin/contracts/:contractId/upgrade
Content-Type: application/json
Authorization: Bearer <admin-jwt-token>

{
  "wasmHash": "<sha256-hash-of-new-wasm>",
  "description": "Fixes XYZ vulnerability, improves gas efficiency"
}
```

The API will:
- Record the upgrade announcement in the database
- Set the execution time to current_time + 48 hours
- Emit an on-chain event with the WASM hash
- Return the scheduled upgrade details

### Step 4: Wait 48 Hours

The 48-hour window allows the community to:
- Review the proposed upgrade
- Audit the new contract code
- Raise concerns or objections
- Plan for any necessary changes

### Step 5: Execute Upgrade

After 48 hours have passed, execute the upgrade via the admin API or direct contract invocation:

```bash
POST /api/admin/contracts/:contractId/upgrade/execute
Content-Type: application/json
Authorization: Bearer <admin-jwt-token>

{
  "wasmHash": "<sha256-hash-of-new-wasm>"
}
```

Or directly via Soroban CLI:

```bash
soroban contract invoke \
  --source <admin-keypair> \
  --network <network> \
  --contract-id <contract-id> \
  -- \
  updateContractInstance \
  --new_wasm_hash <wasm-hash>
```

### Step 6: Verify Upgrade

Verify the contract has been upgraded:

```bash
soroban contract read \
  --network <network> \
  --contract-id <contract-id>
```

Check that the contract code hash matches the new WASM hash.

## Contract Upgrade Events

When an upgrade is executed, the contract emits an event on the Stellar ledger:

```
Event Type: ContractUpgrade
Data:
  - previous_wasm_hash: <old-hash>
  - new_wasm_hash: <new-hash>
  - upgrade_time: <timestamp>
  - admin: <admin-address>
```

These events are indexed by the Soroban Contract Event Indexer and available via:

```
GET /api/contracts/:contractId/events?type=ContractUpgrade
```

## Safety Considerations

1. **Always Test First**: Test the new contract on testnet before mainnet deployment
2. **Backup State**: Export contract state before upgrading
3. **Announce Early**: Announce upgrades well in advance when possible
4. **Monitor**: Watch the indexed events and logs after deployment
5. **Rollback Plan**: Have a plan to rapidly deploy a fix if the upgrade causes issues

## Rollback

If a critical issue is discovered with an upgraded contract:

1. Deploy a fixed version of the contract
2. Announce and schedule the rollback upgrade following the same process
3. Document the incident

## Contracts Subject to Upgrade

The following AfriPay contracts support upgrades:

- `escrow` - Payment escrow mechanism
- `fee-distributor` - Fee collection and distribution
- `kyc-attestation` - KYC verification records
- `loyalty-token` - Loyalty rewards token
- `recurring-payments` - Recurring payment scheduling
- `savings-vault` - User savings accounts
- `multisig-approval` - Multi-signature approvals
- `dispute-resolution` - Dispute handling
- `agent-escrow` - Agent-specific escrow

## Version Management

Track contract versions by:

1. Git tags: `contract-<name>-v<version>`
2. WASM hash: Store in version history table
3. Event log: All upgrades recorded on-chain

Example version record:

```json
{
  "contract_id": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  "version": "1.2.0",
  "wasm_hash": "a1b2c3d4e5f6...",
  "deployed_at": "2026-04-26T10:30:00Z",
  "upgraded_from": "1.1.0",
  "release_notes": "Security fix for XYZ"
}
```

## Further Reading

- [Soroban Contract Documentation](https://developers.stellar.org/docs/smart-contracts)
- [Contract Instance Upgrade](https://developers.stellar.org/docs/smart-contracts/upgrading)
- [Event Indexing](./../backend/docs/CONTRACT_EVENTS.md)
