# Scheduled Jobs

This directory contains scheduled background jobs for the AfriPay platform.

## Available Jobs

### checkClaimableBalanceExpiry.js
Checks for claimable balances that are expiring within 7 days and sends email notifications to both senders and recipients.

- **Schedule**: Daily at 9:00 AM
- **Purpose**: Notify users about upcoming claimable balance expiries (30-day expiration)
- **Actions**:
  - Queries pending claimable balance transactions
  - Calculates days until expiry
  - Sends email notifications to senders
  - Sends email notifications to registered recipients

## Scheduler

The job scheduler is initialized in `scheduler.js` and started when the server boots up in `index.js`.

To add a new scheduled job:

1. Create a new job file in this directory
2. Export an async function that performs the job
3. Add the job to `scheduler.js` with a cron schedule
4. Use node-cron syntax for scheduling: https://www.npmjs.com/package/node-cron

## Cron Schedule Examples

```
* * * * * - Every minute
0 * * * * - Every hour
0 9 * * * - Every day at 9:00 AM
0 0 * * 0 - Every Sunday at midnight
0 0 1 * * - First day of every month at midnight
```

## Deployment model & cross-instance locking (BE-221)

Every scheduled job is wrapped by `safeJob(name, fn, { lockTtlMs })` in
`src/scheduler.js`. Each tick it acquires the Redis lock `job:<name>`
(`SET NX EX`, renewed every TTL/3 while the job runs), so with N API replicas
each job body runs **once per tick**. Replicas that find the lock held skip
the tick (`job_runs_total{status="skipped_locked"}`).

If Redis is unreachable, jobs are skipped unless `ALLOW_UNLOCKED_JOBS=true`.
The default is `true` outside production and `false` when
`NODE_ENV=production`. Alternatively, run the scheduler in a single dedicated
worker deployment and keep it disabled on API replicas.

## Job metrics & alerts (BE-222)

`safeJob` exports at `/metrics`:

- `job_runs_total{job,status}` — `success` | `error` | `skipped_locked` | `skipped_no_lock`
- `job_duration_seconds{job}` — histogram
- `job_last_success_timestamp{job}` — gauge (unix seconds)
- `job_interval_seconds{job}` — approximate cron interval
- `job_items_processed_total{job}` — jobs call `ctx.itemsProcessed(n)`

Alert rules live in `monitoring/alerts.yml` (stale > 3× interval, errors for
15 min); the Grafana dashboard has a "Jobs" row. `/health/deep` reports
`degraded` when any job is stale; per-job details are shown when the request
carries `Authorization: Bearer $METRICS_TOKEN`.
