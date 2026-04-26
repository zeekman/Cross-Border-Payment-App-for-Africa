const StellarSdk = require('@stellar/stellar-sdk');
const logger = require('../utils/logger');

const isTestnet = process.env.STELLAR_NETWORK !== 'mainnet';
const anchorUrl = process.env.ANCHOR_URL || 'https://testanchor.stellar.org';

// Get SEP-24 info
async function getAnchorInfo() {
  try {
    const response = await fetch(`${anchorUrl}/.well-known/stellar.toml`);
    const text = await response.text();
    
    // Parse TOML to find TRANSFER_SERVER
    const transferServerMatch = text.match(/TRANSFER_SERVER\s*=\s*"([^"]+)"/);
    const transferServer = transferServerMatch ? transferServerMatch[1] : null;

    return {
      transferServer,
      anchorUrl
    };
  } catch (err) {
    logger.error('Failed to get anchor info', { error: err.message });
    throw new Error('Failed to connect to anchor');
  }
}

// Initiate SEP-24 deposit
async function initiateDeposit(userPublicKey, asset) {
  try {
    const { transferServer } = await getAnchorInfo();
    if (!transferServer) throw new Error('Anchor does not support SEP-24');

    const response = await fetch(`${transferServer}/transactions/deposit/interactive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset_code: asset,
        account: userPublicKey
      })
    });

    const data = await response.json();
    return {
      url: data.url,
      id: data.id
    };
  } catch (err) {
    logger.error('Failed to initiate deposit', { error: err.message });
    throw err;
  }
}

// Initiate SEP-24 withdrawal
async function initiateWithdrawal(userPublicKey, asset) {
  try {
    const { transferServer } = await getAnchorInfo();
    if (!transferServer) throw new Error('Anchor does not support SEP-24');

    const response = await fetch(`${transferServer}/transactions/withdraw/interactive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset_code: asset,
        account: userPublicKey
      })
    });

    const data = await response.json();
    return {
      url: data.url,
      id: data.id
    };
  } catch (err) {
    logger.error('Failed to initiate withdrawal', { error: err.message });
    throw err;
  }
}

// Get transaction status
async function getTransactionStatus(transactionId) {
  try {
    const { transferServer } = await getAnchorInfo();
    if (!transferServer) throw new Error('Anchor does not support SEP-24');

    const response = await fetch(`${transferServer}/transaction?id=${transactionId}`);
    const data = await response.json();
    return data.transaction;
  } catch (err) {
    logger.error('Failed to get transaction status', { error: err.message });
    throw err;
  }
}

module.exports = { getAnchorInfo, initiateDeposit, initiateWithdrawal, getTransactionStatus };
