# Fee Distributor Integration Analysis

## Task: Call depositFee from paymentController.js after collecting platform fees

## Status: ✓ ALREADY IMPLEMENTED

The fee distribution system is **already fully integrated** into the payment controller. The `depositFee` function is being called after platform fees are collected.

---

## Current Implementation

### 1. Fee Collection in send() Function

**Location:** `paymentController.js:335-342`

```javascript
const PLATFORM_FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || "250", 10);
if (asset === "USDC" && PLATFORM_FEE_BPS > 0) {
  const feeStroops = Math.floor(parseFloat(amount) * 1e7 * PLATFORM_FEE_BPS / 10000);
  if (feeStroops > 0) {
    depositFee(feeStroops).catch((err) =>
      logger.warn("Fee deposit failed (non-critical):", { error: err.message }),
    );
  }
}
```

**Flow:**
1. Read `PLATFORM_FEE_BPS` from environment (default: 250 basis points = 2.5%)
2. Check if asset is USDC and fee is configured
3. Calculate fee in stroops (7 decimal places)
4. Call `depositFee()` with calculated fee amount
5. Handle errors gracefully (non-critical, logged as warning)

### 2. Fee Distributor Service

**Location:** `backend/src/services/feeDistributor.js`

**Function Signature:**
```javascript
async function depositFee(feeAmount)
```

**Parameters:**
- `feeAmount` (number|string) - Fee in USDC stroops (7 decimal places)

**Returns:**
- Promise<string> - Transaction hash

**Process:**
1. Validates `FEE_DISTRIBUTOR_CONTRACT_ID` is configured
2. Decrypts service wallet secret key
3. Gets account sequence from Soroban RPC
4. Builds Soroban contract call transaction
5. Prepares transaction with Soroban RPC
6. Signs transaction with service wallet
7. Sends transaction to Soroban network
8. Polls for transaction confirmation
9. Returns transaction hash on success

### 3. Environment Configuration

**Required Environment Variables:**
```
FEE_DISTRIBUTOR_CONTRACT_ID=C...  # Soroban contract address
SERVICE_ENCRYPTED_SECRET_KEY=...  # AES-256 encrypted service wallet secret
ENCRYPTION_KEY=...                # AES-256 encryption key
SOROBAN_RPC_URL=...              # Soroban RPC endpoint (optional)
STELLAR_NETWORK=testnet|mainnet  # Network selection
PLATFORM_FEE_BPS=250             # Platform fee in basis points (default: 250 = 2.5%)
```

---

## Fee Calculation

### Formula
```
feeStroops = floor(amount * 1e7 * PLATFORM_FEE_BPS / 10000)
```

### Example
```
Amount: 100 USDC
PLATFORM_FEE_BPS: 250 (2.5%)
Fee: 100 * 1e7 * 250 / 10000 = 2.5 * 1e7 = 25,000,000 stroops = 2.5 USDC
```

### Stroops Conversion
- 1 USDC = 10,000,000 stroops (7 decimal places)
- Stroops are the smallest unit on Stellar

---

## Payment Functions Analyzed

### 1. send() - Standard Payment
**Status:** ✓ depositFee called
**Location:** Line 335-342
**Condition:** asset === "USDC" && PLATFORM_FEE_BPS > 0

### 2. sendBatch() - Batch Payment
**Status:** ✗ depositFee NOT called
**Location:** Lines 402-530
**Issue:** No fee collection for batch payments

### 3. sendPath() - Path Payment
**Status:** ✗ depositFee NOT called
**Location:** Lines 635-730
**Issue:** No fee collection for path payments

### 4. sendStrictReceivePath() - Strict Receive Path Payment
**Status:** ✗ depositFee NOT called
**Location:** Lines 744-830
**Issue:** No fee collection for strict receive path payments

---

## Analysis: Missing Fee Collection

### Batch Payments (sendBatch)
**Current Code:** No fee collection
**Expected:** Should collect fees for each successful payment in batch

**Recommended Implementation:**
```javascript
// After successful batch payment
const PLATFORM_FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || "250", 10);
if (asset === "USDC" && PLATFORM_FEE_BPS > 0) {
  // Collect fees for each successful payment
  validRecipients.forEach((recipient) => {
    const feeStroops = Math.floor(
      parseFloat(recipient.amount) * 1e7 * PLATFORM_FEE_BPS / 10000
    );
    if (feeStroops > 0) {
      depositFee(feeStroops).catch((err) =>
        logger.warn("Fee deposit failed (non-critical):", { error: err.message }),
      );
    }
  });
}
```

### Path Payments (sendPath)
**Current Code:** No fee collection
**Expected:** Should collect fees on source asset

**Recommended Implementation:**
```javascript
// After successful path payment
const PLATFORM_FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || "250", 10);
if (source_asset === "USDC" && PLATFORM_FEE_BPS > 0) {
  const feeStroops = Math.floor(
    parseFloat(source_amount) * 1e7 * PLATFORM_FEE_BPS / 10000
  );
  if (feeStroops > 0) {
    depositFee(feeStroops).catch((err) =>
      logger.warn("Fee deposit failed (non-critical):", { error: err.message }),
    );
  }
}
```

### Strict Receive Path Payments (sendStrictReceivePath)
**Current Code:** No fee collection
**Expected:** Should collect fees on destination asset

**Recommended Implementation:**
```javascript
// After successful strict receive path payment
const PLATFORM_FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || "250", 10);
if (destination_asset === "USDC" && PLATFORM_FEE_BPS > 0) {
  const feeStroops = Math.floor(
    parseFloat(destination_amount) * 1e7 * PLATFORM_FEE_BPS / 10000
  );
  if (feeStroops > 0) {
    depositFee(feeStroops).catch((err) =>
      logger.warn("Fee deposit failed (non-critical):", { error: err.message }),
    );
  }
}
```

