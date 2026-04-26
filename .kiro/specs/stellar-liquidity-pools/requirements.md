# Requirements Document

## Introduction

This feature integrates Stellar's Automated Market Maker (AMM) liquidity pools into the AfriPay Cross-Border Payment App. AfriPay users holding idle XLM or USDC can deposit assets into Stellar liquidity pools to earn passive income through trading fees. The integration exposes pool discovery, deposit, and withdrawal via a REST API, and surfaces pool APY and user share balances in the Dashboard. An impermanent loss warning is shown before any deposit is confirmed.

## Glossary

- **Liquidity_Pool**: A Stellar AMM pool holding two assets (XLM and USDC) that earns trading fees distributed to liquidity providers.
- **Pool_Share**: A token representing a user's proportional ownership of a Liquidity_Pool.
- **APY**: Annual Percentage Yield — the annualised return rate of a Liquidity_Pool based on accumulated trading fees.
- **Impermanent_Loss**: The temporary loss in value a liquidity provider may experience when the price ratio of the two pooled assets changes relative to simply holding them.
- **Liquidity_Service**: The backend service (`backend/src/services/liquidity.js`) responsible for all Liquidity_Pool operations via the Stellar SDK.
- **Liquidity_API**: The Express router exposing `/api/liquidity/*` endpoints.
- **Dashboard**: The React frontend component (`frontend/src/`) that displays account balances, pool information, and user Pool_Shares.
- **Stellar_SDK**: The `@stellar/stellar-sdk` library already integrated in `backend/src/services/stellar.js`.
- **User**: An authenticated AfriPay account holder.

---

## Requirements

### Requirement 1: List Available Liquidity Pools

**User Story:** As a User, I want to see available XLM/USDC liquidity pools with their APY, so that I can decide which pool to deposit into.

#### Acceptance Criteria

1. THE Liquidity_API SHALL expose a `GET /api/liquidity/pools` endpoint.
2. WHEN a `GET /api/liquidity/pools` request is received, THE Liquidity_Service SHALL query the Stellar Horizon API for all active XLM/USDC Liquidity_Pools.
3. WHEN the Stellar Horizon API returns pool data, THE Liquidity_API SHALL respond with HTTP 200 and a JSON array containing each pool's ID, asset pair, total liquidity, fee rate, and calculated APY.
4. WHEN the Stellar Horizon API returns no pools, THE Liquidity_API SHALL respond with HTTP 200 and an empty JSON array.
5. IF the Stellar Horizon API returns an error, THEN THE Liquidity_API SHALL respond with HTTP 502 and a descriptive error message.
6. WHEN a `GET /api/liquidity/pools` request is received without a valid authentication token, THE Liquidity_API SHALL respond with HTTP 401.

---

### Requirement 2: Deposit into a Liquidity Pool

**User Story:** As a User, I want to deposit XLM and USDC into a liquidity pool, so that I can earn passive income from trading fees.

#### Acceptance Criteria

1. THE Liquidity_API SHALL expose a `POST /api/liquidity/deposit` endpoint.
2. WHEN a `POST /api/liquidity/deposit` request is received, THE Liquidity_API SHALL require a valid authentication token, a pool ID, a maximum XLM amount, and a maximum USDC amount in the request body.
3. WHEN a `POST /api/liquidity/deposit` request is received with a missing or invalid field, THE Liquidity_API SHALL respond with HTTP 400 and a message identifying the invalid field.
4. WHEN a `POST /api/liquidity/deposit` request is received without a valid authentication token, THE Liquidity_API SHALL respond with HTTP 401.
5. WHEN a valid deposit request is received, THE Liquidity_Service SHALL construct and submit a `liquidityPoolDeposit` operation using the Stellar_SDK with the specified pool ID, maximum amounts, and a minimum price tolerance of 10%.
6. WHEN the Stellar network confirms the deposit transaction, THE Liquidity_API SHALL respond with HTTP 200 and a JSON object containing the transaction hash and the Pool_Share amount received.
7. IF the User's account balance is insufficient for the requested deposit amounts, THEN THE Liquidity_API SHALL respond with HTTP 422 and the message "Insufficient balance for deposit".
8. IF the Stellar network rejects the deposit transaction, THEN THE Liquidity_API SHALL respond with HTTP 502 and the Stellar error detail.
9. THE Liquidity_Service SHALL record each confirmed deposit in the PostgreSQL database with the user ID, pool ID, deposited amounts, Pool_Share amount, and timestamp.

