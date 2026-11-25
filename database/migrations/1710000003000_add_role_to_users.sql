-- Migration: add role column to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user'
  CHECK (role IN ('user', 'admin'));

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Migration: add fee_amount column to transactions
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fee_amount DECIMAL(20, 7) NOT NULL DEFAULT 0;
