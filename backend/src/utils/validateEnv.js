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

/**
 * Validates required configuration before the server listens.
 * Never logs secret values — only variable names.
 */
function validateEnv() {
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

  if (!isSet(process.env.FRONTEND_URL)) {
    console.warn(
      '\x1b[33m[CONFIG WARNING] FRONTEND_URL is not set. CORS and email links may not work as expected.\x1b[0m'
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
