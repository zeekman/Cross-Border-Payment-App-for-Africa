/**
 * BE-191: smoke test that the Express app module loads. A truncated or
 * badly-merged source file anywhere in the require graph of src/app.js makes
 * this fail with a SyntaxError instead of letting the container boot-loop.
 */
process.env.JWT_SECRET = 'test_secret';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.STELLAR_NETWORK = 'testnet';
process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';

jest.mock('../src/db');
jest.mock('../src/services/email');
jest.mock('../src/utils/validateEnv', () => jest.fn());

test('require("./src/app") succeeds and exports an Express app', () => {
  let app;
  expect(() => {
    app = require('../src/app');
  }).not.toThrow();
  expect(typeof app).toBe('function');
  expect(typeof app.use).toBe('function');
});
