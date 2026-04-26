/**
 * horizon-validation.test.js
 *
 * Tests that stellar.js throws HorizonValidationError when Horizon returns
 * malformed / unexpected data, and that valid responses still pass through.
 *
 * All Horizon network calls are fully mocked — no real traffic.
 */

// ---------------------------------------------------------------------------
// Mock Horizon server — defined before jest.mock hoisting
// ---------------------------------------------------------------------------
const mockServer = {
  loadAccount: jest.fn(),
  fetchBaseFee: jest.fn().mockResolvedValue(100),
  submitTransaction: jest.fn(),
  transactions: jest.fn(),
  strictSendPaths: jest.fn(),
};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => mockServer),
    },
  };
});

global.fetch = jest.fn().mockResolvedValue({ ok: true });

// ---------------------------------------------------------------------------
// Load modules AFTER mocks
// ---------------------------------------------------------------------------
const stellar = require('../services/stellar');
const StellarSdk = require('@stellar/stellar-sdk');
const { HorizonValidationError } = require('../utils/horizonSchemas');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ENCRYPTION_KEY = 'test-encryption-key-32-bytes!!!!!';

function setEnv() {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.STELLAR_NETWORK = 'testnet';
  // USDC_ISSUER is set per-suite where needed; clear it here to avoid cross-test pollution
}

function encryptSecret(secret) {
  const crypto = require('crypto');
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'utf8').slice(0, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

/** Minimal valid account mock that TransactionBuilder can use */
function validAccount(publicKey) {
  let seq = BigInt(1000);
  return {
    id: publicKey,
    balances: [{ asset_type: 'native', balance: '100.0000000' }],
    sequence: '1000',
    accountId: () => publicKey,
    sequenceNumber: () => String(seq),
    incrementSequenceNumber: () => { seq += BigInt(1); },
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false },
    signers: [{ key: publicKey, weight: 1 }],
  };
}

/** Minimal valid submit response */
const VALID_SUBMIT = {
  hash: 'a'.repeat(64),
  ledger: 1234,
};

beforeEach(() => {
  setEnv();
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});

// ===========================================================================
// getBalance — loadAccount response validation
// ===========================================================================
describe('getBalance — malformed Horizon account response', () => {
  const PK = StellarSdk.Keypair.random().publicKey();

  test('throws HorizonValidationError when balances field is missing', async () => {
    mockServer.loadAccount.mockResolvedValue({ id: PK }); // no balances
    await expect(stellar.getBalance(PK)).rejects.toThrow(HorizonValidationError);
  });

  test('throws HorizonValidationError when id field is missing', async () => {
    mockServer.loadAccount.mockResolvedValue({ balances: [] }); // no id
    await expect(stellar.getBalance(PK)).rejects.toThrow(HorizonValidationError);
  });

  test('throws HorizonValidationError when balance entry has non-numeric balance', async () => {
    mockServer.loadAccount.mockResolvedValue({
      id: PK,
      balances: [{ asset_type: 'native', balance: 'not-a-number' }],
    });
    await expect(stellar.getBalance(PK)).rejects.toThrow(HorizonValidationError);
  });

  test('throws HorizonValidationError when asset_type is an unknown value', async () => {
    mockServer.loadAccount.mockResolvedValue({
      id: PK,
      balances: [{ asset_type: 'exotic_unknown', balance: '10.0000000' }],
    });
    await expect(stellar.getBalance(PK)).rejects.toThrow(HorizonValidationError);
  });

  test('throws HorizonValidationError when Horizon returns null', async () => {
    mockServer.loadAccount.mockResolvedValue(null);
    await expect(stellar.getBalance(PK)).rejects.toThrow(HorizonValidationError);
  });

  test('throws HorizonValidationError when Horizon returns a plain string', async () => {
    mockServer.loadAccount.mockResolvedValue('unexpected string');
    await expect(stellar.getBalance(PK)).rejects.toThrow(HorizonValidationError);
  });

  test('error message contains the label "loadAccount"', async () => {
    mockServer.loadAccount.mockResolvedValue({ id: PK }); // missing balances
    await expect(stellar.getBalance(PK)).rejects.toMatchObject({
      message: expect.stringContaining('loadAccount'),
    });
  });

  test('error has status 502', async () => {
    mockServer.loadAccount.mockResolvedValue({ id: PK });
    await expect(stellar.getBalance(PK)).rejects.toMatchObject({ status: 502 });
  });

  test('still returns [] for a genuine 404 (unfunded account)', async () => {
    mockServer.loadAccount.mockRejectedValue({ response: { status: 404 } });
    await expect(stellar.getBalance(PK)).resolves.toEqual([]);
  });

  test('passes through valid account with extra unknown fields', async () => {
    mockServer.loadAccount.mockResolvedValue({
      id: PK,
      balances: [{ asset_type: 'native', balance: '50.0000000' }],
      some_future_field: 'ignored',
    });
    const result = await stellar.getBalance(PK);
    expect(result).toEqual([{ asset: 'XLM', balance: '50.0000000' }]);
  });

  test('passes through valid multi-asset account', async () => {
    mockServer.loadAccount.mockResolvedValue({
      id: PK,
      balances: [
        { asset_type: 'native', balance: '100.0000000' },
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GISSUER', balance: '25.0000000', limit: '1000.0000000' },
      ],
    });
    const result = await stellar.getBalance(PK);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ asset: 'XLM', balance: '100.0000000' });
    expect(result).toContainEqual({ asset: 'USDC', balance: '25.0000000' });
  });
});

