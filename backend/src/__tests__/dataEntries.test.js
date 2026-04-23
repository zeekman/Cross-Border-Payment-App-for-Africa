/**
 * Tests for manageData (setDataEntry, getDataEntries) in stellar.js
 * and the ALLOWED_KEYS allowlist in walletController.js.
 */

const mockServer = {
  loadAccount: jest.fn(),
  fetchBaseFee: jest.fn().mockResolvedValue(100),
  submitTransaction: jest.fn().mockResolvedValue({ hash: 'testhash123', ledger: 1 }),
  transactions: jest.fn(),
};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: { Server: jest.fn().mockImplementation(() => mockServer) },
  };
});

global.fetch = jest.fn().mockResolvedValue({ ok: true });

const stellar = require('../services/stellar');
const StellarSdk = require('@stellar/stellar-sdk');
const { ALLOWED_KEYS } = require('../controllers/walletController');

const ENCRYPTION_KEY = 'test-encryption-key-32-bytes!!!!!';

function mockAccount(publicKey, dataAttr = {}) {
  return {
    id: publicKey,
    balances: [],
    data_attr: dataAttr,
    incrementSequenceNumber: jest.fn(),
    sequenceNumber: jest.fn().mockReturnValue('1'),
    accountId: jest.fn().mockReturnValue(publicKey),
  };
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.STELLAR_NETWORK = 'testnet';
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers — generate a real keypair + encrypted secret for tests
// ---------------------------------------------------------------------------
let testPublicKey, testEncryptedSecret;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  const kp = StellarSdk.Keypair.random();
  testPublicKey = kp.publicKey();
  testEncryptedSecret = stellar.decryptPrivateKey; // just verify it exists
  // Encrypt via round-trip: encrypt the secret using the same logic
  const crypto = require('crypto');
  const key = Buffer.from(ENCRYPTION_KEY, 'utf8').slice(0, 32);
  const iv = require('crypto').randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(kp.secret(), 'utf8'), cipher.final()]);
  testEncryptedSecret = iv.toString('hex') + ':' + enc.toString('hex');
  testPublicKey = kp.publicKey();
});

// ---------------------------------------------------------------------------
// setDataEntry — sets a value
// ---------------------------------------------------------------------------
test('setDataEntry submits a manageData transaction and returns hash', async () => {
  mockServer.loadAccount.mockResolvedValue(mockAccount(testPublicKey));

  const result = await stellar.setDataEntry({
    publicKey: testPublicKey,
    encryptedSecretKey: testEncryptedSecret,
    key: 'kyc_hash',
    value: 'abc123',
  });

  expect(result.transactionHash).toBe('testhash123');
  expect(mockServer.submitTransaction).toHaveBeenCalledTimes(1);

  const tx = mockServer.submitTransaction.mock.calls[0][0];
  const op = tx.operations[0];
  expect(op.type).toBe('manageData');
  expect(op.name).toBe('kyc_hash');
  expect(op.value.toString('utf8')).toBe('abc123');
});

// ---------------------------------------------------------------------------
// setDataEntry — deletes when value is null
// ---------------------------------------------------------------------------
test('setDataEntry sends null value to delete the entry', async () => {
  mockServer.loadAccount.mockResolvedValue(mockAccount(testPublicKey));

  await stellar.setDataEntry({
    publicKey: testPublicKey,
    encryptedSecretKey: testEncryptedSecret,
    key: 'kyc_hash',
    value: null,
  });

  const tx = mockServer.submitTransaction.mock.calls[0][0];
  const op = tx.operations[0];
  expect(op.type).toBe('manageData');
  expect(op.name).toBe('kyc_hash');
  expect(op.value).toBeNull();
});

// ---------------------------------------------------------------------------
// getDataEntries — decodes base64 values
// ---------------------------------------------------------------------------
test('getDataEntries returns decoded key-value pairs', async () => {
  const dataAttr = {
    kyc_hash: Buffer.from('abc123').toString('base64'),
    federation_address: Buffer.from('user*afripay.io').toString('base64'),
  };
  mockServer.loadAccount.mockResolvedValue(mockAccount(testPublicKey, dataAttr));

  const entries = await stellar.getDataEntries(testPublicKey);

  expect(entries).toEqual(
    expect.arrayContaining([
      { key: 'kyc_hash', value: 'abc123' },
      { key: 'federation_address', value: 'user*afripay.io' },
    ])
  );
});

// ---------------------------------------------------------------------------
// getDataEntries — empty account
// ---------------------------------------------------------------------------
test('getDataEntries returns empty array when no data entries exist', async () => {
  mockServer.loadAccount.mockResolvedValue(mockAccount(testPublicKey, {}));
  const entries = await stellar.getDataEntries(testPublicKey);
  expect(entries).toEqual([]);
});

// ---------------------------------------------------------------------------
// ALLOWED_KEYS allowlist
// ---------------------------------------------------------------------------
test('ALLOWED_KEYS contains expected keys', () => {
  expect(ALLOWED_KEYS.has('kyc_hash')).toBe(true);
  expect(ALLOWED_KEYS.has('federation_address')).toBe(true);
  expect(ALLOWED_KEYS.has('afripay_verified')).toBe(true);
});

test('ALLOWED_KEYS rejects arbitrary keys', () => {
  expect(ALLOWED_KEYS.has('__proto__')).toBe(false);
  expect(ALLOWED_KEYS.has('admin')).toBe(false);
  expect(ALLOWED_KEYS.has('random_key')).toBe(false);
});
