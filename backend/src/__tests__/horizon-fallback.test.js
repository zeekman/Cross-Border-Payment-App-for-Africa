/**
 * Tests for Horizon fallback logic in stellar.js
 *
 * Verifies:
 * 1. Network error on primary → fallback node is used
 * 2. Stellar protocol error on primary → fallback is NOT triggered
 * 3. Both nodes fail with network errors → clear combined error thrown
 * 4. Correct node is logged per scenario
 */

// ---------------------------------------------------------------------------
// Mock Horizon — Server constructor returns primary on first call, fallback on second
// ---------------------------------------------------------------------------
const mockPrimary = {
  loadAccount: jest.fn(),
  fetchBaseFee: jest.fn().mockResolvedValue(100),
  submitTransaction: jest.fn(),
  transactions: jest.fn(),
  ledgers: jest.fn(),
  strictSendPaths: jest.fn(),
};

const mockFallback = {
  loadAccount: jest.fn(),
  fetchBaseFee: jest.fn().mockResolvedValue(100),
  submitTransaction: jest.fn(),
  transactions: jest.fn(),
  ledgers: jest.fn(),
  strictSendPaths: jest.fn(),
};

// Use a module-level array so the factory closure only references `mock*` vars
const mockServers = [mockPrimary, mockFallback];
let mockServerIndex = 0;

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      // Each call to new Server() returns the next server in mockServers
      Server: jest.fn().mockImplementation(() => mockServers[mockServerIndex++]),
    },
  };
});

global.fetch = jest.fn().mockResolvedValue({ ok: true });

// ---------------------------------------------------------------------------
// Load module AFTER mocks — env vars must be set first
// ---------------------------------------------------------------------------
beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'test-encryption-key-32-bytes!!!!!';
  process.env.STELLAR_NETWORK = 'testnet';
  process.env.STELLAR_HORIZON_URL = 'https://horizon-primary.example.com';
  process.env.STELLAR_HORIZON_FALLBACK_URL = 'https://horizon-fallback.example.com';
});

// Require lazily so env vars are set before module initialisation
const getStellar = () => require('../services/stellar');
const getLogger = () => require('../utils/logger');

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(getLogger(), 'warn').mockImplementation(() => {});
  jest.spyOn(getLogger(), 'info').mockImplementation(() => {});
  jest.spyOn(getLogger(), 'debug').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function networkError(msg = 'connect ECONNREFUSED') {
  const err = new Error(msg);
  err.code = 'ECONNREFUSED';
  return err;
}

function protocolError(resultCode = 'tx_bad_seq') {
  const err = new Error('Transaction submission failed');
  err.response = {
    status: 400,
    data: { extras: { result_codes: { transaction: resultCode } } },
  };
  return err;
}

// ---------------------------------------------------------------------------
// 1. Network error on primary → fallback is used
// ---------------------------------------------------------------------------
describe('Horizon failover — network error on primary', () => {
  test('getBalance uses fallback when primary throws a network error', async () => {
    mockPrimary.loadAccount.mockRejectedValue(networkError());
    mockFallback.loadAccount.mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '50.0000000' }],
    });

    const balances = await getStellar().getBalance('GTEST123');

    expect(mockPrimary.loadAccount).toHaveBeenCalledTimes(1);
    expect(mockFallback.loadAccount).toHaveBeenCalledTimes(1);
    expect(balances).toEqual([{ asset: 'XLM', balance: '50.0000000' }]);
  });

  test('logs a warning when falling back to secondary node', async () => {
    mockPrimary.loadAccount.mockRejectedValue(networkError('connect ECONNREFUSED'));
    mockFallback.loadAccount.mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '10.0000000' }],
    });

    await getStellar().getBalance('GTEST456');

    expect(getLogger().warn).toHaveBeenCalledWith(
      expect.stringContaining('Primary Horizon node unreachable'),
      expect.objectContaining({ fallbackUrl: 'https://horizon-fallback.example.com' })
    );
  });

  test('logs success on fallback node', async () => {
    mockPrimary.loadAccount.mockRejectedValue(networkError());
    mockFallback.loadAccount.mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '10.0000000' }],
    });

    await getStellar().getBalance('GTEST789');

    expect(getLogger().info).toHaveBeenCalledWith(
      expect.stringContaining('fallback node'),
      expect.objectContaining({ url: 'https://horizon-fallback.example.com' })
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Stellar protocol error on primary → fallback NOT triggered
// ---------------------------------------------------------------------------
describe('Horizon failover — protocol error on primary', () => {
  test('does NOT fall back on a Stellar protocol error (tx_bad_seq)', async () => {
    mockPrimary.loadAccount.mockRejectedValue(protocolError('tx_bad_seq'));

    await expect(getStellar().getBalance('GTEST_PROTO')).rejects.toThrow();

    expect(mockFallback.loadAccount).not.toHaveBeenCalled();
  });

  test('does NOT fall back on HTTP 400 from Horizon', async () => {
    mockPrimary.loadAccount.mockRejectedValue(protocolError('op_no_trust'));

    await expect(getStellar().getBalance('GTEST_400')).rejects.toThrow();

    expect(mockFallback.loadAccount).not.toHaveBeenCalled();
  });

  test('surfaces the original protocol error unchanged', async () => {
    mockPrimary.loadAccount.mockRejectedValue(protocolError('tx_insufficient_balance'));

    await expect(getStellar().getBalance('GTEST_SURF')).rejects.toMatchObject({
      response: { status: 400 },
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Both nodes fail with network errors → clear combined error
// ---------------------------------------------------------------------------
describe('Horizon failover — both nodes unavailable', () => {
  test('throws a combined error when both nodes fail', async () => {
    mockPrimary.loadAccount.mockRejectedValue(networkError('Primary ECONNREFUSED'));
    mockFallback.loadAccount.mockRejectedValue(networkError('Fallback ECONNREFUSED'));

    await expect(getStellar().getBalance('GTEST_BOTH')).rejects.toThrow(
      /Both Horizon nodes are unavailable/
    );
  });

  test('combined error message includes both failure reasons', async () => {
    mockPrimary.loadAccount.mockRejectedValue(networkError('Primary down'));
    mockFallback.loadAccount.mockRejectedValue(networkError('Fallback down'));

    let thrown;
    try {
      await getStellar().getBalance('GTEST_MSG');
    } catch (e) {
      thrown = e;
    }

    expect(thrown.message).toMatch(/Primary down/);
    expect(thrown.message).toMatch(/Fallback down/);
    expect(thrown.primaryError).toBeDefined();
    expect(thrown.fallbackError).toBeDefined();
  });
});
