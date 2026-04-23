# Implementation Plan: DEX Order Management

## Overview

Extend the existing DEX service and routes to support limit orders (offers), add a PostgreSQL migration for persistence, and surface open orders in a new Orders tab within the Swap page.

## Tasks

- [ ] 1. Create the `dex_offers` database migration
  - Create `database/migrations/012_add_dex_offers_table.js` with `up`/`down` exports
  - Define columns: `id`, `user_id` (FK to users), `offer_id` (bigint), `offer_type`, `selling_asset`, `buying_asset`, `amount`, `price`, `status`, `created_at`, `cancelled_at`
  - Add indexes on `user_id` and `offer_id`
  - _Requirements: 5.1, 5.5_

- [ ] 2. Implement `createOffer` in the DEX service
  - [ ] 2.1 Add `createOffer(params)` to `backend/src/services/dex.js`
    - Build and submit `manageSellOffer` or `manageBuyOffer` operation based on `params.type`
    - Extract the Stellar `offerId` from the transaction result
    - Insert a row into `dex_offers` with status `"open"`; log DB errors with tx hash but do not throw
    - Return the offer DTO `{ offerId, type, sellingAsset, buyingAsset, amount, price, status }`
    - Map `underfunded` Stellar result code to a typed error; propagate other Stellar errors
    - _Requirements: 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 5.2, 5.4_

  - [ ]* 2.2 Write property test for `createOffer` — Property 2: Offer type determines SDK operation
    - **Property 2: For any valid offer params, `type: "sell"` invokes `manageSellOffer` and `type: "buy"` invokes `manageBuyOffer`**
    - **Validates: Requirements 1.5, 1.6**

  - [ ]* 2.3 Write property test for `createOffer` — Property 4: Confirmed offer is persisted
    - **Property 4: For any confirmed offer, the `dex_offers` row matches the request params and has `status = "open"`**
    - **Validates: Requirements 1.10, 5.2**

- [ ] 3. Implement `cancelOffer` in the DEX service
  - [ ] 3.1 Add `cancelOffer(params)` to `backend/src/services/dex.js`
    - Look up the offer in `dex_offers` by `offerId`; throw 404 error if not found
    - Verify `user_id` matches `params.userId`; throw 403 error if not
    - Submit `manageSellOffer` / `manageBuyOffer` with `amount = "0"` and the original `offerId`
    - Update `dex_offers` row: set `status = "cancelled"`, `cancelled_at = now()`; log DB errors with tx hash
    - Return `{ offerId, status: "cancelled" }`
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 5.3, 5.4_

  - [ ]* 3.2 Write property test for `cancelOffer` — Property 5: Ownership enforcement
    - **Property 5: For any offer owned by user A, a cancel request from user B returns a 403 error and no Stellar transaction is submitted**
    - **Validates: Requirements 2.3, 2.4**

  - [ ]* 3.3 Write property test for `cancelOffer` — Property 6: Cancellation uses amount=0
    - **Property 6: For any valid cancellation, the SDK operation is submitted with the original asset pair, `amount = "0"`, and the original `offerId`**
    - **Validates: Requirements 2.6**

  - [ ]* 3.4 Write property test for `cancelOffer` — Property 7: Cancellation round-trip updates response and database
    - **Property 7: After a confirmed cancellation, the return value has `status: "cancelled"` and the `dex_offers` row has `status = "cancelled"` with a non-null `cancelled_at`**
    - **Validates: Requirements 2.7, 2.8, 5.3**

- [ ] 4. Implement `listOffers` in the DEX service
  - [ ] 4.1 Add `listOffers(publicKey, status)` to `backend/src/services/dex.js`
    - Query Horizon `/accounts/:publicKey/offers` for live open offers
    - When `status` is `"cancelled"` or undefined, merge with DB records accordingly
    - Map Horizon offer objects to the offer DTO shape
    - Throw a typed Horizon error if the Horizon request fails
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7_

  - [ ]* 4.2 Write property test for `listOffers` — Property 8: List response shape is complete
    - **Property 8: For any N offers (0–20) returned by the Horizon mock, the result is an array of length N where each element contains all required DTO fields**
    - **Validates: Requirements 3.4, 3.5**

  - [ ]* 4.3 Write property test for `listOffers` — Property 9: Status filter returns only matching offers
    - **Property 9: For any mixed-status offer list and any filter value of `"open"` or `"cancelled"`, only offers matching the filter appear in the result**
    - **Validates: Requirements 3.7**

