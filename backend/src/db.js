const { Pool } = require('pg');
const { dbQueryDuration } = require('./utils/metrics');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('Unexpected DB error', err);
});

async function query(text, params) {
  const end = dbQueryDuration.startTimer();
  try {
    const result = await pool.query(text, params);
    end({ success: 'true' });
    return result;
  } catch (err) {
    end({ success: 'false' });
    throw err;
  }
}

module.exports = { query, pool };
