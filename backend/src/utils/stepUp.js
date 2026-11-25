const jwt = require('jsonwebtoken');

const STEP_UP_TTL = process.env.STEP_UP_TOKEN_TTL || '5m';

/** Issue a short-lived step-up token proving a recent second factor (PIN or WebAuthn). */
function issueStepUpToken(userId, method = 'pin') {
  return jwt.sign({ sub: userId, typ: 'step_up', amr: [method] }, process.env.JWT_SECRET, {
    expiresIn: STEP_UP_TTL,
  });
}

/** Express middleware: requires a valid X-Step-Up-Token for the authenticated user. */
function requireStepUp(req, res, next) {
  const token = req.headers['x-step-up-token'];
  if (!token) return res.status(401).json({ error: 'Step-up verification required', code: 'STEP_UP_REQUIRED' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.typ !== 'step_up' || payload.sub !== req.user?.userId) throw new Error('mismatch');
    req.stepUp = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired step-up token', code: 'STEP_UP_INVALID' });
  }
}

module.exports = { issueStepUpToken, requireStepUp };
