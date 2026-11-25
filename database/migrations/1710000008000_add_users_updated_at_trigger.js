exports.up = (pgm) => {
  pgm.sql(`
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
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS users_updated_at ON users;
    DROP FUNCTION IF EXISTS set_users_updated_at();
  `);
};
