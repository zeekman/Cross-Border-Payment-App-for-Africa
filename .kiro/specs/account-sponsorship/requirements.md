# Requirements Document

## Introduction

New Stellar accounts require a minimum balance of 1 XLM (base reserve) to be activated on the network. New AfriPay users who have no XLM cannot self-activate their Stellar wallet, creating a barrier to entry. This feature implements Stellar's native sponsorship mechanism so AfriPay's platform account sponsors the base reserve for new user accounts on mainnet, eliminating the funding barrier. Testnet onboarding continues to use Friendbot.

## Glossary

- **Sponsorship_Service**: The backend service responsible for constructing and submitting sponsored account creation transactions to the Stellar network.
- **Platform_Account**: The AfriPay-controlled Stellar keypair that sponsors base reserves for new user accounts.
- **Sponsored_Account**: A user Stellar account whose base reserve is covered by the Platform_Account.
- **Base_Reserve**: The minimum XLM balance (currently 1 XLM) required to activate a Stellar account.
- **Wallet_Controller**: The Express controller handling wallet creation and management endpoints.
- **Sponsorship_Record**: A database row in the `sponsored_accounts` table tracking a sponsored account and its reserve obligations.
- **Horizon**: The Stellar network API server used to submit transactions and query account state.

---

## Requirements

### Requirement 1: Platform Account Configuration

**User Story:** As a backend engineer, I want the platform keypair to be configurable via environment variables, so that AfriPay can manage the sponsoring account securely across environments.

#### Acceptance Criteria

1. THE Sponsorship_Service SHALL load the platform account secret key from the `PLATFORM_SECRET_KEY` environment variable.
2. THE Sponsorship_Service SHALL load the platform account public key from the `PLATFORM_PUBLIC_KEY` environment variable.
3. IF `PLATFORM_SECRET_KEY` is not set on mainnet, THEN THE Sponsorship_Service SHALL throw a configuration error at startup and prevent wallet creation.
4. THE Sponsorship_Service SHALL expose `PLATFORM_SECRET_KEY` and `PLATFORM_PUBLIC_KEY` as documented entries in `backend/.env.example` and `.env.example`.

---

### Requirement 2: Sponsored Account Creation on Mainnet

**User Story:** As a new AfriPay user on mainnet, I want my Stellar account to be activated without needing to acquire XLM first, so that I can start using the app immediately.

#### Acceptance Criteria

1. WHEN a new wallet is created and `STELLAR_NETWORK` is `mainnet`, THE Sponsorship_Service SHALL construct a sponsored account creation transaction using `StellarSdk.Operation.beginSponsoringFutureReserves` and `StellarSdk.Operation.endSponsoringFutureReserves`.
2. WHEN a sponsored account creation transaction is constructed, THE Sponsorship_Service SHALL include a `createAccount` operation with a starting balance of `0` XLM funded by the Platform_Account.
3. WHEN a sponsored account creation transaction is submitted, THE Sponsorship_Service SHALL sign the transaction with both the Platform_Account keypair and the new user keypair.
4. WHEN a sponsored account creation transaction is successfully submitted, THE Sponsorship_Service SHALL return the new account's public key and encrypted secret key to the Wallet_Controller.
5. WHEN a new wallet is created and `STELLAR_NETWORK` is `testnet`, THE Sponsorship_Service SHALL use Friendbot to fund the account and SHALL NOT use the sponsorship flow.

---

### Requirement 3: Sponsorship Record Tracking

**User Story:** As an AfriPay operator, I want to track which accounts have been sponsored and their reserve obligations, so that I can monitor platform liability and manage the sponsoring account's balance.

#### Acceptance Criteria

1. THE Sponsorship_Service SHALL persist a Sponsorship_Record to the `sponsored_accounts` table immediately after a sponsored account creation transaction is confirmed.
2. THE Sponsorship_Record SHALL include: the sponsored account's public key, the Platform_Account's public key, the transaction hash, the reserve amount in XLM, and the timestamp of sponsorship.
3. THE Sponsorship_Service SHALL store the sponsorship status as `active` upon creation.
4. IF a sponsored account creation transaction fails, THEN THE Sponsorship_Service SHALL NOT persist a Sponsorship_Record and SHALL propagate the error to the Wallet_Controller.

---

### Requirement 4: Sponsored Accounts Database Migration

**User Story:** As a backend engineer, I want a database migration for the `sponsored_accounts` table, so that sponsorship data is stored in a structured and queryable way.

#### Acceptance Criteria

1. THE Migration SHALL create a `sponsored_accounts` table with columns: `id` (serial primary key), `sponsored_public_key` (text, unique, not null), `sponsor_public_key` (text, not null), `transaction_hash` (text, not null), `reserve_amount` (numeric, not null), `status` (text, not null, default `active`), and `created_at` (timestamptz, not null, default now()).
2. THE Migration SHALL create an index on `sponsored_public_key` for efficient lookup.
3. THE Migration SHALL create an index on `sponsor_public_key` to support queries aggregating total reserve obligations per platform account.

---

### Requirement 5: Wallet Creation Integration

**User Story:** As a backend engineer, I want the wallet creation flow to transparently use sponsorship on mainnet, so that no changes are required in the API contract or frontend.

#### Acceptance Criteria

1. WHEN `createWallet` is called, THE Wallet_Controller SHALL invoke the sponsorship flow on mainnet and the Friendbot flow on testnet without exposing the difference to the API caller.
2. THE Wallet_Controller SHALL store the new wallet's `public_key` and `encrypted_secret_key` in the `wallets` table using the same schema as the existing non-sponsored flow.
3. IF the Platform_Account has insufficient XLM to cover the base reserve, THEN THE Sponsorship_Service SHALL return an error with a descriptive message and SHALL NOT create a partial wallet record.

---

### Requirement 6: Sponsorship Transaction Atomicity

**User Story:** As an AfriPay operator, I want the sponsorship transaction to be atomic, so that a partially-applied transaction never leaves the network or database in an inconsistent state.

#### Acceptance Criteria

1. THE Sponsorship_Service SHALL include `beginSponsoringFutureReserves`, `createAccount`, and `endSponsoringFutureReserves` as operations within a single Stellar transaction.
2. IF the Stellar network rejects the sponsorship transaction, THEN THE Sponsorship_Service SHALL NOT write any record to the `sponsored_accounts` table.
3. THE Sponsorship_Service SHALL set a transaction timeout of 30 seconds consistent with other transaction builders in the codebase.

---

### Requirement 7: Sponsorship Flow Tests

**User Story:** As a backend engineer, I want automated tests for the sponsorship flow, so that regressions are caught before deployment.

#### Acceptance Criteria

1. THE Test_Suite SHALL verify that `createWallet` uses the sponsorship path when `STELLAR_NETWORK` is `mainnet`.
2. THE Test_Suite SHALL verify that `createWallet` uses the Friendbot path when `STELLAR_NETWORK` is `testnet`.
3. THE Test_Suite SHALL verify that a Sponsorship_Record is persisted to the database after a successful sponsored account creation.
4. THE Test_Suite SHALL verify that no Sponsorship_Record is persisted when the Stellar transaction fails.
5. THE Test_Suite SHALL verify that a configuration error is thrown when `PLATFORM_SECRET_KEY` is missing on mainnet.
