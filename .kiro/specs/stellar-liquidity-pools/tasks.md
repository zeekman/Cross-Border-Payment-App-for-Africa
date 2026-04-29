# Implementation Plan: Stellar Liquidity Pool Integration

## Overview

Implement Stellar AMM liquidity pool support for AfriPay following the layered architecture: database migration → backend service → Express router → React frontend. Each layer builds on the previous, with property-based and unit tests placed close to the code they validate.

## Tasks

- [ ] 1. Create database migration for liquidity_transactions table
  - Create `database/migrations/YYYYMMDDHHMMSS_create_liquidity_transactions.js` (or `.sql`)
  - Define all columns: `id`, `user_id`, `pool_id`, `transaction_type`, `xlm_amount`, `usdc_amount`, `pool_shares`, `transaction_hash`, `created_at` with constraints from the design
  - Add indexes on `user_id`, `pool_id`, and `created_at DESC`
  - _Requirements: 6.1_

- [ ] 2. Implement the liquidity service
  - [ ] 2.1 Create `backend/src/services/liquidity.js` with `getPools()`
    - Query Stellar Horizon for all active XLM/USDC liquidity pools
    - Normalise each pool record to the `Pool` interface (id, assetA, assetB, totalLiquidity, feeRate, apy)
    - Compute APY using `(fee_earned_24h / total_reserves_usd) * 365`; fall back to `(total_fee_pool / pool_age_days)` when 24h fee data is unavailable
    - Reuse `withFallback` and `withRetry` from `stellar.js`
    - _Requirements: 1.2, 1.3, 1.4_

  - [ ]* 2.2 Write property test for pool list response shape (Property 4)
    - **Property 4: Pool list response contains all required fields for every pool**
    - **Validates: Requirements 1.3**
    - Tag: `// Feature: stellar-liquidity-pools, Property 4: pool list response contains all required fields for every pool`
    - Generate arbitrary arrays of Horizon pool records with fast-check; assert every normalised element contains `id`, `assetA`, `assetB`, `totalLiquidity`, `feeRate`, and `apy`

  - [ ] 2.3 Add `deposit()` to `backend/src/services/liquidity.js`
    - Decrypt the user's secret key via `decryptPrivateKey` from `stellar.js`
    - Build and submit a `liquidityPoolDeposit` operation with the given `poolId`, `maxXlm`, `maxUsdc`, and a 10% minimum price tolerance
    - Detect `op_underfunded` in `err.response?.data?.extras?.result_codes` and throw a typed `InsufficientBalanceError`
    - _Requirements: 2.5, 2.7, 2.8_

  - [ ]* 2.4 Write property test for deposit response shape (Property 5)
    - **Property 5: Successful deposit response contains transaction hash and pool shares**
    - **Validates: Requirements 2.6**
    - Tag: `// Feature: stellar-liquidity-pools, Property 5: successful deposit response contains transaction hash and pool shares`
    - Generate arbitrary confirmed Stellar deposit results with fast-check; assert response always contains a non-empty `transaction_hash` and a positive `pool_shares`

  - [ ] 2.5 Add `withdraw()` to `backend/src/services/liquidity.js`
    - Build and submit a `liquidityPoolWithdraw` operation with the given `poolId`, `poolShares`, and `minAmountA/B = 0`
    - Detect insufficient-shares error code and throw a typed `InsufficientSharesError`
    - _Requirements: 4.5, 4.7, 4.8_

  - [ ]* 2.6 Write property test for withdrawal response shape (Property 6)
    - **Property 6: Successful withdrawal response contains transaction hash and asset amounts**
    - **Validates: Requirements 4.6**
    - Tag: `// Feature: stellar-liquidity-pools, Property 6: successful withdrawal response contains transaction hash and asset amounts`
    - Generate arbitrary confirmed Stellar withdrawal results; assert response always contains a non-empty `transaction_hash`, non-negative `xlm_received`, and non-negative `usdc_received`

  - [ ] 2.7 Add `recordTransaction()` to `backend/src/services/liquidity.js`
    - Insert a row into `liquidity_transactions` with all required fields
    - On DB insert failure, log the error including `transaction_hash` via `logger.error`; do not rethrow (Stellar tx is already on-chain)
    - _Requirements: 2.9, 4.9, 6.2, 6.3_

  - [ ]* 2.8 Write property test for transaction persistence round-trip (Property 3)
    - **Property 3: Confirmed transactions are persisted with all required fields**
    - **Validates: Requirements 2.9, 4.9, 6.2**
    - Tag: `// Feature: stellar-liquidity-pools, Property 3: confirmed transactions are persisted with all required fields`
    - Generate random deposit/withdrawal parameters; mock Stellar to return a confirmed result; query the DB and assert the inserted row matches all input parameters and the returned transaction hash

