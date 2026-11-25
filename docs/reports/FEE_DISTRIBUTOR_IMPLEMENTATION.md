# Fee Distributor Implementation Guide

## Overview

This guide provides step-by-step instructions for implementing fee collection in all payment functions.

---

## Current Status

### Already Implemented ✓
- `send()` - Standard payment (Line 335-342)
- `depositFee()` service function
- Environment configuration

### Missing Implementation ✗
- `sendBatch()` - Batch payments
- `sendPath()` - Path payments
- `sendStrictReceivePath()` - Strict receive path payments

---

## Implementation Plan

### 1. sendBatch() - Batch Payment Fee Collection

**Location:** After successful batch payment (around line 500)

**Current Code:**
```javascript
await Promise.all(results.map(async (result) => {
  const isSubmitted = result.status === "pending";
  if (isSubmitted) { 
    result.status = "success"; 
    result.tx_hash = transactionHash; 
    result.ledger = ledger; 
  }
  const txId = await insertTransactionRecord({
    sender_wallet: public_key, 
    recipient_wallet: result.recipient_address,
    amount: result.amount, 
    asset, 
    memo: memo || null, 
    memo_type,
    tx_hash: result.tx_hash || null, 
    status: result.status === "success" ? "completed" : "failed",
  });
  result.id = txId;
  if (result.status === "success") {
    const txData = { 
      id: txId, 
      tx_hash: transactionHash, 
      ledger, 
      amount: result.amount, 
      asset, 
      sender: public_key, 
      recipient: result.recipient_address, 
      type: "payment" 
    };
    webhook.deliver("payment.sent", txData).catch(() => {});
    webhook.deliver("payment.received", txData).catch(() => {});
  }
}));

await cache.del(`balance:${public_key}`);
```

**Proposed Change:**
```javascript
await Promise.all(results.map(async (result) => {
  const isSubmitted = result.status === "pending";
  if (isSubmitted) { 
    result.status = "success"; 
    result.tx_hash = transactionHash; 
    result.ledger = ledger; 
  }
  const txId = await insertTransactionRecord({
    sender_wallet: public_key, 
    recipient_wallet: result.recipient_address,
    amount: result.amount, 
    asset, 
    memo: memo || null, 
    memo_type,
    tx_hash: result.tx_hash || null, 
    status: result.status === "success" ? "completed" : "failed",
  });
  result.id = txId;
  if (result.status === "success") {
    const txData = { 
      id: txId, 
      tx_hash: transactionHash, 
      ledger, 
      amount: result.amount, 
      asset, 
      sender: public_key, 
      recipient: result.recipient_address, 
      type: "payment" 
    };
    webhook.deliver("payment.sent", txData).catch(() => {});
    webhook.deliver("payment.received", txData).catch(() => {});
    
    // Collect platform fee for each successful payment
    const PLATFORM_FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || "250", 10);
    if (asset === "USDC" && PLATFORM_FEE_BPS > 0) {
      const feeStroops = Math.floor(
        parseFloat(result.amount) * 1e7 * PLATFORM_FEE_BPS / 10000
      );
      if (feeStroops > 0) {
        depositFee(feeStroops).catch((err) =>
          logger.warn("Fee deposit failed (non-critical):", { error: err.message }),
        );
      }
    }
  }
}));

await cache.del(`balance:${public_key}`);
```

**Key Points:**
- Fee collected per successful payment
- Only for USDC asset
- Non-blocking (fire-and-forget)
- Errors logged but not thrown

---

### 2. sendPath() - Path Payment Fee Collection

**Location:** After successful path payment (around line 715)

**Current Code:**
```javascript
const txData = { 
  id: txId, 
  tx_hash: transactionHash, 
  ledger, 
  source_amount, 
  source_asset, 
  destination_asset, 
  sender: public_key, 
  recipient: recipient_address 
};
webhook.deliver("payment.sent", txData).catch(() => {});
webhook.deliver("payment.received", txData).catch(() => {});

res.json({
  message: "Path payment sent successfully",
  transaction: { 
    id: txId, 
    tx_hash: transactionHash, 
    ledger, 
    source_amount, 
    source_asset, 
    destination_asset, 
    recipient: recipient_address 
  },
});
```

