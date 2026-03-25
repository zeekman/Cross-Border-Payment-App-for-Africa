/**
 * validateEnv must run before the server listens; these tests load it in isolation
 * with jest.resetModules() so each case gets a fresh module and env slice.
 */

const baseRequired = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'jwt-test-secret',
  ENCRYPTION_KEY: '01234567890123456789012345678901',
  STELLAR_NETWORK: 'testnet',
  STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org'
};

describe('validateEnv', () => {
  let exitMock;
  let errorMock;
  let warnMock;
  let logMock;

  beforeEach(() => {
    jest.resetModules();
    exitMock = jest.spyOn(process, 'exit').mockImplementation(() => {});
    errorMock = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnMock = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logMock = jest.spyOn(console, 'log').mockImplementation(() => {});
    process.env = { ...baseRequired, FRONTEND_URL: 'http://localhost:3000' };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function runValidate() {
    require('../src/utils/validateEnv')();
  }

  test('does not exit when all required vars are set and Stellar URLs match', () => {
    runValidate();
    expect(exitMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });

  test('warns when FRONTEND_URL is unset but does not exit', () => {
    delete process.env.FRONTEND_URL;
    runValidate();
    expect(exitMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalled();
  });

  const requiredNames = [
    'DATABASE_URL',
    'JWT_SECRET',
    'ENCRYPTION_KEY',
    'STELLAR_NETWORK',
    'STELLAR_HORIZON_URL'
  ];

  test.each(requiredNames)('exits with code 1 when %s is missing', (name) => {
    delete process.env[name];
    runValidate();
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(errorMock).toHaveBeenCalled();
    const logged = errorMock.mock.calls.flat().join(' ');
    expect(logged).toContain(name);
    expect(logged).not.toContain('postgresql://');
    expect(logged).not.toContain('jwt-test-secret');
  });

  test('exits when STELLAR_HORIZON_URL does not match STELLAR_NETWORK=testnet', () => {
    process.env.STELLAR_HORIZON_URL = 'https://horizon.stellar.org';
    runValidate();
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  test('exits when custom STELLAR_NETWORK has invalid STELLAR_HORIZON_URL', () => {
    process.env.STELLAR_NETWORK = 'custom';
    process.env.STELLAR_HORIZON_URL = 'not-a-valid-url';
    runValidate();
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  test('allows custom STELLAR_NETWORK with a valid STELLAR_HORIZON_URL', () => {
    process.env.STELLAR_NETWORK = 'futurenet';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-futurenet.stellar.org';
    runValidate();
    expect(exitMock).not.toHaveBeenCalled();
  });
});
