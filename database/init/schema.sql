-- Cross-Border Payment App - PostgreSQL Schema (Docker init)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  phone              VARCHAR(20),
  email_verified     BOOLEAN     NOT NULL DEFAULT FALSE,
  verification_token VARCHAR(64),
  token_expires_at   TIMESTAMPTZ,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE wallets (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key           VARCHAR(56) UNIQUE NOT NULL,
  encrypted_secret_key TEXT NOT NULL,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE transactions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sender_wallet    VARCHAR(56) NOT NULL,
  recipient_wallet VARCHAR(56) NOT NULL,
  amount           DECIMAL(20, 7) NOT NULL,
  asset            VARCHAR(12) DEFAULT 'XLM',
  memo             VARCHAR(128),
  memo_type        VARCHAR(10),
  tx_hash          VARCHAR(64) UNIQUE,
  status           VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE contacts (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           VARCHAR(100) NOT NULL,
  wallet_address VARCHAR(56) NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, wallet_address)
);

CREATE TABLE password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(64) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_transactions_sender ON transactions(sender_wallet);
CREATE INDEX idx_transactions_recipient ON transactions(recipient_wallet);
CREATE INDEX idx_wallets_user ON wallets(user_id);
CREATE INDEX idx_contacts_user ON contacts(user_id);
CREATE INDEX idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX idx_password_reset_tokens_active ON password_reset_tokens(token_hash) WHERE used_at IS NULL;

-- Refresh sessions: store hashed token only (raw value lives in httpOnly cookie)
CREATE TABLE refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(64) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- Keep users.updated_at in sync on every UPDATE (INSERT still uses column DEFAULT)
CREATE OR REPLACE FUNCTION set_users_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION set_users_updated_at();

