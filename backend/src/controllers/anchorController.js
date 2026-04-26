const { initiateDeposit, initiateWithdrawal, getTransactionStatus } = require('../services/anchor');
const db = require('../db');

async function deposit(req, res, next) {
  try {
    const { asset } = req.body;
    const userId = req.user.userId;

    // Get user's wallet
    const walletResult = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [userId]
    );
    if (!walletResult.rows[0]) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const publicKey = walletResult.rows[0].public_key;
    const depositInfo = await initiateDeposit(publicKey, asset);

    res.json({
      url: depositInfo.url,
      id: depositInfo.id,
      message: 'Open the URL in a new window to complete deposit'
    });
  } catch (err) {
    next(err);
  }
}

async function withdraw(req, res, next) {
  try {
    const { asset } = req.body;
    const userId = req.user.userId;

    // Get user's wallet
    const walletResult = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [userId]
    );
    if (!walletResult.rows[0]) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const publicKey = walletResult.rows[0].public_key;
    const withdrawInfo = await initiateWithdrawal(publicKey, asset);

    res.json({
      url: withdrawInfo.url,
      id: withdrawInfo.id,
      message: 'Open the URL in a new window to complete withdrawal'
    });
  } catch (err) {
    next(err);
  }
}

async function status(req, res, next) {
  try {
    const { id } = req.params;
    const txStatus = await getTransactionStatus(id);
    res.json(txStatus);
  } catch (err) {
    next(err);
  }
}

module.exports = { deposit, withdraw, status };
