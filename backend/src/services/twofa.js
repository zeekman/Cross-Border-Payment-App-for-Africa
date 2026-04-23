const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const crypto = require('crypto');

async function generateSecret(email) {
  const secret = speakeasy.generateSecret({
    name: `AfriPay (${email})`,
    issuer: 'AfriPay',
    length: 32
  });

  const qrCode = await QRCode.toDataURL(secret.otpauth_url);
  return { secret: secret.base32, qrCode };
}

function verifyToken(secret, token) {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 2
  });
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

module.exports = {
  generateSecret,
  verifyToken,
  generateBackupCodes,
  useBackupCode
};