---

### Requirement 3: Impermanent Loss Warning Before Deposit

**User Story:** As a User, I want to be warned about impermanent loss before depositing into a pool, so that I can make an informed decision.

#### Acceptance Criteria

1. WHEN a User initiates a deposit action on the Dashboard, THE Dashboard SHALL display an impermanent loss warning modal before submitting the deposit request.
2. THE Dashboard SHALL present the warning modal with a plain-language explanation of Impermanent_Loss and a link to further documentation.
3. WHEN the User confirms the warning modal, THE Dashboard SHALL proceed to submit the `POST /api/liquidity/deposit` request.
4. WHEN the User dismisses the warning modal, THE Dashboard SHALL cancel the deposit action and return the User to the pool view without submitting any request.

---

### Requirement 4: Withdraw from a Liquidity Pool

**User Story:** As a User, I want to withdraw my assets from a liquidity pool, so that I can reclaim my deposited funds and earned fees.

#### Acceptance Criteria

1. THE Liquidity_API SHALL expose a `POST /api/liquidity/withdraw` endpoint.
2. WHEN a `POST /api/liquidity/withdraw` request is received, THE Liquidity_API SHALL require a valid authentication token, a pool ID, and a Pool_Share amount in the request body.
3. WHEN a `POST /api/liquidity/withdraw` request is received with a missing or invalid field, THE Liquidity_API SHALL respond with HTTP 400 and a message identifying the invalid field.
4. WHEN a `POST /api/liquidity/withdraw` request is received without a valid authentication token, THE Liquidity_API SHALL respond with HTTP 401.
5. WHEN a valid withdrawal request is received, THE Liquidity_Service SHALL construct and submit a `liquidityPoolWithdraw` operation using the Stellar_SDK with the specified pool ID, Pool_Share amount, and minimum asset amounts of 0.
6. WHEN the Stellar network confirms the withdrawal transaction, THE Liquidity_API SHALL respond with HTTP 200 and a JSON object containing the transaction hash, the XLM amount received, and the USDC amount received.
7. IF the User does not hold sufficient Pool_Shares for the requested withdrawal amount, THEN THE Liquidity_API SHALL respond with HTTP 422 and the message "Insufficient pool shares for withdrawal".
8. IF the Stellar network rejects the withdrawal transaction, THEN THE Liquidity_API SHALL respond with HTTP 502 and the Stellar error detail.
9. THE Liquidity_Service SHALL record each confirmed withdrawal in the PostgreSQL database with the user ID, pool ID, Pool_Share amount redeemed, assets received, and timestamp.

---

### Requirement 5: Display Pool Information and User Shares on Dashboard

**User Story:** As a User, I want to see my liquidity pool positions and APY on the Dashboard, so that I can monitor my passive income.

#### Acceptance Criteria

1. THE Dashboard SHALL include a dedicated liquidity pool section displaying all available XLM/USDC Liquidity_Pools fetched from `GET /api/liquidity/pools`.
2. WHEN pool data is loading, THE Dashboard SHALL display a loading indicator in the liquidity pool section.
3. WHEN pool data has loaded, THE Dashboard SHALL display each pool's asset pair, APY, and total liquidity.
4. WHEN a User holds Pool_Shares in a Liquidity_Pool, THE Dashboard SHALL display the User's Pool_Share balance and estimated current value in that pool.
5. THE Dashboard SHALL provide a deposit action and a withdraw action for each Liquidity_Pool.
6. IF the `GET /api/liquidity/pools` request fails, THEN THE Dashboard SHALL display an error message in the liquidity pool section and provide a retry action.

---

### Requirement 6: Liquidity Pool Data Persistence

**User Story:** As a developer, I want liquidity pool transactions stored in PostgreSQL, so that the platform can audit activity and display historical positions.

#### Acceptance Criteria

1. THE Liquidity_Service SHALL use a PostgreSQL migration to create a `liquidity_transactions` table with columns: `id`, `user_id`, `pool_id`, `transaction_type` (`deposit` or `withdrawal`), `xlm_amount`, `usdc_amount`, `pool_shares`, `transaction_hash`, and `created_at`.
2. WHEN a deposit or withdrawal is confirmed, THE Liquidity_Service SHALL insert a record into the `liquidity_transactions` table within the same logical operation as the Stellar transaction confirmation.
3. IF the database insert fails after a confirmed Stellar transaction, THEN THE Liquidity_Service SHALL log the error with the transaction hash so the record can be reconciled manually.