**Proposed Change:**
```javascript
const txData = { 
  id: txId, 
  tx_hash: transactionHash, 
  ledger, 
  source_amount, 
  source_asset, 
  destination_asset, 
  sender: public_key, 
  recipient: recipient_address 
};
webhook.deliver("payment.sent", txData).catch(() => {});
webhook.deliver("payment.received", txData).catch(() => {});

// Collect platform fee on source asset
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

res.json({
  message: "Path payment sent successfully",
  transaction: { 
    id: txId, 
    tx_hash: transactionHash, 
    ledger, 
    source_amount, 
    source_asset, 
    destination_asset, 
    recipient: recipient_address 
  },
});
```

**Key Points:**
- Fee collected on source asset (what sender pays)
- Only for USDC source asset
- Non-blocking (fire-and-forget)
- Errors logged but not thrown

---

### 3. sendStrictReceivePath() - Strict Receive Path Fee Collection

**Location:** After successful strict receive path payment (around line 815)

**Current Code:**
```javascript
const txData = { 
  id: txId, 
  tx_hash: transactionHash, 
  ledger, 
  destination_amount, 
  destination_asset, 
  sender: public_key, 
  recipient: recipient_address 
};
webhook.deliver("payment.sent", txData).catch(() => {});
webhook.deliver("payment.received", txData).catch(() => {});

res.json({
  message: "Strict receive path payment sent successfully",
  transaction: { 
    id: txId, 
    tx_hash: transactionHash, 
    ledger, 
    destination_amount, 
    destination_asset, 
    recipient: recipient_address, 
    status: "confirming" 
  },
});
```

**Proposed Change:**
```javascript
const txData = { 
  id: txId, 
  tx_hash: transactionHash, 
  ledger, 
  destination_amount, 
  destination_asset, 
  sender: public_key, 
  recipient: recipient_address 
};
webhook.deliver("payment.sent", txData).catch(() => {});
webhook.deliver("payment.received", txData).catch(() => {});

// Collect platform fee on destination asset
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

res.json({
  message: "Strict receive path payment sent successfully",
  transaction: { 
    id: txId, 
    tx_hash: transactionHash, 
    ledger, 
    destination_amount, 
    destination_asset, 
    recipient: recipient_address, 
    status: "confirming" 
  },
});
```

**Key Points:**
- Fee collected on destination asset (what recipient receives)
- Only for USDC destination asset
- Non-blocking (fire-and-forget)
- Errors logged but not thrown

---

## Implementation Steps

### Step 1: Verify Current Implementation
```bash
# Check that depositFee is imported
grep "const { depositFee }" backend/src/controllers/paymentController.js

# Check current fee collection in send()
grep -A 10 "PLATFORM_FEE_BPS" backend/src/controllers/paymentController.js
```

### Step 2: Add Fee Collection to sendBatch()
1. Locate the webhook delivery code in sendBatch()
2. Add fee collection after webhook delivery
3. Use result.amount for fee calculation
4. Test with batch payments

### Step 3: Add Fee Collection to sendPath()
1. Locate the webhook delivery code in sendPath()
2. Add fee collection after webhook delivery
3. Use source_amount for fee calculation
4. Test with path payments

### Step 4: Add Fee Collection to sendStrictReceivePath()
1. Locate the webhook delivery code in sendStrictReceivePath()
2. Add fee collection after webhook delivery
3. Use destination_amount for fee calculation
4. Test with strict receive path payments

### Step 5: Test All Payment Types
```bash
# Test standard payment
curl -X POST http://localhost:3000/api/payments/send \
  -H "Authorization: Bearer JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "recipient_address": "GBXYZ...",
    "amount": "100",
    "asset": "USDC"
  }'

# Test batch payment
curl -X POST http://localhost:3000/api/payments/batch \
  -H "Authorization: Bearer JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "recipients": [
      {"recipient_address": "GBXYZ...", "amount": "50"},
      {"recipient_address": "GABC...", "amount": "50"}
    ],
    "asset": "USDC"
  }'

# Test path payment
curl -X POST http://localhost:3000/api/payments/path \
  -H "Authorization: Bearer JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "recipient_address": "GBXYZ...",
    "source_asset": "USDC",
    "source_amount": "100",
    "destination_asset": "XLM",
    "destination_min_amount": "500"
  }'

# Test strict receive path payment
curl -X POST http://localhost:3000/api/payments/strict-receive-path \
  -H "Authorization: Bearer JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "recipient_address": "GBXYZ...",
    "source_asset": "USDC",
    "source_max_amount": "100",
    "destination_asset": "XLM",
    "destination_amount": "500"
  }'
```

