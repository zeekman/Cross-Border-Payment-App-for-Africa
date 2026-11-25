/**
 * SEP-10 web-auth challenge/response.
 *
 * home_domain matching rule (see BE-014):
 * The challenge transaction's manage_data operation name MUST be exactly
 * `${HOME_DOMAIN} auth` — an EXACT, CASE-SENSITIVE string comparison against
 * the server's configured home domain. No substring, prefix, or suffix match
 * is permitted, and the domain is never normalized (no case-folding, no
 * trailing-dot stripping) before comparison, because doing so would let a
 * client authenticate a transaction whose operation name reads e.g.
 * `afripay.app.attacker.com auth`, `AfriPay.App auth`, or `afripay.app. auth`
 * as if it were `afripay.app auth`. Any deviation is rejected.
 */
'use strict';

const StellarSDK = require('@stellar/stellar-sdk');
const crypto = require('crypto');
const db = require('../db');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const SEP10_SIGNING_SECRET = process.env.SEP10_SIGNING_SECRET;
let SERVER_KEYPAIR;

if (SEP10_SIGNING_SECRET) {
  SERVER_KEYPAIR = StellarSDK.Keypair.fromSecret(SEP10_SIGNING_SECRET);
} else if (process.env.NODE_ENV === 'production') {
  throw new Error(
    'SEP10_SIGNING_SECRET must be set in production. ' +
    'Set it to a Stellar secret key (starting with S) to enable deterministic SEP-10 signing.'
  );
} else {
  SERVER_KEYPAIR = StellarSDK.Keypair.random();
}
const CHALLENGE_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const HOME_DOMAIN = process.env.SEP10_HOME_DOMAIN || 'afripay.app';
const EXPIRY_BUFFER_SECONDS = 60; // refresh if token expires within 60s
const SEP10_TOKEN_TTL = 24 * 60 * 60; // 24h default anchor token lifetime

// In-memory mutex map to prevent concurrent re-auth for the same user
const _refreshLocks = new Map();

function networkPassphrase() {
  return process.env.STELLAR_NETWORK === 'mainnet'
    ? StellarSDK.Networks.PUBLIC
    : StellarSDK.Networks.TESTNET;
}

// ---------------------------------------------------------------------------
// Challenge / Verify (existing behaviour, unchanged)
// ---------------------------------------------------------------------------

function generateChallenge(clientPublicKey) {
  const transaction = new StellarSDK.TransactionBuilder(
    new StellarSDK.Account(SERVER_KEYPAIR.publicKey(), '0'),
    { fee: StellarSDK.BASE_FEE, networkPassphrase: networkPassphrase() }
  )
    .addOperation(
      StellarSDK.Operation.manageData({
        name: `${HOME_DOMAIN} auth`,
        value: crypto.randomBytes(32).toString('hex'),
      })
    )
    .setTimeout(CHALLENGE_TIMEOUT / 1000)
    .build();

  transaction.sign(SERVER_KEYPAIR);
  return transaction.toEnvelope().toXDR('base64');
}

function verifyChallenge(clientPublicKey, signedXDR) {
  try {
    const transaction = StellarSDK.TransactionBuilder.fromXDR(signedXDR, networkPassphrase());

    // Exact, case-sensitive match on the manage_data operation name against
    // the configured home domain. Reject anything that merely contains,
    // starts with, or ends with the expected value (sub-domain spoofing,
    // trailing-dot spoofing, case-mismatch spoofing).
    const expectedName = `${HOME_DOMAIN} auth`;
    const manageDataOp = (transaction.operations || []).find(op => op.type === 'manageData');
    if (!manageDataOp || manageDataOp.name !== expectedName) return false;

    // Verify server signed it
    const serverSigned = transaction.signatures.some(sig => {
      try {
        return StellarSDK.Keypair.fromPublicKey(SERVER_KEYPAIR.publicKey()).verify(transaction.hash(), sig.signature());
      } catch { return false; }
    });
    if (!serverSigned) return false;

    const clientSigned = transaction.signatures.some(sig => {
      try {
        return StellarSDK.Keypair.fromPublicKey(clientPublicKey).verify(transaction.hash(), sig.signature());
      } catch { return false; }
    });
    return clientSigned;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session store helpers
// ---------------------------------------------------------------------------

function sep10SessionKey(userId) {
  return `sep10:session:${userId}`;
}

/**
 * Persist a SEP-10 token alongside its expiry in the session store (Redis or DB).
 */
async function storeSession(userId, token, expAt) {
  const ttl = Math.max(1, expAt - Math.floor(Date.now() / 1000));
  await cache.set(sep10SessionKey(userId), { token, exp: expAt }, ttl);
}

/**
 * Retrieve the current SEP-10 session for a user.
 * Returns { token, exp } or null.
 */
async function getSession(userId) {
  return cache.get(sep10SessionKey(userId));
}

async function deleteSession(userId) {
  await cache.del(sep10SessionKey(userId));
}

// ---------------------------------------------------------------------------
// Near-expiry detection & silent refresh
// ---------------------------------------------------------------------------

/**
 * Return a valid SEP-10 token for the user, transparently refreshing if near expiry.
 *
 * @param {string} userId
 * @param {Function} reauthFn - async (userId) => { token, exp } — called to get fresh token.
 *   If null (e.g. hardware wallet), throws SEP10_REAUTH_REQUIRED.
 */
async function getValidToken(userId, reauthFn = null) {
  const session = await getSession(userId);
  const now = Math.floor(Date.now() / 1000);

  if (session && session.exp - now > EXPIRY_BUFFER_SECONDS) {
    return session.token; // still fresh
  }

  // Near expiry or no session — attempt silent refresh
  return _withLock(userId, async () => {
    // Re-check inside lock (another concurrent call may have refreshed already)
    const fresh = await getSession(userId);
    if (fresh && fresh.exp - Math.floor(Date.now() / 1000) > EXPIRY_BUFFER_SECONDS) {
      return fresh.token;
    }

    if (!reauthFn) {
      const err = new Error('SEP-10 re-authentication required');
      err.code = 'SEP10_REAUTH_REQUIRED';
      throw err;
    }

    logger.info('SEP-10 token near expiry — silent refresh', { userId });
    let result;
    try {
      result = await reauthFn(userId);
    } catch (e) {
      logger.error('SEP-10 silent refresh failed', { userId, error: e.message });
      const err = new Error('SEP10_REAUTH_REQUIRED');
      err.code = 'SEP10_REAUTH_REQUIRED';
      throw err;
    }

    await storeSession(userId, result.token, result.exp || Math.floor(Date.now() / 1000) + SEP10_TOKEN_TTL);
    return result.token;
  });
}

// Simple per-key async mutex
function _withLock(key, fn) {
  const existing = _refreshLocks.get(key);
  const promise = (existing || Promise.resolve()).then(() => fn()).finally(() => {
    if (_refreshLocks.get(key) === promise) _refreshLocks.delete(key);
  });
  _refreshLocks.set(key, promise);
  return promise;
}

module.exports = {
  generateChallenge,
  verifyChallenge,
  HOME_DOMAIN,
  storeSession,
  getSession,
  deleteSession,
  getValidToken,
  SERVER_KEYPAIR,
  EXPIRY_BUFFER_SECONDS,
};
