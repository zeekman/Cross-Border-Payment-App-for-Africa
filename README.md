# AfriPay — Cross-Border Payment App for Africa

A production-ready cross-border remittance platform built on the **Stellar Network**, enabling fast, secure, and low-cost payments across African countries using USDC stablecoin and XLM.

AfriPay connects senders with registered payout agents who handle local fiat distribution, with the Stellar blockchain managing escrow, fee collection, and settlement. Designed for emerging markets where stablecoin remittance rails can significantly reduce cross-border payment costs.

---

## Overview

AfriPay implements an escrow-based remittance flow on Stellar:

1. A sender creates a remittance by depositing USDC/XLM into escrow via the Stellar network.
2. A registered payout agent handles fiat distribution to the recipient off-chain.
3. The agent confirms payout on-chain via the backend.
4. The platform releases funds to the agent minus a configurable platform fee.
5. Platform fees accumulate and are managed by the admin.

The system is transparent, auditable on Stellar Explorer, and modular enough to extend with Soroban smart contracts.

---

## Key Features

- **Escrow-Based Transfers** — Secure USDC/XLM deposits held until payout confirmation
- **Agent Network** — Registered agents handle fiat distribution off-chain
- **Automated Fee Collection** — Platform fees calculated and accumulated automatically
- **Multi-Status Tracking** — Remittances tracked through Pending, Completed, and Cancelled states
- **Authorization Security** — JWT-based role access control for all operations
- **QR Payment Generator** — Shareable QR codes for wallet addresses
- **Contact List** — Save frequent recipients for quick transfers
- **Fraud Protection** — Rate limiting and transaction velocity checks
- **Event Logging** — All transactions stored in PostgreSQL and linked to Stellar Explorer
- **Cancellation Support** — Senders can cancel pending remittances
- **Multi-Currency UI** — Display estimated values in NGN, GHS, KES, USD

---

## Architecture

### Stack

| Layer      | Technology                          |
|------------|-------------------------------------|
| Frontend   | React 18, Tailwind CSS              |
| Backend    | Node.js, Express.js                 |
| Blockchain | Stellar SDK, Horizon API            |
| Database   | PostgreSQL                          |
| Auth       | JWT + bcrypt                        |
| Network    | Stellar Testnet / Mainnet           |

### Project Structure

```
├── backend/
│   ├── src/
│   │   ├── controllers/
│   │   │   ├── authController.js       # Register, login, JWT issuance
│   │   │   ├── walletController.js     # Balance, QR code, transactions
│   │   │   ├── paymentController.js    # Send payments, history, fraud check
│   │   │   └── contactsController.js  # Frequent contacts CRUD
│   │   ├── middleware/
│   │   │   └── auth.js                 # JWT verification middleware
│   │   ├── routes/
│   │   │   ├── auth.js
│   │   │   ├── wallet.js
│   │   │   └── payments.js
│   │   ├── services/
│   │   │   └── stellar.js              # Wallet generation, signing, broadcasting
│   │   ├── db.js                       # PostgreSQL connection pool
│   │   └── index.js                    # Express app entry point
│   ├── .env.example
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Welcome.jsx             # Onboarding screen
│   │   │   ├── Register.jsx            # Sign up + wallet creation
│   │   │   ├── Login.jsx               # Authentication
│   │   │   ├── Dashboard.jsx           # Balance, recent activity, currency toggle
│   │   │   ├── SendMoney.jsx           # Send with two-step confirmation
│   │   │   ├── ReceiveMoney.jsx        # QR code + address sharing
│   │   │   ├── TransactionHistory.jsx  # Full history with filters
│   │   │   └── Profile.jsx             # User info + contacts management
│   │   ├── components/
│   │   │   └── Layout.jsx              # Mobile bottom nav shell
│   │   ├── context/
│   │   │   └── AuthContext.jsx         # Global auth state
│   │   └── utils/
│   │       ├── api.js                  # Axios instance with JWT interceptor
│   │       └── currency.js             # XLM conversion rates + formatters
│   ├── .env.example
│   └── package.json
├── contracts/
│   ├── escrow/                         # Soroban smart contract (Rust/WASM)
│   │   ├── src/
│   │   │   └── lib.rs                  # Escrow contract implementation
│   │   ├── Cargo.toml
│   │   └── README.md                   # Contract ABI & documentation
│   ├── README.md                       # Contracts directory guide
│   ├── deploy.sh                       # Deployment script for all contracts
│   └── .gitignore
└── database/
    └── schema.sql                      # PostgreSQL tables + indexes
```

