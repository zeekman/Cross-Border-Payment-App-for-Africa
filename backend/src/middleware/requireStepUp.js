const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cache = require('../utils/cache');

const STEP_UP_TTL_SECONDS = 120;
const STEP_UP_HEADER = 'x-step-up-token';

function issueStepUpToken(userId) {
  const jti = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign(
    { sub: String(userId), purpose: 'transaction_step_up', jti },
    process.env.JWT_SECRET,
    { expiresIn: STEP_UP_TTL_SECONDS },
  );
  return { token, expiresIn: STEP_UP_TTL_SECONDS };
}

async function requireStepUp(req, res, next) {
  const token = req.get(STEP_UP_HEADER);
  if (!token) return rejectStepUp(res);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (
      payload.purpose !== 'transaction_step_up' ||
      !payload.jti ||
      payload.sub !== String(req.user.userId)
    ) {
      return rejectStepUp(res);
    }

    const ttl = Math.max(1, payload.exp - Math.floor(Date.now() / 1000));
    const consumed = await cache.setIfAbsent(`stepup:used:${payload.jti}`, req.user.userId, ttl);
    if (!consumed) return rejectStepUp(res);

    return next();
  } catch (_) {
    return rejectStepUp(res);
  }
}

function rejectStepUp(res) {
  return res.status(403).json({
    error: 'Transaction confirmation required. Verify your PIN and try again.',
    code: 'STEP_UP_REQUIRED',
  });
}

module.exports = { requireStepUp, issueStepUpToken, STEP_UP_TTL_SECONDS };