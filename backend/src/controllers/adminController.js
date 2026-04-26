const db = require('../db');
const { getStellarStats } = require('../services/stellar');

// Cache for Stellar stats (10 seconds)
let stellarStatsCache = null;
let stellarStatsCacheTime = 0;
const CACHE_DURATION = 10000; // 10 seconds

async function getStats(req, res, next) {
  try {
    const { rows } = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM users)                          AS total_users,
        (SELECT COUNT(*) FROM transactions)                   AS total_transactions,
        (SELECT COALESCE(SUM(amount), 0) FROM transactions
          WHERE status = 'completed')                         AS total_volume,
        (SELECT COALESCE(SUM(fee_amount), 0) FROM transactions
          WHERE status = 'completed')                         AS total_fees
    `);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function getUsers(req, res, next) {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const search = req.query.search ? `%${req.query.search}%` : null;

    const params = search ? [search, search, limit, offset] : [limit, offset];
    const where  = search ? `WHERE u.full_name ILIKE $1 OR u.email ILIKE $2` : '';
    const lIdx   = search ? 3 : 1;

    const { rows } = await db.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.role, u.created_at, w.public_key
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${lIdx} OFFSET $${lIdx + 1}`,
      params
    );

    const countParams = search ? [search, search] : [];
    const countWhere  = search ? `WHERE full_name ILIKE $1 OR email ILIKE $2` : '';
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) FROM users ${countWhere}`,
      countParams
    );

    res.json({ data: rows, total: parseInt(countRows[0].count), page, limit });
  } catch (err) {
    next(err);
  }
}

async function getTransactions(req, res, next) {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const { status, asset, from, to } = req.query;

    const conditions = [];
    const params     = [];

    if (status) { params.push(status);  conditions.push(`status = $${params.length}`); }
    if (asset)  { params.push(asset);   conditions.push(`asset = $${params.length}`); }
    if (from)   { params.push(from);    conditions.push(`created_at >= $${params.length}`); }
    if (to)     { params.push(to);      conditions.push(`created_at <= $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(limit, offset);
    const { rows } = await db.query(
      `SELECT * FROM transactions ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, -2);
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) FROM transactions ${where}`,
      countParams
    );

    res.json({ data: rows, total: parseInt(countRows[0].count), page, limit });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStats, getUsers, getTransactions, getStellarNetworkStats };

async function getStellarNetworkStats(req, res, next) {
  try {
    const now = Date.now();
    
    // Return cached data if still valid
    if (stellarStatsCache && (now - stellarStatsCacheTime) < CACHE_DURATION) {
      return res.json(stellarStatsCache);
    }

    // Fetch fresh data
    const stats = await getStellarStats();
    
    // Update cache
    stellarStatsCache = stats;
    stellarStatsCacheTime = now;

    res.json(stats);
  } catch (err) {
    next(err);
  }
}