### Step 6: Verify Fee Deposits
1. Check Soroban contract for fee deposits
2. Verify transaction hashes in logs
3. Confirm fees accumulated on-chain

---

## Code Pattern

All fee collection follows this pattern:

```javascript
// 1. Read fee configuration
const PLATFORM_FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || "250", 10);

// 2. Check asset and fee configuration
if (asset === "USDC" && PLATFORM_FEE_BPS > 0) {
  // 3. Calculate fee in stroops
  const feeStroops = Math.floor(
    parseFloat(amount) * 1e7 * PLATFORM_FEE_BPS / 10000
  );
  
  // 4. Deposit fee if non-zero
  if (feeStroops > 0) {
    depositFee(feeStroops).catch((err) =>
      logger.warn("Fee deposit failed (non-critical):", { error: err.message }),
    );
  }
}
```

---

## Error Handling

### Non-Critical Failures
```javascript
depositFee(feeStroops).catch((err) =>
  logger.warn("Fee deposit failed (non-critical):", { error: err.message }),
);
```

**Behavior:**
- Errors are caught and logged
- Payment is not affected
- User receives payment confirmation
- Fee deposit is retried on next transaction

### Critical Failures
If `FEE_DISTRIBUTOR_CONTRACT_ID` or `SERVICE_ENCRYPTED_SECRET_KEY` is missing:
- Error is thrown during service initialization
- Application fails to start
- Requires configuration fix

---

## Testing Checklist

### Unit Tests
- [ ] Fee calculation is correct
- [ ] Only USDC fees are collected
- [ ] Fee is zero when PLATFORM_FEE_BPS is 0
- [ ] depositFee is called with correct amount
- [ ] Errors are caught and logged

### Integration Tests
- [ ] Standard payment collects fee
- [ ] Batch payment collects fees per payment
- [ ] Path payment collects fee on source asset
- [ ] Strict receive path collects fee on destination asset
- [ ] Fee deposit succeeds on-chain
- [ ] Fee deposit failure doesn't block payment

### End-to-End Tests
- [ ] Payment succeeds with fee collection
- [ ] Fee appears in Soroban contract
- [ ] Multiple payments accumulate fees
- [ ] Fee collection works on testnet
- [ ] Fee collection works on mainnet

---

## Monitoring

### Metrics to Track
- Total fees collected per day
- Fee deposit success rate
- Average fee deposit time
- Failed fee deposits

### Logs to Monitor
```
"Fee deposit failed (non-critical):" - Non-critical failures
"Webhook delivery blocked:" - SSRF validation failures
"Transaction failed:" - Soroban transaction failures
```

### Alerts to Set
- Fee deposit failure rate > 5%
- Fee deposit timeout > 30 seconds
- Missing environment configuration
- Soroban RPC connection failures

---

## Deployment Checklist

- [ ] Code changes reviewed
- [ ] Tests passing
- [ ] Environment variables configured
- [ ] Soroban contract deployed
- [ ] Service wallet funded with USDC
- [ ] Testnet deployment successful
- [ ] Mainnet deployment scheduled
- [ ] Monitoring configured
- [ ] Rollback plan documented

---

## Rollback Plan

If fee collection causes issues:

1. **Disable Fee Collection**
   ```bash
   export PLATFORM_FEE_BPS=0
   ```

2. **Revert Code Changes**
   ```bash
   git revert <commit-hash>
   ```

3. **Restart Application**
   ```bash
   npm restart
   ```

4. **Verify Payments Work**
   ```bash
   # Test payment without fee collection
   curl -X POST http://localhost:3000/api/payments/send ...
   ```

---

## Conclusion

The fee distribution system is ready for extension to all payment types. Follow this guide to add fee collection to batch, path, and strict receive path payments.

**Key Points:**
- Use same pattern as send() function
- Collect fees per payment (batch) or per transaction (path)
- Use fire-and-forget pattern for non-blocking delivery
- Log errors but don't throw
- Test thoroughly before deployment
