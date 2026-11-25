#!/usr/bin/env node
/**
 * Generate AFRI Token Keypairs
 * 
 * This script generates issuer and distribution keypairs for the AFRI token.
 * 
 * SECURITY WARNING:
 * - The issuer secret key should be stored in COLD STORAGE
 * - Never commit the issuer secret to version control
 * - Use a separate signing ceremony for production issuance
 * - The distribution account handles day-to-day token distribution
 * 
 * Usage: node scripts/generateAFRIKeypairs.js
 */

const StellarSdk = require('@stellar/stellar-sdk');
const crypto = require('crypto');

function encryptPrivateKey(secretKey, encryptionKey) {
  const key = Buffer.from(encryptionKey, 'utf8').slice(0, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(secretKey, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

console.log('='.repeat(80));
console.log('AFRI TOKEN KEYPAIR GENERATION');
console.log('='.repeat(80));
console.log();

// Generate issuer keypair
const issuerPair = StellarSdk.Keypair.random();
console.log('ISSUER ACCOUNT (Cold Storage - Keep Secure!)');
console.log('-'.repeat(80));
console.log('Public Key: ', issuerPair.publicKey());
console.log('Secret Key: ', issuerPair.secret());
console.log();

// Generate distribution keypair
const distributionPair = StellarSdk.Keypair.random();
console.log('DISTRIBUTION ACCOUNT (Hot Wallet - For Daily Operations)');
console.log('-'.repeat(80));
console.log('Public Key: ', distributionPair.publicKey());
console.log('Secret Key: ', distributionPair.secret());
console.log();

// Show encrypted versions if ENCRYPTION_KEY is set
if (process.env.ENCRYPTION_KEY) {
  console.log('ENCRYPTED SECRETS (For .env file)');
  console.log('-'.repeat(80));
  console.log('AFRI_ISSUER_SECRET=', encryptPrivateKey(issuerPair.secret(), process.env.ENCRYPTION_KEY));
  console.log('AFRI_DISTRIBUTION_SECRET=', encryptPrivateKey(distributionPair.secret(), process.env.ENCRYPTION_KEY));
  console.log();
}

console.log('NEXT STEPS:');
console.log('-'.repeat(80));
console.log('1. Fund both accounts on testnet using Friendbot:');
console.log(`   https://friendbot.stellar.org?addr=${issuerPair.publicKey()}`);
console.log(`   https://friendbot.stellar.org?addr=${distributionPair.publicKey()}`);
console.log();
console.log('2. Add trustline from distribution account to AFRI asset');
console.log();
console.log('3. Update .env file with:');
console.log(`   AFRI_ISSUER_PUBLIC=${issuerPair.publicKey()}`);
console.log(`   AFRI_DISTRIBUTION_PUBLIC=${distributionPair.publicKey()}`);
console.log();
console.log('4. Update stellar.toml with the issuer public key');
console.log();
console.log('5. Store issuer secret key in cold storage (hardware wallet, paper backup)');
console.log();
console.log('='.repeat(80));