### Storage Model

**PostgreSQL Tables:**
- `users` — Account credentials and profile
- `wallets` — Stellar public key + AES-256 encrypted secret key
- `transactions` — All remittance records with status tracking
- `contacts` — Saved frequent recipients per user

### Fee Model

Platform fees are calculated using basis points (bps):

```
fee = amount * fee_bps / 10000

Examples:
  250 bps = 2.5%
  500 bps = 5.0%
```

---

## Stellar Protocol Compatibility

AfriPay targets **Stellar Protocol 19+**. Note that the inflation operation was removed in **Protocol 12 (2019)** and is not used anywhere in this codebase. No `setOptions` calls set an `inflationDest`. Any SDK examples referencing inflation are outdated and should be ignored.

---

## Compliance — Asset Clawback

For regulatory compliance (fraud investigations, court orders), AfriPay supports the Stellar **clawback** operation on USDC assets. This allows the asset issuer to reclaim tokens from a user's account when legally required.

- Endpoint: `POST /api/admin/clawback` (admin-only)
- Requires the issuer account to have `AUTH_CLAWBACK_ENABLED_FLAG` set on-chain
- All clawback operations are recorded in the audit log with reason, amount, and transaction hash
- Configure `ISSUER_PUBLIC_KEY` and `ISSUER_ENCRYPTED_SECRET_KEY` in your `.env`

---

### Wallet Generation

On registration, a Stellar keypair is automatically generated:
- Public key stored in the database
- Secret key encrypted with AES-256-CBC before storage
- Account funded via Friendbot on testnet

### Transaction Flow

```
Sender → [approve USDC transfer] → Backend → [sign with keypair]
       → Stellar Horizon API → [broadcast transaction]
       → Transaction hash stored in DB
       → Visible on Stellar Expert Explorer
```

### Supported Assets

- `XLM` — Native Stellar Lumens
- `USDC` — USD Coin on Stellar
- Display conversion: NGN, GHS, KES, USD

---


- A Stellar testnet account (auto-created on registration)

### 1. Database
```bash
psql -U postgres -c "CREATE DATABASE cbpa_db;"
```

Then run migrations (see Database Migrations below).

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env
# Fill in your values (see Environment Variables below)
npm run dev
# Server starts on http://localhost:5000
```

### 2. Docker Compose (Recommended)

1. Copy `.env.example` to `.env` and customize:
   ```
   cp .env.example .env
   ```

2. Start full stack:
   ```
   docker compose up -d --build
   ```

3. Access:
   - Frontend: http://localhost:3000
   - Backend API: http://localhost

AfriPay uses [node-pg-migrate](https://github.com/salsita/node-pg-migrate) for schema version control. All schema changes must be made as numbered migration files inside `database/migrations/` — never by editing `schema.sql` directly.

### Run migrations
```bash
cd backend
npm run migrate
```

### Roll back the last migration
```bash
cd backend
npm run migrate:rollback
```

### Adding a new migration

Create a new file in `database/migrations/` following the naming convention:
```
002_your_migration_name.js
```

Each file must export an `up` and a `down` function:
```js
exports.up = (pgm) => {
  // forward changes
};

