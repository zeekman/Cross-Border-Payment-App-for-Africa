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

### ttlKeeperJob.js
Keeper job that bumps the TTL (time-to-live) of long-lived Soroban contract records so they are not archived by the Stellar network.

- **Schedule**: Every 6 hours (`0 */6 * * *`)
- **Purpose**: Prevent persistent/instance storage entries from being archived. On Stellar, entries whose TTL runs out get archived and any later call that reads them fails until a `RestoreFootprint` operation is submitted. This job proactively extends the TTL of records that are nearing expiry.
- **Targets**:
  - Active savings vaults with distant unlock times
  - Open escrows (created / funded / active)
  - KYC attestations that are still valid
  - Any other long-lived persistent records tracked by the platform
- **Actions**:
  - Queries the database for long-lived records (vaults, escrows, attestations) that are still active
  - Builds a `SorobanRpc` `ExtendFootprintTTLOp` (or `extendFootprintTtl` transaction) for the corresponding contract data ledger keys
  - Submits the extend-footprint operation via the configured Soroban RPC endpoint
  - Logs successes and failures; failures are retried on the next run
- **Configuration**:
  - `SOROBAN_RPC_URL` — Soroban RPC endpoint used to submit extend-footprint operations
  - `SOROBAN_NETWORK_PASSPHRASE` — network passphrase for signing
  - `KEEPER_SECRET_KEY` — secret key of the keeper account that pays for and signs the extend operations
  - `TTL_EXTEND_THRESHOLD_LEDGERS` / `TTL_EXTEND_AMOUNT_LEDGERS` — optional overrides for the extend threshold and target TTL (defaults mirror the contract constants: ~7-day threshold, ~30-day bump)

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
0 */6 * * * - Every 6 hours
0 9 * * * - Every day at 9:00 AM
0 0 * * 0 - Every Sunday at midnight
0 0 1 * * - First day of every month at midnight