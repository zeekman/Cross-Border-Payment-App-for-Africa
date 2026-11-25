# Webhook Implementation Guide

## Quick Start

### 1. Register a Webhook

**Endpoint:** `POST /api/webhooks`

**Request:**
```bash
curl -X POST https://api.afripay.com/api/webhooks \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-domain.com/webhooks/payments",
    "events": ["payment.sent", "payment.received", "payment.failed"]
  }'
```

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "url": "https://your-domain.com/webhooks/payments",
  "events": ["payment.sent", "payment.received", "payment.failed"],
  "active": true,
  "created_at": "2024-05-30T12:34:56.789Z",
  "secret": "whsec_1234567890abcdef..."
}
```

**Important:** Save the `secret` - you'll need it to verify webhook signatures.

### 2. List Your Webhooks

**Endpoint:** `GET /api/webhooks`

**Request:**
```bash
curl https://api.afripay.com/api/webhooks \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "webhooks": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "url": "https://your-domain.com/webhooks/payments",
      "events": ["payment.sent", "payment.received", "payment.failed"],
      "active": true,
      "created_at": "2024-05-30T12:34:56.789Z"
    }
  ]
}
```

### 3. Receive Webhook Events

**Webhook Endpoint:** Your registered URL

**Headers:**
```
Content-Type: application/json
X-AfriPay-Signature: sha256=<hmac-sha256-hex>
```

**Payload:**
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

### 4. Verify Webhook Signature

**Node.js Example:**
```javascript
const crypto = require('crypto');

function verifyWebhookSignature(req, secret) {
  const signature = req.headers['x-afripay-signature'];
  const body = JSON.stringify(req.body);
  
  const expectedSignature = 'sha256=' + 
    crypto.createHmac('sha256', secret)
      .update(body)
      .digest('hex');
  
  return signature === expectedSignature;
}

