# Bump Sequence Recovery Bugfix Design

## Overview

When a Stellar transaction fails mid-flight, the on-chain sequence number may advance while the
local SDK state remains stale. All subsequent transactions from that account are rejected by
Horizon with `tx_bad_seq`. The existing `_sendPaymentOnce` retry loop reloads the account on
each attempt, which handles transient desync, but cannot recover from a persistent desync because
it never issues a `bumpSequence` operation to force the on-chain sequence forward.

This fix adds a `recoverSequence` helper that detects `tx_bad_seq`, fetches the current on-chain
sequence number, issues a `bumpSequence` operation to resync, and retries the original
transaction. The recovery is injected as a post-retry escalation path in `_sendPaymentOnce` and
wrapped around `sendPathPayment` and `addTrustline`. A dev-only `POST /api/dev/fix-sequence`
endpoint is added to `backend/src/routes/dev.js` for manual recovery during development.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — a `tx_bad_seq` result code in the
  Horizon error response after the existing retry loop is exhausted, indicating the local sequence
  number is permanently out of sync with the on-chain sequence number.
- **Property (P)**: The desired behavior when the bug condition holds — the system issues a
  `bumpSequence` operation to resync the account and retries the original transaction successfully.
- **Preservation**: All transaction paths that do NOT encounter `tx_bad_seq` must continue to
  behave exactly as before, with no additional overhead or changed return values.
- **`isBadSeq(err)`**: Existing helper in `stellar.js` that returns `true` when
  `err.response?.data?.extras?.result_codes?.transaction === 'tx_bad_seq'`.
- **`recoverSequence(publicKey, keypair)`**: New helper to be added to `stellar.js` that fetches
  the current on-chain sequence number and submits a `bumpSequence` operation.
- **`_sendPaymentOnce`**: The inner payment function in `stellar.js` that contains the existing
  `MAX_SEQ_RETRIES` loop. The `bumpSequence` escalation is added after this loop exhausts.
- **`withSequenceRecovery(fn, publicKey, keypair)`**: New wrapper that calls `fn`, and if it
  throws `tx_bad_seq`, calls `recoverSequence` then retries `fn` once.
- **`MAX_SEQ_RETRIES`**: Existing constant (3) controlling the reload-and-retry loop in
  `_sendPaymentOnce`. Unchanged by this fix.

## Bug Details

### Fault Condition

The bug manifests when a Stellar transaction fails and the on-chain sequence number has advanced
beyond what the SDK last loaded. The `_sendPaymentOnce` retry loop reloads the account on each
attempt (which fetches a fresh sequence number), but if the on-chain sequence is ahead by more
than one increment, or if the desync is caused by an external transaction, the reload alone is
insufficient and all retries fail with `tx_bad_seq`. The `sendPathPayment` and `addTrustline`
functions have no retry loop at all, so they fail immediately on the first `tx_bad_seq`.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { err: HorizonError, attempt: number, operation: string }
  OUTPUT: boolean

  RETURN err.response?.data?.extras?.result_codes?.transaction === 'tx_bad_seq'
         AND (
           (operation === 'sendPayment' AND attempt >= MAX_SEQ_RETRIES)
           OR operation IN ['sendPathPayment', 'addTrustline']
         )
