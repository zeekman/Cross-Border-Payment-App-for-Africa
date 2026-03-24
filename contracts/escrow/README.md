# Soroban Escrow Contract

A trustless, on-chain escrow contract for USDC remittances on the Stellar network. This contract enables secure multi-party fund transfers with agent-mediated payout confirmation and automated fee collection.

## Overview

The escrow contract implements a three-party model:
1. **Sender** — Initiates the remittance by depositing USDC
2. **Recipient** — The final beneficiary of funds
3. **Agent** — Handles off-chain fiat distribution and confirms completion

The contract ensures funds are held safely until the agent confirms successful payout, at which point fees are deducted and the agent receives their share.

## Architecture

### Core Components

**Escrow State Machine**
```
Pending → Released (agent confirms)
       ↓
    Cancelled (sender refunds)
```

**Data Model**
- `Escrow` — Tracks sender, recipient, agent, amount, fees, status, and timestamp
- `EscrowStatus` — Enum: Pending, Released, Cancelled
- Events — Emitted on all state transitions for blockchain transparency

**Fee Mechanism**
- Fees calculated in basis points (100 bps = 1%)
- Deducted automatically on release
- Accumulated for admin withdrawal

## Smart Contract Functions

### Initialization
```rust
fn initialize(admin: Address, usdc_address: Address)
```
Sets up the contract with an admin account and USDC token address. Called once during deployment.

**Parameters:**
- `admin` — Address authorized to withdraw accumulated fees
- `usdc_address` — USDC contract address on Stellar (e.g., USDC on testnet)

**Events:** `EscrowInitialized`

---

### Create Escrow
```rust
fn create_escrow(
    sender: Address,
    recipient: Address,
    agent: Address,
    amount: i128,
    release_fee_bps: u32,
) -> u64
```
Creates a new escrow and transfers USDC from sender to the contract.

**Parameters:**
- `sender` — Stellar address of the remittance originator
- `recipient` — Stellar address of the final recipient
- `agent` — Agent handling the payout (agent account address)
- `amount` — Amount in stroops (USDC smallest unit, 1 USDC = 10^7 stroops)
- `release_fee_bps` — Fee in basis points (0-10000, where 10000 = 100%)

**Returns:** Unique escrow ID (u64)

**Validations:**
- Amount must be > 0
- Fee must be ≤ 100% (10000 bps)
- Sender must have sufficient USDC balance and approval

**Events:** `EscrowCreated`

**Example (JavaScript via soroban.js):**
```javascript
const escrowId = await client.create_escrow(
    senderAddress,
    recipientAddress,
    agentAddress,
    1000_0000000n,  // 1000 USDC
    250n             // 2.5% fee
);
```

---

### Release Escrow
```rust
fn release_escrow(escrow_id: u64)
```
Confirms payout and releases funds to the agent. Only the assigned agent can call this.

**Parameters:**
- `escrow_id` — ID of the escrow to release

**Logic:**
1. Validates caller is the agent
2. Calculates: `fee = (amount × fee_bps) / 10000`
3. Transfers `agent_amount = amount - fee` to agent
4. Accumulates `fee` in contract
5. Updates escrow status to `Released`

**Events:** `EscrowReleased`

**Security:** Only the agent specified in `create_escrow` can release, preventing unauthorized payouts.

---

### Cancel Escrow
```rust
fn cancel_escrow(escrow_id: u64)
```
Refunds the full amount to sender. Only the sender can cancel, and only if escrow is pending.

**Parameters:**
- `escrow_id` — ID of the escrow to cancel

**Logic:**
1. Validates caller is the sender
2. Verifies escrow is `Pending`
3. Transfers full `amount` back to sender
4. Updates escrow status to `Cancelled`

**Events:** `EscrowCancelled`

---

### Get Escrow
```rust
fn get_escrow(escrow_id: u64) -> Escrow
```
Retrieves full escrow details.

**Returns:**
```rust
Escrow {
    id: u64,
    sender: Address,
    recipient: Address,
    agent: Address,
    amount: i128,
    release_fee_bps: u32,
    status: EscrowStatus,
    created_at: u64,  // Ledger timestamp in seconds
}
```

---

### Get Accumulated Fees
```rust
fn get_accumulated_fees() -> i128
```
Returns total platform fees collected but not yet withdrawn.

---

### Withdraw Fees
```rust
fn withdraw_fees(amount: i128)
```
Withdraws accumulated fees to the admin account. Only admin can call.

**Parameters:**
- `amount` — Amount to withdraw (must be ≤ accumulated fees)

**Security:** Only initialized admin can withdraw.

---

### Get Metadata
```rust
fn get_metadata() -> (Address, Address)
```
Returns `(admin, usdc_address)` for verification and integration.

---

## Events

### EscrowInitialized
```rust
struct EscrowInitialized {
    contract_id: Address,
    admin: Address,
    usdc_address: Address,
}
```

### EscrowCreated
```rust
struct EscrowCreated {
    escrow_id: u64,
    sender: Address,
    recipient: Address,
    agent: Address,
    amount: i128,
    release_fee_bps: u32,
}
```

### EscrowReleased
```rust
struct EscrowReleased {
    escrow_id: u64,
    agent_amount: i128,
    fee_amount: i128,
}
```

### EscrowCancelled
```rust
struct EscrowCancelled {
    escrow_id: u64,
    refund_amount: i128,
}
```

All events are published to the Stellar ledger and visible on Stellar Expert.

