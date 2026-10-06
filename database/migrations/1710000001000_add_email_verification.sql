-- Migration: add email verification columns to users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified     BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS verification_token VARCHAR(64),
  ADD COLUMN IF NOT EXISTS token_expires_at   TIMESTAMPTZ;
