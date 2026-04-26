/**
 * Unit tests for path-payment functions in stellar.js
 * All Horizon calls are mocked — no real network traffic.
 */

const mockStrictSendPaths = jest.fn();
const mockSubmitTransaction = jest.fn();
const mockLoadAccount = jest.fn();
const mockFetchBaseFee = jest.fn().mockResolvedValue(100);

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        strictSendPaths: mockStrictSendPaths,
        loadAccount: mockLoadAccount,
        fetchBaseFee: mockFetchBaseFee,
        submitTransaction: mockSubmitTransaction,
      })),
    },
  };
});

global.fetch = jest.fn().mockResolvedValue({ ok: true });

process.env.ENCRYPTION_KEY  = 'test-encryption-key-32-bytes!!!!!';
process.env.STELLAR_NETWORK = 'testnet';
process.env.USDC_ISSUER     = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const StellarSdk = require('@stellar/stellar-sdk');
const stellar    = require('../services/stellar');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function encryptSecret(secret) {
  const crypto = require('crypto');
  const key    = Buffer.from(process.env.ENCRYPTION_KEY, 'utf8').slice(0, 32);
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc    = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function buildMockAccount(publicKey) {
  let seq = BigInt(1000);
  return {
    id: publicKey,
    accountId: () => publicKey,
    sequenceNumber: () => String(seq),
    incrementSequenceNumber: () => { seq += BigInt(1); },
    balances: [
      { asset_type: 'native', balance: '500.0000000' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC',
        asset_issuer: process.env.USDC_ISSUER, balance: '100.0000000' },
    ],
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false },
    signers: [{ key: publicKey, weight: 1 }],
  };
}

const senderKp    = StellarSdk.Keypair.random();
const recipientKp = StellarSdk.Keypair.random();
const encSecret   = encryptSecret(senderKp.secret());

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchBaseFee.mockResolvedValue(100);
  mockSubmitTransaction.mockResolvedValue({ hash: 'path-tx-hash', ledger: 55 });
  mockLoadAccount.mockResolvedValue(buildMockAccount(senderKp.publicKey()));
});

// ---------------------------------------------------------------------------
// findPaymentPath
// ---------------------------------------------------------------------------
describe('findPaymentPath', () => {
  const mockPathRecord = {
    destination_amount: '9.8500000',
    path: [{ asset_type: 'native' }],
  };

  function mockPaths(records) {
    mockStrictSendPaths.mockReturnValue({
      call: jest.fn().mockResolvedValue({ records }),
    });
  }

  test('returns destinationAmount and path for a valid route', async () => {
    mockPaths([mockPathRecord]);
    const result = await stellar.findPaymentPath('XLM', '100', 'USDC', recipientKp.publicKey());
    expect(result).toEqual({ destinationAmount: '9.8500000', path: mockPathRecord.path });
  });

  test('returns null when no paths are found', async () => {
    mockPaths([]);
    const result = await stellar.findPaymentPath('XLM', '100', 'USDC', recipientKp.publicKey());
    expect(result).toBeNull();
  });

  test('picks the record with the highest destination_amount', async () => {
    mockPaths([
      { destination_amount: '9.5000000', path: [] },
      { destination_amount: '10.2000000', path: [{ asset_type: 'native' }] },
      { destination_amount: '8.0000000', path: [] },
    ]);
    const result = await stellar.findPaymentPath('XLM', '100', 'USDC', recipientKp.publicKey());
    expect(result.destinationAmount).toBe('10.2000000');
  });

  test('calls strictSendPaths with correct source asset and amount', async () => {
    mockPaths([mockPathRecord]);
    await stellar.findPaymentPath('XLM', '50', 'USDC', recipientKp.publicKey());
    expect(mockStrictSendPaths).toHaveBeenCalledWith(
      StellarSdk.Asset.native(),
      '50',
      expect.any(Array),
    );
  });

  test('throws when source asset issuer is not configured', async () => {
    delete process.env.NGN_ISSUER;
    await expect(
      stellar.findPaymentPath('NGN', '100', 'USDC', recipientKp.publicKey())
    ).rejects.toMatchObject({ status: 500 });
  });
});

// ---------------------------------------------------------------------------
// sendPathPayment
// ---------------------------------------------------------------------------
describe('sendPathPayment', () => {
  const baseArgs = {
    senderPublicKey:      senderKp.publicKey(),
    encryptedSecretKey:   encSecret,
    recipientPublicKey:   recipientKp.publicKey(),
    sourceAsset:          'XLM',
    sourceAmount:         '100',
    destinationAsset:     'USDC',
    destinationMinAmount: '9.75',
    path:                 [],
  };

  test('returns transactionHash and ledger on success', async () => {
    const result = await stellar.sendPathPayment(baseArgs);
    expect(result).toEqual({ transactionHash: 'path-tx-hash', ledger: 55 });
  });

  test('calls submitTransaction exactly once', async () => {
    await stellar.sendPathPayment(baseArgs);
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });

  test('submitted transaction contains a pathPaymentStrictSend operation', async () => {
    let capturedTx;
    mockSubmitTransaction.mockImplementation((tx) => {
      capturedTx = tx;
      return Promise.resolve({ hash: 'captured-hash', ledger: 1 });
    });

    await stellar.sendPathPayment(baseArgs);

    const ops = capturedTx.operations;
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('pathPaymentStrictSend');
    expect(ops[0].sendAmount).toBe('100');
    expect(ops[0].destMin).toBe('9.75');
  });

  test('applies slippage correctly — destMin reflects the provided value', async () => {
    let capturedTx;
    mockSubmitTransaction.mockImplementation((tx) => {
      capturedTx = tx;
      return Promise.resolve({ hash: 'slippage-hash', ledger: 2 });
    });

    await stellar.sendPathPayment({ ...baseArgs, destinationMinAmount: '9.65' });
    expect(capturedTx.operations[0].destMin).toBe('9.65');
  });

  test('propagates Horizon submission errors', async () => {
    mockSubmitTransaction.mockRejectedValue(new Error('tx_no_destination'));
    await expect(stellar.sendPathPayment(baseArgs)).rejects.toThrow('tx_no_destination');
  });

  test('throws 500 when destination asset issuer is not configured', async () => {
    delete process.env.NGN_ISSUER;
    await expect(
      stellar.sendPathPayment({ ...baseArgs, destinationAsset: 'NGN' })
    ).rejects.toMatchObject({ status: 500 });
    // Restore
    process.env.USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  });

  test('adds memo when provided', async () => {
    let capturedTx;
    mockSubmitTransaction.mockImplementation((tx) => {
      capturedTx = tx;
      return Promise.resolve({ hash: 'memo-hash', ledger: 3 });
    });

    await stellar.sendPathPayment({ ...baseArgs, memo: 'school fees' });
    expect(capturedTx.memo.value.toString()).toBe('school fees');
  });
});
