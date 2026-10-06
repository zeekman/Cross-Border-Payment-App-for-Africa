const jwt = require('jsonwebtoken');
const Sentry = require('@sentry/node');
const db = require('../db');
const { isJtiBlacklisted } = require('../controllers/sessionController');

function maskWalletAddress(address) {
  if (!address || address.length < 8) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

module.exports = async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if JTI is blacklisted (token revoked via session management)
    if (payload.jti) {
      const blacklisted = await isJtiBlacklisted(payload.jti);
      if (blacklisted) {
        return res.status(401).json({ 
          error: 'Token has been revoked', 
          code: 'TOKEN_REVOKED' 
        });
      }
    }
    
    // Check if user account is suspended
    const { rows } = await db.query(
      'SELECT is_suspended, suspension_reason FROM users WHERE id = $1',
      [payload.userId]
    );
    
    if (rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    if (rows[0].is_suspended) {
      return res.status(403).json({ 
        error: 'Account suspended',
        reason: rows[0].suspension_reason || 'Your account has been suspended',
        code: 'ACCOUNT_SUSPENDED'
      });
    }
    
    req.user = payload;
    Sentry.setUser({
      id: req.user.userId,
      wallet: maskWalletAddress(req.user.walletAddress),
    });
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};
