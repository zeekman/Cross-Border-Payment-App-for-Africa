const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const runIntegration = Boolean(connectionString);

(runIntegration ? describe : describe.skip)(
  'users.updated_at trigger (PostgreSQL)',
  () => {
    let pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString });
      const sqlPath = path.join(
        __dirname,
        '../../database/migrations/001_add_updated_at_trigger.sql',
      );
      const sql = fs.readFileSync(sqlPath, 'utf8');
      await pool.query(sql);
    });

    afterAll(async () => {
      if (pool) await pool.end();
    });

    test('updated_at advances when a user row is updated', async () => {
      const email = `updated-at-${Date.now()}@integration.test`;
      const inserted = await pool.query(
        `INSERT INTO users (full_name, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, updated_at`,
        ['Trigger Test', email, 'not-a-real-hash'],
      );
      const { id, updated_at: before } = inserted.rows[0];

      await new Promise((r) => setTimeout(r, 50));

      const updated = await pool.query(
        `UPDATE users SET full_name = $1 WHERE id = $2 RETURNING updated_at`,
        ['Trigger Test Updated', id],
      );
      const after = updated.rows[0].updated_at;

      expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());

      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    });
  },
);
