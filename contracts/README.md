# Smart Contracts

This directory contains Soroban smart contracts for the AfriPay cross-border payment platform.

## Contracts

| Contract | Description | Docs |
|---|---|---|
| `escrow/` | Three-party (sender/recipient/agent) trustless escrow for USDC remittances | [README](./escrow/README.md) |
| `agent-escrow/` | Trustless agent-mediated escrow variant for cross-border remittances | [README](./agent-escrow/README.md) |
| `dispute-resolution/` | On-chain three-party dispute resolution for escrowed payments | — |
| `fee-distributor/` | On-chain platform fee accumulation and withdrawal | — |
| `kyc-attestation/` | On-chain KYC status via SHA-256 hash (no raw PII stored on-chain) | — |
| `loyalty-token/` | SEP-41 compatible fungible loyalty token with tiered fee-discount redemption | — |
| `multisig-approval/` | Multisig proposal approval and signer key rotation | — |
| `recurring-payments/` | User-authorized recurring transfers without giving the contract custody of funds | [README](./recurring-payments/README.md) |
| `savings-vault/` | On-chain savings deposit/withdrawal vault | — |

Each contract is an independent crate — see its `Cargo.toml` and `src/lib.rs` for details where a dedicated README isn't yet written.

**Deployment:** [deploy.sh](./deploy.sh)

## Admin rotation

All nine contracts above support a **two-step admin rotation** (SC-120 / SC-190). The flow is:

1. `propose_admin(admin, new_admin)` — the current admin authorizes the call. The proposed admin is
   stored as `PendingAdmin` together with an ETA of **24 hours** from the current ledger timestamp.
   Emits `AdminProposed { admin, new_admin, eta }`.
2. `accept_admin(new_admin)` — the *new* admin must sign (`new_admin.require_auth()`) and the ledger
   timestamp must be `>= eta`. On success `Admin` is swapped to `new_admin`, `PendingAdmin` is
   cleared, and `AdminChanged { old, new }` is emitted.
3. `cancel_admin_proposal(admin)` — the current admin can cancel a pending proposal at any time.
   Emits `AdminCancelled { admin, new_admin }`.

Notes:

- Rotation cannot complete without the new admin's signature, and cannot complete before the 24 h
  delay elapses. Both are enforced on-chain and covered by tests.
- Once `accept_admin` succeeds, the old admin loses **all** privileges immediately (e.g. `pause`,
  `unpause`, fee withdrawal, KYC revocation, upgrades). Calls made with the old key fail auth.
- **Recommendation:** the admin should be a multisig account, or the `multisig-approval` contract
  itself, so that a single lost or compromised key cannot take over or lock out governance.

## Events

All contracts publish events with stable topics so the backend indexer
(`backend/src/jobs/contractEventIndexer.js`) can build history and trigger notifications.

### Admin rotation events

| Topic | Payload |
|---|---|
| `("admin_proposed",)` | `{ admin, new_admin, eta }` |
| `("admin_changed",)` | `{ old, new }` |
| `("admin_cancelled",)` | `{ admin, new_admin }` |

### `multisig-approval` events

Every state-changing function in `multisig-approval` emits exactly one event. Topics are
`(symbol, id)` where `id` is the transaction/proposal id (or signer address for weight changes).

| Topic | Payload |
|---|---|
| `("ms_proposed", tx_id)` | `{ proposer, amount, recipient, description, expires_at }` |
| `("ms_approved", tx_id)` | `{ approver, weight, total_approvals, quorum }` |
| `("ms_rejected", tx_id)` | `{ rejecter, weight, total_rejections, quorum }` |
| `("ms_cancelled", tx_id)` | `{ canceller }` |
| `("ms_expired", tx_id)` | `{ tx_id, expired_at }` |
| `("ms_executed", tx_id)` | `{ executor, amount, recipient }` |
| `("ms_quorum_proposed", id)` | `{ proposer, quorum, eta }` |
| `("ms_quorum_changed", id)` | `{ old_quorum, new_quorum }` |
| `("ms_weight_set", signer)` | `{ signer, old_weight, new_weight }` |

Signer-rotation events (`EvtSignerChangeProposed`, `EvtSignerChanged`, `EvtSignerChangeCancelled`)
are documented in `multisig-approval/src/lib.rs`.

## Building

```bash
cd <contract-dir>   # e.g. escrow, fee-distributor, savings-vault, ...
cargo build --release --target wasm32-unknown-unknown
cargo test
```

## Deployment

The deploy script never passes a secret key on the command line. It signs with a
named Stellar CLI identity (`--source <identity>`).

### Deployer identity setup

**Testnet** — create or import an identity once (the key is read from a prompt/stdin, not argv):

```bash
stellar keys generate afripay-testnet-deployer --network testnet --fund
# or: stellar keys add afripay-testnet-deployer --secret-key   (paste key at the prompt)
SOROBAN_IDENTITY=afripay-testnet-deployer bash deploy.sh
```

As a testnet-only convenience, `SOROBAN_SECRET_KEY` is still accepted: the script imports it
into an identity via stdin and unsets the variable before any deploy call.

**Mainnet** — an explicit identity is required (no env-secret fallback); a Ledger is recommended:

```bash
stellar keys add afripay-mainnet --ledger      # or another hardware-backed identity
EXPECTED_WASM_HASH=<sha256 of audited wasm> SOROBAN_IDENTITY=afripay-mainnet \
  bash deploy.sh --network mainnet --confirm-mainnet
```

The script exits non-zero (without writing `.deployed_ids.env`) if the deploy fails, the
returned contract ID is not a valid `C…` address, or the WASM hash does not match
`EXPECTED_WASM_HASH` (mandatory on mainnet).

### Integration tests

`integration-tests/` registers all contracts in a single test `Env` and exercises KYC → escrow →
release → fee distributor → dispute, recurring payments with a fee, and savings deposit/withdraw:

```bash
cd integration-tests && cargo test
```

See [deploy.sh](./deploy.sh) for detailed deployment instructions and network configuration.

## Development

### Prerequisites
- Rust 1.70+
- Soroban CLI
- wasm32 target: `rustup target add wasm32-unknown-unknown`

### Testing
```bash
cd <contract-dir>
cargo test
```

### Building for Production
```bash
cd <contract-dir>
cargo build --release --target wasm32-unknown-unknown
```

## Integration

The escrow contract is designed to integrate with the AfriPay backend to replace the centralized payment logic with trustless on-chain operations.

### Backend Integration Steps
1. Deploy the contract and save the contract ID
2. Update backend environment variables with `ESCROW_CONTRACT_ID` and `ESCROW_USDC_ADDRESS`
3. Modify payment controller to invoke contract functions instead of direct transfers
4. Listen for escrow events on Stellar for state synchronization

### Next Steps
1. Test on Stellar testnet
2. Get security audit from Soroban auditors
3. Deploy to mainnet
4. Gradual migration of escrow operations from backend to contract

## Resources

- [Soroban Docs](https://soroban.stellar.org)
- [Stellar Expert](https://stellar.expert)
- [USDC on Stellar](https://www.circle.com/usdc-on-stellar)

## License

See root LICENSE file.
