/**
 * BE-137: support a short grace window for concurrent refreshes.
 * revoked_at records when a token was rotated; replaced_by_enc holds the
 * encrypted successor so a concurrent request with the same cookie can be
 * handed the same successor instead of being treated as reuse.
 */

exports.up = (pgm) => {
  pgm.addColumns('refresh_tokens', {
    revoked_at: { type: 'timestamptz' },
    replaced_by_enc: { type: 'text' },
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('refresh_tokens', ['revoked_at', 'replaced_by_enc'], { ifExists: true });
};
