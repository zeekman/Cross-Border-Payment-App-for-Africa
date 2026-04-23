const nacl = require('tweetnacl');
const ed2curve = require('ed2curve');
const StellarSdk = require('@stellar/stellar-sdk');

/**
 * Encrypt a memo using ECIES with the recipient's Stellar public key (Ed25519).
 * Returns a base64 encoded string containing ephemeral public key, nonce, and ciphertext.
 */
function encryptMemo(memo, recipientPublicKey) {
  // Decode the recipient's public key from Stellar format
  const recipientPubKeyBytes = StellarSdk.StrKey.decodeEd25519PublicKey(recipientPublicKey);
  
  // Convert Ed25519 public key to Curve25519 for encryption
  const recipientCurvePubKey = ed2curve.convertPublicKey(recipientPubKeyBytes);
  if (!recipientCurvePubKey) {
    throw new Error('Invalid recipient public key for encryption');
  }

  // Generate ephemeral keypair
  const ephemeralKeypair = nacl.box.keyPair();

  // Encrypt the memo
  const messageBytes = Buffer.from(memo, 'utf8');
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(messageBytes, nonce, recipientCurvePubKey, ephemeralKeypair.secretKey);

  // Combine: ephemeral public key + nonce + ciphertext
  const encrypted = Buffer.concat([
    ephemeralKeypair.publicKey,
    nonce,
    ciphertext
  ]);

  return encrypted.toString('base64');
}

/**
 * Decrypt a memo using the recipient's Stellar secret key.
 */
function decryptMemo(encryptedMemo, recipientSecretKey) {
  // Decode the encrypted data
  const encryptedBytes = Buffer.from(encryptedMemo, 'base64');
  
  // Extract components
  const ephemeralPubKey = encryptedBytes.subarray(0, nacl.box.publicKeyLength);
  const nonce = encryptedBytes.subarray(nacl.box.publicKeyLength, nacl.box.publicKeyLength + nacl.box.nonceLength);
  const ciphertext = encryptedBytes.subarray(nacl.box.publicKeyLength + nacl.box.nonceLength);

  // Decode the recipient's secret key
  const recipientSecretBytes = StellarSdk.StrKey.decodeEd25519SecretSeed(recipientSecretKey);
  
  // Convert Ed25519 secret key to Curve25519
  const recipientCurveSecretKey = ed2curve.convertSecretKey(recipientSecretBytes);
  if (!recipientCurveSecretKey) {
    throw new Error('Invalid recipient secret key for decryption');
  }

  // Decrypt
  const decrypted = nacl.box.open(ciphertext, nonce, ephemeralPubKey, recipientCurveSecretKey);
  if (!decrypted) {
    throw new Error('Decryption failed');
  }

  return Buffer.from(decrypted).toString('utf8');
}

module.exports = {
  encryptMemo,
  decryptMemo
};