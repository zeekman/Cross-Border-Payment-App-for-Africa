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

- `Pending` → `Released` when the assigned agent calls `release_escrow`
- `Pending` → `Cancelled` when the original sender calls `cancel_escrow`

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

## Storage Layout

This contract stores state under the following `DataKey` variants in persistent storage:

- `DataKey::Admin` -> `Address`
- `DataKey::UsdcAddress` -> `Address`
- `DataKey::EscrowCounter` -> `u64`
- `DataKey::AccumulatedFees` -> `i128`
- `DataKey::Escrow(u64)` -> `Escrow`

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
    created_at: u64,
    expires_at: u64,
}
```

### `EscrowStatus` enum

```rust
enum EscrowStatus {
    Pending,
    Released,
    Cancelled,
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
4. Call `release_escrow(agent, escrow_id)` when payout is confirmed.
5. Call `cancel_escrow(sender, escrow_id)` to refund pending escrow.
6. Admin calls `withdraw_fees(admin, amount)` to collect fees.

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
