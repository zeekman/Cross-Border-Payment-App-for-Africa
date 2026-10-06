const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

async function generateSecret(email) {
  const secret = speakeasy.generateSecret({
    name: `AfriPay (${email})`,
    issuer: 'AfriPay',
    length: 32
  });

  const qrCode = await QRCode.toDataURL(secret.otpauth_url);
  return { secret: secret.base32, qrCode, otpauthUri: secret.otpauth_url };
}

function verifyToken(secret, token) {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 2
  });
}

/** Return the TOTP time-step counter matched by a code, or null when invalid. */
function getTokenCounter(secret, token, at = Date.now()) {
  const step = 30;
  const currentCounter = Math.floor(at / 1000 / step);
  const delta = speakeasy.totp.verifyDelta({
    secret,
    encoding: 'base32',
    token,
    time: Math.floor(at / 1000),
    step,
    window: 2
  });
  return delta ? currentCounter + delta.delta : null;
}

function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return codes;
}

function useBackupCode(codes, code) {
  const index = codes.indexOf(code);
  if (index === -1) return null;
  codes.splice(index, 1);
  return codes;
}

async function hashBackupCode(code) {
  return bcrypt.hash(code, 10);
}

async function verifyBackupCode(code, hash) {
  return bcrypt.compare(code, hash);
}

module.exports = {
  generateSecret,
  verifyToken,
  getTokenCounter,
  generateBackupCodes,
  useBackupCode,
  hashBackupCode,
  verifyBackupCode,
};