- [ ] 3. Checkpoint — Ensure all service-layer tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement the liquidity API router
  - [ ] 4.1 Create `backend/src/routes/liquidity.js` with `GET /api/liquidity/pools`
    - Apply auth middleware
    - Call `liquidityService.getPools()`; return 200 with pool array or 200 with `[]` when empty
    - Return 502 with descriptive message on Horizon error
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [ ] 4.2 Add `POST /api/liquidity/deposit` to the router
    - Validate `pool_id`, `max_xlm`, `max_usdc` using `express-validator` (required, non-empty, positive numeric); return 400 with field-identifying errors on failure
    - Call `liquidityService.deposit()`; on `InsufficientBalanceError` return 422; on Stellar rejection return 502; on success call `recordTransaction()` and return 200 with `{ transaction_hash, pool_shares }`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

  - [ ] 4.3 Add `POST /api/liquidity/withdraw` to the router
    - Validate `pool_id` and `pool_shares` using `express-validator`; return 400 on failure
    - Call `liquidityService.withdraw()`; on `InsufficientSharesError` return 422; on Stellar rejection return 502; on success call `recordTransaction()` and return 200 with `{ transaction_hash, xlm_received, usdc_received }`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9_

  - [ ] 4.4 Register the liquidity router in the Express app
    - Mount the router at `/api/liquidity` in the main app entry point (e.g. `backend/src/app.js`)
    - _Requirements: 1.1, 2.1, 4.1_

  - [ ]* 4.5 Write property test for authentication enforcement (Property 1)
    - **Property 1: All liquidity endpoints require authentication**
    - **Validates: Requirements 1.6, 2.4, 4.4**
    - Tag: `// Feature: stellar-liquidity-pools, Property 1: all liquidity endpoints require authentication`
    - Generate arbitrary strings as Bearer tokens (empty, malformed, expired JWTs) with fast-check; assert all three endpoints return 401

  - [ ]* 4.6 Write property test for input validation (Property 2)
    - **Property 2: Input validation rejects requests with missing or invalid fields**
    - **Validates: Requirements 2.2, 2.3, 4.2, 4.3**
    - Tag: `// Feature: stellar-liquidity-pools, Property 2: input validation rejects requests with missing or invalid fields`
    - Generate deposit/withdraw bodies with one or more fields removed or set to invalid values; assert response is always 400 with a field-identifying error

  - [ ]* 4.7 Write unit tests for router error paths
    - `GET /api/liquidity/pools` returns 502 when Horizon throws (req 1.5)
    - `POST /api/liquidity/deposit` returns 422 on `op_underfunded` (req 2.7) and 502 on other Stellar rejection (req 2.8)
    - `POST /api/liquidity/withdraw` returns 422 on insufficient shares (req 4.7) and 502 on other Stellar rejection (req 4.8)
    - DB insert failure after confirmed tx logs error with transaction hash (req 6.3)
    - _Requirements: 1.5, 2.7, 2.8, 4.7, 4.8, 6.3_

- [ ] 5. Checkpoint — Ensure all API route tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement the ImpermanentLossModal component
  - [ ] 6.1 Create `frontend/src/components/ImpermanentLossModal.jsx`
    - Render a modal with a plain-language explanation of impermanent loss and a link to Stellar documentation
    - Accept `onConfirm` and `onDismiss` callback props; wire them to Confirm and Cancel buttons
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 6.2 Write unit tests for ImpermanentLossModal
    - Assert explanation text and documentation link are rendered (req 3.2)
    - Assert `onConfirm` is called when Confirm is clicked and `onDismiss` is called when Cancel is clicked (req 3.3, 3.4)
    - _Requirements: 3.2, 3.3, 3.4_

- [ ] 7. Implement the LiquiditySection component and wire into Dashboard
  - [ ] 7.1 Create `frontend/src/components/LiquiditySection.jsx`
    - Fetch pool data from `GET /api/liquidity/pools` on mount
    - Display a loading indicator while fetching (req 5.2)
    - Display an error message and retry button if the fetch fails (req 5.6)
    - Render each pool's asset pair, APY, and total liquidity (req 5.3)
    - For pools where the user holds shares, display share balance and estimated current value (req 5.4)
    - Render Deposit and Withdraw action buttons per pool (req 5.5)
    - On Deposit click, show `ImpermanentLossModal`; on confirm call `POST /api/liquidity/deposit`; on dismiss cancel without submitting (req 3.1, 3.3, 3.4)
    - On Withdraw click, call `POST /api/liquidity/withdraw` directly
    - _Requirements: 3.1, 3.3, 3.4, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ]* 7.2 Write property test for dashboard pool rendering (Property 7)
    - **Property 7: Dashboard renders required fields and actions for every pool**
    - **Validates: Requirements 5.3, 5.5**
    - Tag: `// Feature: stellar-liquidity-pools, Property 7: dashboard renders required fields and actions for every pool`
    - Generate arbitrary arrays of pool objects with fast-check; render `LiquiditySection`; assert every pool's asset pair, APY, total liquidity, deposit button, and withdraw button are present

  - [ ]* 7.3 Write property test for user share display (Property 8)
    - **Property 8: Dashboard displays user share balance for every pool where the user holds shares**
    - **Validates: Requirements 5.4**
    - Tag: `// Feature: stellar-liquidity-pools, Property 8: dashboard displays user share balance for every pool where the user holds shares`
    - Generate arbitrary pool arrays where a random subset has a positive user share balance; render `LiquiditySection`; assert share balance and estimated value are visible for each such pool

  - [ ]* 7.4 Write unit tests for LiquiditySection loading and error states
    - Assert loading indicator is shown while API call is pending (req 5.2)
    - Assert error message and retry button appear when pool fetch fails (req 5.6)
    - Assert confirming the modal triggers the deposit API call; dismissing does not (req 3.3, 3.4)
    - _Requirements: 3.3, 3.4, 5.2, 5.6_

  - [ ] 7.5 Mount LiquiditySection in `frontend/src/pages/Dashboard.jsx`
    - Import and render `<LiquiditySection />` in the Dashboard page
    - _Requirements: 5.1_

- [ ] 8. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Property tests use **fast-check** (`npm install --save-dev fast-check`) with a minimum of 100 iterations each
- Each property test must include the tag comment referencing the feature and property number
- The service layer never throws HTTP errors; error classification happens in the router
- DB insert failures after a confirmed Stellar tx are logged but not surfaced to the caller — the on-chain transaction cannot be rolled back
