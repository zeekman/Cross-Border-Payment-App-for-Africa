const db = require('../db');

exports.summary = async (req, res) => {
  try {
    const userId = req.user.id;
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    // Monthly totals by asset
    const monthlyData = await db.query(`
      SELECT 
        DATE_TRUNC('month', created_at) as month,
        asset,
        SUM(CAST(amount AS DECIMAL)) as total
      FROM transactions
      WHERE user_id = $1 AND created_at >= $2 AND status = 'completed'
      GROUP BY DATE_TRUNC('month', created_at), asset
      ORDER BY month DESC
    `, [userId, sixMonthsAgo]);

    // Top 5 recipients
    const topRecipients = await db.query(`
      SELECT 
        recipient_address,
        COUNT(*) as count,
        SUM(CAST(amount AS DECIMAL)) as total_amount
      FROM transactions
      WHERE user_id = $1 AND status = 'completed'
      GROUP BY recipient_address
      ORDER BY total_amount DESC
      LIMIT 5
    `, [userId]);

    // Asset breakdown (all time)
    const assetBreakdown = await db.query(`
      SELECT 
        asset,
        COUNT(*) as count,
        SUM(CAST(amount AS DECIMAL)) as total
      FROM transactions
      WHERE user_id = $1 AND status = 'completed'
      GROUP BY asset
    `, [userId]);

    // Transaction frequency (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const frequency = await db.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as count
      FROM transactions
      WHERE user_id = $1 AND created_at >= $2 AND status = 'completed'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `, [userId, thirtyDaysAgo]);

    res.json({
      monthly: monthlyData.rows,
      top_recipients: topRecipients.rows,
      asset_breakdown: assetBreakdown.rows,
      transaction_frequency: frequency.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
