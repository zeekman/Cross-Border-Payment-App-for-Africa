# KYC Attestation Contract

On-chain KYC attestation for AfriPay. Stores a SHA-256 hash of the user's KYC data — never raw PII. Any Stellar ecosystem participant can call `is_verified` to check a wallet's KYC status without trusting AfriPay's centralized database.

## Overview

The contract enforces three-tier KYC levels:
- **Basic**: Minimal KYC (name, ID verification)
- **Enhanced**: Enhanced due diligence (proof of address, source of funds)
- **Premium** (called "Business" in `DataKey`): Full business KYC

## Access Control

- `attest`, `revoke`, `batch_revoke`, `migrate` — admin only
- `is_verified`, `is_valid_and_unexpired`, `get_attestation` — public
- `get_highest_tier` — public

## Storage Model (Issue #1454)

`DataKey::TieredAttestation(user, tier)` is the **single source of truth** for attestation records. Every reader and writer goes through the private helpers `load_attestation(user, tier)` / `store_attestation(user, tier, rec)`, so there is exactly one storage key per `(user, tier)` pair.

The legacy mirror keys are **no longer written**:

- `DataKey::Attestation(user)` — previously a "whichever tier was written last" mirror (misleading by construction).
- `DataKey::AttestationByTier(user, tier)` — a duplicate of `TieredAttestation` under a different key.

Removing these mirrors cuts persistent rent and write fees on the hottest admin path (`attest`/`revoke`) to roughly one third of the previous cost, and eliminates the class of bug where a write updated only one of the copies (e.g. a revoked user still reading as verified).

### Migration (`migrate`)

For deployments that still hold data in the old layout, a one-time admin-only `migrate` step (SC-186) is provided:

1. Copies any `AttestationByTier`-only records into `TieredAttestation` (existing `TieredAttestation` entries win).
2. Deletes both legacy keys (`Attestation` and `AttestationByTier`).

`migrate` is idempotent and intended to be run **once** immediately after upgrading the contract; after it completes, no legacy keys remain and all reads are served from `TieredAttestation`. See `src/test.rs` for a migration test that seeds old-layout data and verifies reads after `migrate`.

## Events (Issue #1455)

Events are structured `#[contracttype]` payloads with the user in the topics so indexers can filter by user without decoding every payload. Payloads carry everything needed to rebuild an `Attestation` without follow-up RPC reads (important for backfills and for entries that have since been archived).

| Event | Topics | Payload |
| --- | --- | --- |
| `kyc_attested` | `("kyc_attested", user, tier)` | `{ admin, kyc_hash, attested_at, expires_at, is_renewal }` |
| `kyc_renewed` | `("kyc_renewed", user, tier)` | `{ admin, kyc_hash, attested_at, expires_at, is_renewal }` |
| `kyc_revoked` | `("kyc_revoked", user, tier)` | `{ admin, revoked_at, revocation_count }` |
| `kyc_batch_revoked` | `("kyc_batch_revoked")` | `{ admin, count }` |

Notes for consumers:

- `is_renewal` distinguishes a fresh attestation from a renewal of an existing one.
- `kyc_hash` is the SHA-256 commitment to the KYC evidence; auditors can prove which evidence hash was attested at a given time from the event log alone.
- `revocation_count` lets indexers track repeat revocations per user.
- `kyc_batch_revoked` is emitted once per batch call (`revoke_batch` / `batch_revoke`); per-user details are available from the corresponding `kyc_revoked` events.

The backend `contractEventIndexer.js` is updated in a linked backend issue to consume this schema.

## Cross-Contract Call Costs (Issue #1072)

### Single Verification Call

A single `is_verified(user, tier)` call from another contract (e.g., escrow contract during `create_escrow`):
- **Storage reads**: 1 persistent storage lookup (`TieredAttestation(user, tier)`)
- **Ledger calls**: 1 ledger timestamp check (for expiry)
- **CPU**: ~100–200 instructions (hash lookup + expiry comparison)
- **Network**: 1 cross-contract invocation overhead

**Resource cost per call**: ~500–1000 CPU instructions equivalent (varies by Soroban host state).

### Batch Operation Worst Case

When `batch_create_escrow` (planned for issue #SC-002) creates N escrows (N ≤ 20 per batch):
- Each escrow creation checks KYC for **both sender and agent**: **2 KYC calls per escrow**
- Maximum batch: **20 escrows × 2 calls = 40 cross-contract KYC invocations** in a single transaction

**Resource accumulation**:
- At ~750 CPU instructions per call (average): **40 × 750 = 30,000 CPU instructions**
- Transaction limit on Soroban (testnet): ~1,600,000 CPU instructions
- **Proportion**: ~1.9% of transaction budget for KYC alone in a full 20-item batch

This is **well within safe limits** even with complex tier logic, assuming no other expensive operations.

### Observation

Cross-contract KYC calls do NOT become a bottleneck at current batch sizes (≤20) or KYC tier complexity. The escrow contract's other operations (storage reads/writes, fee math, token transfers) are likely more expensive per-escrow than KYC verification.

## Batched Verification API (Evaluation)

**Proposal**: A `is_valid_and_unexpired_batch(users_and_tiers: Vec<(Address, KycTier)>) -> Vec<bool>` entry point to reduce cross-contract call overhead.

**Evaluation**:
- **Benefit**: Reduces N cross-contract calls to 1 invocation; saves ~(N-1) × call overhead (~10–20 CPU instructions per saved call).
- **Cost**: Adds complexity to contract (batch validation loop, vector handling).
- **Verdict**: **Not needed** at current batch sizes. A single call overhead is ~20–50 CPU instructions; savings on a 40-call batch would be ~800–2000 instructions — less than 0.1% of transaction budget.

**Recommendation for future**: Only implement if:
1. Batch sizes grow significantly (>100 escrows per transaction), or
2. Cross-contract call overhead doubles in future Soroban versions

## Testing

See `src/test.rs` for:
- Basic attestation and verification tests
- Tier-specific verification (Basic, Enhanced, Premium)
- Expiry and revocation behavior
- Batch revocation atomic semantics
- **Batch KYC cost test** (`test_batch_kyc_verification_cost`) — simulates 20 concurrent KYC checks in a single transaction to measure actual resource usage

## Deployment

```bash
cd contracts/kyc-attestation
cargo build --release --target wasm32-unknown-unknown
cargo test
```

See [../deploy.sh](../deploy.sh) for on-chain deployment and initialization.

## Future Enhancements

1. **Tier upgrade/downgrade paths** (e.g., auto-expiry for stale Enhanced tiers)
2. **Attestation recall windows** (e.g., admin can invalidate recent attestations)
3. **Off-chain oracle integration** (if cross-chain KYC data becomes necessary)
