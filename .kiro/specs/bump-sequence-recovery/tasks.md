# Implementation Plan

- [ ] 1. Write bug condition exploration test
  - **Property 1: Fault Condition** - Persistent tx_bad_seq After Retry Exhaustion
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists across all affected operations
  - **Scoped PBT Approach**: Scope the property to the concrete failing cases — `submitTransaction` always returns `tx_bad_seq` for `sendPayment` (after MAX_SEQ_RETRIES), `sendPathPayment`, and `addTrustline`
  - Mock `withFallback`/`submitTransaction` to always return a `tx_bad_seq` Horizon error (`err.response.data.extras.result_codes.transaction === 'tx_bad_seq'`)
  - Assert that `_sendPaymentOnce` throws `tx_bad_seq` after exhausting `MAX_SEQ_RETRIES` attempts with no `bumpSequence` call issued
  - Assert that `sendPathPayment` throws `tx_bad_seq` immediately on first attempt with no recovery
  - Assert that `addTrustline` throws `tx_bad_seq` immediately on first attempt with no recovery
  - Mock `loadAccount` to always return the same stale sequence even after reload (confirms root cause hypothesis 1 — reload alone is insufficient)
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct — it proves the bug exists and no `bumpSequence` is issued)
  - Document counterexamples found (e.g., "`sendPayment` with desynced account throws `tx_bad_seq` after 3 retries — no `bumpSequence` call observed", "`sendPathPayment` throws immediately with no recovery path")
  - Mark task complete when tests are written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3_

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-tx_bad_seq Paths Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: `sendPayment` with correct sequence submits exactly once, returns `{ transactionHash, ledger, type: 'payment' }` on unfixed code
  - Observe: errors with result codes other than `tx_bad_seq` (e.g. `tx_insufficient_fee`, `op_no_destination`) propagate unchanged — no `recoverSequence` call
  - Observe: 503/504 network errors trigger `withRetry` exponential backoff — `recoverSequence` is never called
  - Observe: `sendPathPayment` success returns `{ transactionHash, ledger }` unchanged
  - Observe: `addTrustline` success returns `{ transactionHash }` unchanged
  - Write property-based test: for all Horizon error result codes that are NOT `tx_bad_seq`, `withSequenceRecovery` passes the error through unchanged (generate random non-`tx_bad_seq` result codes)
  - Write property-based test: for all valid transaction parameters where no `tx_bad_seq` occurs, `sendPayment`, `sendPathPayment`, and `addTrustline` return the same shape as the originals
  - Write property-based test: for sequences of mixed success/failure scenarios, `bumpSequence` is called exactly zero times when no `tx_bad_seq` occurs
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 3. Fix for persistent tx_bad_seq sequence desync with no bumpSequence recovery

  - [ ] 3.1 Add `recoverSequence(publicKey, keypair)` helper to `backend/src/services/stellar.js`
    - Load the current on-chain account using `withFallback` to get the live sequence number
    - Build a `bumpSequence` transaction targeting `account.sequenceNumber()` (the current on-chain value)
    - Sign with `keypair` and submit via `withFallback`
    - Log a warning before submission: `'issuing bumpSequence for account', { publicKey }`
    - _Bug_Condition: `isBugCondition(input)` where `err.response?.data?.extras?.result_codes?.transaction === 'tx_bad_seq'` AND (`operation === 'sendPayment'` AND `attempt >= MAX_SEQ_RETRIES`) OR `operation IN ['sendPathPayment', 'addTrustline']`_
    - _Expected_Behavior: `bumpSequence` operation is submitted to Horizon, resyncing the on-chain sequence number so subsequent transactions succeed_
    - _Requirements: 2.1_

  - [ ] 3.2 Add `withSequenceRecovery(fn, publicKey, keypair)` wrapper to `backend/src/services/stellar.js`
    - Call `fn()` inside a try/catch
    - On catch: if `isBadSeq(err)`, log a warning (`'tx_bad_seq detected, attempting bumpSequence recovery'`), call `recoverSequence(publicKey, keypair)`, then return `fn()` (one retry)
    - On catch: if NOT `isBadSeq(err)`, rethrow unchanged — all non-`tx_bad_seq` errors pass through
    - If `recoverSequence` itself throws, propagate the error with a log message indicating recovery was attempted and failed
    - _Bug_Condition: `isBadSeq(err)` returns true_
    - _Expected_Behavior: `recoverSequence` is called exactly once, then `fn()` is retried once; all other errors pass through unchanged_
    - _Preservation: errors where `isBadSeq(err)` is false are rethrown without calling `recoverSequence`_
    - _Requirements: 2.1, 2.2, 2.3, 3.2_

  - [ ] 3.3 Modify `_sendPaymentOnce` to escalate to `bumpSequence` after `MAX_SEQ_RETRIES` exhaustion
    - After the existing `MAX_SEQ_RETRIES` loop throws `lastErr`, add: `if (isBadSeq(lastErr)) { await recoverSequence(publicKey, keypair); return <final submission attempt>; }`
    - The existing reload-and-retry loop remains completely unchanged — `bumpSequence` is only triggered after all retries are exhausted
    - The final submission after `recoverSequence` uses a freshly loaded account (same pattern as existing loop)
    - _Bug_Condition: `isBadSeq(lastErr)` is true after `attempt >= MAX_SEQ_RETRIES`_
    - _Expected_Behavior: `recoverSequence` is called once after retry exhaustion, then one final submission attempt is made_
    - _Preservation: the existing `MAX_SEQ_RETRIES` reload-and-retry loop runs first and is unmodified (Requirement 3.3)_
    - _Requirements: 2.1, 2.2, 2.3, 3.3_

  - [ ] 3.4 Wrap `sendPathPayment` submission block with `withSequenceRecovery`
    - Wrap the `loadAccount` + `buildTransaction` + `submitTransaction` block in `withSequenceRecovery(fn, publicKey, keypair)`
    - Return value shape `{ transactionHash, ledger }` must remain identical
    - _Bug_Condition: `sendPathPayment` throws `tx_bad_seq` on first submission (no existing retry loop)_
    - _Preservation: success path returns `{ transactionHash, ledger }` unchanged (Requirement 3.5)_
    - _Requirements: 1.3, 2.1, 2.2, 3.5_

  - [ ] 3.5 Wrap `addTrustline` submission block with `withSequenceRecovery`
    - Wrap the `loadAccount` + `buildTransaction` + `submitTransaction` block in `withSequenceRecovery(fn, publicKey, keypair)`
    - Return value shape `{ transactionHash }` must remain identical
    - _Bug_Condition: `addTrustline` throws `tx_bad_seq` on first submission (no existing retry loop)_
    - _Preservation: success path returns `{ transactionHash }` unchanged (Requirement 3.5)_
    - _Requirements: 1.3, 2.1, 2.2, 3.5_

  - [ ] 3.6 Add `POST /api/dev/fix-sequence` to `backend/src/routes/dev.js`
    - Follow the existing `fund-wallet` route pattern in `dev.js`
    - Query the authenticated user's `public_key` and `encrypted_secret_key` from the DB
    - Decrypt the secret key and call `recoverSequence(publicKey, keypair)`
    - Return `{ message: 'Sequence recovered', transactionHash }` on success
    - Protected by the existing `NODE_ENV !== 'development'` guard at the top of the router (returns 404 in non-dev environments)
    - _Requirements: 2.4, 2.5_

  - [ ] 3.7 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Automatic bumpSequence Recovery on tx_bad_seq
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms `bumpSequence` is issued and the retry succeeds for `_sendPaymentOnce`, `sendPathPayment`, and `addTrustline`
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Tests PASS (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ] 3.8 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-tx_bad_seq Paths Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions on normal transactions, non-sequence errors, network errors, and return value shapes)

- [ ] 4. Checkpoint — Ensure all tests pass
  - Run the full test suite: `npm test` in `backend/`
  - Ensure the exploration test (task 1 / Property 1) passes — bug is fixed
  - Ensure the preservation tests (task 2 / Property 2) pass — no regressions
  - Ensure existing tests in `devFaucet.test.js` and `stellar.js` unit tests still pass
  - Ask the user if any questions arise
