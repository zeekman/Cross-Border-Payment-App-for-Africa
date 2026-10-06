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

## Building

```bash
cd <contract-dir>   # e.g. escrow, fee-distributor, savings-vault, ...
cargo build --release --target wasm32-unknown-unknown
cargo test
```

## Deployment

```bash
export SOROBAN_SECRET_KEY='your-secret-key'
bash deploy.sh
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
