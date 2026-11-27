'use strict';

const StellarSdk = require('@stellar/stellar-sdk');

function baseAccountAddress(address) {
  if (typeof address !== 'string' || !StellarSdk.StrKey.isValidMed25519PublicKey(address)) {
    return address;
  }
  const decoded = StellarSdk.StrKey.decodeMed25519PublicKey(address);
  const publicKeyBytes = Buffer.isBuffer(decoded) ? decoded.subarray(0, 32) : decoded.ed25519;
  if (!Buffer.isBuffer(publicKeyBytes) || publicKeyBytes.length !== 32) {
    throw new Error('Unable to decode Stellar muxed account address');
  }
  return StellarSdk.StrKey.encodeEd25519PublicKey(publicKeyBytes);
}

module.exports = { baseAccountAddress };
