-- Migration: link sessions to their refresh-token family so revoking a
-- session also revokes the device's refresh tokens (BE-182)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS family_id UUID;

CREATE INDEX IF NOT EXISTS idx_sessions_family_id ON sessions(family_id);
