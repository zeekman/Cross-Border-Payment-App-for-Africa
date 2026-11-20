# Monitoring

`prometheus.yml` scrapes the API's `/metrics` endpoint, `alerts.yml` holds the
alert rules and `grafana-dashboard.json` is the dashboard. Start them with
`docker compose -f docker-compose.monitoring.yml up`.

## Ledger listener (BE-198)

The ledger listener (`backend/src/services/ledgerListener.js`) credits incoming
payments, sends "payment received" notifications and webhooks, and confirms
transactions. If its Horizon stream dies silently, those stop without any error.

### Metrics

| Metric | Type | Meaning |
|---|---|---|
| `ledger_listener_lag_ledgers` | gauge | Ledgers between the newest **payment** on Horizon and the newest payment the listener's stream has delivered. `0` means caught up. |
| `ledger_listener_last_event_timestamp_seconds` | gauge | Unix time of the listener's last proof of life. |

Lag is measured against the newest *payment*, not the newest ledger, because the
stream only carries payments. "No event for a minute" is normal on a quiet
network or at night; measured that way it reads `0`, so the alerts do not flap.
It only grows when Horizon has payments the stream has not delivered.

### Proof of life

The listener records proof of life (visible as `last_event_at`) when:

1. any Horizon stream (payments, effects, per-account transactions) delivers a message, or
2. a health poll (every `LEDGER_HEALTH_POLL_MS`, default 15 s, first poll at startup) finds the
   payments stream open and fully caught up with Horizon.

A poll that finds the stream behind, or fails to reach Horizon, is **not** proof of
life, so a dead stream stops refreshing `last_event_at` and the status degrades.

### `/health/deep`

`components.ledger_listener`:

| Field | Meaning |
|---|---|
| `status` | `healthy`, `degraded`, or `unknown` (listener not started yet) |
| `last_event_at` | ISO time of the last proof of life, `null` if none yet |
| `stale_ms` | Milliseconds since `last_event_at` |
| `last_ledger_sequence` | Highest ledger the listener has seen on any stream |
| `horizon_latest_ledger` | Latest ledger Horizon reported at the last poll |
| `lag_ledgers` | Same value as `ledger_listener_lag_ledgers` |

`degraded` once there has been no proof of life for `LEDGER_LISTENER_MAX_STALE_MS`
(default 90 000 ms, so a dead stream is flagged well inside 2 minutes), or if the
listener started and never produced any. A degraded listener makes the overall
status `degraded` (HTTP 200); it does not take the API out of rotation.

| Variable | Default | Effect |
|---|---|---|
| `LEDGER_LISTENER_MAX_STALE_MS` | `90000` | Time without proof of life before `degraded` |
| `LEDGER_HEALTH_POLL_MS` | `15000` | How often the listener compares its stream with Horizon |

### Alerts (`alerts.yml`)

| Alert | Fires when |
|---|---|
| `LedgerListenerLagging` | `ledger_listener_lag_ledgers > 12` for 2 minutes (about a minute of ledgers behind) |
| `LedgerListenerSilent` | no proof of life for over 120 s |

The dashboard has two matching panels: *Ledger Listener Lag* and *Ledger Listener
Seconds Since Last Proof of Life*.

## Webhook delivery queue (BE-217)

Deliveries run as durable BullMQ jobs (see `docs/webhook-delivery.md`).

| Metric | Type | Meaning |
|---|---|---|
| `afripay_webhook_queue_depth{state}` | gauge | Jobs by state: `waiting`, `active`, `delayed` (waiting for a retry), `failed`. Sampled every 15 s. |
| `afripay_webhook_deliveries_total{result}` | counter | Attempts by result: `delivered`, `retry` (failed, another attempt scheduled), `failed` (event out of attempts or not retryable), `skipped` (endpoint deleted or disabled since it was queued). |
| `afripay_webhook_endpoints_disabled_total` | counter | Endpoints disabled automatically after repeated failed events. |

Alerts (`alerts.yml`): `WebhookQueueBacklog` (more than 1000 jobs waiting for 10 minutes) and
`WebhookEndpointsAutoDisabled` (any endpoint disabled in the last hour). The dashboard has *Webhook
Queue Depth* and *Webhook Delivery Attempts* panels.