// In your webhook handler
app.post('/webhooks/payments', (req, res) => {
  if (!verifyWebhookSignature(req, process.env.WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  const { event, data, timestamp } = req.body;
  
  switch (event) {
    case 'payment.sent':
      handlePaymentSent(data);
      break;
    case 'payment.received':
      handlePaymentReceived(data);
      break;
    case 'payment.failed':
      handlePaymentFailed(data);
      break;
  }
  
  res.json({ success: true });
});
```

**Python Example:**
```python
import hmac
import hashlib
import json

def verify_webhook_signature(request, secret):
    signature = request.headers.get('X-AfriPay-Signature', '')
    body = request.get_data(as_text=True)
    
    expected_signature = 'sha256=' + hmac.new(
        secret.encode(),
        body.encode(),
        hashlib.sha256
    ).hexdigest()
    
    return hmac.compare_digest(signature, expected_signature)

@app.route('/webhooks/payments', methods=['POST'])
def handle_webhook():
    if not verify_webhook_signature(request, os.environ['WEBHOOK_SECRET']):
        return {'error': 'Invalid signature'}, 401
    
    data = request.get_json()
    event = data['event']
    
    if event == 'payment.sent':
        handle_payment_sent(data['data'])
    elif event == 'payment.received':
        handle_payment_received(data['data'])
    elif event == 'payment.failed':
        handle_payment_failed(data['data'])
    
    return {'success': True}
```

---

## Event Types

### payment.sent

**Triggered:** When a payment is successfully broadcast to the Stellar network

**Payload:**
```json
{
  "event": "payment.sent",
  "data": {
    "id": "transaction-uuid",
    "tx_hash": "stellar-transaction-hash",
    "ledger": 12345,
    "amount": "100.00",
    "asset": "XLM",
    "sender": "sender-public-key",
    "recipient": "recipient-public-key",
    "type": "payment|claimable_balance"
  },
  "timestamp": "2024-05-30T12:34:56.789Z"
}
```

**Use Cases:**
- Update your database with transaction details
- Send confirmation email to sender
- Update UI with transaction status
- Trigger downstream processes

### payment.received

**Triggered:** When a payment is successfully broadcast (for non-claimable balances)

**Payload:** Same as payment.sent

**Use Cases:**
- Notify recipient of incoming payment
- Update recipient's balance
- Send notification email
- Trigger fulfillment process

**Note:** Not triggered for claimable_balance type (recipient hasn't claimed yet)

### payment.failed

**Triggered:** When a payment fails at any stage

**Payload Examples:**

KYC Required:
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

Fraud Blocked:
```json
{
  "event": "payment.failed",
  "data": {
    "code": "FRAUD_BLOCKED",
    "error": "Transaction limit reached. Please wait before sending again."
  },
  "timestamp": "2024-05-30T12:34:56.789Z"
}
```

Transaction Failed:
```json
{
  "event": "payment.failed",
  "data": {
    "error": "Transaction failed",
    "details": { /* Stellar error details */ }
  },
  "timestamp": "2024-05-30T12:34:56.789Z"
}
```

**Use Cases:**
- Log failed transactions
- Alert user of payment failure
- Retry logic
- Fraud investigation

---

## Webhook Delivery Guarantees

### Delivery Attempts
- **Max Attempts:** 3
- **Backoff:** Exponential (1s, 2s, 4s)
- **Timeout:** Network timeout per attempt

### Failure Scenarios
- Network error → Retried
- HTTP 3xx/4xx/5xx → Retried
- SSRF validation failure → Logged, not retried
- Max retries exceeded → Logged for investigation

### Best Practices
1. **Idempotency:** Handle duplicate webhooks gracefully
2. **Timeouts:** Respond within 30 seconds
3. **Logging:** Log all webhook events
4. **Verification:** Always verify signatures
5. **Monitoring:** Alert on webhook failures

---

## Security

### Signature Verification

Every webhook includes an `X-AfriPay-Signature` header with HMAC-SHA256 signature.

**Format:** `sha256=<hex-encoded-hmac>`

**Verification:**
```javascript
const crypto = require('crypto');
const signature = req.headers['x-afripay-signature'];
const body = JSON.stringify(req.body);
const secret = 'your-webhook-secret';

const expectedSignature = 'sha256=' + 
  crypto.createHmac('sha256', secret)
    .update(body)
    .digest('hex');

const isValid = signature === expectedSignature;
```

### URL Requirements

- **Protocol:** HTTPS only (HTTP rejected)
- **Public:** Must be publicly accessible
- **No Private IPs:** RFC-1918 ranges blocked
- **No Loopback:** 127.0.0.0/8 blocked
- **No Metadata:** Cloud metadata endpoints blocked

### Webhook Secret

- Stored securely in database
- Never transmitted in webhook payload
- Use for signature verification only
- Treat like a password

---

## Troubleshooting

### Webhook Not Received

1. **Check URL:** Ensure HTTPS and publicly accessible
2. **Check Firewall:** Allow inbound HTTPS traffic
3. **Check Logs:** Look for delivery errors
4. **Check Signature:** Verify signature verification logic
5. **Check Events:** Ensure webhook subscribed to event

### Signature Verification Failing

1. **Check Secret:** Ensure using correct secret
2. **Check Body:** Ensure using raw request body
3. **Check Encoding:** Ensure hex encoding
4. **Check Format:** Ensure `sha256=` prefix

### Webhook Delivery Slow

1. **Check Response Time:** Respond within 30 seconds
2. **Check Network:** Ensure stable connection
3. **Check Logs:** Look for retry attempts
4. **Check Backoff:** Exponential backoff may delay delivery

---

## Monitoring

### Webhook Health

Monitor these metrics:
- Delivery success rate
- Average delivery time
- Retry rate
- Signature verification failures
- SSRF validation failures

### Logging

Log these events:
- Webhook received
- Signature verified
- Event processed
- Errors encountered

### Alerts

Set up alerts for:
- Delivery failures
- Signature verification failures
- Response timeouts
- High retry rates

---

## Examples

### Node.js Express

```javascript
const express = require('express');
const crypto = require('crypto');
const app = express();

app.use(express.json());

function verifySignature(req, secret) {
  const signature = req.headers['x-afripay-signature'];
  const body = JSON.stringify(req.body);
  const expected = 'sha256=' + 
    crypto.createHmac('sha256', secret)
      .update(body)
      .digest('hex');
  return signature === expected;
}

app.post('/webhooks/payments', (req, res) => {
  if (!verifySignature(req, process.env.WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { event, data } = req.body;

  switch (event) {
    case 'payment.sent':
      console.log('Payment sent:', data);
      break;
    case 'payment.received':
      console.log('Payment received:', data);
      break;
    case 'payment.failed':
      console.log('Payment failed:', data);
      break;
  }

  res.json({ success: true });
});

app.listen(3000);
```

### Python Flask

```python
import hmac
import hashlib
import json
from flask import Flask, request

app = Flask(__name__)

def verify_signature(request, secret):
    signature = request.headers.get('X-AfriPay-Signature', '')
    body = request.get_data(as_text=True)
    expected = 'sha256=' + hmac.new(
        secret.encode(),
        body.encode(),
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)

@app.route('/webhooks/payments', methods=['POST'])
def handle_webhook():
    if not verify_signature(request, os.environ['WEBHOOK_SECRET']):
        return {'error': 'Invalid signature'}, 401

    data = request.get_json()
    event = data['event']

    if event == 'payment.sent':
        print('Payment sent:', data['data'])
    elif event == 'payment.received':
        print('Payment received:', data['data'])
    elif event == 'payment.failed':
        print('Payment failed:', data['data'])

    return {'success': True}

if __name__ == '__main__':
    app.run(port=3000)
```

---

## API Reference

### POST /api/webhooks

Create a webhook

**Request:**
```json
{
  "url": "https://your-domain.com/webhooks/payments",
  "events": ["payment.sent", "payment.received", "payment.failed"]
}
```

**Response:** 201 Created
```json
{
  "id": "webhook-uuid",
  "url": "https://your-domain.com/webhooks/payments",
  "events": ["payment.sent", "payment.received", "payment.failed"],
  "active": true,
  "created_at": "2024-05-30T12:34:56.789Z",
  "secret": "whsec_..."
}
```

### GET /api/webhooks

List your webhooks

**Response:** 200 OK
```json
{
  "webhooks": [
    {
      "id": "webhook-uuid",
      "url": "https://your-domain.com/webhooks/payments",
      "events": ["payment.sent", "payment.received", "payment.failed"],
      "active": true,
      "created_at": "2024-05-30T12:34:56.789Z"
    }
  ]
}
```

---

## Support

For issues or questions:
- Check the troubleshooting section
- Review webhook logs
- Contact support@afripay.com
