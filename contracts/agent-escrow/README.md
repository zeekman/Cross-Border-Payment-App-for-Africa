# Agent Escrow Contract

A Soroban smart contract implementing trustless agent-mediated escrow for cross-border remittances on the Stellar network.

## Overview

The Agent Escrow Contract enables secure, trustless transfers between remittance senders and recipients via trusted agents. The contract acts as an intermediary, holding funds in escrow until the agent confirms off-chain fiat delivery, at which point funds are released to the agent (minus a platform fee).

## Key Features

- **Trustless Agent Payout**: Senders lock USDC in escrow; agents confirm delivery and receive funds
- **Sender Refund Protection**: Senders can reclaim funds if the agent doesn't confirm within 48 hours
- **Platform Fees**: Configurable basis-point fees accumulated by the admin
- **Immutable Ledger Trail**: All transactions and status changes are recorded on-chain

## Contract Functions

### Initialization

#### `initialize(env, admin, usdc_address)`
Initializes the contract. Must be called once before any other function.

**Arguments:**
- `admin`: Address that may withdraw accumulated fees
- `usdc_address`: Stellar asset contract address for USDC

**Panics if:**
- Contract is already initialized

---

### Core Escrow Operations

#### `create_escrow(env, sender, recipient, agent, amount, fee_bps) -> u64`
Locks USDC in escrow pending agent payout confirmation.

**Arguments:**
- `sender`: Payer; must authorize this call
- `recipient`: Off-chain fiat recipient (informational)
- `agent`: Registered payout agent who will call `confirm_payout`
- `amount`: USDC amount in stroops (must be > 0)
- `fee_bps`: Platform fee in basis points (0–10,000)

**Returns:** New escrow ID

**Panics if:**
- Amount is not positive
- Fee exceeds 10,000 basis points

**Events:**
- `EscrowCreated`: Contains escrow details and expiration timestamp

---

#### `confirm_payout(env, agent, escrow_id)`
Agent confirms off-chain fiat delivery, releasing USDC from escrow.

**Arguments:**
- `agent`: Must match the agent recorded in the escrow
- `escrow_id`: ID returned by `create_escrow`

**Effects:**
- Transfers `(amount - fee)` to the agent
- Accumulates the fee for later admin withdrawal
- Updates escrow status to `Completed`

**Panics if:**
- Caller is not the designated agent
- Escrow is not in `Pending` status

**Events:**
- `PayoutConfirmed`: Contains agent amount and fee amount

---

#### `cancel_escrow(env, sender, escrow_id)`
Cancels a pending escrow and refunds the sender.

**Arguments:**
- `sender`: Must match the sender recorded in the escrow
- `escrow_id`: ID returned by `create_escrow`

**Effects:**
- Returns full amount to the original sender
- Updates escrow status to `Cancelled`

**Requirements:**
- Only the original sender may cancel
- 48-hour cancellation window must have elapsed

**Panics if:**
- Caller is not the escrow sender
- Escrow is not in `Pending` status
- Cancellation window has not elapsed

**Events:**
- `EscrowCancelled`: Contains escrow ID and refund amount

---

#### `get_escrow(env, escrow_id) -> AgentEscrow`
Returns the full escrow record for the given ID.

**Arguments:**
- `escrow_id`: ID returned by `create_escrow`

**Returns:** Complete `AgentEscrow` struct with all fields

**Panics if:**
- Escrow not found

---

### Fee Management

#### `get_fees(env) -> i128`
Returns total platform fees accumulated but not yet withdrawn.

---

#### `withdraw_fees(env, to, amount)`
Withdraws `amount` of the accumulated platform fees to `to`. Requires the
stored admin's authorisation. Partial withdrawals are supported; insurance
contributions are not withdrawable here.

**Arguments:**
- `to`: Recipient of the fees (e.g. treasury). Must not be the contract itself
- `amount`: Amount to withdraw (must be positive and not exceed accumulated fees)

**Panics if:**
- Admin has not authorised the call
- `amount` is zero/negative or exceeds accumulated fees
- `to` is the contract address

