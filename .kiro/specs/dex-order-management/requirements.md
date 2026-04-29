# Requirements Document

## Introduction

This feature adds Stellar DEX order management to the AfriPay Cross-Border Payment App, enabling power users and small businesses to place, monitor, and cancel limit orders (sell and buy offers) on the Stellar Decentralised Exchange. Unlike simple swaps that execute immediately at market price, DEX offers allow users to specify a desired exchange rate and wait for the market to fill the order. The feature exposes offer CRUD operations via a REST API and surfaces open orders in a dedicated Orders tab within the Swap page. This feature depends on the existing DEX integration (Issue 78).

## Glossary

- **DEX**: The Stellar Decentralised Exchange — an on-chain order book where accounts post offers to trade assets at specified prices.
- **Offer**: A Stellar DEX order created by a `manageSellOffer` or `manageBuyOffer` operation, specifying a selling asset, a buying asset, an amount, and a price ratio.
- **Sell_Offer**: An Offer where the User specifies the asset and amount they are selling and the minimum price they will accept.
- **Buy_Offer**: An Offer where the User specifies the asset and amount they want to buy and the maximum price they will pay.
- **Offer_ID**: The unique integer identifier assigned by the Stellar network to each active Offer.
- **DEX_Service**: The backend service (`backend/src/services/dex.js`) responsible for all DEX operations via the Stellar SDK.
- **DEX_API**: The Express router exposing `/api/dex/*` endpoints.
- **Orders_Tab**: The React UI component within the Swap page that lists the User's open Offers and allows cancellation.
- **Stellar_SDK**: The `@stellar/stellar-sdk` library already integrated in `backend/src/services/stellar.js`.
- **Horizon_API**: The Stellar Horizon REST API used to query on-chain account offer data.
- **User**: An authenticated AfriPay account holder.

---

## Requirements

### Requirement 1: Create a DEX Offer

**User Story:** As a User, I want to place a limit order on the Stellar DEX, so that I can trade assets at a price I choose rather than the current market rate.

#### Acceptance Criteria

1. THE DEX_API SHALL expose a `POST /api/dex/offer` endpoint protected by the existing auth middleware.
2. WHEN a `POST /api/dex/offer` request is received, THE DEX_API SHALL require the following fields in the request body: `type` (either `"sell"` or `"buy"`), `sellingAsset`, `buyingAsset`, `amount`, and `price`.
3. WHEN a `POST /api/dex/offer` request is received with a missing or invalid field, THE DEX_API SHALL respond with HTTP 400 and a JSON error message identifying the invalid field.
4. WHEN a `POST /api/dex/offer` request is received without a valid authentication token, THE DEX_API SHALL respond with HTTP 401.
5. WHEN a valid sell offer request is received, THE DEX_Service SHALL construct and submit a `manageSellOffer` operation using the Stellar_SDK with the specified selling asset, buying asset, amount, and price.
6. WHEN a valid buy offer request is received, THE DEX_Service SHALL construct and submit a `manageBuyOffer` operation using the Stellar_SDK with the specified selling asset, buying asset, amount, and price.
7. WHEN the Stellar network confirms the offer transaction, THE DEX_API SHALL respond with HTTP 201 and a JSON object containing the Offer_ID, offer type, selling asset, buying asset, amount, price, and status `"open"`.
8. IF the User's account balance is insufficient to fund the Offer, THEN THE DEX_API SHALL respond with HTTP 422 and the message `"Insufficient balance to place offer"`.
9. IF the Stellar network rejects the offer transaction, THEN THE DEX_API SHALL respond with HTTP 502 and the Stellar error detail.
10. THE DEX_Service SHALL persist each confirmed Offer in the PostgreSQL database with the user ID, Offer_ID, offer type, selling asset, buying asset, amount, price, status, and created timestamp.

---

### Requirement 2: Cancel a DEX Offer

**User Story:** As a User, I want to cancel an open limit order, so that I can recover my reserved funds when market conditions change.

#### Acceptance Criteria

1. THE DEX_API SHALL expose a `DELETE /api/dex/offer/:offerId` endpoint protected by the existing auth middleware.
2. WHEN a `DELETE /api/dex/offer/:offerId` request is received without a valid authentication token, THE DEX_API SHALL respond with HTTP 401.
3. WHEN a `DELETE /api/dex/offer/:offerId` request is received, THE DEX_Service SHALL verify that the specified Offer_ID belongs to the authenticated User before submitting any transaction.
4. IF the specified Offer_ID does not belong to the authenticated User, THEN THE DEX_API SHALL respond with HTTP 403 and the message `"Offer does not belong to this account"`.
5. IF the specified Offer_ID is not found in the database, THEN THE DEX_API SHALL respond with HTTP 404 and the message `"Offer not found"`.
6. WHEN the Offer_ID is verified as belonging to the authenticated User, THE DEX_Service SHALL submit a `manageSellOffer` or `manageBuyOffer` operation using the Stellar_SDK with the original asset pair, an amount of `0`, and the Offer_ID to cancel the Offer on-chain.
7. WHEN the Stellar network confirms the cancellation, THE DEX_API SHALL respond with HTTP 200 and a JSON object containing the Offer_ID and status `"cancelled"`.
8. WHEN the Stellar network confirms the cancellation, THE DEX_Service SHALL update the Offer's status to `"cancelled"` and record the cancelled timestamp in the PostgreSQL database.
9. IF the Stellar network rejects the cancellation transaction, THEN THE DEX_API SHALL respond with HTTP 502 and the Stellar error detail.

