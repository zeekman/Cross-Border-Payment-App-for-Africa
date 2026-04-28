-- Issue #244: Confirm composite indexes on transactions table
-- for efficient history queries filtered by wallet + date.
--
-- These indexes support the two most common WHERE patterns in
-- GET /api/payments/history:
--   WHERE sender_wallet = $1 AND created_at >= ... AND created_at <= ...
--   WHERE recipient_wallet = $1 AND created_at >= ... AND created_at <= ...
--
-- Run this migration if the indexes do not already exist.

CREATE INDEX IF NOT EXISTS idx_transactions_sender_created_at
  ON transactions (sender_wallet, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_recipient_created_at
  ON transactions (recipient_wallet, created_at DESC);
