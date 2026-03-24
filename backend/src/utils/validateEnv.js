const EXPECTED_URLS = {
  mainnet: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
};

function validateEnv() {
  const network = process.env.STELLAR_NETWORK || 'testnet';
  const horizonUrl = process.env.STELLAR_HORIZON_URL || EXPECTED_URLS.testnet;
  const expected = EXPECTED_URLS[network];

  if (expected && horizonUrl.replace(/\/$/, '') !== expected) {
    console.error(
      `\x1b[31m[CONFIG ERROR] STELLAR_HORIZON_URL "${horizonUrl}" does not match STELLAR_NETWORK="${network}". Expected URL containing "${expected}".\x1b[0m`
    );
    process.exit(1);
  }

  if (network === 'mainnet') {
    console.log('\x1b[31m%s\x1b[0m', '');
    console.log('\x1b[31m%s\x1b[0m', '  ⚠️  WARNING: RUNNING ON STELLAR MAINNET  ⚠️');
    console.log('\x1b[31m%s\x1b[0m', '  Real funds are at risk. Double-check your configuration.');
    console.log('\x1b[31m%s\x1b[0m', '');
  }
}

module.exports = validateEnv;
