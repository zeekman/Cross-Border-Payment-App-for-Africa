# Webhook Signatures

Every delivery includes these headers:

| Header | Description |
| --- | --- |
| `X-AfriPay-Event-Id` | Stable per event (also the payload `id`). Reused on retries — use it to de-duplicate. |
| `X-AfriPay-Delivery-Id` | Unique per delivery attempt. |
| `X-AfriPay-Timestamp` | Unix seconds when the attempt was signed. |
| `X-AfriPay-Signature-v2` | `t=<ts>,v1=<sig>[,v1=<sig_prev>]` where `sig = HMAC_SHA256(secret, "<ts>.<raw body>")` (hex). |
| `X-AfriPay-Signature-256` | **Deprecated.** `sha256=HMAC_SHA256(secret, body)`. Removed after one deprecation cycle. |

Requests time out after `WEBHOOK_TIMEOUT_MS` (default 10 s); slow receivers are recorded as `timeout` and retried.

## Verifying

1. Parse `t` and every `v1` from `X-AfriPay-Signature-v2`.
2. Reject if `|now - t| > 300` seconds (recommended tolerance).
3. Compute `HMAC_SHA256(secret, t + "." + rawBody)` and compare in constant time against any `v1`.
4. Ignore events whose `X-AfriPay-Event-Id` you have already processed.

### Node.js

```js
const crypto = require('crypto');

function verify(header, rawBody, secret, toleranceSec = 300) {
  let t; const sigs = [];
  header.split(',').forEach((p) => {
    const [k, v] = p.split('=');
    if (k === 't') t = parseInt(v, 10);
    if (k === 'v1') sigs.push(v);
  });
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return sigs.some((s) => {
    const b = Buffer.from(s, 'hex');
    return b.length === expected.length && crypto.timingSafeEqual(b, expected);
  });
}
```

The backend ships the same helper: `require('backend/src/utils/webhookSignature').verify(header, body, secrets, toleranceSec)`.

### Python

```python
import hmac, hashlib, time

def verify(header: str, raw_body: bytes, secret: str, tolerance_sec: int = 300) -> bool:
    t, sigs = None, []
    for part in header.split(','):
        k, _, v = part.partition('=')
        if k == 't':
            t = int(v)
        elif k == 'v1':
            sigs.append(v)
    if t is None or abs(time.time() - t) > tolerance_sec:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, s) for s in sigs)
```