---

## Building

### Prerequisites
- Rust 1.70+
- `wasm32-unknown-unknown` target
- Soroban CLI

### Build

```bash
rustup target add wasm32-unknown-unknown
cd contracts/escrow
cargo build --release --target wasm32-unknown-unknown
```

Output: `target/wasm32-unknown-unknown/release/escrow_contract.wasm`

### Test

```bash
cd contracts/escrow
cargo test
```

Tests cover:
- Initialization
- Double initialization prevention
- Escrow creation
- Multiple escrows
- Invalid amount/fee validation
- Fee accumulation
- Non-existent escrow handling
- Metadata retrieval

---

## Deployment

### Prerequisites
1. **Soroban CLI** — [Installation guide](https://soroban.stellar.org/docs/reference/cli)
2. **Stellar account** with XLM for transaction fees
3. **Secret key** with proper permissions

### Deploy to Testnet

```bash
export STELLAR_NETWORK=testnet
export SOROBAN_SECRET_KEY='your-secret-key'
cd contracts
bash deploy.sh
```

### Deploy to Mainnet

```bash
export STELLAR_NETWORK=mainnet
export SOROBAN_SECRET_KEY='your-secret-key'
cd contracts
bash deploy.sh
```

The script will:
1. Build the contract
2. Optimize the WASM
3. Deploy to the specified network
4. Save deployment info to `deployments/{network}_deployment.json`
5. Output the contract ID and Stellar Expert link

### Manual Deployment

```bash
# Compile
cargo build --release --target wasm32-unknown-unknown

# Deploy
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/escrow_contract.wasm \
  --source YOUR_SECRET_KEY \
  --network testnet
```

---

## Integration with Backend

### Node.js Integration Example

```javascript
const StellarSdk = require('@stellar/stellar-sdk');

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const USDC_ADDRESS = 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTPK5XNQWRZNRNW5DOOJ4JY6P';

async function initializeEscrowContract(adminAddress) {
    const contract = new StellarSdk.Contract(CONTRACT_ID);
    
    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
    })
        .addOperation(
            new StellarSdk.Operation.InvokeHostFunction({
                func: new StellarSdk.xdr.HostFunction({
                    type: StellarSdk.xdr.HostFunctionType.hostFunctionTypeInvokeContract(),
                    invokeContract: new StellarSdk.xdr.InvokeContractArgs({
                        contractAddress: contract.address(),
                        functionName: 'initialize',
                        args: [
                            StellarSdk.nativeToScVal(adminAddress, { type: 'address' }),
                            StellarSdk.nativeToScVal(USDC_ADDRESS, { type: 'address' }),
                        ],
                    }),
                }),
            })
        )
        .setTimeout(30)
        .build();
    
    // Sign and submit...
}

async function createEscrow(senderAddress, recipientAddress, agentAddress, amount, feeBps) {
    // Similar pattern to initialize - invoke contract function
    // Returns escrow_id on success
}
```

### Key Points
1. Use `soroban contract invoke` CLI or SDK for function calls
2. Amounts must be in stroops (multiply USDC by 10^7)
3. Fees are in basis points (100 = 1%, 250 = 2.5%, etc.)
4. Always verify contract ID and network before submitting transactions

---

## Security Considerations

### Access Control
- **Initialize**: Deploys call only
- **Create Escrow**: Any caller with funds (public function)
- **Release Escrow**: Only assigned agent
- **Cancel Escrow**: Only original sender
- **Withdraw Fees**: Only admin

### Fund Safety
- Contract holds USDC through Stellar's native token system
- No private key storage
- Trustline validation integrated into Stellar transfers
- All revert conditions explicitly documented

### Risks & Mitigations
| Risk | Mitigation |
|------|-----------|
| Agent doesn't release | Sender can cancel and refund within reasonable timeframe |
| Rug pull by admin | Fees only on released escrows; admin cannot access pending funds |
| Wrong contract deployed | Verify contract ID on Stellar Expert before first use |
| Network outage | Stellar's infrastructure redundancy; stored on immutable ledger |

---

## Monitoring & Debugging

### Check Escrow Status
```bash
soroban contract invoke \
  --id CAAAA... \
  --source SOURCE_KEY \
  --fn get_escrow \
  --arg-u64 123
```

### Monitor Events
```bash
# Use Stellar Expert or soroban-cli to watch contract events
soroban events --id CAAAA... --network testnet
```

### View Deployments
```bash
cat contracts/deployments/testnet_deployment.json
```

---

## Roadmap & Future Enhancements

- **Timelock Escrow** — Automatic refund after 30 days if not released
- **Multi-Agent Support** — Multiple agents per escrow for redundancy
- **Dispute Resolution** — Escalation mechanism for conflicting claims
- **Automated Price Feeds** — Integrate Stellar's price oracle for dynamic fees
- **Batch Operations** — Create multiple escrows in one transaction

---

## References

- [Soroban Documentation](https://soroban.stellar.org)
- [Stellar Expert Contract Explorer](https://stellar.expert)
- [USDC on Stellar](https://www.circle.com/usdc-on-stellar)
- [Stellar Testnet](https://stellar.org/developers)

---

## License

This contract is part of the AfriPay cross-border payment platform. See root LICENSE file.

---

## Support

For issues or questions:
1. Check [Soroban Discord](https://discord.gg/stellardev)
2. Review contract ABI in this README
3. Check test cases in `src/lib.rs` for usage examples
