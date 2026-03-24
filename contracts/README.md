# Smart Contracts

This directory contains Soroban smart contracts for the AfriPay cross-border payment platform.

## Contracts

### Escrow Contract (`escrow/`)
A trustless on-chain escrow contract for USDC remittances.

**Features:**
- Three-party escrow model (sender, recipient, agent)
- Automated fee calculation and collection
- Event emission for blockchain transparency
- Full test coverage
- Comprehensive documentation

**Quick Links:**
- Documentation: [escrow/README.md](./escrow/README.md)
- Source: [escrow/src/lib.rs](./escrow/src/lib.rs)
- Deployment: [deploy.sh](./deploy.sh)

## Building

```bash
cd escrow
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
cd escrow
cargo test
```

### Building for Production
```bash
cd escrow
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
