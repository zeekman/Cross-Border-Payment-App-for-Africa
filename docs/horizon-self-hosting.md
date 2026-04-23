# Stellar Horizon Self-Hosting Guide

Running your own Horizon node eliminates dependency on SDF's public endpoints (which carry rate limits and no SLA), gives you full control over data retention, and lets you scale independently.

> **Note:** The `stellar/quickstart` image is convenient for development but is **not recommended for production**. This guide covers a production-grade setup using Horizon's "Captive Core" mode — the architecture SDF recommends.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Resource Requirements](#resource-requirements)
3. [Quick Start (Docker Compose)](#quick-start-docker-compose)
4. [Environment Variables](#environment-variables)
5. [Pointing AfriPay at Your Node](#pointing-afripay-at-your-node)
6. [Verifying the Node](#verifying-the-node)
7. [History Retention & Storage Management](#history-retention--storage-management)
8. [Upgrading](#upgrading)
9. [Further Reading](#further-reading)

---

## Architecture

Horizon uses **Captive Core** — it manages its own lightweight Stellar Core subprocess internally. You do **not** need to run a separate, standalone Stellar Core node.

```
┌─────────────────────────────────────┐
│  AfriPay Backend                    │
│  STELLAR_HORIZON_URL=http://horizon │
└──────────────┬──────────────────────┘
               │ HTTP
┌──────────────▼──────────────────────┐
│  Horizon (stellar/stellar-horizon)  │
│  + embedded Captive Core subprocess │
└──────────────┬──────────────────────┘
               │ PostgreSQL
┌──────────────▼──────────────────────┐
│  PostgreSQL 16                      │
└─────────────────────────────────────┘
```

---

## Resource Requirements

From the [official Horizon prerequisites](https://developers.stellar.org/docs/data/apis/horizon/admin-guide/prerequisites) (30-day retention window, pubnet):

| Component | CPU | RAM | Disk |
|---|---|---|---|
| Horizon API service | 4 vCPU | 16 GB | 100 GB SSD ≥ 3K IOPS |
| PostgreSQL database | 4 vCPU | 32 GB | 2 TB SSD (NVMe) ≥ 7K IOPS |

**AWS equivalents:** `c5d.xlarge` (Horizon) + `i4g.xlarge` (PostgreSQL)  
**GCP equivalents:** `n4-standard-4` (Horizon) + `c3-highmem-8` (PostgreSQL)

> Requirements grow with longer retention windows and network growth. For testnet, a single `t3.xlarge` (4 vCPU / 16 GB) with 500 GB SSD is sufficient.

---

## Quick Start (Docker Compose)

See [`docker-compose.horizon.yml`](../docker-compose.horizon.yml) in the project root.

```bash
# 1. Copy and fill in the environment file
cp .env.example .env
# Set HORIZON_NETWORK, HORIZON_DB_PASSWORD, etc. (see below)

# 2. Start Horizon + its dedicated PostgreSQL
docker compose -f docker-compose.horizon.yml up -d

# 3. Watch ingestion progress (initial catch-up takes hours on pubnet)
docker compose -f docker-compose.horizon.yml logs -f horizon
```

Horizon will be available at `http://localhost:8000` once ingestion reaches the current ledger.

---

## Environment Variables

Set these in your `.env` before starting the Compose stack:

| Variable | Example | Description |
|---|---|---|
| `HORIZON_NETWORK` | `testnet` | `testnet` or `pubnet` |
| `HORIZON_DB_PASSWORD` | `changeme` | Password for the Horizon PostgreSQL user |
| `HORIZON_HISTORY_RETENTION_COUNT` | `518400` | Ledgers to retain (~30 days = 518 400 ledgers) |
| `HORIZON_INGEST` | `true` | Enable ingestion on this instance |
| `HORIZON_PORT` | `8000` | Port Horizon listens on inside the container |

---

## Pointing AfriPay at Your Node

Once your Horizon node is running and caught up, update your AfriPay backend `.env`:

```env
# Replace the SDF public endpoint with your own node
STELLAR_HORIZON_URL=http://localhost:8000

# Optional: keep SDF as a fallback in case your node is temporarily unavailable
STELLAR_HORIZON_FALLBACK_URL=https://horizon-testnet.stellar.org
```

For production, put Horizon behind a reverse proxy (nginx/Caddy) with TLS and use `https://`:

```env
STELLAR_HORIZON_URL=https://horizon.yourdomain.com
STELLAR_HORIZON_FALLBACK_URL=https://horizon.stellar.org
```

No code changes are required — AfriPay reads these variables at startup.

---

## Verifying the Node

```bash
# Check Horizon is responding
curl http://localhost:8000

# Check ingestion is caught up (core_latest_ledger should match horizon_latest_ledger)
curl http://localhost:8000 | jq '{core_latest_ledger, horizon_latest_ledger, history_latest_ledger}'

# Run a test query
curl "http://localhost:8000/accounts/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"
```

---

## History Retention & Storage Management

Horizon stores all ingested ledger data in PostgreSQL. The `HORIZON_HISTORY_RETENTION_COUNT` variable controls how many ledgers are kept.

| Retention | Ledger count | Approx. disk (pubnet) |
|---|---|---|
| 7 days | ~120 960 | ~500 GB |
| 30 days | ~518 400 | ~2 TB |
| 90 days | ~1 555 200 | ~6 TB |

Horizon automatically reaps old ledgers during ingestion. No manual cleanup is needed.

---

## Upgrading

```bash
# Pull the latest image
docker compose -f docker-compose.horizon.yml pull horizon

# Restart with zero-downtime (run two instances behind a load balancer for HA)
docker compose -f docker-compose.horizon.yml up -d --no-deps horizon
```

Check the [Horizon releases page](https://github.com/stellar/stellar-horizon/releases) for breaking changes before upgrading.

---

## Further Reading

- [Horizon Admin Guide](https://developers.stellar.org/docs/data/apis/horizon/admin-guide/overview)
- [Horizon Prerequisites](https://developers.stellar.org/docs/data/apis/horizon/admin-guide/prerequisites)
- [Horizon Ingestion](https://developers.stellar.org/docs/data/apis/horizon/admin-guide/ingestion)
- [Horizon Scaling](https://developers.stellar.org/docs/data/apis/horizon/admin-guide/scaling)
- [stellar/stellar-horizon on GitHub](https://github.com/stellar/stellar-horizon)

*Content was rephrased for compliance with licensing restrictions.*
