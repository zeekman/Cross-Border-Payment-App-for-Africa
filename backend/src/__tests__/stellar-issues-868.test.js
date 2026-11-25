/**
 * Tests for #868: services/stellar.js — duplicate withFallback wrapper
 * that swallowed all subsequent functions into an unreachable inner scope.
 *
 * The bug: two `async function withFallback(...)` declarations back-to-back,
 * the second nested inside the first's still-open body.  Every function
 * after the opening brace (createWallet, sendPayment, loadAccount helpers,
 * etc.) was scoped inside withFallback and never reached the module level.
 * Confirmed by: `node -e "require('./src/services/stellar.js')"` throwing
 * ReferenceError: createWallet is not defined at the module.exports statement.
 *
 * Acceptance criteria covered:
 *  ✓ require() succeeds — no ReferenceError at module.exports
 *  ✓ typeof module.createWallet === 'function'
 *  ✓ All other key exported functions are present and callable
 *  ✓ withFallback exists only once in the module source
 *  ✓ withFallback signature is the merged single version
 *  ✓ createWallet runs successfully (Friendbot mocked)
 */

// ---------------------------------------------------------------------------
// Mock all external dependencies so we can require stellar.js in unit tests
// ---------------------------------------------------------------------------
const mockServer = {
  loadAccount: jest.fn(),
  fetchBaseFee: jest.fn().mockResolvedValue(100),
  submitTransaction: jest.fn(),
  transactions: jest.fn(),
  feeStats: jest.fn(),
  ledgers: jest.fn(),
  assets: jest.fn(),
  operations: jest.fn(),
};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => mockServer),
    },
    SorobanRpc: {
      Server: jest.fn().mockImplementation(() => ({})),
    },
  };
});

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../utils/retry', () => ({
  withRetry: jest.fn((fn) => fn()),
  retryWithBackoff: jest.fn((fn) => fn()),
}));

jest.mock('../utils/withTimeout', () => ({
  withTimeout: jest.fn((p) => p),
}));

jest.mock('../utils/txQueue', () => ({
  enqueue: jest.fn((_key, fn) => fn()),
}));

jest.mock('../utils/metrics', () => ({
  horizonRequestDuration: {
    startTimer: jest.fn(() => jest.fn()),
  },
}));

jest.mock('../utils/horizonSchemas', () => ({
  AccountResponseSchema: {},
  TransactionSubmitResponseSchema: {},
  TransactionPageSchema: {},
  TransactionRecordSchema: {},
  OperationPageSchema: {},
  PathPageSchema: {},
  validateHorizonResponse: jest.fn((_, raw) => raw),
}));

jest.mock('./memoRequired', () => ({
  checkMemoRequired: jest.fn().mockResolvedValue(false),
}), { virtual: false });

global.fetch = jest.fn().mockResolvedValue({ ok: true });

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
process.env.ENCRYPTION_KEY    = 'test-encryption-key-32-bytes!!!';
process.env.STELLAR_NETWORK   = 'testnet';
process.env.XLM_ISSUER        = undefined;

// ---------------------------------------------------------------------------
// Load the module AFTER mocks are in place
// ---------------------------------------------------------------------------
let stellar;
try {
  stellar = require('../services/stellar');
} catch (e) {
  // If module load fails we want the tests to report the error clearly
  stellar = null;
}

// ===========================================================================
// #868 — Module must load and export top-level functions
// ===========================================================================
describe('#868 — stellar.js module loads without error', () => {
  test('require() does not throw', () => {
    expect(stellar).not.toBeNull();
    expect(stellar).toBeDefined();
  });

  test('typeof stellar is object (module.exports is a plain object)', () => {
    expect(typeof stellar).toBe('object');
  });
});

describe('#868 — core functions are exported at module top level', () => {
  const coreExports = [
    'createWallet',
    'getBalance',
    'sendPayment',
    'sendBatchPayment',
    'getTransactions',
    'encryptPrivateKey',
    'decryptPrivateKey',
    'fetchFee',
    'fetchFeeStats',
    'feeForPriority',
    'checkHorizonHealth',
    'findPaymentPath',
    'sendPathPayment',
    'addTrustline',
    'removeTrustline',
    'getTrustlines',
    'addAccountSigner',
    'removeAccountSigner',
    'mergeAccount',
    'clawbackAsset',
    'validateNetworkPassphrase',
    'withSequenceRecovery',
    'isBadSeq',
    'recoverSequence',
  ];

  test.each(coreExports)('%s is exported and is a function', (name) => {
    expect(stellar).not.toBeNull();
    expect(typeof stellar[name]).toBe('function');
  });
});

// ===========================================================================
// #868 — Regression: withFallback is declared exactly once in the source
// ===========================================================================
describe('#868 regression — withFallback appears only once', () => {
  test('source file has exactly one withFallback function declaration', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../services/stellar.js'),
      'utf8'
    );
    const matches = src.match(/async function withFallback/g) || [];
    expect(matches.length).toBe(1);
  });

  test('withFallback uses the merged single signature (operation label for metrics)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../services/stellar.js'),
      'utf8'
    );
    // The reconciled signature should include an operation parameter
    expect(src).toMatch(/async function withFallback\(fn,\s*operation\s*=/);
  });
});

// ===========================================================================
// #868 — createWallet runs at the top level (not in a closure)
// ===========================================================================
describe('#868 — createWallet is callable and resolves', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  test('createWallet resolves with a publicKey and encryptedSecretKey', async () => {
    const result = await stellar.createWallet();

    expect(result).toHaveProperty('publicKey');
    expect(result).toHaveProperty('encryptedSecretKey');
    expect(typeof result.publicKey).toBe('string');
    expect(typeof result.encryptedSecretKey).toBe('string');
    // Stellar public keys start with G and are 56 characters
    expect(result.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
  });
});

// ===========================================================================
// #868 — withFallback helper routes to primary then fallback correctly
// ===========================================================================
describe('#868 — withFallback (internal call sites still work)', () => {
  test('getBalance calls through withFallback and returns account_exists', async () => {
    mockServer.loadAccount.mockResolvedValueOnce({
      balances: [{ asset_type: 'native', balance: '100.0000000' }],
      subentry_count: 0,
    });

    const result = await stellar.getBalance('GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3');

    expect(result.account_exists).toBe(true);
    expect(result.balances).toHaveLength(1);
    expect(result.balances[0].asset_code).toBe('XLM');
  });
});
