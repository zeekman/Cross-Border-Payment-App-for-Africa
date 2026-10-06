-- Migration: idempotency keys table
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        VARCHAR(255) NOT NULL,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash VARCHAR(64) NOT NULL,
  status_code  INTEGER NOT NULL,
  response   JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (key, user_id)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys(created_at);
