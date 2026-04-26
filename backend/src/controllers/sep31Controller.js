const { v4: uuidv4 } = require('uuid');
const db = require('../db');

async function getInfo(req, res, next) {
  try {
    res.json({
      assets: [
        {
          code: 'USDC',
          issuer: process.env.USDC_ISSUER || 'GBBD47UZQ2BNSE7E2CMPL3XUREV3ZCYY5LMPJCJ7I7ZLIP4UGJLE66V2',
          sep12: {
            sender: ['name', 'email', 'phone_number'],
            receiver: ['name', 'email', 'phone_number']
          }
        }
      ],
      sep12: {
        sender: ['name', 'email', 'phone_number'],
        receiver: ['name', 'email', 'phone_number']
      }
    });
  } catch (err) {
    next(err);
  }
}

async function createTransaction(req, res, next) {
  try {
    const { amount, asset_code = 'USDC', receiver_account, sender_name, sender_email } = req.body;
    const userId = req.user.userId;

    if (!amount || !receiver_account) {
      return res.status(400).json({ error: 'amount and receiver_account required' });
    }

    // Check KYC status
    const user = await db.query('SELECT kyc_status FROM users WHERE id = $1', [userId]);
    const kycVerified = user.rows[0]?.kyc_status === 'verified';

    const txId = uuidv4();
    await db.query(
      `INSERT INTO sep31_transactions (id, sender_id, receiver_account, amount, asset_code, kyc_verified, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [txId, userId, receiver_account, amount, asset_code, kycVerified]
    );

    res.status(201).json({
      id: txId,
      status: 'pending',
      amount,
      asset_code,
      receiver_account,
      kyc_verified: kycVerified
    });
  } catch (err) {
    next(err);
  }
}

async function getTransaction(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const result = await db.query(
      `SELECT id, status, amount, asset_code, receiver_account, kyc_verified, created_at, updated_at
       FROM sep31_transactions
       WHERE id = $1 AND sender_id = $2`,
      [id, userId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getInfo,
  createTransaction,
  getTransaction
};
