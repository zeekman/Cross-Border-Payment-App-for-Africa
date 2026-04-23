const StellarSDK = require('@stellar/stellar-sdk');
const crypto = require('crypto');
const db = require('../db');

const SERVER_KEYPAIR = StellarSDK.Keypair.random();
const CHALLENGE_TIMEOUT = 15 * 60 * 1000; // 15 minutes

function generateChallenge(clientPublicKey) {
  const server = StellarSDK.Keypair.fromPublicKey(SERVER_KEYPAIR.publicKey());
  const client = StellarSDK.Keypair.fromPublicKey(clientPublicKey);

  const transaction = new StellarSDK.TransactionBuilder(
    new StellarSDK.Account(server.publicKey(), '0'),
    {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase: process.env.STELLAR_NETWORK === 'mainnet'
        ? StellarSDK.Networks.PUBLIC_NETWORK_PASSPHRASE
        : StellarSDK.Networks.TESTNET_NETWORK_PASSPHRASE
    }
  )
    .addOperation(
      StellarSDK.Operation.manageData({
        name: 'challenge',
        value: crypto.randomBytes(32).toString('hex')
      })
    )
    .setTimeout(CHALLENGE_TIMEOUT / 1000)
    .build();

  transaction.sign(server);
  return transaction.toEnvelope().toXDR('base64');
}

function verifyChallenge(clientPublicKey, signedXDR) {
  try {
    const transaction = StellarSDK.TransactionEnvelope.fromXDR(
      signedXDR,
      process.env.STELLAR_NETWORK === 'mainnet'
        ? StellarSDK.Networks.PUBLIC_NETWORK_PASSPHRASE
        : StellarSDK.Networks.TESTNET_NETWORK_PASSPHRASE
    );

    const tx = transaction.transaction();
    
    // Verify server signed it
    const serverSigned = transaction.signatures.some(sig => {
      try {
        StellarSDK.Keypair.fromPublicKey(SERVER_KEYPAIR.publicKey()).verify(
          tx.hash(),
          sig.signature()
        );
        return true;
      } catch {
        return false;
      }
    });

    if (!serverSigned) return false;

    // Verify client signed it
    const clientSigned = transaction.signatures.some(sig => {
      try {
        StellarSDK.Keypair.fromPublicKey(clientPublicKey).verify(
          tx.hash(),
          sig.signature()
        );
        return true;
      } catch {
        return false;
      }
    });

    return clientSigned;
  } catch (err) {
    return false;
  }
}

module.exports = {
  generateChallenge,
  verifyChallenge,
  SERVER_KEYPAIR
};
