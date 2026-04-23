const jwt = require('jsonwebtoken');
const { generateChallenge, verifyChallenge } = require('../services/sep10');
const db = require('../db');

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
    const { transaction } = req.body;
    if (!transaction) {
      return res.status(400).json({ error: 'transaction required' });
    }

    // Extract account from transaction
    const StellarSDK = require('@stellar/stellar-sdk');
    const tx = StellarSDK.TransactionEnvelope.fromXDR(
      transaction,
      process.env.STELLAR_NETWORK === 'mainnet'
        ? StellarSDK.Networks.PUBLIC_NETWORK_PASSPHRASE
        : StellarSDK.Networks.TESTNET_NETWORK_PASSPHRASE
    );

    const account = tx.transaction().source.accountId();

    // Verify the challenge
    const isValid = verifyChallenge(account, transaction);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid challenge signature' });
    }

    // Find or create user by Stellar account
    let user = await db.query('SELECT id, email FROM users WHERE stellar_account = $1', [account]);
    
    if (!user.rows[0]) {
      // Create a new user linked to this Stellar account
      const { v4: uuidv4 } = require('uuid');
      const userId = uuidv4();
      await db.query(
        'INSERT INTO users (id, email, stellar_account, email_verified) VALUES ($1, $2, $3, TRUE)',
        [userId, `${account.slice(0, 10)}@stellar.local`, account]
      );
      user = { rows: [{ id: userId, email: `${account.slice(0, 10)}@stellar.local` }] };
    }

    const token = jwt.sign(
      { userId: user.rows[0].id, email: user.rows[0].email, role: 'user' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({ token });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getChallenge,
  postChallenge
};
