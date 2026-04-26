/**
 * Tests for network passphrase validation in stellar.js.
 * Asserts that a testnet-signed XDR is rejected when the server is configured for mainnet.
 */

describe('validateNetworkPassphrase', () => {
  const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
  const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

  function loadStellar(network) {
    jest.resetModules();
    process.env.STELLAR_NETWORK = network;
    process.env.STELLAR_HORIZON_URL =
      network === 'mainnet'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org';
    return require('../src/services/stellar');
  }

  afterEach(() => {
    jest.resetModules();
  });

  test('does not throw when passphrase matches testnet config', () => {
    const stellar = loadStellar('testnet');
    expect(() => stellar.validateNetworkPassphrase(TESTNET_PASSPHRASE)).not.toThrow();
  });

  test('does not throw when passphrase matches mainnet config', () => {
    const stellar = loadStellar('mainnet');
    expect(() => stellar.validateNetworkPassphrase(MAINNET_PASSPHRASE)).not.toThrow();
  });

  test('throws when testnet-signed XDR is submitted to mainnet-configured server', () => {
    const stellar = loadStellar('mainnet');
    expect(() => stellar.validateNetworkPassphrase(TESTNET_PASSPHRASE)).toThrow(
      /Network passphrase mismatch/
    );
  });

  test('throws when mainnet-signed XDR is submitted to testnet-configured server', () => {
    const stellar = loadStellar('testnet');
    expect(() => stellar.validateNetworkPassphrase(MAINNET_PASSPHRASE)).toThrow(
      /Network passphrase mismatch/
    );
  });

  test('thrown error has status 400', () => {
    const stellar = loadStellar('mainnet');
    try {
      stellar.validateNetworkPassphrase(TESTNET_PASSPHRASE);
      fail('Expected error to be thrown');
    } catch (err) {
      expect(err.status).toBe(400);
    }
  });

  test('does not throw when passphrase is undefined (no XDR passphrase to check)', () => {
    const stellar = loadStellar('testnet');
    expect(() => stellar.validateNetworkPassphrase(undefined)).not.toThrow();
  });
});

describe('validateEnv passphrase mismatch detection', () => {
  let exitMock;
  let errorMock;

  beforeEach(() => {
    jest.resetModules();
    exitMock = jest.spyOn(process, 'exit').mockImplementation(() => {});
    errorMock = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('exits and logs passphrase mismatch risk when mainnet URL used with testnet network', () => {
    process.env = {
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      JWT_SECRET: 'secret',
      ENCRYPTION_KEY: '01234567890123456789012345678901',
      STELLAR_NETWORK: 'testnet',
      STELLAR_HORIZON_URL: 'https://horizon.stellar.org', // mainnet URL with testnet config
      FRONTEND_URL: 'http://localhost:3000',
    };

    require('../src/utils/validateEnv')();

    expect(exitMock).toHaveBeenCalledWith(1);
    const logged = errorMock.mock.calls.flat().join(' ');
    expect(logged).toMatch(/STELLAR_HORIZON_URL does not match/);
  });

  test('exits and logs passphrase mismatch risk when testnet URL used with mainnet network', () => {
    process.env = {
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      JWT_SECRET: 'secret',
      ENCRYPTION_KEY: '01234567890123456789012345678901',
      STELLAR_NETWORK: 'mainnet',
      STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org', // testnet URL with mainnet config
      FRONTEND_URL: 'http://localhost:3000',
    };

    require('../src/utils/validateEnv')();

    expect(exitMock).toHaveBeenCalledWith(1);
    const logged = errorMock.mock.calls.flat().join(' ');
    expect(logged).toMatch(/passphrase mismatch risk/);
  });
});
