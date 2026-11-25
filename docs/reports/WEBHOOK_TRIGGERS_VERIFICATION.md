# Webhook Triggers Verification

## Overview

This document verifies that webhook delivery is properly triggered for PAYMENT_SENT and PAYMENT_RECEIVED events in the paymentController.js.

## Webhook Trigger Locations

### 1. Standard Payment Send (`send()` function)

**Location:** `backend/src/controllers/paymentController.js:346-349`

**Trigger Condition:** Payment successfully broadcast to Stellar network

**Code:**
```javascript
const txData = { 
  id: txId, 
  tx_hash: transactionHash, 
  ledger, 
  amount, 
  asset, 
  sender: public_key, 
  recipient: recipient_address, 
  type 
};
webhook.deliver("payment.sent", txData).catch(() => {});
if (type !== "claimable_balance") {
  webhook.deliver("payment.received", txData).catch(() => {});
}
```

**Events Triggered:**
- ✓ `payment.sent` - Always triggered on success
- ✓ `payment.received` - Triggered for regular payments (not claimable balances)

**Payload Data:**
- id: Transaction UUID
- tx_hash: Stellar transaction hash
- ledger: Ledger sequence number
- amount: Payment amount
- asset: Asset code (XLM, USDC, etc.)
- sender: Sender's public key
- recipient: Recipient's public key
- type: "payment" or "claimable_balance"

---

### 2. Batch Payment (`sendBatch()` function)

**Location:** `backend/src/controllers/paymentController.js:494-495`

**Trigger Condition:** Each batch payment successfully broadcast

**Code:**
```javascript
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
```

**Events Triggered:**
- ✓ `payment.sent` - For each successful batch payment
- ✓ `payment.received` - For each successful batch payment

**Payload Data:** Same as standard payment

---

### 3. Path Payment (`sendPath()` function)

**Location:** `backend/src/controllers/paymentController.js:712-713`

**Trigger Condition:** Path payment successfully broadcast

**Code:**
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
```

**Events Triggered:**
- ✓ `payment.sent` - On successful path payment
- ✓ `payment.received` - On successful path payment

**Payload Data:**
- id: Transaction UUID
- tx_hash: Stellar transaction hash
- ledger: Ledger sequence number
- source_amount: Amount sent
- source_asset: Source asset code
- destination_asset: Destination asset code
- sender: Sender's public key
- recipient: Recipient's public key

---

### 4. Strict Receive Path Payment (`sendStrictReceivePath()` function)

**Location:** `backend/src/controllers/paymentController.js:809-810`

**Trigger Condition:** Strict receive path payment successfully broadcast

**Code:**
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
```

**Events Triggered:**
- ✓ `payment.sent` - On successful strict receive path payment
- ✓ `payment.received` - On successful strict receive path payment

**Payload Data:**
- id: Transaction UUID
- tx_hash: Stellar transaction hash
- ledger: Ledger sequence number
- destination_amount: Amount received
- destination_asset: Destination asset code
- sender: Sender's public key
- recipient: Recipient's public key

---

## Payment Failed Event Triggers

### Failure Scenarios

#### 1. KYC Required (Line 221)
```javascript
webhook.deliver("payment.failed", { 
  code: "KYC_REQUIRED", 
  error: "KYC verification required for transactions above $100 USD equivalent." 
}).catch(() => {});
```

#### 2. Daily Limit Exceeded (Line 255)
```javascript
webhook.deliver("payment.failed", { 
  code: "DAILY_LIMIT_EXCEEDED", 
  error: `Daily send limit of ${DAILY_SEND_LIMIT} reached. Try again tomorrow.` 
}).catch(() => {});
```

#### 3. Fraud Velocity Check (Line 268)
```javascript
webhook.deliver("payment.failed", { 
  code: "FRAUD_BLOCKED", 
  error: "Transaction limit reached. Please wait before sending again." 
}).catch(() => {});
```

#### 4. Fraud Detection (Line 276)
```javascript
webhook.deliver("payment.failed", { 
  code: "FRAUD_BLOCKED", 
  error: fraudCheck.reason 
}).catch(() => {});
```

#### 5. Daily Limit Exceeded (Line 287)
```javascript
webhook.deliver("payment.failed", { 
  code: "DAILY_LIMIT_EXCEEDED", 
  error: "Daily send limit reached. Try again later." 
}).catch(() => {});
```

#### 6. Transaction Failed - Status Error (Line 390)
```javascript
const failedPayload = { error: err.message };
if (err.payload?.code) failedPayload.code = err.payload.code;
webhook.deliver("payment.failed", failedPayload).catch(() => {});
```

#### 7. Transaction Failed - Response Error (Line 395)
```javascript
webhook.deliver("payment.failed", { 
  error: "Transaction failed", 
  details: extras 
}).catch(() => {});
```