END FUNCTION
```

### Examples

- `sendPayment` with a desynced account: all 3 retry attempts fail with `tx_bad_seq` because
  `loadAccount` returns the same stale sequence each time → error thrown to caller (bug).
- `sendPathPayment` with a desynced account: first submission fails with `tx_bad_seq`, no retry
  exists → error thrown immediately (bug).
- `addTrustline` with a desynced account: same as `sendPathPayment` — no recovery path (bug).
- `sendPayment` with a correct sequence: submits normally, no `bumpSequence` issued (preserved).
- `sendPayment` failing with `tx_insufficient_fee`: error propagates without `bumpSequence` (preserved).

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Transactions with a correct sequence number submit normally with no additional Horizon calls.
- Errors other than `tx_bad_seq` (e.g. `tx_insufficient_fee`, `op_no_destination`,
  `tx_failed` for claimable balance fallback) propagate unchanged without triggering sequence recovery.
- The existing `MAX_SEQ_RETRIES` reload-and-retry loop in `_sendPaymentOnce` runs first before
  any `bumpSequence` escalation is attempted.
- `withRetry` exponential backoff for 503/504 network errors operates independently and is
  unaffected by the sequence recovery logic.
- `sendPathPayment` and `addTrustline` return values (`{ transactionHash, ledger }` and
  `{ transactionHash }` respectively) are unchanged on success.

**Scope:**
All inputs that do NOT produce a `tx_bad_seq` error are completely unaffected by this fix. This
includes:
- Successful transactions (any operation type)
- Transactions failing with non-sequence error codes
- Network-level failures handled by `withRetry` or `withFallback`
- The claimable balance fallback path in `_sendPaymentOnce`

## Hypothesized Root Cause

1. **Missing `bumpSequence` escalation in `_sendPaymentOnce`**: The retry loop reloads the
   account on each attempt, which refreshes the sequence number from Horizon. However, if the
   on-chain sequence has advanced by more than the number of retries, or if a concurrent
   transaction incremented it between retries, all attempts still fail. The fix is to issue a
   `bumpSequence` operation after the retry loop exhausts, forcing the on-chain sequence to a
   known-good value before one final retry.

2. **No sequence recovery in `sendPathPayment`**: This function loads the account once and
   submits directly with no retry loop. A single `tx_bad_seq` failure is fatal. The fix wraps
   the submission in `withSequenceRecovery`.

3. **No sequence recovery in `addTrustline`**: Same issue as `sendPathPayment` — uses
   `withRetry` for network errors but has no `tx_bad_seq` handling. The fix wraps the
   submission in `withSequenceRecovery`.

4. **No dev tooling for manual recovery**: Developers have no way to manually trigger a
   `bumpSequence` for a desynced account during development. The fix adds
   `POST /api/dev/fix-sequence` to `backend/src/routes/dev.js` following the existing
   `fund-wallet` pattern.

## Correctness Properties

Property 1: Fault Condition - Automatic bumpSequence Recovery on tx_bad_seq

_For any_ transaction submission where the bug condition holds (the operation fails with
`tx_bad_seq` after the existing retry loop is exhausted, or on first attempt for
`sendPathPayment`/`addTrustline`), the fixed code SHALL issue a `bumpSequence` operation to
resync the account sequence number and retry the original transaction, returning a successful
result if the retry succeeds.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - Non-tx_bad_seq Paths Unchanged

_For any_ input where the bug condition does NOT hold (sequence is correct, or the error is not
`tx_bad_seq`), the fixed code SHALL produce exactly the same result as the original code,
with no additional Horizon calls, no changed return values, and no altered error propagation.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Changes Required

**File**: `backend/src/services/stellar.js`

**New Helper — `recoverSequence`**:
```
FUNCTION recoverSequence(publicKey, keypair)
  account = loadAccount(publicKey)           // fetch current on-chain sequence
  tx = buildTransaction(account)
       .addOperation(bumpSequence({ bumpTo: account.sequenceNumber() }))
       .setTimeout(30)
       .build()
  tx.sign(keypair)
  submitTransaction(tx)                      // resync on-chain sequence
END FUNCTION
```

**New Wrapper — `withSequenceRecovery`**:
```
FUNCTION withSequenceRecovery(fn, publicKey, keypair)
  TRY
    RETURN fn()
  CATCH err
    IF isBadSeq(err) THEN
      logger.warn('tx_bad_seq detected, attempting bumpSequence recovery', { publicKey })
      recoverSequence(publicKey, keypair)    // may throw — propagates to caller
      RETURN fn()                            // one retry after recovery
    ELSE
      THROW err
    END IF
  END TRY
