// BE-182: link sessions to their refresh-token family so revoking a
// session also revokes the device's refresh tokens.
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS family_id UUID');
  pgm.sql('CREATE INDEX IF NOT EXISTS idx_sessions_family_id ON sessions(family_id)');
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS idx_sessions_family_id');
  pgm.sql('ALTER TABLE sessions DROP COLUMN IF EXISTS family_id');
};