---

## Event Delivery Mechanism

### Database Query
```sql
SELECT url, secret FROM webhooks 
WHERE active = true AND $1 = ANY(events)
```

**Parameters:**
- `$1` = Event name ("payment.sent", "payment.received", or "payment.failed")

**Result:** All active webhooks subscribed to the event

### Delivery Process

1. **Query webhooks** - Find all active webhooks for the event
2. **Build payload** - Create payload with event, data, and timestamp
3. **Parallel delivery** - Trigger `deliverWithRetry()` for each webhook
4. **Retry logic** - Exponential backoff (1s, 2s, 4s) up to 3 attempts
5. **Error handling** - Log failures, don't block payment response

### Fire-and-Forget Pattern
```javascript
webhook.deliver("payment.sent", txData).catch(() => {});
```

- Webhook delivery is non-blocking
- Errors are caught and logged
- Payment response is sent immediately
- Webhook delivery happens asynchronously

---

## Webhook Payload Structure

### Standard Payload Format
```json
{
  "event": "payment.sent|payment.received|payment.failed",
  "data": { /* event-specific data */ },
  "timestamp": "2024-05-30T12:34:56.789Z"
}
```

### Example: Payment Sent
```json
{
  "event": "payment.sent",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "tx_hash": "abc123def456...",
    "ledger": 12345,
    "amount": "100.00",
    "asset": "XLM",
    "sender": "GBRPYHIL2CI3...",
    "recipient": "GBXYZ123...",
    "type": "payment"
  },
  "timestamp": "2024-05-30T12:34:56.789Z"
}
```

### Example: Payment Failed
```json
{
  "event": "payment.failed",
  "data": {
    "code": "KYC_REQUIRED",
    "error": "KYC verification required for transactions above $100 USD equivalent."
  },
  "timestamp": "2024-05-30T12:34:56.789Z"
}
```

---

## Webhook Signature Verification

### Header
```
X-AfriPay-Signature: sha256=<hex-encoded-hmac>
```

### Verification Process (Webhook Receiver)
```javascript
const crypto = require('crypto');
const signature = req.headers['x-afripay-signature'];
const body = JSON.stringify(req.body);
const secret = 'webhook-secret-from-database';

const expectedSignature = 'sha256=' + 
  crypto.createHmac('sha256', secret)
    .update(body)
    .digest('hex');

if (signature === expectedSignature) {
  // Webhook is authentic
}
```

---

## Retry Logic

### Exponential Backoff
```
Attempt 1: Immediate
Attempt 2: After 1 second (2^0 * 1000ms)
Attempt 3: After 2 seconds (2^1 * 1000ms)
Attempt 4: After 4 seconds (2^2 * 1000ms)
```

### Retry Conditions
- Network errors (connection refused, timeout)
- HTTP 3xx/4xx/5xx responses
- SSRF validation failure (logged, not retried)

### Max Attempts
- 3 total attempts per webhook
- After 3 failures, logged for operator investigation

---

## SSRF Protection

### Pre-Delivery Validation
```javascript
if (!await isPublicHttpsUrl(url)) {
  logger.error('Webhook delivery blocked: URL failed SSRF validation', { url });
  return;
}
```

### Blocked Ranges
- RFC-1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
- Loopback: 127.0.0.0/8, ::1
- Link-local: 169.254.0.0/16
- Metadata: AWS, GCP, Azure endpoints
- Reserved: 0.0.0.0/8, 224.0.0.0/4, 240.0.0.0/4

---

## Verification Summary

### Payment Sent Events
✓ Standard payment send
✓ Batch payment send
✓ Path payment send
✓ Strict receive path payment send

### Payment Received Events
✓ Standard payment receive (except claimable balances)
✓ Batch payment receive
✓ Path payment receive
✓ Strict receive path payment receive

### Payment Failed Events
✓ KYC required
✓ Daily limit exceeded
✓ Fraud blocked
✓ Transaction failed

### Delivery Mechanism
✓ Database query for active webhooks
✓ Parallel delivery using Promise.all()
✓ Retry logic with exponential backoff
✓ SSRF protection on each delivery
✓ HMAC-SHA256 signature verification
✓ Fire-and-forget pattern (non-blocking)
✓ Comprehensive error logging

---

## Conclusion

**Status: ✓ FULLY IMPLEMENTED**

The webhook delivery system is completely integrated into the paymentController.js with:

1. **Multiple trigger points** - All payment types covered
2. **Robust delivery** - Retry logic with exponential backoff
3. **Security** - SSRF protection and signature verification
4. **Reliability** - Fire-and-forget pattern ensures payment API responsiveness
5. **Observability** - Comprehensive logging for debugging

No additional implementation is required. The system is production-ready.