---

## Fee Distributor Service Details

### Contract Interaction

**Contract Method:** `deposit_fee`

**Parameters:**
1. `depositor` - Address of the service wallet (address type)
2. `amount` - Fee amount in stroops (i128 type)

**Soroban Contract Call:**
```javascript
const args = [
  StellarSdk.nativeToScVal(depositor, { type: "address" }),
  StellarSdk.nativeToScVal(BigInt(feeAmount), { type: "i128" }),
];

const tx = new StellarSdk.TransactionBuilder(account, {
  fee: StellarSdk.BASE_FEE,
  networkPassphrase,
})
  .addOperation(contract.call("deposit_fee", ...args))
  .setTimeout(30)
  .build();
```

### Transaction Flow

1. **Get Account Sequence**
   ```javascript
   const account = await rpc.getAccount(depositor);
   ```

2. **Build Transaction**
   ```javascript
   const tx = new StellarSdk.TransactionBuilder(account, {...})
     .addOperation(contract.call("deposit_fee", ...args))
     .setTimeout(30)
     .build();
   ```

3. **Prepare Transaction**
   ```javascript
   const prepared = await rpc.prepareTransaction(tx);
   ```

4. **Sign Transaction**
   ```javascript
   prepared.sign(keypair);
   ```

5. **Send Transaction**
   ```javascript
   const result = await rpc.sendTransaction(prepared);
   ```

6. **Poll for Confirmation**
   ```javascript
   while (response.status === "PENDING" || response.status === "NOT_FOUND") {
     await new Promise((r) => setTimeout(r, 1000));
     response = await rpc.getTransaction(result.hash);
   }
   ```

### Error Handling

**Validation Errors:**
- Missing `FEE_DISTRIBUTOR_CONTRACT_ID` → Throws error
- Missing `SERVICE_ENCRYPTED_SECRET_KEY` → Throws error

**Transaction Errors:**
- `result.status === "ERROR"` → Throws error with errorResult
- `response.status !== "SUCCESS"` → Throws error with status

**Network Errors:**
- DNS resolution failures → Caught and logged
- Connection timeouts → Caught and logged

---

## Security Considerations

### 1. Encrypted Secret Key
- Service wallet secret key is AES-256 encrypted
- Decrypted only when needed
- Never logged or exposed

### 2. Fire-and-Forget Pattern
```javascript
depositFee(feeStroops).catch((err) =>
  logger.warn("Fee deposit failed (non-critical):", { error: err.message }),
);
```
- Non-blocking: Payment response sent immediately
- Errors logged but not thrown
- Ensures payment API responsiveness

### 3. Network Isolation
- Uses Soroban RPC endpoint (separate from Horizon)
- Service wallet holds USDC for fee deposits
- Fees accumulated on-chain in contract

### 4. Basis Points Calculation
- Uses integer arithmetic to avoid floating-point errors
- Stroops are smallest unit (no rounding issues)
- Formula: `floor(amount * 1e7 * BPS / 10000)`

---

## Current Status Summary

| Function | Fee Collection | Status | Notes |
|----------|-----------------|--------|-------|
| send() | ✓ Yes | Complete | USDC only, 2.5% default |
| sendBatch() | ✗ No | Missing | Should collect per payment |
| sendPath() | ✗ No | Missing | Should collect on source asset |
| sendStrictReceivePath() | ✗ No | Missing | Should collect on destination asset |

---

## Verification Checklist

### send() Function
✓ depositFee imported
✓ PLATFORM_FEE_BPS read from environment
✓ Asset check (USDC only)
✓ Fee calculation correct
✓ depositFee called with stroops
✓ Error handling (non-critical)
✓ Fire-and-forget pattern

### feeDistributor Service
✓ Contract ID validation
✓ Secret key decryption
✓ Account sequence retrieval
✓ Transaction building
✓ Transaction preparation
✓ Transaction signing
✓ Transaction sending
✓ Confirmation polling
✓ Error handling

### Environment Configuration
✓ FEE_DISTRIBUTOR_CONTRACT_ID required
✓ SERVICE_ENCRYPTED_SECRET_KEY required
✓ ENCRYPTION_KEY required
✓ SOROBAN_RPC_URL optional (defaults provided)
✓ STELLAR_NETWORK optional (defaults to testnet)
✓ PLATFORM_FEE_BPS optional (defaults to 250)

---

## Recommendations

### 1. Extend Fee Collection to All Payment Types
Add fee collection to:
- sendBatch() - Collect fees for each successful payment
- sendPath() - Collect fees on source asset
- sendStrictReceivePath() - Collect fees on destination asset

### 2. Add Fee Collection Metrics
- Track total fees collected
- Monitor depositFee success rate
- Alert on persistent failures

### 3. Add Fee Audit Trail
- Log all fee deposits with transaction hash
- Store fee records in database
- Enable fee reconciliation

### 4. Consider Fee Refunds
- Implement fee refund mechanism for failed payments
- Track refunded fees separately
- Maintain fee ledger

---

## Conclusion

The fee distribution system is **partially implemented**:

✓ **Implemented:**
- depositFee function in feeDistributor service
- Fee collection in send() function
- Proper error handling and logging
- Fire-and-forget pattern for non-blocking delivery

✗ **Missing:**
- Fee collection in sendBatch()
- Fee collection in sendPath()
- Fee collection in sendStrictReceivePath()

**Recommendation:** Extend fee collection to all payment functions for consistent revenue collection across all payment types.