**Events:**
- `FeesWithdrawn`: `{ admin, to, amount, remaining_fees }`

---

### Insurance Fund

Every fee booked by `confirm_payout`, `partial_confirm_payout` and
`admin_release` (to agent) is split: `InsuranceContributionBps` (default
500 = 5 %) goes to the insurance fund, the rest to withdrawable fees.
`withdraw_fees` never touches the insurance fund.

#### `insurance_payout(env, escrow_id)`
Admin only. Pays the escrow's original sender from the insurance fund.

- The escrow must be `Cancelled`.
- The claim is the escrow's `released_amount` (funds the agent received
  before cancellation; everything else was already refunded). A plain
  cancel with no partial releases has nothing to claim.
- Cumulative payouts per escrow are capped at that claim, so repeated calls
  cannot pay twice. Each call pays `min(outstanding claim, fund balance)`.
- Emits `InsurancePayout`.

#### `set_insurance_contribution_bps(env, new_bps)`
Admin only. Sets the insurance share of each fee (max 1000 = 10 %).
Emits `InsuranceContributionBpsUpdated`.

#### `get_insurance_balance(env) -> i128`
Current insurance fund balance (`get_insurance_fund` is an alias).

#### `get_insurance_contribution_bps(env) -> u32` / `get_insurance_paid(env, escrow_id) -> i128`
Current contribution rate, and insurance already paid for an escrow.

### Administration

#### `update_admin(env, new_admin)`
Rotates the admin. Requires authorisation from **both** the current and
the new admin. Emits `AdminUpdated`.

---

## Data Structures

### EscrowStatus
```rust
pub enum EscrowStatus {
    Pending,      // Awaiting agent payout confirmation
    Completed,    // Agent confirmed payout; funds released
    Cancelled,    // Cancelled by sender after timeout; funds refunded
}
```

### AgentEscrow
```rust
pub struct AgentEscrow {
    pub id: u64,              // Unique escrow ID
    pub sender: Address,      // Payer
    pub recipient: Address,   // Off-chain recipient
    pub agent: Address,       // Payout agent
    pub amount: i128,         // Amount in stroops
    pub fee_bps: u32,         // Platform fee in basis points
    pub status: EscrowStatus,
    pub created_at: u64,      // Creation timestamp
    pub expires_at: u64,      // Cancellation window expiration (created_at + 48h)
}
```

---

## Events

- **EscrowCreated**: Emitted when a new escrow is created
- **PayoutConfirmed**: Emitted when agent confirms payout
- **EscrowCancelled**: Emitted when sender cancels escrow
- **FeesWithdrawn**: Emitted when the admin withdraws platform fees

---

## Constants

- **CANCEL_WINDOW_SECS**: 48 hours (172,800 seconds) — period after which sender can cancel

---

## Usage Flow

1. **Sender** calls `create_escrow` with details and locks USDC
2. **Agent** performs off-chain fiat delivery
3. **Agent** calls `confirm_payout` to release funds
4. **Alternatively**, if agent doesn't confirm within 48 hours, **Sender** calls `cancel_escrow` for a refund
5. **Admin** periodically calls `withdraw_fees` to collect platform fees

---

## Security Considerations

- **Sender Protection**: 48-hour cancellation window ensures senders can recover funds if agent doesn't deliver
- **Agent Authorization**: Only the designated agent can release funds
- **Admin Control**: Only the admin can withdraw fees, preventing unauthorized access
- **Immutability**: All state changes are persisted and auditable on-chain
- **Integer Overflow**: Escrow counter uses checked arithmetic to prevent overflow

---

## Testing

The contract includes comprehensive tests in `src/test.rs` covering:
- Escrow creation and validation
- Payout confirmation (happy path)
- Cancellation after timeout
- Fee accumulation and withdrawal
- Authorization and permission checks
- Edge cases (expired escrows, invalid amounts, etc.)

---

## Deployment

See the parent directory's deployment guide for instructions on building and deploying this contract to Stellar testnet or mainnet.