---

### Requirement 3: List Open DEX Offers

**User Story:** As a User, I want to see all my open limit orders, so that I can monitor my active positions and decide whether to cancel any.

#### Acceptance Criteria

1. THE DEX_API SHALL expose a `GET /api/dex/offers` endpoint protected by the existing auth middleware.
2. WHEN a `GET /api/dex/offers` request is received without a valid authentication token, THE DEX_API SHALL respond with HTTP 401.
3. WHEN a `GET /api/dex/offers` request is received, THE DEX_Service SHALL query the Horizon_API for all open offers associated with the authenticated User's Stellar account.
4. WHEN the Horizon_API returns offer data, THE DEX_API SHALL respond with HTTP 200 and a JSON array where each element contains the Offer_ID, offer type, selling asset, buying asset, amount, price, and status.
5. WHEN the Horizon_API returns no open offers for the User, THE DEX_API SHALL respond with HTTP 200 and an empty JSON array.
6. IF the Horizon_API returns an error, THEN THE DEX_API SHALL respond with HTTP 502 and a descriptive error message.
7. THE DEX_API SHALL support an optional `status` query parameter; WHEN `status=open` is provided, THE DEX_API SHALL return only offers with status `"open"`; WHEN `status=cancelled` is provided, THE DEX_API SHALL return only offers with status `"cancelled"`.

---

### Requirement 4: Orders Tab in the Swap Page

**User Story:** As a User, I want an Orders tab in the Swap page, so that I can view and manage my open DEX limit orders without leaving the trading interface.

#### Acceptance Criteria

1. THE Orders_Tab SHALL be rendered as a tab within the existing Swap page (`frontend/src/pages/`).
2. WHEN the Orders_Tab is active, THE Orders_Tab SHALL fetch and display the User's open offers from `GET /api/dex/offers`.
3. WHEN offer data is loading, THE Orders_Tab SHALL display a loading indicator.
4. WHEN offer data has loaded, THE Orders_Tab SHALL display each Offer in a list showing the offer type, selling asset, buying asset, amount, price, and creation date.
5. WHEN the User has no open offers, THE Orders_Tab SHALL display the message `"No open orders"`.
6. THE Orders_Tab SHALL provide a cancel action for each open Offer.
7. WHEN the User activates the cancel action for an Offer, THE Orders_Tab SHALL display a confirmation prompt before submitting the `DELETE /api/dex/offer/:offerId` request.
8. WHEN the User confirms cancellation, THE Orders_Tab SHALL submit the delete request and, upon success, remove the cancelled Offer from the displayed list.
9. IF the `GET /api/dex/offers` request fails, THEN THE Orders_Tab SHALL display an error message and provide a retry action.
10. IF a cancellation request fails, THEN THE Orders_Tab SHALL display an inline error message for the affected Offer and leave it in the list.

---

### Requirement 5: DEX Offer Data Persistence

**User Story:** As a developer, I want DEX offer records stored in PostgreSQL, so that the platform can enforce ownership checks, audit activity, and display order history.

#### Acceptance Criteria

1. THE DEX_Service SHALL use a PostgreSQL migration to create a `dex_offers` table with columns: `id` (serial primary key), `user_id` (foreign key to users), `offer_id` (Stellar Offer_ID, bigint), `offer_type` (`"sell"` or `"buy"`), `selling_asset`, `buying_asset`, `amount` (numeric), `price` (numeric), `status` (`"open"` or `"cancelled"`), `created_at`, and `cancelled_at` (nullable).
2. WHEN a new Offer is confirmed by the Stellar network, THE DEX_Service SHALL insert a record into the `dex_offers` table within the same logical operation as the transaction confirmation.
3. WHEN an Offer is cancelled on the Stellar network, THE DEX_Service SHALL update the corresponding `dex_offers` row, setting `status` to `"cancelled"` and `cancelled_at` to the current timestamp.
4. IF the database insert or update fails after a confirmed Stellar transaction, THEN THE DEX_Service SHALL log the error with the Stellar transaction hash so the record can be reconciled manually.
5. THE `dex_offers` table SHALL have an index on `user_id` to support efficient lookup of offers by User.
