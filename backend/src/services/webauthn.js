const crypto = require('crypto');
const Redis = require('ioredis');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const db = require('../db');

const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'AfriPay';
const ORIGIN = (process.env.WEBAUTHN_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3000').split(',');
const CHALLENGE_TTL_SECONDS = 120;

let redis = null;
const memory = new Map();
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  redis.on('error', () => {});
}

async function saveChallenge(key, value) {
  if (redis) return redis.set(key, JSON.stringify(value), 'EX', CHALLENGE_TTL_SECONDS);
  memory.set(key, { value, expires: Date.now() + CHALLENGE_TTL_SECONDS * 1000 });
}

/** Fetch and delete a challenge — challenges are single-use. */
async function consumeChallenge(key) {
  if (redis) {
    const raw = await redis.getdel(key);
    return raw ? JSON.parse(raw) : null;
  }
  const entry = memory.get(key);
  memory.delete(key);
  return entry && entry.expires > Date.now() ? entry.value : null;
}

/** Hash of the pending transaction the step-up is bound to (optional). */
function txHash(tx) {
  if (!tx || (tx.amount == null && !tx.recipient)) return null;
  return crypto.createHash('sha256').update(`${tx.amount ?? ''}|${tx.recipient ?? ''}`).digest('hex');
}

async function getCredentials(userId) {
  const { rows } = await db.query(
    'SELECT credential_id, public_key, counter, transports FROM webauthn_credentials WHERE user_id = $1',
    [userId]
  );
  return rows;
}

async function registrationOptions(user) {
  const creds = await getCredentials(user.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: creds.map((c) => ({ id: c.credential_id, transports: c.transports || undefined })),
    authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
  });
  await saveChallenge(`webauthn:reg:${user.id}`, { challenge: options.challenge });
  return options;
}

async function verifyRegistration(userId, response) {
  const stored = await consumeChallenge(`webauthn:reg:${userId}`);
  if (!stored) return { ok: false, error: 'Challenge expired or already used' };
  const { verified, registrationInfo } = await verifyRegistrationResponse({
    response,
    expectedChallenge: stored.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });
  if (!verified || !registrationInfo) return { ok: false, error: 'Registration could not be verified' };
  await db.query(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      registrationInfo.credentialID,
      Buffer.from(registrationInfo.credentialPublicKey).toString('base64url'),
      registrationInfo.counter,
      response.response?.transports || null,
    ]
  );
  return { ok: true };
}

async function stepUpOptions(userId, tx) {
  const creds = await getCredentials(userId);
  if (!creds.length) return null;
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
    allowCredentials: creds.map((c) => ({ id: c.credential_id, transports: c.transports || undefined })),
  });
  await saveChallenge(`webauthn:stepup:${userId}`, { challenge: options.challenge, txHash: txHash(tx) });
  return options;
}

async function verifyStepUp(userId, response, tx) {
  const stored = await consumeChallenge(`webauthn:stepup:${userId}`);
  if (!stored) return { ok: false, error: 'Challenge expired or already used' };
  if (stored.txHash && stored.txHash !== txHash(tx)) {
    return { ok: false, error: 'Transaction does not match the challenge' };
  }
  const { rows } = await db.query(
    'SELECT credential_id, public_key, counter, transports FROM webauthn_credentials WHERE user_id = $1 AND credential_id = $2',
    [userId, response?.id]
  );
  const cred = rows[0];
  if (!cred) return { ok: false, error: 'Unknown credential' };

  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      authenticator: {
        credentialID: cred.credential_id,
        credentialPublicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')),
        counter: Number(cred.counter),
        transports: cred.transports || undefined,
      },
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const info = result.authenticationInfo;
  if (!result.verified || !info?.userVerified) return { ok: false, error: 'User verification required' };

  await db.query('UPDATE webauthn_credentials SET counter = $1 WHERE credential_id = $2', [
    info.newCounter,
    cred.credential_id,
  ]);
  return { ok: true };
}

module.exports = { registrationOptions, verifyRegistration, stepUpOptions, verifyStepUp, consumeChallenge, saveChallenge };
