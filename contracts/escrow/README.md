# Soroban Escrow Contract

A trustless, on-chain escrow contract for USDC remittances on the Stellar network. This contract holds funds in escrow, allows agents to confirm payout, and accumulates fees for withdrawal by the admin.

## Contents

- [Contract Overview](#contract-overview)
- [Public Function ABI](#public-function-abi)
- [Event Schemas](#event-schemas)
- [Storage Layout](#storage-layout)
- [Getting Started](#getting-started)
- [Deployment](#deployment)
- [Deployed Contract IDs](#deployed-contract-ids)
- [Integration Notes](#integration-notes)
- [Security Summary](#security-summary)

## Contract Overview

This contract supports a three-party escrow flow:

1. **Sender** - deposits USDC into escrow
2. **Recipient** - beneficiary of the payout
3. **Agent** - confirms payout and triggers release

The escrow lifecycle is:

- `Pending` → `Released` when the assigned agent calls `release_escrow` or fully settles the escrow with `partial_release`
- `Pending` → `Cancelled` when the original sender calls `cancel_escrow`
- `Pending` → `UnderDispute` when the sender or recipient calls `dispute_escrow`, handing the full balance to the dispute-resolution contract for arbitration

Completed or cancelled escrow records may be archived after a configurable retention period to limit persistent storage growth.

Fees are calculated in basis points and stored separately as `AccumulatedFees`.

## Public Function ABI

### `initialize`

Signature:
```rust
fn initialize(env: Env, admin: Address, usdc_address: Address)
```

Description:
- Sets the admin address and the USDC token contract address.
- Can only be called once.

Parameters:
- `admin` (`Address`) - the account authorized to withdraw collected fees and perform upgrades.
- `usdc_address` (`Address`) - the contract ID for the USDC token on the network.

Returns:
- `void`

Authorization:
- No authorization check beyond deployment; this is expected to be called during contract setup.

Panics / Errors:
- `Contract already initialized` if the contract has already been initialized.

Events:
- `EscrowInitialized`

---

### `upgrade`

Signature:
```rust
fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>)
```

Description:
- Upgrades the current contract WASM code.
- Only the stored admin may call this function.

Parameters:
- `admin` (`Address`) - must match the stored admin address.
- `new_wasm_hash` (`BytesN<32>`) - the hash of the new WASM bytecode.

Returns:
- `void`

Authorization:
- Requires `admin.require_auth()` and the provided admin must equal the stored admin.

Panics / Errors:
- `Contract not initialized` if the contract has not been initialized.
- `Only admin can upgrade the contract` if the caller is not the stored admin.

Events:
- `Upgraded`

---

### `create_escrow`

Signature:
```rust
fn create_escrow(
    env: Env,
    sender: Address,
    recipient: Address,
    agent: Address,
    amount: i128,
    release_fee_bps: u32,
) -> u64
```

Description:
- Creates a new escrow entry and transfers USDC from the sender to the contract.
- Stores sender, recipient, agent, amount, fee, status, timestamps, and expiry.

Parameters:
- `sender` (`Address`) - originator who must authorize the transfer.
- `recipient` (`Address`) - the intended final beneficiary.
- `agent` (`Address`) - the account that can release the escrow.
- `amount` (`i128`) - USDC amount in stroops (`1 USDC = 10^7 stroops`).
- `release_fee_bps` (`u32`) - release fee in basis points (max 5000).

Returns:
- `u64` - the newly created escrow ID.

Authorization:
- `sender.require_auth()` is required.

Panics / Errors:
- `Amount below minimum (100 stroops)` if `amount < 100`.
- `Fee cannot be 100%` if `release_fee_bps == 10000`.
- `Fee exceeds maximum of 5000 bps (50%)` if `release_fee_bps > 5000`.
- `Sender, recipient, and agent must be distinct addresses` if any two roles overlap.
- Panics from the underlying USDC token transfer if the sender has insufficient allowance or balance.

Events:
- `EscrowCreated`

---

### `deposit`

Signature:
```rust
fn deposit(env: Env, sender: Address, escrow_id: u64, amount: i128)
```

Description:
- Adds additional USDC to an existing pending escrow.

Parameters:
- `sender` (`Address`) - must authorize the transfer.
- `escrow_id` (`u64`) - the escrow to deposit into.
- `amount` (`i128`) - the deposit amount in stroops.

Returns:
- `void`

Authorization:
- `sender.require_auth()` is required.

Panics / Errors:
- `Amount must be positive` if `amount <= 0`.
- `Escrow {id} not found` if the escrow does not exist.
- `Escrow is not in pending state` if the escrow is already released or cancelled.
- `Escrow has expired` if the current ledger timestamp is greater than or equal to `expires_at`.
- Panics from the underlying USDC transfer if the sender has insufficient allowance or balance.

Events:
- None emitted by this function.

---

### `release_escrow`

Signature:
```rust
fn release_escrow(env: Env, agent: Address, escrow_id: u64)
```

Description:
- Releases escrow funds to the assigned agent and records fees.

Parameters:
- `agent` (`Address`) - must be the escrow-assigned agent and authorize the call.
- `escrow_id` (`u64`) - the escrow to release.

Returns:
- `void`

Authorization:
- `agent.require_auth()` is required.
- The caller must match `escrow.agent`.

Panics / Errors:
- `Escrow {id} not found` if the escrow does not exist.
- `Only the agent can release escrow` if the caller is not the assigned agent.
- `Escrow is not in pending state` if the escrow is already released or cancelled.

Behavior:
- Calculates `fee_amount = (amount * release_fee_bps) / 10000`.
- Sends `agent_amount = amount - fee_amount` to the agent.
- Adds `fee_amount` to `AccumulatedFees` storage.
- Updates the escrow status to `Released`.

Events:
- `EscrowReleased`

---

### `cancel_escrow`

Signature:
```rust
fn cancel_escrow(env: Env, sender: Address, escrow_id: u64)
```

Description:
- Refunds the full escrow amount to the original sender.

Parameters:
- `sender` (`Address`) - must authorize the refund.
- `escrow_id` (`u64`) - the escrow to cancel.

Returns:
- `void`

Authorization:
- `sender.require_auth()` is required.
- The caller must match `escrow.sender`.

Panics / Errors:
- `Escrow {id} not found` if the escrow does not exist.
- `Only the sender can cancel escrow` if the caller is not the original sender.
- `Escrow is not in pending state` if the escrow is already released or cancelled.

Behavior:
- Transfers the full escrow amount back to `sender`.
- Updates the escrow status to `Cancelled`.

Events:
- `EscrowCancelled`

---

### `confirm_delivery`

Signature:
```rust
fn confirm_delivery(env: Env, agent: Address, escrow_id: u64)
```

Description:
- Marks an escrow as having had off-chain payout confirmed by the agent.
- Prevents the sender from cancelling the escrow after confirmation.

Parameters:
- `agent` (`Address`) - must authorize the confirmation.
- `escrow_id` (`u64`) - the escrow to confirm.

Returns:
- `void`

Authorization:
- `agent.require_auth()` is required.
- The caller must match `escrow.agent`.

Panics / Errors:
- `Escrow {id} not found` if the escrow does not exist.
- `Only the agent can confirm delivery` if the caller is not the assigned agent.
- `Escrow is not in pending state` if the escrow is already released or cancelled.
- `Delivery has already been confirmed` if confirmation has already been submitted.

Events:
- `DeliveryConfirmed`

---

### `partial_release`

Signature:
```rust
fn partial_release(env: Env, agent: Address, escrow_id: u64, amount: i128)
```

Description:
- Releases a portion of the escrow amount to the agent with proportional fee calculation.
- Keeps the escrow in `Pending` state until the remaining amount reaches zero.

Parameters:
- `agent` (`Address`) - must authorize the release.
- `escrow_id` (`u64`) - the escrow to partially release.
- `amount` (`i128`) - the amount to release in stroops.

Returns:
- `void`

Authorization:
- `agent.require_auth()` is required.
- The caller must match `escrow.agent`.

Panics / Errors:
- `Escrow {id} not found` if the escrow does not exist.
- `Only the agent can release escrow` if the caller is not the assigned agent.
- `Escrow is not in pending state` if the escrow is already released or cancelled.
- `Amount must be positive` if the release amount is zero or negative.
- `Release amount exceeds escrow balance` if the requested amount is larger than the remaining escrow amount.

Behavior:
- Calculates `fee_amount = (amount * release_fee_bps) / 10000`.
- Sends `amount - fee_amount` to the assigned agent.
- Adds `fee_amount` to `AccumulatedFees` storage.
- Reduces `escrow.amount` by the released amount.
- Sets `status = Released` only when the full escrow amount has been paid out.

Events:
- `PartialRelease`

---

### `set_retention_period`

Signature:
```rust
fn set_retention_period(env: Env, admin: Address, retention_secs: u64)
```

Description:
- Configures the number of seconds after which completed or cancelled escrow records are eligible for cleanup.

Parameters:
- `admin` (`Address`) - must authorize the change.
- `retention_secs` (`u64`) - the retention period in seconds.

Returns:
- `void`

Authorization:
- `admin.require_auth()` is required.
- The caller must match the stored admin.

Panics / Errors:
- `Retention period must be positive` if zero is passed.
- `Only admin can perform this action` if the caller is not the stored admin.

---

### `cleanup_escrow`

Signature:
```rust
fn cleanup_escrow(env: Env, escrow_id: u64)
```

Description:
- Removes a completed or cancelled escrow record from persistent storage once the configured retention period has elapsed.
- Permissionless: like `expire_escrow`, anyone may call it (no admin auth) so old records can be swept without placing the burden on the admin.

Parameters:
- `escrow_id` (`u64`) - the escrow to archive.

Returns:
- `void`

Authorization:
- `admin.require_auth()` is required.
- The caller must match the stored admin.

Panics / Errors:
- `Escrow {id} not found` if the escrow does not exist.
- `Only released or cancelled escrows can be cleaned up` if the escrow is still pending.
- `Escrow retention period has not elapsed` if the configured TTL has not passed since `updated_at`.

Events:
- `EscrowArchived`

---

### `get_escrow`

Signature:
```rust
fn get_escrow(env: Env, escrow_id: u64) -> Escrow
```

Description:
- Reads the escrow record from storage.

Parameters:
- `escrow_id` (`u64`) - the escrow to retrieve.

Returns:
- `Escrow` struct.

Panics / Errors:
- `Escrow {id} not found` if the escrow does not exist.

Authorization:
- Public read-only.

---

### `get_accumulated_fees`

Signature:
```rust
fn get_accumulated_fees(env: Env) -> i128
```

Description:
- Returns the current collected fee balance.

Returns:
- `i128` - accumulated fee amount in stroops.

Authorization:
- Public read-only.

---

### `withdraw_fees`

Signature:
```rust
fn withdraw_fees(env: Env, admin: Address, amount: i128)
```

Description:
- Withdraws collected fees to the admin account.

Parameters:
- `admin` (`Address`) - must match the stored admin and authorize the call.
- `amount` (`i128`) - withdrawal amount in stroops.

Returns:
- `void`

Authorization:
- `admin.require_auth()` is required.
- The caller must equal the stored admin.

Panics / Errors:
- `Amount must be positive` if `amount <= 0`.
- `Contract not initialized` if the contract was never initialized.
- `Only admin can withdraw fees` if the caller is not the stored admin.
- `Insufficient accumulated fees` if `amount` exceeds the stored fee balance.
- Panics from the underlying USDC transfer if the contract account cannot send the requested amount.

---

### `get_metadata`

Signature:
```rust
fn get_metadata(env: Env) -> (Address, Address)
```

Description:
- Returns the configured admin and USDC token contract address.

Returns:
- `(Address, Address)` - `(admin, usdc_address)`.

Authorization:
- Public read-only.

Panics / Errors:
- `Contract not initialized` if the contract was never initialized.

## Dispute Escalation

If the agent confirms delivery but never releases (`confirm_delivery`) or disputes
the payout amount, the sender cannot cancel (cancellation is blocked once
delivery is confirmed) and would otherwise have to wait out the full
`DEFAULT_EXPIRY_SECS` (30 days). This contract closes that gap by routing a
pending escrow into the on-chain `dispute-resolution` contract for arbitration.

### `set_dispute_contract`

Signature:
```rust
fn set_dispute_contract(env: Env, admin: Address, dispute_contract: Address)
```

Admin-only. Stores the dispute-resolution contract address used by
`dispute_escrow`. Read back with `get_dispute_contract()`. Until this is set,
`dispute_escrow` panics with `Dispute resolution contract not configured`.

### `dispute_escrow`

Signature:
```rust
fn dispute_escrow(env: Env, caller: Address, escrow_id: u64) -> u64
```

Escalates a pending escrow to the configured dispute-resolution contract. Only
the **sender** or **recipient** may call (auth required). The full remaining
balance is transferred to the dispute-resolution contract, which records a
dispute and takes custody of the funds; the escrow is marked `UnderDispute`
and can no longer be released, cancelled, deposited into, or expired. The
adjudicated winner is paid directly by the dispute-resolution contract.

Returns the dispute ID assigned by the dispute-resolution contract.

Panics / Errors:
- `Dispute resolution contract not configured` if no dispute contract was set.
- `Escrow {id} not found` if the escrow does not exist.
- `Only the sender or recipient can dispute escrow` if the caller is neither.
- `Escrow is not in pending state` if the escrow is no longer pending.

Events:
- `EscrowDisputed`

### Dispute-resolution setup

The dispute-resolution contract must register this escrow as its trusted escrow
(via its admin-only `set_escrow_contract`) before `dispute_escrow` can succeed;
its `open_escrow_dispute` is only callable by the registered escrow contract.

## Event Schemas

### `EscrowInitialized`

Emitted by `initialize`.

Fields:
- `contract_id` (`Address`) - the contract's own address.
- `admin` (`Address`) - configured admin for the contract.
- `usdc_address` (`Address`) - configured USDC token contract.

### `Upgraded`

Emitted by `upgrade`.

Fields:
- `new_wasm_hash` (`BytesN<32>`) - hash of the new contract WASM bytecode.

### `EscrowCreated`

Emitted by `create_escrow`.

Fields:
- `escrow_id` (`u64`) - assigned escrow identifier.
- `sender` (`Address`) - escrow originator.
- `recipient` (`Address`) - final beneficiary.
- `agent` (`Address`) - payout agent.
- `amount` (`i128`) - escrowed USDC amount in stroops.
- `release_fee_bps` (`u32`) - configured fee in basis points.

### `EscrowReleased`

Emitted by `release_escrow`.

Fields:
- `escrow_id` (`u64`) - released escrow identifier.
- `agent_amount` (`i128`) - amount transferred to the agent after fees.
- `fee_amount` (`i128`) - fee amount added to accumulated fees.

### `EscrowCancelled`

Emitted by `cancel_escrow`.

Fields:
- `escrow_id` (`u64`) - cancelled escrow identifier.
- `refund_amount` (`i128`) - refunded amount returned to the sender.

### `DeliveryConfirmed`

Emitted by `confirm_delivery`.

Fields:
- `escrow_id` (`u64`) - escrow identifier.
- `agent` (`Address`) - agent that confirmed delivery.

### `EscrowDisputed`

Emitted by `dispute_escrow`.

Fields:
- `escrow_id` (`u64`) - escrow identifier.
- `dispute_id` (`u64`) - dispute ID assigned by the dispute-resolution contract.
- `opener` (`Address`) - sender or recipient who escalated the escrow.
- `amount` (`i128`) - balance handed over to the dispute-resolution contract.

### `PartialRelease`

Emitted by `partial_release`.

Fields:
- `escrow_id` (`u64`) - escrow identifier.
- `released_amount` (`i128`) - amount released to the agent.
- `remaining_amount` (`i128`) - amount remaining in escrow.
- `fee_amount` (`i128`) - release fee for this partial payout.

### `EscrowArchived`

Emitted by `cleanup_escrow`.

Fields:
- `escrow_id` (`u64`) - archived escrow identifier.

## Storage Layout

This contract stores state under the following `DataKey` variants in persistent storage:

- `DataKey::Admin` -> `Address`
- `DataKey::UsdcAddress` -> `Address`
- `DataKey::EscrowCounter` -> `u64`
- `DataKey::AccumulatedFees` -> `i128`
- `DataKey::RetentionPeriodSecs` -> `u64`
- `DataKey::Escrow(u64)` -> `Escrow`
- `DataKey::DisputeContractAddress` -> `Address` (dispute-resolution contract used by `dispute_escrow`)
- `DataKey::ContractVersion` -> `u32`

### `Escrow` struct layout

```rust
struct Escrow {
    id: u64,
    sender: Address,
    recipient: Address,
    agent: Address,
    amount: i128,
    release_fee_bps: u32,
    status: EscrowStatus,
    payout_confirmed: bool,
    created_at: u64,
    updated_at: u64,
    expires_at: u64,
}
```

### Storage TTL strategy

Completed or cancelled escrows are eligible for cleanup after a configurable retention period. The admin can set the retention TTL via `set_retention_period`. Once the escrow's `updated_at` timestamp is older than the retention threshold, anyone can reclaim its storage with the permissionless `cleanup_escrow`, obviating the need for a manual admin (or automated job under the admin's key) sweep.

### `EscrowStatus` enum

```rust
enum EscrowStatus {
    Pending,
    Released,
    Cancelled,
    UnderDispute,
}
```

## Getting Started

### JavaScript / Stellar SDK Example

The contract can be invoked using the Soroban `InvokeHostFunction` operation via the Stellar SDK. The example below shows how to call `create_escrow`.

> Replace `CONTRACT_ID`, `USDC_ADDRESS`, and account setup with your own values.

```javascript
import { Server, Keypair, Networks, TransactionBuilder, Operation, xdr, Contract } from 'stellar-sdk';

const server = new Server('https://horizon-testnet.stellar.org');
const NETWORK_PASSPHRASE = Networks.TESTNET;
const CONTRACT_ID = 'YOUR_ESCROW_CONTRACT_ID';
const USDC_ADDRESS = 'YOUR_USDC_CONTRACT_ID';

async function invokeContract(sourceKeypair, functionName, args) {
  const sourceAccount = await server.loadAccount(sourceKeypair.publicKey());
  const contractAddress = Contract.fromContractId(CONTRACT_ID).address();

  const tx = new TransactionBuilder(sourceAccount, {
    fee: await server.fetchBaseFee(),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
        contractAddress,
        functionName: xdr.Symbol.fromString(functionName),
        args,
      })),
    }))
    .setTimeout(30)
    .build();

  tx.sign(sourceKeypair);
  return server.submitTransaction(tx);
}

function addressToScVal(address) {
  return xdr.ScVal.scvAddress(xdr.ScAddress.publicKeyTypeEd25519(address));
}

async function createEscrow(senderKeypair, recipientAddress, agentAddress, amountStroops, feeBps) {
  const args = [
    addressToScVal(senderKeypair.publicKey()),
    addressToScVal(recipientAddress),
    addressToScVal(agentAddress),
    xdr.ScVal.scvI128(amountStroops.toString()),
    xdr.ScVal.scvU32(feeBps),
  ];

  return invokeContract(senderKeypair, 'create_escrow', args);
}
```

### Recommended call flow

1. Deploy and initialize the contract with `initialize(admin, usdc_address)`.
2. Call `create_escrow(sender, recipient, agent, amount, release_fee_bps)`.
3. Optionally call `deposit(sender, escrow_id, amount)` to add funds.
4. Call `confirm_delivery(agent, escrow_id)` after the agent confirms off-chain payout.
5. Call `partial_release(agent, escrow_id, amount)` to release funds in installments, or `release_escrow(agent, escrow_id)` to release the remaining balance.
6. Call `cancel_escrow(sender, escrow_id)` to refund pending escrow before delivery confirmation.
7. Admin calls `withdraw_fees(admin, amount)` to collect fees.

## Deployment

### Testnet deployment

```bash
export STELLAR_NETWORK=testnet
export SOROBAN_SECRET_KEY='YOUR_SECRET_KEY'
cd contracts
bash deploy.sh
```

### Mainnet deployment

```bash
export STELLAR_NETWORK=mainnet
export SOROBAN_SECRET_KEY='YOUR_SECRET_KEY'
cd contracts
bash deploy.sh
```

### Manual deployment

```bash
cargo build --release --target wasm32-unknown-unknown
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/escrow_contract.wasm \
  --source YOUR_SECRET_KEY \
  --network testnet
```

## Deployed Contract IDs

- Testnet: `TBD`
- Mainnet: `TBD`

> Update these values once the escrow contract is deployed to the desired network.

## Integration Notes

- Amounts are always represented in stroops for USDC (`1 USDC = 10^7 stroops`).
- Fees are basis points: `100 bps = 1%`, `250 bps = 2.5%`.
- `create_escrow` will fail if sender, recipient, and agent addresses are not distinct.
- Deposits are only allowed while escrow status is `Pending` and before `expires_at`.
- The contract does not emit an event for `deposit`.

## Security Summary

- `initialize` is single-use and sets trusted admin and USDC addresses.
- `create_escrow` requires sender authorization.
- `release_escrow` can only be called by the assigned agent.
- `cancel_escrow` can only be called by the original sender.
- `withdraw_fees` can only be called by the stored admin.
- Fees are stored in `AccumulatedFees` and never directly withdrawable by non-admin accounts.

## Security Audit Checklist

### Re-Entrancy
- Soroban prevents re-entrancy by disallowing cross-contract calls that re-enter the same contract instance within a single transaction invocation.
- All functions that make external token calls (`create_escrow`, `release_escrow`, `cancel_escrow`, `expire_escrow`) follow the **checks-effects-interactions** pattern: contract storage state is updated before any `token.transfer` call.
  - `create_escrow`: escrow record written to storage before `token.transfer`.
  - `release_escrow`: status set to `Released` and fees accumulated before `token.transfer`.
  - `cancel_escrow`: status set to `Cancelled` before `token.transfer` refund.

### Integer Overflow
- Soroban uses `i128` for token amounts with checked arithmetic.
- The escrow counter uses `checked_add` to prevent overflow.

### Access Control
- `initialize`: no auth required (single-use, blocked on re-call).
- `create_escrow`: `sender.require_auth()`.
- `release_escrow`: `agent.require_auth()` + agent address match.
- `cancel_escrow`: `sender.require_auth()` + sender address match.
- `withdraw_fees`: `admin.require_auth()` + stored admin match.
- `dispute_escrow`: `require_auth()` + caller must be the escrow sender or recipient.
- `upgrade`, `migrate`, `set_retention_period`, `cleanup_escrow`, `update_fee`, `set_kyc_contract`, `set_dispute_contract`: admin-only.
- `upgrade`, `migrate`, `set_retention_period`, `update_fee`, `set_kyc_contract`: admin-only.
- `expire_escrow`, `cleanup_escrow`: permissionless (anyone may call once eligible).

### Event Emission Completeness
- `EscrowInitialized` on `initialize`.
- `EscrowCreated` on `create_escrow` and each entry in `batch_create_escrow`.
- `EscrowReleased` on `release_escrow`.
- `EscrowCancelled` on `cancel_escrow`.
- `EscrowExpired` on `expire_escrow`.
- `DeliveryConfirmed` on `confirm_delivery`.
- `PartialRelease` on `partial_release`.
- `EscrowArchived` on `cleanup_escrow`.
- `FeesWithdrawn` on `withdraw_fees`.
- `EscrowDisputed` on `dispute_escrow`.
- `FeeUpdated` on `update_fee`.
- `Upgraded` on `upgrade`.
- `Migrated` on `migrate`.

## Build

```bash
rustup target add wasm32-unknown-unknown
cd contracts/escrow
cargo build --release --target wasm32-unknown-unknown
```

## Tests

```bash
cd contracts/escrow
cargo test
```
