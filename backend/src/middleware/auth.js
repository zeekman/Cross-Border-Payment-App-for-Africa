const jwt = require('jsonwebtoken');
const Sentry = require('@sentry/node');

function maskWalletAddress(address) {
  if (!address || address.length < 8) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

module.exports = function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    Sentry.setUser({
      id: req.user.userId,
      wallet: maskWalletAddress(req.user.walletAddress),
    });
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};
