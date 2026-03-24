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

## Stellar Integration

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

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
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

### 3. Frontend

```bash
cd frontend
npm install
cp .env.example .env
npm start
# App starts on http://localhost:3000
```

---

## Database Migrations

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

---

## License

MIT