exports.down = (pgm) => {
  // reverse changes
};
```

node-pg-migrate tracks applied migrations in a `pgmigrations` table that it creates automatically. Never delete or edit this table manually.

---

## API Endpoints

| Method | Endpoint                  | Auth | Description                        |
|--------|---------------------------|------|------------------------------------|
| POST   | /api/auth/register        | No   | Register user + auto-create wallet |
| POST   | /api/auth/login           | No   | Login, receive JWT                 |
| GET    | /api/auth/me              | Yes  | Get current user profile           |
| GET    | /api/wallet/balance       | Yes  | Get wallet address + balances      |
| GET    | /api/wallet/qr            | Yes  | Generate QR code for address       |
| GET    | /api/wallet/contacts      | Yes  | List saved contacts                |
| POST   | /api/wallet/contacts      | Yes  | Add a contact                      |
| DELETE | /api/wallet/contacts/:id  | Yes  | Remove a contact                   |
| POST   | /api/payments/send        | Yes  | Broadcast payment to Stellar       |
| GET    | /api/payments/history     | Yes  | Full transaction history           |
| POST   | /api/wallet/merge         | Yes  | Merge (close) account into another |
| POST   | /api/support/tickets      | Yes  | Create a support/dispute ticket    |
| GET    | /api/support/tickets      | Yes  | List user's support tickets        |
| POST   | /api/admin/clawback       | Admin| Clawback asset for compliance      |
| GET    | /api/admin/health         | Admin| Full service health diagnostics    |
| POST   | /api/escrow/create        | Yes  | Create agent escrow (approved agents only) |
| POST   | /api/escrow/:id/confirm   | Yes  | Agent confirms payout              |
| POST   | /api/escrow/:id/cancel    | Yes  | Sender cancels escrow              |

---

## Agent Registration and Approval

AfriPay uses a registered agent network for fiat distribution. Only **approved** agents may be used as the `agent_wallet` parameter in `POST /api/escrow/create`.

### Agent Lifecycle

```
1. Agent applies → POST /api/auth/register (creates a user account)
2. Agent submits their Stellar wallet address for approval
3. Admin reviews and approves → INSERT INTO agents (wallet_address, status='approved')
4. Agent is now eligible to receive escrow assignments
5. Admin may suspend an agent by setting status='suspended'
```

### agents Table

| Column           | Type        | Description                              |
|------------------|-------------|------------------------------------------|
| id               | uuid        | Primary key                              |
| user_id          | uuid        | FK to users table                        |
| wallet_address   | text        | Agent's Stellar public key (unique)      |
| status           | varchar(20) | `pending` / `approved` / `suspended`     |
| country          | varchar(10) | ISO country code (optional)              |
| created_at       | timestamptz | Registration timestamp                   |
| approved_at      | timestamptz | Admin approval timestamp                 |

### Validation

`POST /api/escrow/create` checks the `agents` table before creating any on-chain escrow:

- If `agent_wallet` is not found with `status = 'approved'`, the request is rejected with HTTP 400:
  ```json
  { "error": "Agent is not registered in the AfriPay network" }
  ```
- Only after a successful agent lookup does the backend proceed to sign and broadcast the Soroban escrow transaction.

---

## Environment Variables

```env
PORT=5000
NODE_ENV=development

# PostgreSQL
DATABASE_URL=postgresql://user:password@localhost:5432/cbpa_db

# JWT
JWT_SECRET=your_super_secret_jwt_key_here
JWT_EXPIRES_IN=7d

# Stellar Network
# Use 'testnet' for development, 'mainnet' for production
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org

# AES-256 encryption key for private key storage (must be exactly 32 characters)
ENCRYPTION_KEY=your_32_character_encryption_key_

# Cache Configuration
# Balance cache TTL in seconds (default: 30)
# Time-To-Live for cached wallet balance data. Lower values ensure fresher data but increase load on Horizon.
# Higher values reduce load but may show stale balances after recent transactions.
# Cache is automatically invalidated after send, sendBatch, and sendPath operations.
BALANCE_CACHE_TTL_SECONDS=30

# CORS
FRONTEND_URL=http://localhost:3000
```

> For mainnet: set `STELLAR_NETWORK=mainnet` and `STELLAR_HORIZON_URL=https://horizon.stellar.org`

---

## Security

