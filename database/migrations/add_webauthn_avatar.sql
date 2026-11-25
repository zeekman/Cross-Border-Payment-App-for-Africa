-- Migration: WebAuthn credentials (BE-208) and avatar URL (BE-210)
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  TEXT NOT NULL UNIQUE,
  public_key     TEXT NOT NULL,
  counter        BIGINT NOT NULL DEFAULT 0,
  transports     TEXT[],
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
