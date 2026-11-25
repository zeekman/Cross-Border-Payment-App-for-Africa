const crypto = require('crypto');
const db = require('../db');
const audit = require('../services/audit');
const cache = require('../utils/cache');
const { PIN_POLICY } = require('../services/pin');
const { issueStepUpToken } = require('../middleware/requireStepUp');
const {
  getRpConfig,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('../services/webauthn');

const CHALLENGE_TTL_SECONDS = 120;
const challengeKey = (userId) => `webauthn:stepup:${userId}`;

/** Hash of the pending transaction the step-up is bound to (optional). */
function txHash(tx) {
  if (!tx || (tx.amount == null && !tx.recipient)) return null;
  return crypto.createHash('sha256').update(`${tx.amount ?? ''}|${tx.recipient ?? ''}`).digest('hex');
}

function getPinPolicy(req, res) {
  res.json(PIN_POLICY);
}

async function webauthnStepUpOptions(req, res, next) {
  try {
    const userId = req.user.userId;
    const { rows } = await db.query(
      'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1',
      [userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No biometric credential registered' });

    const { rpID } = getRpConfig();
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: rows.map((c) => ({
        id: c.credential_id,
        transports: c.transports ? JSON.parse(c.transports) : undefined,
      })),
    });
    await cache.set(
      challengeKey(userId),
      { challenge: options.challenge, txHash: txHash(req.body?.transaction) },
      CHALLENGE_TTL_SECONDS
    );
    res.json(options);
  } catch (err) {
    next(err);
  }
}

async function webauthnStepUpVerify(req, res, next) {
  const userId = req.user.userId;
  const fail = (reason) => {
    audit.log(userId, 'step_up_webauthn_failed', req.ip, req.headers['user-agent'], { reason });
    return res.status(401).json({ error: 'Biometric verification failed' });
  };
  try {
    const { assertion, transaction } = req.body || {};
    if (!assertion?.id) return res.status(400).json({ error: 'assertion is required' });

    // Single-use challenge: read then delete before verifying.
    const stored = await cache.get(challengeKey(userId));
    await cache.del(challengeKey(userId));
    if (!stored) return fail('challenge_missing');
    if (stored.txHash && stored.txHash !== txHash(transaction)) return fail('transaction_mismatch');

    const credRow = await db.query(
      'SELECT id, credential_id, public_key, counter FROM webauthn_credentials WHERE user_id = $1 AND credential_id = $2',
      [userId, assertion.id]
    );
    const credential = credRow.rows[0];
    if (!credential) return fail('unknown_credential');
    const storedCounter = Number(credential.counter);

    const { rpID, origin } = getRpConfig();
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge: stored.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: credential.credential_id,
          publicKey: Uint8Array.from(Buffer.from(credential.public_key, 'base64')),
          counter: storedCounter,
        },
      });
    } catch (err) {
      return fail(err.message);
    }

    const info = verification.authenticationInfo || {};
    const newCounter = info.newCounter ?? 0;
    if (!verification.verified || !info.userVerified) return fail('user_verification_required');
    if (newCounter !== 0 && newCounter <= storedCounter) return fail('counter_replay');

    await db.query(
      'UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE id = $2',
      [newCounter, credential.id]
    );
    audit.log(userId, 'step_up_webauthn', req.ip, req.headers['user-agent']);
    res.json({ message: 'Biometric verified', ...issueStepUpToken(userId) });
  } catch (err) {
    next(err);
  }
}

module.exports = { getPinPolicy, webauthnStepUpOptions, webauthnStepUpVerify };
