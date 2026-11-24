# Webhook delivery

Webhook events are delivered by a durable queue (BE-217). A receiver that is down
for hours, or an API restart in the middle of a retry window, no longer loses events.

## How it works

1. A payment (or other) event calls `deliver(event, userId, data)`. It finds the
   **event owner's** active webhooks subscribed to that event.
2. For each one it enqueues a single BullMQ job (`webhook-delivery` queue). The job
   holds only the webhook id and the event payload.
3. A worker loads the webhook, including its secret, **from the database at send
   time**, then signs and POSTs the payload. Secrets are never stored in the queue
   or held in memory between retries.
4. A failed attempt is retried after the next delay in the schedule. Retries live in
   Redis, so they survive an API restart.
5. When an event runs out of attempts it is marked `failed`, the owner is notified, and
   the failure counts toward the endpoint's auto-disable threshold.

Each attempt writes a row to `webhook_deliveries` (`attempt` and `max_attempts` show
where a delivery got to). Delivering a payload is unchanged: the same JSON body, the
same `X-AfriPay-Signature-256` header, the same SSRF checks and redirect blocking.

## Retry schedule

The first attempt is immediate. Each later attempt follows the next delay:

| Attempt | Delay before it | Cumulative |
|---|---|---|
| 1 | immediate | 0 |
| 2 | 10 s | 10 s |
| 3 | 1 m | 1 m 10 s |
| 4 | 5 m | 6 m 10 s |
| 5 | 30 m | 36 m 10 s |
| 6 | 2 h | 2 h 36 m |
| 7 | 6 h | 8 h 36 m |
| 8 | 12 h | 20 h 36 m |
| 9 | 24 h | 44 h 36 m |

That is 9 attempts (the first try plus 8 retries) over about 45 hours.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WEBHOOK_RETRY_SCHEDULE` | `10s,1m,5m,30m,2h,6h,12h,24h` | Delay before each retry. Comma separated; each entry is a number plus `s`, `m`, `h` or `d`. N entries means N+1 attempts. At most 20 entries. |
| `WEBHOOK_MAX_CONSECUTIVE_FAILURES` | `5` | Failed events in a row before the endpoint is disabled. |
| `WEBHOOK_WORKER_CONCURRENCY` | `5` | Deliveries one API process sends in parallel. |
| `WEBHOOK_QUEUE_NAME` | `webhook-delivery` | Queue name, to separate environments that share one Redis. |

A malformed `WEBHOOK_RETRY_SCHEDULE` (a bad token, an empty entry, too many entries)
falls back to the default and logs a warning, rather than silently shortening the
retry window. Invalid counts fall back to their defaults.

## Permanent failure and auto-disable

- **Permanent failure.** After the last attempt, the delivery is marked `failed`
  and the owner gets an in-app notification (`webhook_delivery_failed`) and an email
  naming the event and the endpoint's host. The URL itself is never included, since it
  may carry a token. The failed delivery can be retried by hand from the delivery log
  (`POST /api/webhooks/deliveries/:id/retry`), which enqueues a fresh job.
- **Not retried at all.** A URL that fails SSRF validation (for example one that now
  resolves to a private address) cannot be fixed by retrying, so it fails immediately.
- **Auto-disable.** Each permanently failed *event* increments the endpoint's
  `consecutive_failures`; any successful delivery resets it to 0. At
  `WEBHOOK_MAX_CONSECUTIVE_FAILURES` the endpoint is set `active = false` with
  `disabled_at` and `disabled_reason`, and the owner is notified
  (`webhook_endpoint_disabled`). Jobs for a disabled endpoint that are still queued
  are dropped when they come up.
- **Re-enabling.** `PUT /api/webhooks/:id` with `{ "active": true }` re-enables the
  endpoint and clears `consecutive_failures`, `disabled_at` and `disabled_reason`.
  The list endpoint shows all three.

## Without Redis

If `REDIS_URL` is not set the queue is disabled and the API logs a warning. Deliveries
then use the legacy in-process retries: 3 attempts over about 3 seconds, lost on
restart. The same fallback applies to a single event whose enqueue fails because Redis
is unreachable at that moment, so the event is sent in-process rather than dropped.
Run Redis in production.

## Operating it

- **Metrics:** `afripay_webhook_queue_depth{state}`, `afripay_webhook_deliveries_total{result}`
  and `afripay_webhook_endpoints_disabled_total` (see `monitoring/README.md`), with alerts
  in `monitoring/alerts.yml`.
- **Restart safety:** on shutdown the worker is drained before the database pool closes.
  A job that was mid-attempt when the process died is picked up again by BullMQ's stalled-job recovery (within its stalled-job limit), so it may be sent more than once; receivers should treat deliveries as at-least-once and de-duplicate on the event payload.
- **Rollback:** unset `REDIS_URL` to return to in-process delivery. The new
  `webhooks` columns are additive and can stay.

## Database

Migration `20261120000000_webhook_durable_delivery.js` adds `consecutive_failures`
(`int`, default 0), `disabled_at` and `disabled_reason` to `webhooks`.

## Delivery contract fix

`deliver(event, userId, data)` takes the event owner's id and delivers only to that
user's webhooks. A merge had left the implementation as `deliver(event, data)`, which
referenced an undefined `userId` and threw on every call; callers' `.catch(() => {})`
hid it, so no webhook was being delivered at all.
