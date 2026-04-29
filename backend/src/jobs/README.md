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
