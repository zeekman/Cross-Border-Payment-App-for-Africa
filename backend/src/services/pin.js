const bcrypt = require('bcryptjs');

/**
 * Validate PIN format (4-6 digits)
 */
function validatePIN(pin) {
  return /^\d{4,6}$/.test(pin);
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
  hashPIN,
  comparePIN,
};
