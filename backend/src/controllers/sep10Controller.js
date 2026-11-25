const jwt = require('jsonwebtoken');
const { generateChallenge, verifyChallenge } = require('../services/sep10');
const { networkPassphrase } = require('../services/stellar');
const db = require('../db');
const { signAccessToken } = require('../utils/tokens');
const { recordSession } = require('./sessionController');

async function getChallenge(req, res, next) {
  try {
    const { account } = req.query;
    if (!account) {
      return res.status(400).json({ error: 'account parameter required' });
    }

    const challenge = generateChallenge(account);
    res.json({ transaction: challenge, network_passphrase: process.env.STELLAR_NETWORK === 'mainnet' ? 'Public Global Stellar Network ; September 2015' : 'Test SDF Network ; September 2015' });
  } catch (err) {
    next(err);
  }
}

async function postChallenge(req, res, next) {
  try {
    const { transaction, network_passphrase } = req.body;
    if (!transaction) {
      return res.status(400).json({ error: 'transaction required' });
    }

    if (network_passphrase !== networkPassphrase) {
      return res.status(400).json({ error: 'Invalid network passphrase' });
    }

    // Extract account from transaction
    const StellarSDK = require('@stellar/stellar-sdk');
    const passphrase = process.env.STELLAR_NETWORK === 'mainnet'
      ? StellarSDK.Networks.PUBLIC
      : StellarSDK.Networks.TESTNET;
    const tx = StellarSDK.TransactionBuilder.fromXDR(transaction, passphrase);

    const account = tx.source;

    // Verify the challenge
    const isValid = verifyChallenge(account, transaction);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid challenge signature' });
    }

    // Find or create user by Stellar account
    let user = await db.query('SELECT id, email, role FROM users WHERE stellar_account = $1', [account]);

    if (!user.rows[0]) {
      // Create a new user linked to this Stellar account.
      // SEP-10 wallet-auth users skip email verification by design — the
      // Stellar signature proves ownership of the wallet keypair, which is
      // the security primitive for this authentication flow.
      const { v4: uuidv4 } = require('uuid');
      const userId = uuidv4();
      const syntheticEmail = `${account.slice(0, 10)}@stellar.local`;
      await db.query(
        'INSERT INTO users (id, email, stellar_account, email_verified) VALUES ($1, $2, $3, TRUE)',
        [userId, syntheticEmail, account]
      );
      user = { rows: [{ id: userId, email: syntheticEmail, role: 'user' }] };
    }

    // Use the shared signAccessToken() utility which includes a jti claim
    // so that token revocation (logout, session invalidation) works correctly.
    const token = signAccessToken({ userId: user.rows[0].id, email: user.rows[0].email, role: user.rows[0].role || 'user' });

    // Record the session so SEP-10 logins appear in the sessions API
    // and are subject to SESSION_CAP enforcement.
    await recordSession(user.rows[0].id, token, req).catch(() => {});

    res.json({ token });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getChallenge,
  postChallenge
};
