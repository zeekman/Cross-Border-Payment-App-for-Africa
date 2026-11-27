const bcrypt = require('bcryptjs');

const PIN_MIN_LENGTH = 4;
const PIN_MAX_LENGTH = 6;

// Most common real-world PINs (4 and 6 digits).
const COMMON_PINS = new Set([
  '1234', '0000', '1111', '1212', '7777', '1004', '2000', '4444', '2222', '6969',
  '9999', '3333', '5555', '6666', '1122', '1313', '8888', '4321', '2001', '1010',
  '2580', '0852', '1230', '0123', '1998', '1999', '2468', '1357', '1236', '0007',
  '123456', '000000', '111111', '121212', '123123', '654321', '666666', '696969',
  '112233', '159753', '789456', '123321', '222222', '555555', '777777', '888888',
  '999999', '101010', '202020', '147258', '258369', '102030', '131313', '123654',
]);

const PIN_POLICY = {
  min_length: PIN_MIN_LENGTH,
  max_length: PIN_MAX_LENGTH,
  recommended_length: 6,
  rules: [
    { code: 'repeated', description: 'PIN cannot be the same digit repeated (e.g. 0000)' },
    { code: 'sequential', description: 'PIN cannot be an ascending or descending run (e.g. 1234, 9876)' },
    { code: 'common', description: 'PIN cannot be one of the most commonly used PINs' },
    { code: 'personal', description: 'PIN cannot be your birth year or date of birth (YYYY, DDMM, MMDD)' },
  ],
};

/**
 * Validate PIN format (4-6 digits)
 */
function validatePIN(pin) {
  return typeof pin === 'string' && /^\d{4,6}$/.test(pin);
}

function isSequential(pin) {
  const d = pin.split('').map(Number);
  const asc = d.every((v, i) => i === 0 || v === (d[i - 1] + 1) % 10);
  const desc = d.every((v, i) => i === 0 || v === (d[i - 1] + 9) % 10);
  return asc || desc;
}

function personalPatterns(dob) {
  if (!dob) return [];
  const date = new Date(dob);
  if (Number.isNaN(date.getTime())) return [];
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return [yyyy, dd + mm, mm + dd, dd + mm + yyyy.slice(2), mm + dd + yyyy.slice(2)];
}

/**
 * Check PIN strength. Returns null when acceptable, or a reason code:
 * 'repeated' | 'sequential' | 'common' | 'personal'.
 * Only applied when setting a new PIN — existing PINs keep working.
 */
function checkPINStrength(pin, { dateOfBirth } = {}) {
  if (/^(\d)\1+$/.test(pin)) return 'repeated';
  if (isSequential(pin)) return 'sequential';
  if (COMMON_PINS.has(pin)) return 'common';
  if (personalPatterns(dateOfBirth).includes(pin)) return 'personal';
  return null;
}

/**
 * Hash a PIN using bcrypt
 */
async function hashPIN(pin) {
  if (!validatePIN(pin)) {
    throw new Error('PIN must be 4-6 digits');
  }
  return bcrypt.hash(pin, 12);
}

/**
 * Compare a PIN with its hash
 */
async function comparePIN(pin, hash) {
  if (!validatePIN(pin)) {
    return false;
  }
  return bcrypt.compare(pin, hash);
}

module.exports = {
  validatePIN,
  checkPINStrength,
  hashPIN,
  comparePIN,
  PIN_POLICY,
};