// ===========================================================================
// sendPayment — submitTransaction response validation
// ===========================================================================
describe('sendPayment — malformed submitTransaction response', () => {
  let keypair, encryptedSecret, recipient;

  beforeEach(() => {
    keypair = StellarSdk.Keypair.random();
    recipient = StellarSdk.Keypair.random().publicKey();
    encryptedSecret = encryptSecret(keypair.secret());
    mockServer.loadAccount.mockResolvedValue(validAccount(keypair.publicKey()));
    mockServer.fetchBaseFee.mockResolvedValue(100);
  });

  test('throws HorizonValidationError when hash is missing', async () => {
    mockServer.submitTransaction.mockResolvedValue({ ledger: 42 });
    await expect(stellar.sendPayment({
      senderPublicKey: keypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipient,
      amount: '10',
      asset: 'XLM',
    })).rejects.toThrow(HorizonValidationError);
  });

  test('throws HorizonValidationError when hash is not 64 hex chars', async () => {
    mockServer.submitTransaction.mockResolvedValue({ hash: 'tooshort', ledger: 42 });
    await expect(stellar.sendPayment({
      senderPublicKey: keypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipient,
      amount: '10',
      asset: 'XLM',
    })).rejects.toThrow(HorizonValidationError);
  });

  test('throws HorizonValidationError when hash contains uppercase hex', async () => {
    mockServer.submitTransaction.mockResolvedValue({ hash: 'A'.repeat(64), ledger: 42 });
    await expect(stellar.sendPayment({
      senderPublicKey: keypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipient,
      amount: '10',
      asset: 'XLM',
    })).rejects.toThrow(HorizonValidationError);
  });

  test('throws HorizonValidationError when ledger is missing', async () => {
    mockServer.submitTransaction.mockResolvedValue({ hash: 'a'.repeat(64) });
    await expect(stellar.sendPayment({
      senderPublicKey: keypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipient,
      amount: '10',
      asset: 'XLM',
    })).rejects.toThrow(HorizonValidationError);
  });

  test('throws HorizonValidationError when ledger is a string instead of number', async () => {
    mockServer.submitTransaction.mockResolvedValue({ hash: 'a'.repeat(64), ledger: '42' });
    await expect(stellar.sendPayment({
      senderPublicKey: keypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipient,
      amount: '10',
      asset: 'XLM',
    })).rejects.toThrow(HorizonValidationError);
  });

  test('throws HorizonValidationError when submitTransaction returns null', async () => {
    mockServer.submitTransaction.mockResolvedValue(null);
    await expect(stellar.sendPayment({
      senderPublicKey: keypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipient,
      amount: '10',
      asset: 'XLM',
    })).rejects.toThrow(HorizonValidationError);
  });

  test('error has status 502', async () => {
    mockServer.submitTransaction.mockResolvedValue({ ledger: 42 }); // missing hash
    await expect(stellar.sendPayment({
      senderPublicKey: keypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipient,
      amount: '10',
      asset: 'XLM',
    })).rejects.toMatchObject({ status: 502 });
  });

  test('succeeds with valid response including extra fields', async () => {
    mockServer.submitTransaction.mockResolvedValue({
      hash: 'b'.repeat(64),
      ledger: 99,
      result_xdr: 'some_xdr_string', // extra field — should passthrough
    });
    const result = await stellar.sendPayment({
      senderPublicKey: keypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipient,
      amount: '10',
      asset: 'XLM',
    });
    expect(result).toMatchObject({ transactionHash: 'b'.repeat(64), ledger: 99 });
  });
});

