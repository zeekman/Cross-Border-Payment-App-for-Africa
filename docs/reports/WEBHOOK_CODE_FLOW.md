# Webhook Delivery Code Flow

## Overview

This document traces the exact code flow for webhook delivery from payment events to registered endpoints.

---

## Flow 1: Successful Payment Send

### Step 1: Payment Initiated
**File:** `paymentController.js:182`
```javascript
async function send(req, res, next) {
  const txId = uuidv4();
  // ... validation and setup ...
```

### Step 2: Payment Broadcast to Stellar
**File:** `paymentController.js:310-318`
```javascript
const { transactionHash, ledger, type, claimableBalanceId } = await sendPayment({
  senderPublicKey: public_key,
  encryptedSecretKey: encrypted_secret_key,
  recipientPublicKey: recipient_address,
  amount,
  asset,
  memo: memo || undefined,
  memoType: memo ? memo_type : undefined,
  feePriority: fee_priority,
}, req.logger);
```

### Step 3: Transaction Saved to Database
**File:** `paymentController.js:320-327`
```javascript
const txStatus = type === "claimable_balance" ? "pending_claim" : "confirming";
await db.query(
  `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, memo_type, tx_hash, status, claimable_balance_id, request_id, is_encrypted, encrypted_memo, ledger_close_time)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [txId, public_key, recipient_address, amount, asset, memo || null, memo_type, transactionHash, txStatus, claimableBalanceId || null, req.requestId, is_encrypted, encrypted_memo, ledger_close_time],
);
```

### Step 4: Webhook Delivery Triggered
**File:** `paymentController.js:346-349`
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

### Step 5: Webhook Service - deliver()
**File:** `webhook.js:104-111`
```javascript
async function deliver(event, data) {
  const { rows } = await db.query(
    `SELECT url, secret FROM webhooks WHERE active = true AND $1 = ANY(events)`,
    [event]
  );
  const payload = { event, data, timestamp: new Date().toISOString() };
  await Promise.all(rows.map((wh) => deliverWithRetry(wh.url, wh.secret, payload)));
}
```

**Database Query:**
```sql
SELECT url, secret FROM webhooks 
WHERE active = true AND 'payment.sent' = ANY(events)
```

**Result:** All active webhooks subscribed to `payment.sent` event

### Step 6: Parallel Delivery
**File:** `webhook.js:111`
```javascript
await Promise.all(rows.map((wh) => deliverWithRetry(wh.url, wh.secret, payload)));
```

For each webhook:
- Call `deliverWithRetry(url, secret, payload)`
- Execute in parallel
- Wait for all to complete

### Step 7: Webhook Service - deliverWithRetry()
**File:** `webhook.js:68-101`
```javascript
async function deliverWithRetry(url, secret, payload, attempt = 0) {
  // Re-validate URL before each delivery to catch DNS rebinding / stale records
  if (!await isPublicHttpsUrl(url)) {
    logger.error('Webhook delivery blocked: URL failed SSRF validation', { url });
    return;
  }
  const body = JSON.stringify(payload);
  const signature = sign(secret, body);
  try {
    await httpsPost(url, body, signature);
  } catch (err) {
    if (attempt < MAX_ATTEMPTS - 1) {
      const delay = Math.pow(2, attempt) * 1000;
      logger.warn('Webhook delivery failed, retrying', {
        url,
        attempt: attempt + 1,
        maxAttempts: MAX_ATTEMPTS,
        delay,
        error: err.message,
      });
      await new Promise((r) => setTimeout(r, delay));
      return deliverWithRetry(url, secret, payload, attempt + 1);
    }
    // All attempts exhausted
    logger.error('Webhook delivery permanently failed after max retries', {
      url,
      event: payload.event,
      attempts: MAX_ATTEMPTS,
      error: err.message,
    });
  }
}
```

### Step 7a: SSRF Validation
**File:** `webhook.js:8-42`
```javascript
async function isPublicHttpsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname;

  // Reject bare private IPs
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && isPrivateIp(hostname)) {
    return false;
  }

  // Resolve and check returned IP
  try {
    const { address } = await require('dns').promises.lookup(hostname);
    if (isPrivateIp(address)) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}