- Passwords hashed with bcrypt (cost factor 12)
- Stellar private keys encrypted with AES-256-CBC before DB storage — never stored in plaintext
- JWT authentication required on all protected routes
- Rate limiting: 100 req/15min globally, 10 req/15min on auth endpoints
- Fraud protection: blocks wallets exceeding 5 transactions in 10 minutes
- Input validation on all endpoints via `express-validator`
- CORS restricted to configured frontend origin

---

## Performance & Caching

**Balance Caching with Redis**

Wallet balances are cached in Redis to reduce load on the Stellar Horizon API. The cache behavior is configurable:

- **Configurable TTL**: Set `BALANCE_CACHE_TTL_SECONDS` in your environment (default: 30 seconds)
- **Automatic Invalidation**: Cache is cleared immediately after:
  - Standard payments (`POST /api/payments`)
  - Batch payments (`POST /api/payments/batch`)
  - Path payments (`POST /api/payments/send-path`)
- **Fallback Behavior**: If Redis is not configured, balances are fetched live from Horizon on every request
- **Stale Balance Risk**: In production, ensure the TTL is low enough (15-30 seconds recommended) to prevent users from seeing significantly stale balances after receiving payments

To adjust the cache TTL in production, update the `BALANCE_CACHE_TTL_SECONDS` environment variable without restarting (if using a process manager with hot-reload support).

---

## Transaction Status Tracking

| Status    | Description                                      |
|-----------|--------------------------------------------------|
| pending   | Remittance created, awaiting agent confirmation  |
| completed | Payout confirmed, funds released                 |
| cancelled | Cancelled by sender, full refund issued          |

---

## Error Handling

| Scenario                        | HTTP Code | Response                          |
|---------------------------------|-----------|-----------------------------------|
| Invalid credentials             | 401       | Invalid email or password         |
| Expired/missing JWT             | 401       | Invalid or expired token          |
| Duplicate email                 | 409       | Email already registered          |
| Invalid amount                  | 400       | Amount must be greater than 0     |
| Transaction velocity exceeded   | 429       | Transaction limit reached         |
| Stellar broadcast failure       | 400       | Transaction failed + extras       |

---

## Testing on Testnet

1. Register an account — a Stellar testnet wallet is auto-funded via Friendbot
2. Copy your wallet address from the Dashboard
3. Use [Stellar Laboratory](https://laboratory.stellar.org) to send test XLM to your address
4. Send a payment to another testnet address
5. View the transaction on [Stellar Expert (Testnet)](https://stellar.expert/explorer/testnet)

---

## Roadmap

- [x] Soroban smart contract escrow (Rust/WASM on Stellar) — [contracts/escrow/](https://github.com/kay-ai/Cross-Border-Payment-App-for-Africa/tree/main/contracts/escrow)
  - Trustless three-party escrow model
  - Automated fee calculation and collection
  - Full event logging for transparency
  - Comprehensive test coverage
- [ ] Multi-currency USDC support with on-chain fee deduction
- [ ] Agent registration and payout confirmation system
- [ ] Batch remittance processing
- [ ] Agent reputation system
- [ ] Dispute resolution mechanism
- [ ] Time-locked escrow options (auto-refund after 30 days)
- [ ] Push notifications for transaction events
- [ ] Integration with fiat on/off ramps (M-Pesa, Flutterwave, Paystack)
- [ ] Mobile app (React Native)

---

## Contributing

Contributions are welcome. Please ensure:

- Code follows existing patterns and style
- New features include appropriate error handling
- Environment variables are documented in `.env.example`
- No secrets or private keys are committed

---

## Resources

- [Stellar Developer Docs](https://developers.stellar.org)
- [Stellar SDK (JavaScript)](https://stellar.github.io/js-stellar-sdk/)
- [Horizon API Reference](https://developers.stellar.org/api/horizon)
- [Stellar Expert Explorer](https://stellar.expert)
- [Stellar Discord](https://discord.gg/stellar)
- [Soroban Smart Contracts](https://soroban.stellar.org)

## Docs

- [Horizon Self-Hosting Guide](docs/horizon-self-hosting.md) — run your own Horizon node in production
- [Wallet Backup & Recovery](docs/wallet-backup-recovery.md)

---

## License

MIT
