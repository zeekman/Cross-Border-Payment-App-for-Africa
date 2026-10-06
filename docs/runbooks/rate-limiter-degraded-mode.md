# Runbook: Rate limiter degraded to in-memory fallback

Relates to issue #952 (BE-005). Component: `backend/src/middleware/rateLimiter.js`.

## What "degraded" means

`authLimiter`, `paymentLimiter`, `readLimiter`, and `adminLimiter` are backed
by a shared Redis store (`RedisStore` in `rateLimiter.js`) so that a limit
like "5 auth attempts/min" is enforced across all backend instances behind
the load balancer. If Redis is unreachable (or `REDIS_URL` isn't set),
`RedisStore.increment()` returns `null` and express-rate-limit silently
falls back to its **default in-memory store**.

## Blast radius

The in-memory fallback is **per process**, not shared. With N backend
instances behind the load balancer, the effective limit becomes
`configured_max * N` for as long as Redis is unreachable, because each
instance counts requests independently and has no visibility into what the
others have seen.

This matters most exactly when it's most dangerous:

- **`authLimiter`** (5 req/min/IP): a credential-stuffing or brute-force run
  against login/registration gets up to Nx the intended attempt budget per
  IP.
- **`paymentLimiter`** (10 req/min/user): abuse or a runaway client retry
  loop can submit up to Nx payments/min per user before the shared limit
  would have started returning 429s.
- **`readLimiter`** / **`adminLimiter`**: lower severity, but the same
  multiplication applies.

The limiter does not stop working — it fails *open* to a weaker limit, not
closed. No requests are rejected differently than normal; the only observable
difference during an incident is that abusive traffic gets further before
being throttled.

## How you'll know

- **Logs**: `logger.warn` fires once when a limiter prefix (`auth`,
  `payment`, `read`, `admin`) transitions into degraded mode
  (`"Rate limiter degraded: falling back to per-process in-memory limiting"`),
  and again every 5 minutes while it remains degraded
  (`"Rate limiter still degraded: ..."`). A `"Rate limiter recovered: ..."`
  warning fires once Redis calls succeed again.
- **Metrics** (`backend/src/utils/metrics.js`, scraped via the Prometheus
  registry):
  - `afripay_rate_limiter_degraded{prefix="auth|payment|read|admin"}` — 1
    while that limiter is on the in-memory fallback, 0 when healthy. Alert on
    this being 1 for more than a few minutes.
  - `afripay_rate_limiter_redis_failures_total{prefix,reason}` — counter of
    Redis failures (`reason="redis_error"`) or missing configuration
    (`reason="no_redis_configured"`).
- **Health check**: `GET` the deep health endpoint backed by
  `runDeepHealthChecks()` in `backend/src/services/health.js` —
  `components.rate_limiter.backends` reports `"redis"` or
  `"memory-fallback"` per prefix; `components.rate_limiter.status` is
  `"degraded"` if any prefix is on the fallback. This is a non-critical
  (not `unhealthy`) contributor to overall health status.

## What to do

1. Confirm it's real: check `afripay_rate_limiter_degraded` and the deep
   health endpoint agree, and look for the Redis connection error in logs.
2. Treat the underlying Redis outage/connectivity issue as the incident —
   the rate limiter alerting here is a symptom detector, not the root cause.
   Follow the Redis incident process to restore connectivity
   (`REDIS_URL`, network path, Redis instance health).
3. While degraded, if you're also seeing abuse traffic (credential
   stuffing, payment retries), consider a temporary compensating control at
   the load balancer / WAF layer (e.g. a stricter per-IP connection limit)
   until Redis is back, since the app-level limiter is weaker than normal.
4. No manual recovery step is needed once Redis is reachable again — the
   next successful `increment()` call on each limiter prefix clears the
   degraded state, resets the metric to 0, and logs a recovery message.