- [ ] 5. Add the three DEX offer routes to the Express router
  - [ ] 5.1 Add `POST /api/dex/offer` to `backend/src/routes/dex.js`
    - Apply auth middleware and express-validator rules for `type`, `sellingAsset`, `buyingAsset`, `amount`, `price`
    - Call `createOffer`; map service errors to 400 / 401 / 422 / 502 HTTP responses
    - Respond 201 with the offer DTO on success
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.7, 1.8, 1.9_

  - [ ]* 5.2 Write property test for `POST /api/dex/offer` — Property 1: Input validation rejects incomplete requests
    - **Property 1: Any request body missing one or more required fields, or with an invalid `type`, returns HTTP 400 with an error body identifying the invalid field**
    - **Validates: Requirements 1.2, 1.3**

  - [ ]* 5.3 Write property test for `POST /api/dex/offer` — Property 3: Confirmed offer response contains all required fields
    - **Property 3: For any valid offer payload with a mocked Stellar confirmation, the 201 response body contains all required DTO fields with values matching the request**
    - **Validates: Requirements 1.7**

  - [ ] 5.4 Add `DELETE /api/dex/offer/:offerId` to `backend/src/routes/dex.js`
    - Apply auth middleware
    - Call `cancelOffer`; map 403 / 404 / 502 service errors to HTTP responses
    - Respond 200 with `{ offerId, status: "cancelled" }` on success
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 2.9_

  - [ ] 5.5 Add `GET /api/dex/offers` to `backend/src/routes/dex.js`
    - Apply auth middleware; pass optional `status` query param to `listOffers`
    - Map Horizon errors to 502; respond 200 with the offer array
    - _Requirements: 3.1, 3.2, 3.6, 3.7_

  - [ ]* 5.6 Write unit tests for all three routes
    - `POST` with each required field missing → 400
    - `POST` with invalid `type` → 400
    - `POST` without auth → 401
    - `DELETE` for offer owned by another user → 403
    - `DELETE` for non-existent offer → 404
    - `POST` when Stellar returns `underfunded` → 422
    - `GET` when Horizon returns an error → 502
    - _Requirements: 1.3, 1.4, 1.8, 2.2, 2.4, 2.5, 3.6_

- [ ] 6. Checkpoint — Ensure all backend tests pass
  - Run the test suite; confirm all route and service tests pass before moving to the frontend.

- [ ] 7. Add the Orders tab to the Swap page
  - [ ] 7.1 Add a tab switcher to `frontend/src/pages/Swap.jsx`
    - Render "Swap" and "Orders" tab buttons; track `activeTab` in local state
    - Conditionally render the existing swap UI or the new Orders panel
    - _Requirements: 4.1_

  - [ ] 7.2 Implement the Orders panel component (inline in Swap.jsx or as a sibling file)
    - On tab activation, call `GET /api/dex/offers` and store results in state
    - Render a loading spinner while fetching
    - Render `"No open orders"` when the array is empty
    - Render an offer list: type, selling asset → buying asset, amount, price, creation date, Cancel button
    - Render a full-panel error message with a Retry button on fetch failure
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.9_

  - [ ] 7.3 Implement the cancel flow in the Orders panel
    - Show a confirmation dialog when the Cancel button is clicked
    - On confirm, call `DELETE /api/dex/offer/:offerId`; remove the offer from the list on success
    - On failure, show an inline error below the affected row; leave the offer in the list
    - _Requirements: 4.6, 4.7, 4.8, 4.10_

  - [ ]* 7.4 Write property test for Orders tab — Property 10: Orders tab fetches offers on activation
    - **Property 10: For any render of the Swap page, activating the Orders tab triggers exactly one `GET /api/dex/offers` call**
    - **Validates: Requirements 4.2**

  - [ ]* 7.5 Write property test for Orders tab — Property 11: Offer rows display all required fields
    - **Property 11: For any non-empty offer array returned by the API mock, each rendered row displays type, selling asset, buying asset, amount, price, creation date, and a cancel button**
    - **Validates: Requirements 4.4, 4.6**

  - [ ]* 7.6 Write property test for Orders tab — Property 12: Cancel confirmation prompt precedes API call
    - **Property 12: For any cancel button click, a confirmation prompt is shown and no DELETE request is submitted until the user explicitly confirms; dismissing the prompt makes no API call**
    - **Validates: Requirements 4.7**

  - [ ]* 7.7 Write property test for Orders tab — Property 13: Confirmed cancellation removes offer from list
    - **Property 13: For any offer list of length N, after the user confirms cancellation of one offer and the DELETE succeeds, the rendered list has length N-1 and the cancelled offer is absent**
    - **Validates: Requirements 4.8**

  - [ ]* 7.8 Write unit tests for the Orders panel
    - Renders loading indicator while fetch is in progress
    - Renders `"No open orders"` when API returns empty array
    - Renders error state with retry button on fetch failure
    - Cancellation failure leaves offer in list with inline error
    - _Requirements: 4.3, 4.5, 4.9, 4.10_

- [ ] 8. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
