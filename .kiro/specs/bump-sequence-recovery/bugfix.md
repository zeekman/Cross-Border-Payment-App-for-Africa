# Bugfix Requirements Document

## Introduction

When a Stellar transaction fails mid-flight (e.g. due to a timeout, network drop, or submission error), the account's on-chain sequence number may have been incremented even though the app never received a success response. Subsequent transactions built with the stale local sequence number are rejected by Horizon with `tx_bad_seq`. AfriPay currently retries with a freshly loaded sequence number but has no mechanism to issue a `bumpSequence` operation when the desync is persistent or detected explicitly. This fix adds automatic `bumpSequence` recovery and a manual trigger in dev tools.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a Stellar transaction fails and the on-chain sequence number has advanced beyond what the SDK last loaded, THEN the system retries the transaction but does not issue a `bumpSequence` operation, causing all subsequent transactions from that account to fail with `tx_bad_seq`.

1.2 WHEN `tx_bad_seq` errors persist across the existing retry loop in `_sendPaymentOnce`, THEN the system throws the error to the caller with no recovery path and no indication that a sequence resync is needed.

1.3 WHEN `tx_bad_seq` errors occur on operations other than `sendPayment` (e.g. `sendPathPayment`, `addTrustline`), THEN the system has no sequence recovery mechanism at all, because those code paths do not include the retry loop.

1.4 WHEN a developer needs to manually recover a desynced account sequence number in a development environment, THEN the system provides no tooling to trigger a `bumpSequence` operation.

### Expected Behavior (Correct)

2.1 WHEN a `tx_bad_seq` error is detected during transaction submission, THEN the system SHALL automatically fetch the current on-chain sequence number and issue a `bumpSequence` operation to resync the account before retrying the original transaction.

2.2 WHEN the automatic `bumpSequence` recovery succeeds, THEN the system SHALL retry the original transaction with the corrected sequence number and return a successful result to the caller.

2.3 WHEN the automatic `bumpSequence` recovery itself fails, THEN the system SHALL propagate the error with a clear log message indicating that sequence recovery was attempted and failed.

2.4 WHEN a developer sends a `POST /api/dev/fix-sequence` request in development mode, THEN the system SHALL issue a `bumpSequence` operation for the authenticated user's wallet and return the result.

2.5 WHEN a `POST /api/dev/fix-sequence` request is made in production or test environments, THEN the system SHALL return a 404 response, consistent with the existing dev-only endpoint guard pattern.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a transaction is submitted and the sequence number is correct, THEN the system SHALL CONTINUE TO submit the transaction normally without any additional `bumpSequence` overhead.

3.2 WHEN a transaction fails for a reason other than `tx_bad_seq` (e.g. `tx_insufficient_fee`, `op_no_destination`), THEN the system SHALL CONTINUE TO propagate the original error without attempting sequence recovery.

3.3 WHEN the existing retry logic in `_sendPaymentOnce` handles a transient `tx_bad_seq` by reloading the account and retrying, THEN the system SHALL CONTINUE TO perform that reload-and-retry behavior as the first recovery attempt before escalating to `bumpSequence`.

3.4 WHEN `withRetry` handles 503/504 network errors, THEN the system SHALL CONTINUE TO apply exponential backoff independently of the sequence recovery logic.

3.5 WHEN a `sendPathPayment` or `addTrustline` operation succeeds normally, THEN the system SHALL CONTINUE TO return results in the same format as before.