END FUNCTION
```

**Specific Changes**:

1. **Add `recoverSequence(publicKey, keypair)`**: New async function that loads the account,
   builds a `bumpSequence` transaction targeting the current on-chain sequence number, signs
   and submits it. Uses `withFallback` for Horizon calls.

2. **Add `withSequenceRecovery(fn, publicKey, keypair)`**: New async wrapper that calls `fn()`,
   catches `tx_bad_seq`, calls `recoverSequence`, then retries `fn()` once. All other errors
   pass through unchanged.

3. **Modify `_sendPaymentOnce`**: After the existing `MAX_SEQ_RETRIES` loop throws `lastErr`,
   check `isBadSeq(lastErr)` and if true, call `recoverSequence` then attempt one final
   submission. This preserves the existing reload-and-retry behavior as the first recovery
   attempt.

4. **Modify `sendPathPayment`**: Wrap the `submitTransaction` call (and the preceding
   `loadAccount` + `buildTransaction`) in `withSequenceRecovery` so a `tx_bad_seq` triggers
   recovery and one retry.

5. **Modify `addTrustline`**: Same as `sendPathPayment` — wrap the submission block in
   `withSequenceRecovery`.

**File**: `backend/src/routes/dev.js`

6. **Add `POST /api/dev/fix-sequence`**: New route following the `fund-wallet` pattern.
   Queries the wallet's `public_key` and `encrypted_secret_key` from the DB, calls
   `recoverSequence`, returns `{ message, transactionHash }`. Protected by the existing
   `NODE_ENV !== 'development'` guard at the top of the router.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that
demonstrate the bug on unfixed code, then verify the fix works correctly and preserves
existing behavior.

### Exploratory Fault Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix.
Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Mock `withFallback` to simulate a desynced account — `loadAccount` returns a
stale sequence, and `submitTransaction` returns a `tx_bad_seq` Horizon error on every attempt.
Assert that the unfixed `_sendPaymentOnce` throws `tx_bad_seq` after exhausting retries, and
that `sendPathPayment`/`addTrustline` throw immediately.

**Test Cases**:
1. **sendPayment desync test**: Mock `submitTransaction` to always return `tx_bad_seq`. Assert
   that `_sendPaymentOnce` throws after `MAX_SEQ_RETRIES` attempts (will fail on unfixed code
   — no bumpSequence issued).
2. **sendPathPayment desync test**: Mock `submitTransaction` to return `tx_bad_seq` on first
   call. Assert that `sendPathPayment` throws immediately with no recovery (will fail on unfixed
   code — no recovery path exists).
3. **addTrustline desync test**: Same as above for `addTrustline` (will fail on unfixed code).
4. **Persistent desync test**: Mock `loadAccount` to always return the same stale sequence even
   after reload. Assert all retries fail (confirms root cause hypothesis 1).

**Expected Counterexamples**:
- `tx_bad_seq` is thrown to the caller after retry exhaustion with no `bumpSequence` call
- Possible causes: no `bumpSequence` escalation after retry loop, no recovery wrapper on
  `sendPathPayment`/`addTrustline`

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces
the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := fixedFunction(input)
  ASSERT expectedBehavior(result)   // bumpSequence issued AND retry succeeded
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function
produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalFunction(input) = fixedFunction(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for successful transactions and non-sequence
errors, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Normal transaction preservation**: Verify that `sendPayment` with a correct sequence
   submits exactly once with no `bumpSequence` call, and returns `{ transactionHash, ledger, type }`.
2. **Non-sequence error preservation**: Verify that errors with result codes other than
   `tx_bad_seq` (e.g. `tx_insufficient_fee`, `op_no_destination`) propagate unchanged without
   triggering `recoverSequence`.
3. **withRetry independence**: Verify that 503/504 errors still trigger `withRetry` exponential
   backoff and that `recoverSequence` is never called for network errors.
4. **sendPathPayment success format**: Verify `{ transactionHash, ledger }` return shape is
   unchanged after the fix.
5. **addTrustline success format**: Verify `{ transactionHash }` return shape is unchanged.

### Unit Tests

- Test `isBadSeq` correctly identifies `tx_bad_seq` in Horizon error responses and returns
  false for all other error shapes.
- Test `recoverSequence` builds and submits a valid `bumpSequence` transaction using the
  current on-chain sequence number.
- Test `withSequenceRecovery` calls `recoverSequence` only on `tx_bad_seq` and passes all
  other errors through unchanged.
- Test `_sendPaymentOnce` escalates to `bumpSequence` after `MAX_SEQ_RETRIES` exhaustion.
- Test `POST /api/dev/fix-sequence` returns 200 with `transactionHash` in development mode.
- Test `POST /api/dev/fix-sequence` returns 404 in production and test environments.

### Property-Based Tests

- Generate random Horizon error result codes and verify `withSequenceRecovery` only triggers
  recovery for `tx_bad_seq`, never for other codes (preservation of error propagation).
- Generate random valid transaction parameters and verify the fixed `sendPayment`,
  `sendPathPayment`, and `addTrustline` return the same shape as the originals when no
  `tx_bad_seq` occurs (preservation of return values).
- Generate sequences of mixed success/failure scenarios and verify `bumpSequence` is called
  exactly once per recovery event, never on successful submissions.

### Integration Tests

- Test full `sendPayment` flow: simulate desync → `tx_bad_seq` → `bumpSequence` → retry
  succeeds → correct `{ transactionHash, ledger, type: 'payment' }` returned.
- Test full `sendPathPayment` flow with desync recovery.
- Test full `addTrustline` flow with desync recovery.
- Test that `bumpSequence` failure during recovery propagates the error with a log message
  containing "sequence recovery".
- Test `POST /api/dev/fix-sequence` end-to-end in development mode with mocked DB and
  Stellar SDK.