// ===========================================================================
// getTransactions — transaction page response validation
// ===========================================================================
describe('getTransactions — malformed Horizon transaction page', () => {
  const PK = StellarSdk.Keypair.random().publicKey();

  function mockTxChain(resolvedValue) {
    mockServer.transactions = jest.fn().mockReturnValue({
      forAccount: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      call: jest.fn().mockResolvedValue(resolvedValue),
    });
  }

  test('returns [] when records field is missing (swallowed by catch)', async () => {
    mockTxChain({ not_records: [] });
    const result = await stellar.getTransactions(PK);
    expect(result).toEqual([]);
  });

  test('returns [] when a record is missing hash (swallowed by catch)', async () => {
    mockTxChain({
      records: [{ id: '1', created_at: '2024-01-01', successful: true }], // no hash
    });
    const result = await stellar.getTransactions(PK);
    expect(result).toEqual([]);
  });

  test('returns [] when a record has a malformed hash', async () => {
    mockTxChain({
      records: [{ id: '1', hash: 'badhash', created_at: '2024-01-01', successful: true }],
    });
    const result = await stellar.getTransactions(PK);
    expect(result).toEqual([]);
  });

  test('returns [] when Horizon returns null', async () => {
    mockTxChain(null);
    const result = await stellar.getTransactions(PK);
    expect(result).toEqual([]);
  });

  test('maps valid records correctly', async () => {
    mockTxChain({
      records: [
        { id: '1', hash: 'c'.repeat(64), created_at: '2024-06-01T00:00:00Z', successful: true, memo: 'hello' },
        { id: '2', hash: 'd'.repeat(64), created_at: '2024-06-02T00:00:00Z', successful: false },
      ],
    });
    const result = await stellar.getTransactions(PK);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: '1',
      hash: 'c'.repeat(64),
      createdAt: '2024-06-01T00:00:00Z',
      memo: 'hello',
      successful: true,
    });
    expect(result[1].memo).toBeUndefined();
  });
});

// ===========================================================================
// findPaymentPath — path page response validation
// ===========================================================================
describe('findPaymentPath — malformed strictSendPaths response', () => {
  // Use a real Stellar keypair public key as the USDC issuer — the SDK validates format
  const VALID_ISSUER = StellarSdk.Keypair.random().publicKey();

  beforeEach(() => {
    process.env.USDC_ISSUER = VALID_ISSUER;
  });

  function mockPaths(resolvedValue) {
    mockServer.strictSendPaths = jest.fn().mockReturnValue({
      call: jest.fn().mockResolvedValue(resolvedValue),
    });
  }

  test('throws HorizonValidationError when records field is missing', async () => {
    mockPaths({ not_records: [] });
    await expect(stellar.findPaymentPath('XLM', '10', 'USDC')).rejects.toThrow(HorizonValidationError);
  });

  test('throws HorizonValidationError when destination_amount is non-numeric', async () => {
    mockPaths({
      records: [{ destination_amount: 'bad', path: [] }],
    });
    await expect(stellar.findPaymentPath('XLM', '10', 'USDC')).rejects.toThrow(HorizonValidationError);
  });

  test('throws HorizonValidationError when Horizon returns null', async () => {
    mockPaths(null);
    await expect(stellar.findPaymentPath('XLM', '10', 'USDC')).rejects.toThrow(HorizonValidationError);
  });

  test('returns null when records array is empty (no path found)', async () => {
    mockPaths({ records: [] });
    const result = await stellar.findPaymentPath('XLM', '10', 'USDC');
    expect(result).toBeNull();
  });

  test('returns best path for valid response', async () => {
    mockPaths({
      records: [
        { destination_amount: '9.5000000', path: [] },
        { destination_amount: '10.2000000', path: [{ asset_type: 'native' }] },
      ],
    });
    const result = await stellar.findPaymentPath('XLM', '10', 'USDC');
    expect(result).toMatchObject({ destinationAmount: '10.2000000' });
  });
});

// ===========================================================================
// HorizonValidationError — class contract
// ===========================================================================
describe('HorizonValidationError', () => {
  test('is an instance of Error', () => {
    const err = new HorizonValidationError('test', {});
    expect(err).toBeInstanceOf(Error);
  });

  test('has status 502', () => {
    const err = new HorizonValidationError('test', {});
    expect(err.status).toBe(502);
  });

  test('has name HorizonValidationError', () => {
    const err = new HorizonValidationError('test', {});
    expect(err.name).toBe('HorizonValidationError');
  });

  test('carries context payload', () => {
    const ctx = { label: 'loadAccount', issues: [{ path: ['id'], message: 'Required' }] };
    const err = new HorizonValidationError('msg', ctx);
    expect(err.context).toEqual(ctx);
  });
});
