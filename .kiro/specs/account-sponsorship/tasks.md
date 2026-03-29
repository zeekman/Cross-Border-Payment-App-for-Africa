# Implementation Plan: Account Sponsorship

## Overview

Implement Stellar native account sponsorship for mainnet wallet creation in `backend/src/services/stellar.js`, add the `sponsored_accounts` database migration, and wire the sponsorship DB write into the wallet creation flow. Testnet continues to use Friendbot unchanged.

## Tasks

- [ ] 1. Add database migration for `sponsored_accounts` table
  - Create `database/migrations/012_add_sponsored_accounts.js` following the pattern of existing migrations
  - Define columns: `id` (serial PK), `sponsored_public_key` (text, unique, not null), `sponsor_public_key` (text, not null), `transaction_hash` (text, not null), `reserve_amount` (numeric, not null), `status` (text, not null, default `'active'`), `created_at` (timestamptz, not null, default `now()`)
  - Add index `sponsored_accounts_sponsored_public_key_idx` on `sponsored_public_key`
  - Add index `sponsored_accounts_sponsor_public_key_idx` on `sponsor_public_key`
  - _Requirements: 4.1, 4.2, 4.3_

- [ ] 2. Add platform account configuration and startup guard in `stellar.js`
  - [ ] 2.1 Load `PLATFORM_SECRET_KEY` and `PLATFORM_PUBLIC_KEY` from `process.env` at module level in `stellar.js`
    - Derive the public key from the secret key using `StellarSdk.Keypair.fromSecret` and validate it matches `PLATFORM_PUBLIC_KEY`
    - On mainnet (`!isTestnet`), throw a `ConfigurationError` synchronously if `PLATFORM_SECRET_KEY` is absent so the process fails fast before any wallet creation is attempted
    - _Requirements: 1.1, 1.2, 1.3_

  - [ ]* 2.2 Write property test for platform keypair loading (Property 1)
    - **Property 1: Platform keypair is loaded from environment variables**
    - **Validates: Requirements 1.1, 1.2**
    - Use `fast-check` `fc.string()` to generate random valid Stellar secret keys; verify the derived public key matches the env-loaded value

- [ ] 3. Implement `createSponsoredAccount` in `stellar.js`
  - [ ] 3.1 Add internal (non-exported) async function `createSponsoredAccount(keypair)` in `stellar.js`
    - Load the platform account from Horizon using `withRetry`/`withFallback`
    - Build a single transaction with three operations in order: `beginSponsoringFutureReserves` (source: platform), `createAccount` (destination: new keypair, startingBalance: `"0"`), `endSponsoringFutureReserves` (source: new keypair)
    - Set `setTimeout(30)` consistent with all other transaction builders in the codebase
    - Sign with both the platform keypair and the new user keypair
    - Submit via `withRetry`/`withFallback`
    - Return `{ publicKey, encryptedSecretKey, transactionHash }`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 6.1, 6.3_

  - [ ]* 3.2 Write property test for mainnet transaction structure (Property 2)
    - **Property 2: Mainnet sponsorship transaction structure**
    - **Validates: Requirements 2.1, 2.2, 2.3, 6.1**
    - Use `fc.record({...})` to generate random user keypairs; mock Horizon `loadAccount` and `submitTransaction`; assert the built transaction has exactly 3 operations in the correct order, `createAccount` starting balance is `"0"`, and the transaction carries exactly 2 signatures

  - [ ]* 3.3 Write property test for transaction timeout (Property 6)
    - **Property 6: Transaction timeout is 30 seconds**
    - **Validates: Requirements 6.3**
    - For any constructed sponsorship transaction, verify `timeBounds.maxTime - timeBounds.minTime <= 30`

- [ ] 4. Update `createWallet` to branch on network and persist sponsorship record
  - [ ] 4.1 Update `createWallet()` in `stellar.js` to call `createSponsoredAccount` on mainnet and Friendbot on testnet
    - On mainnet: call `createSponsoredAccount(keypair)`, then `INSERT` a row into `sponsored_accounts` with `sponsor_public_key`, `transaction_hash`, `reserve_amount = 1`, `status = 'active'`
    - On testnet: keep existing Friendbot path unchanged
    - If the Stellar transaction fails, propagate the error without writing to `sponsored_accounts`
    - Return `{ publicKey, encryptedSecretKey }` in both paths (same shape as before)
    - _Requirements: 2.1, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 5.1, 6.2_

  - [ ]* 4.2 Write property test for `createWallet` return value round-trip (Property 3)
    - **Property 3: createWallet return value round-trip**
    - **Validates: Requirements 2.4**
    - Use `fc.boolean()` to select network; verify `decryptPrivateKey(encryptedSecretKey)` produces a keypair whose derived public key equals the returned `publicKey`

  - [ ]* 4.3 Write property test for sponsorship DB record completeness (Property 4)
    - **Property 4: Successful sponsorship produces a complete DB record**
    - **Validates: Requirements 3.1, 3.2, 3.3**
    - Generate random transaction hashes and public keys; after a mocked successful submission, query the DB and verify the row has non-null `sponsor_public_key`, `transaction_hash`, `reserve_amount`, and `status = 'active'`

  - [ ]* 4.4 Write property test for wallet table correctness (Property 5)
    - **Property 5: Wallet table is written with correct keys**
    - **Validates: Requirements 5.2**
    - For any wallet creation result, verify the `wallets` table row contains the same `public_key` and `encrypted_secret_key` that `createWallet` returned

- [ ] 5. Document environment variables in `.env.example` files
  - Add `PLATFORM_SECRET_KEY=` and `PLATFORM_PUBLIC_KEY=` entries with comments to `backend/.env.example` and `.env.example`
  - _Requirements: 1.4_

- [ ] 6. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Write unit/integration tests for the sponsorship flow
  - [ ] 7.1 Write Jest tests covering the mainnet sponsorship path
    - `createWallet` on mainnet calls `createSponsoredAccount` (mock Horizon)
    - `createWallet` on testnet calls Friendbot and skips sponsorship (mock fetch)
    - Missing `PLATFORM_SECRET_KEY` on mainnet throws `ConfigurationError` at startup
    - Horizon rejection → no `sponsored_accounts` row written
    - Insufficient platform balance → no `wallets` row written
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 5.3_

  - [ ]* 7.2 Write unit test for migration schema
    - Verify migration creates table with correct columns and indexes
    - _Requirements: 4.1, 4.2, 4.3_

- [ ] 8. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- `createSponsoredAccount` is intentionally not exported; only `createWallet` is the public API
- The `wallets` table write remains in `walletController.js` (or `authController.js`) unchanged — no API contract changes
- Property tests require `fast-check`: `npm install --save-dev fast-check`
