const EXPECTED_HORIZON_URLS = {
  mainnet: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org'
};

const REQUIRED_STRING_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'STELLAR_NETWORK',
  'STELLAR_HORIZON_URL'
];

function isSet(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAmlConfigured() {
  return isSet(process.env.AML_PROVIDER) && isSet(process.env.AML_API_KEY);
}

// Clawback (POST /api/admin/clawback, adminController.js#clawback) reads
// these directly from process.env with no fallback. If either is missing
// the endpoint previously only failed at *request* time with a 500,
// silently leaving a compliance-critical admin capability broken. In
// production these are required at boot so misconfiguration is caught
// before traffic is served (BE-040).
const CLAWBACK_REQUIRED_VARS_PRODUCTION = [
  'ISSUER_PUBLIC_KEY',
  'ISSUER_ENCRYPTED_SECRET_KEY',
];

/**
 * Validates required configuration before the server listens.
 * Never logs secret values — only variable names.
 */
function validateEnv() {
  const checkPositiveInt = (varName) => {
    if (process.env[varName]) {
      const val = Number(process.env[varName]);
      if (!Number.isInteger(val) || val <= 0) {
        console.error(
          `\\x1b[31m[CONFIG ERROR] ${varName} must be a positive integer.\\x1b[0m`
        );
        process.exit(1);
      }
    }
  };

  checkPositiveInt('FRAUD_VELOCITY_WINDOW');
  checkPositiveInt('FRAUD_UNIQUE_RECIPIENTS_WINDOW');

  const missing = REQUIRED_STRING_VARS.filter((name) => !isSet(process.env[name]));

  if (missing.length > 0) {
    console.error(
      '\x1b[31m[CONFIG ERROR] Missing required environment variables:\x1b[0m',
      missing.join(', ')
    );
    console.error(
      '\x1b[31mSet them in .env or your deployment environment, then restart.\x1b[0m'
    );
    process.exit(1);
    return;
  }

  // ENCRYPTION_KEY length enforcement.
  // All five Soroban-facing services derive a 32-byte AES key via SHA-256
  // (deriveAesKey in utils/symmetricEncryption.js). Any printable string of
  // ≥ 16 chars works, but shorter secrets have inadequate entropy.
  const encKey = process.env.ENCRYPTION_KEY;
  if (encKey && encKey.length < 16) {
    console.error(
      `\x1b[31m[CONFIG ERROR] ENCRYPTION_KEY is too short (${encKey.length} chars). ` +
      'Minimum 16 characters required; 32+ strongly recommended.\x1b[0m'
    );
    process.exit(1);
    return;
  }
  if (encKey && encKey.length < 32) {
    console.warn(
      `\x1b[33m[CONFIG WARNING] ENCRYPTION_KEY is only ${encKey.length} chars. ` +
      '32+ characters are strongly recommended for adequate entropy.\x1b[0m'
    );
  }

  if (!isSet(process.env.FRONTEND_URL)) {
    console.warn(
      '\x1b[33m[CONFIG WARNING] FRONTEND_URL is not set. CORS and email links may not work as expected.\x1b[0m'
    );
  }

  if (process.env.NODE_ENV === 'production' && !isAmlConfigured()) {
    console.warn(
      '\x1b[33m[CONFIG WARNING] AML/sanctions screening is NOT configured (set AML_PROVIDER and AML_API_KEY). ' +
      'KYC wallets will be flagged as not_screened and high-value payments (>= $1000 USD) will be BLOCKED.\x1b[0m'
    );
  }

  // Clawback secrets are hard-required in production — this is a
  // regulatory/compliance capability and must fail fast at boot rather
  // than 500 on first use.
  if (process.env.NODE_ENV === 'production') {
    const missingClawback = CLAWBACK_REQUIRED_VARS_PRODUCTION.filter(
      (name) => !isSet(process.env[name])
    );
    if (missingClawback.length > 0) {
      console.error(
        '\x1b[31m[CONFIG ERROR] Missing required clawback environment variables:\x1b[0m',
        missingClawback.join(', ')
      );
      console.error(
        '\x1b[31mPOST /api/admin/clawback requires ISSUER_PUBLIC_KEY and ISSUER_ENCRYPTED_SECRET_KEY to be set in production.\x1b[0m'
      );
      process.exit(1);
      return;
    }
  }

  if (!isSet(process.env.AFRI_ISSUER_PUBLIC) || !isSet(process.env.AFRI_ISSUER_SECRET)) {
    console.warn(
      '\x1b[33m[CONFIG WARNING] AFRI_ISSUER_PUBLIC and/or AFRI_ISSUER_SECRET are not set. POST /api/assets/issue will be unavailable.\x1b[0m'
    );
  }

  const network = process.env.STELLAR_NETWORK.trim();
  const horizonUrl = process.env.STELLAR_HORIZON_URL.trim().replace(/\/$/, '');
  const expectedHorizon = EXPECTED_HORIZON_URLS[network];

  if (expectedHorizon && horizonUrl !== expectedHorizon) {
    console.error(
      `\x1b[31m[CONFIG ERROR] STELLAR_HORIZON_URL does not match STELLAR_NETWORK="${network}". Expected "${expectedHorizon}".\x1b[0m`
    );
    console.error(
      `\x1b[31m[CONFIG ERROR] Network passphrase mismatch risk: a ${network === 'mainnet' ? 'testnet' : 'mainnet'}-signed ` +
      `transaction submitted to ${network} Horizon will be rejected or cause fund loss.\x1b[0m`
    );
    process.exit(1);
    return;
  }

  if (!expectedHorizon) {
    try {
      void new URL(horizonUrl);
    } catch {
      console.error(
        '\x1b[31m[CONFIG ERROR] STELLAR_HORIZON_URL must be a valid URL for the chosen STELLAR_NETWORK.\x1b[0m'
      );
      process.exit(1);
      return;
    }
  }

  if (network === 'mainnet') {
    console.log('\x1b[31m%s\x1b[0m', '');
    console.log('\x1b[31m%s\x1b[0m', '  ⚠️  WARNING: RUNNING ON STELLAR MAINNET  ⚠️');
    console.log('\x1b[31m%s\x1b[0m', '  Real funds are at risk. Double-check your configuration.');
    console.log('\x1b[31m%s\x1b[0m', '');
  }
}

module.exports = validateEnv;