```

**Checks:**
1. Valid URL format
2. HTTPS protocol
3. Bare IP not private
4. DNS resolution succeeds
5. Resolved IP not private

### Step 7b: Signature Creation
**File:** `webhook.js:44-46`
```javascript
function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}
```

**Result:** HMAC-SHA256 hex string

### Step 7c: HTTPS POST Request
**File:** `webhook.js:48-66`
```javascript
function httpsPost(url, body, signature) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-AfriPay-Signature': `sha256=${signature}`,
      },
    };
    const req = https.request(options, (res) => {
      res.resume();
      res.statusCode >= 200 && res.statusCode < 300 ? resolve(res.statusCode) : reject(new Error(`HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
```

**Headers Sent:**
```
Content-Type: application/json
Content-Length: <payload-size>
X-AfriPay-Signature: sha256=<hmac-hex>
```

**Body Sent:**
```json
{
  "event": "payment.sent",
  "data": {
    "id": "txId",
    "tx_hash": "transactionHash",
    "ledger": 12345,
    "amount": "100.00",
    "asset": "XLM",
    "sender": "public_key",
    "recipient": "recipient_address",
    "type": "payment"
  },
  "timestamp": "2024-05-30T12:34:56.789Z"
}
```

### Step 8: Webhook Receiver Verification
**Webhook Endpoint:** `https://your-domain.com/webhooks/payments`

**Verification Code (Node.js):**
```javascript
const crypto = require('crypto');

function verifySignature(req, secret) {
  const signature = req.headers['x-afripay-signature'];
  const body = JSON.stringify(req.body);
  
  const expectedSignature = 'sha256=' + 
    crypto.createHmac('sha256', secret)
      .update(body)
      .digest('hex');
  
  return signature === expectedSignature;
}

app.post('/webhooks/payments', (req, res) => {
  if (!verifySignature(req, process.env.WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { event, data, timestamp } = req.body;
  
  // Process webhook
  console.log(`Received ${event} at ${timestamp}`);
  console.log('Transaction:', data);
  
  res.json({ success: true });
});
```

### Step 9: Response Handling
**Success (HTTP 2xx):**
- Webhook delivery complete
- Logged as successful
- No retry

**Failure (HTTP 3xx/4xx/5xx):**
- Logged as failed
- Retry with exponential backoff
- Max 3 attempts

---

## Flow 2: Payment Failure

### Step 1: Validation Failure
**File:** `paymentController.js:221`
```javascript
if (kycStatus !== "verified" && estimatedUSD >= KYC_THRESHOLD_USD) {
  webhook.deliver("payment.failed", { 
    code: "KYC_REQUIRED", 
    error: "KYC verification required for transactions above $100 USD equivalent." 
  }).catch(() => {});
  
  return res.status(403).json({
    error: "KYC verification required for transactions above $100 USD equivalent.",
    kyc_status: kycStatus,
    code: "KYC_REQUIRED",
  });
}
```

### Step 2: Webhook Delivery Triggered
Same as successful flow, but with different event and payload:

**Event:** `payment.failed`

**Payload:**
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

### Step 3: Database Query
```sql
SELECT url, secret FROM webhooks 
WHERE active = true AND 'payment.failed' = ANY(events)
```

### Step 4: Delivery Process
Same as successful flow

---

## Flow 3: Retry Logic

### Attempt 1: Immediate
```javascript
await httpsPost(url, body, signature);
```

### Attempt 1 Fails
```javascript
catch (err) {
  if (attempt < MAX_ATTEMPTS - 1) {  // 0 < 2, true
    const delay = Math.pow(2, 0) * 1000;  // 1000ms
    logger.warn('Webhook delivery failed, retrying', {
      url,
      attempt: 1,
      maxAttempts: 3,
      delay: 1000,
      error: err.message,
    });
    await new Promise((r) => setTimeout(r, 1000));
    return deliverWithRetry(url, secret, payload, 1);
  }
}
```

### Attempt 2: After 1 second
```javascript
await httpsPost(url, body, signature);
```

### Attempt 2 Fails
```javascript
catch (err) {
  if (attempt < MAX_ATTEMPTS - 1) {  // 1 < 2, true
    const delay = Math.pow(2, 1) * 1000;  // 2000ms
    logger.warn('Webhook delivery failed, retrying', {
      url,
      attempt: 2,
      maxAttempts: 3,
      delay: 2000,
      error: err.message,
    });
    await new Promise((r) => setTimeout(r, 2000));
    return deliverWithRetry(url, secret, payload, 2);
  }
}
```

### Attempt 3: After 2 seconds
```javascript
await httpsPost(url, body, signature);
```

### Attempt 3 Fails
```javascript
catch (err) {
  if (attempt < MAX_ATTEMPTS - 1) {  // 2 < 2, false
    // No more retries
  }
  // All attempts exhausted
  logger.error('Webhook delivery permanently failed after max retries', {
    url,
    event: payload.event,
    attempts: 3,
    error: err.message,
  });
}
```

---

## Flow 4: Batch Payment

### Step 1: Batch Payment Processing
**File:** `paymentController.js:402-530`
```javascript
async function sendBatch(req, res, next) {
  // ... validation ...
  
  const results = await Promise.all(
    recipients.map(async (recipient) => {
      // ... send individual payment ...
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
    })
  );
}
```

### Step 2: Webhook Delivery
For each successful payment in batch:
- Trigger `payment.sent` webhook
- Trigger `payment.received` webhook
- Same delivery mechanism as single payment

---

## Flow 5: Path Payment

### Step 1: Path Payment Processing
**File:** `paymentController.js:635-730`
```javascript
async function sendPath(req, res, next) {
  // ... path finding and validation ...
  
  const { transactionHash, ledger } = await sendPathPayment({
    // ... parameters ...
  }, req.logger);
  
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
}
```

### Step 2: Webhook Delivery
Same mechanism as single payment

---

## Summary

### Key Points

1. **Trigger:** Payment success or failure
2. **Query:** Find active webhooks subscribed to event
3. **Payload:** Build event payload with data and timestamp
4. **Delivery:** Trigger `deliverWithRetry()` for each webhook
5. **Validation:** SSRF check before each delivery
6. **Signature:** HMAC-SHA256 in header
7. **Retry:** Exponential backoff (1s, 2s, 4s)
8. **Logging:** All attempts logged
9. **Non-blocking:** Fire-and-forget pattern

### Performance

- **Latency:** Immediate (non-blocking)
- **Throughput:** Parallel delivery
- **Reliability:** Retry logic with exponential backoff
- **Security:** SSRF protection and signature verification

### Error Handling

- **SSRF Failure:** Logged, not retried
- **Network Error:** Retried with backoff
- **HTTP Error:** Retried with backoff
- **Max Retries:** Logged for investigation
