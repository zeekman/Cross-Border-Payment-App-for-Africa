/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'agent_escrows'
      ) THEN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'agent_escrows' AND column_name = 'cancellable_at'
        ) THEN
          ALTER TABLE agent_escrows ADD COLUMN cancellable_at TIMESTAMPTZ;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'agent_escrows' AND column_name = 'payout_confirmed'
        ) THEN
          ALTER TABLE agent_escrows ADD COLUMN payout_confirmed BOOLEAN NOT NULL DEFAULT FALSE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'agent_escrows' AND column_name = 'expires_at'
        ) THEN
          ALTER TABLE agent_escrows ADD COLUMN expires_at TIMESTAMPTZ;
        END IF;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'agent_escrows'
      ) THEN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'agent_escrows' AND column_name = 'cancellable_at'
        ) THEN
          ALTER TABLE agent_escrows DROP COLUMN cancellable_at;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'agent_escrows' AND column_name = 'payout_confirmed'
        ) THEN
          ALTER TABLE agent_escrows DROP COLUMN payout_confirmed;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'agent_escrows' AND column_name = 'expires_at'
        ) THEN
          ALTER TABLE agent_escrows DROP COLUMN expires_at;
        END IF;
      END IF;
    END
    $$;
  `);
};