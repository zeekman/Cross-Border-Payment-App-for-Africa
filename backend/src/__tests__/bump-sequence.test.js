'use strict';

/**
 * Tests for Issue #236 — Bump Sequence Recovery
 *
 * Covers:
 *   - isBadSeq() helper
 *   - recoverSequence() helper
 *   - withSequenceRecovery() wrapper
 *   - Preservation: non-tx_bad_seq errors pass through unchanged
 *   - POST /api/dev/fix-sequence endpoint
 */

// ---------------------------------------------------------------------------
// Helpers to build fake Horizon error objects
// ---------------------------------------------------------------------------

function makeBadSeqError() {
  const err = new Error('tx_bad_seq');
  err.response = {
    status: 400,
    data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } },
  };
  return err;
}

function makeOtherError(code = 'tx_insufficient_fee') {
  const err = new Error(code);
  err.response = {
    status: 400,
    data: { extras: { result_codes: { transaction: code } } },
  };
  return err;
}

// ---------------------------------------------------------------------------
// Unit: isBadSeq
// ---------------------------------------------------------------------------

describe('isBadSeq', () => {
  let isBadSeq;

  beforeEach(() => {
    jest.resetModules();
    // Stub modules stellar.js depends on so we can require it in isolation
    jest.mock('../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    jest.mock('../utils/metrics', () => ({ horizonRequestDuration: { startTimer: () => () => {} } }));
    ({ isBadSeq } = require('../services/stellar'));
  });

  it('returns true for tx_bad_seq', () => {
    expect(isBadSeq(makeBadSeqError())).toBe(true);
  });

  it('returns false for other Horizon error codes', () => {
    expect(isBadSeq(makeOtherError('tx_insufficient_fee'))).toBe(false);
    expect(isBadSeq(makeOtherError('op_no_destination'))).toBe(false);
  });

  it('returns false for network errors (no response)', () => {
    const err = new Error('ECONNREFUSED');
    err.code = 'ECONNREFUSED';
    expect(isBadSeq(err)).toBe(false);
  });

  it('returns false for plain errors with no response', () => {
    expect(isBadSeq(new Error('something else'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit: recoverSequence
// ---------------------------------------------------------------------------

describe('recoverSequence', () => {
  let recoverSequence;
  let mockSubmitTransaction;
  let mockLoadAccount;

  const PUBLIC_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
  const mockKeypair = { sign: jest.fn(), publicKey: () => PUBLIC_KEY };

  beforeEach(() => {
    jest.resetModules();

    mockSubmitTransaction = jest.fn().mockResolvedValue({ hash: 'bumpHash', ledger: 1 });
    mockLoadAccount = jest.fn().mockResolvedValue({
      id: PUBLIC_KEY,
      sequenceNumber: () => '100',
      incrementSequenceNumber: jest.fn(),
    });

    const mockTx = { sign: jest.fn() };
    const mockBuilder = {
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue(mockTx),
    };

    // Fully mock the SDK so stellar.js loads without touching real crypto
    jest.mock('@stellar/stellar-sdk', () => ({
      Networks: {
        TESTNET: 'Test SDF Network ; September 2015',
        PUBLIC: 'Public Global Stellar Network ; September 2015',
      },
      Horizon: {
        Server: jest.fn().mockImplementation(() => ({
          loadAccount: mockLoadAccount,
          fetchBaseFee: jest.fn().mockResolvedValue(100),
          submitTransaction: mockSubmitTransaction,
        })),
      },
      TransactionBuilder: jest.fn().mockImplementation(() => mockBuilder),
      Operation: {
        bumpSequence: jest.fn().mockReturnValue({}),
        payment: jest.fn().mockReturnValue({}),
        changeTrust: jest.fn().mockReturnValue({}),
        pathPaymentStrictSend: jest.fn().mockReturnValue({}),
        pathPaymentStrictReceive: jest.fn().mockReturnValue({}),
        createClaimableBalance: jest.fn().mockReturnValue({}),
        accountMerge: jest.fn().mockReturnValue({}),
        clawback: jest.fn().mockReturnValue({}),
        setOptions: jest.fn().mockReturnValue({}),
        manageData: jest.fn().mockReturnValue({}),
      },
      Asset: { native: jest.fn().mockReturnValue({}) },
      Memo: { text: jest.fn(), id: jest.fn(), hash: jest.fn(), return: jest.fn() },
      Keypair: { fromSecret: jest.fn(), random: jest.fn() },
      Claimant: jest.fn(),
      FederationServer: jest.fn(),
    }));

    jest.mock('../utils/logger', () => ({
      warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }));
    jest.mock('../utils/metrics', () => ({
      horizonRequestDuration: { startTimer: () => () => {} },
    }));
    jest.mock('../utils/retry', () => ({ withRetry: jest.fn((fn) => fn()) }));
    jest.mock('../utils/txQueue', () => ({ enqueue: jest.fn((_, fn) => fn()) }));
    jest.mock('../utils/withTimeout', () => ({ withTimeout: jest.fn((p) => p) }));
    jest.mock('../utils/horizonSchemas', () => ({
      AccountResponseSchema: {},
      TransactionSubmitResponseSchema: {},
      TransactionPageSchema: {},
      PathPageSchema: {},
      validateHorizonResponse: jest.fn((_, data) => data),
    }));

    ({ recoverSequence } = require('../services/stellar'));
  });

  it('loads account, builds bumpSequence tx, and submits it', async () => {
    await recoverSequence(PUBLIC_KEY, mockKeypair);
    expect(mockLoadAccount).toHaveBeenCalledWith(PUBLIC_KEY);
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });

  it('propagates submission errors to the caller', async () => {
    mockSubmitTransaction.mockRejectedValue(new Error('Horizon down'));
    await expect(recoverSequence(PUBLIC_KEY, mockKeypair)).rejects.toThrow('Horizon down');
  });
});

// ---------------------------------------------------------------------------
// Unit: withSequenceRecovery
// ---------------------------------------------------------------------------

describe('withSequenceRecovery', () => {
  let withSequenceRecovery;
  let mockRecoverSequence;

  const PUBLIC_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
  const mockKeypair = { sign: jest.fn(), publicKey: () => PUBLIC_KEY };

  beforeEach(() => {
    jest.resetModules();

    mockRecoverSequence = jest.fn().mockResolvedValue({ hash: 'bumpHash' });

    jest.mock('@stellar/stellar-sdk', () => ({
      Networks: {
        TESTNET: 'Test SDF Network ; September 2015',
        PUBLIC: 'Public Global Stellar Network ; September 2015',
      },
      Horizon: { Server: jest.fn().mockImplementation(() => ({})) },
      TransactionBuilder: jest.fn(),
      Operation: {},
      Asset: { native: jest.fn() },
      Memo: {},
      Keypair: { fromSecret: jest.fn(), random: jest.fn() },
      Claimant: jest.fn(),
      FederationServer: jest.fn(),
    }));
    jest.mock('../utils/logger', () => ({
      warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }));
    jest.mock('../utils/metrics', () => ({
      horizonRequestDuration: { startTimer: () => () => {} },
    }));
    jest.mock('../utils/retry', () => ({ withRetry: jest.fn((fn) => fn()) }));
    jest.mock('../utils/txQueue', () => ({ enqueue: jest.fn((_, fn) => fn()) }));
    jest.mock('../utils/withTimeout', () => ({ withTimeout: jest.fn((p) => p) }));
    jest.mock('../utils/horizonSchemas', () => ({
      AccountResponseSchema: {},
      TransactionSubmitResponseSchema: {},
      TransactionPageSchema: {},
      PathPageSchema: {},
      validateHorizonResponse: jest.fn((_, data) => data),
    }));

    // Load the real module, then override recoverSequence with our mock.
    // withSequenceRecovery calls recoverSequence via the module's own closure,
    // so we patch it on the exports object AND re-assign it in the module scope
    // by replacing the export reference.
    const stellar = require('../services/stellar');
    // Patch the exported reference — withSequenceRecovery reads recoverSequence
    // from the same module scope, so we monkey-patch the module's export to
    // make jest.spyOn work correctly.
    jest.spyOn(stellar, 'recoverSequence').mockImplementation(mockRecoverSequence);
    withSequenceRecovery = stellar.withSequenceRecovery;
  });

  it('returns fn() result on success without calling recoverSequence', async () => {
    const fn = jest.fn().mockResolvedValue({ transactionHash: 'abc' });
    const result = await withSequenceRecovery(fn, PUBLIC_KEY, mockKeypair);
    expect(result).toEqual({ transactionHash: 'abc' });
    expect(mockRecoverSequence).not.toHaveBeenCalled();
  });

  it('passes non-tx_bad_seq errors through without calling recoverSequence', async () => {
    const err = makeOtherError('tx_insufficient_fee');
    const fn = jest.fn().mockRejectedValue(err);
    await expect(withSequenceRecovery(fn, PUBLIC_KEY, mockKeypair)).rejects.toThrow('tx_insufficient_fee');
    expect(mockRecoverSequence).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Preservation: non-tx_bad_seq errors pass through all entry points unchanged
// ---------------------------------------------------------------------------

describe('Preservation: non-tx_bad_seq errors propagate unchanged', () => {
  // Test that various error codes that are NOT tx_bad_seq pass through
  // withSequenceRecovery without triggering recovery.
  const NON_BAD_SEQ_CODES = [
    'tx_insufficient_fee',
    'op_no_destination',
    'tx_failed',
    'op_underfunded',
    'tx_bad_auth',
  ];

  NON_BAD_SEQ_CODES.forEach(code => {
    it(`passes ${code} through withSequenceRecovery without calling recoverSequence`, async () => {
      jest.resetModules();
      jest.mock('../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      jest.mock('../utils/metrics', () => ({ horizonRequestDuration: { startTimer: () => () => {} } }));
      jest.mock('@stellar/stellar-sdk', () => {
        const actual = jest.requireActual('@stellar/stellar-sdk');
        return { ...actual, Horizon: { Server: jest.fn().mockImplementation(() => ({})) } };
      });

      const stellar = require('../services/stellar');
      const mockRecover = jest.spyOn(stellar, 'recoverSequence').mockResolvedValue({});

      const err = makeOtherError(code);
      const fn = jest.fn().mockRejectedValue(err);
      const keypair = { publicKey: () => 'G...' }; // minimal mock

      await expect(stellar.withSequenceRecovery(fn, 'G...', keypair)).rejects.toThrow(code);
      expect(mockRecover).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: POST /api/dev/fix-sequence
// ---------------------------------------------------------------------------

describe('POST /api/dev/fix-sequence', () => {
  let app;
  let mockRecoverSequence;
  const MOCK_HASH = 'bumpTxHash123';

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'development';
    process.env.ENCRYPTION_KEY = 'a'.repeat(32);
    process.env.JWT_SECRET = 'testsecret';

    jest.mock('../db', () => ({
      query: jest.fn(),
    }));

    jest.mock('../services/stellar', () => ({
      detectTestnetReset: jest.fn(),
      refundTestnetWallets: jest.fn(),
      recoverSequence: jest.fn().mockResolvedValue({ hash: MOCK_HASH }),
      decryptPrivateKey: jest.fn().mockReturnValue('SCZANGBA5IIMU7JZBAJFRBR3VFEPD42JKPMJKL2DKRVVKQFAPF3XPVO'),
    }));

    jest.mock('@stellar/stellar-sdk', () => {
      const actual = jest.requireActual('@stellar/stellar-sdk');
      return {
        ...actual,
        Keypair: {
          fromSecret: jest.fn().mockReturnValue({ publicKey: () => 'GABC...' }),
        },
      };
    });

    jest.mock('../middleware/auth', () => (req, _res, next) => {
      req.user = { userId: 1 };
      next();
    });

    jest.mock('../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/dev', require('../routes/dev'));

    const stellar = require('../services/stellar');
    mockRecoverSequence = stellar.recoverSequence;
    const db = require('../db');
    db.query.mockResolvedValue({
      rows: [{ public_key: 'GABC...', encrypted_secret_key: 'enc:key' }],
    });
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it('returns 200 with transactionHash on success', async () => {
    const request = require('supertest');
    const res = await request(app).post('/api/dev/fix-sequence');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Sequence recovered');
    expect(res.body.transactionHash).toBe(MOCK_HASH);
    expect(mockRecoverSequence).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when wallet not found', async () => {
    const db = require('../db');
    db.query.mockResolvedValue({ rows: [] });
    const request = require('supertest');
    const res = await request(app).post('/api/dev/fix-sequence');
    expect(res.status).toBe(404);
  });

  it('returns 404 in non-development environments', async () => {
    process.env.NODE_ENV = 'production';
    jest.resetModules();
    const express = require('express');
    const prodApp = express();
    prodApp.use(express.json());

    jest.mock('../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    jest.mock('../services/stellar', () => ({ detectTestnetReset: jest.fn(), refundTestnetWallets: jest.fn(), recoverSequence: jest.fn(), decryptPrivateKey: jest.fn() }));

    prodApp.use('/api/dev', require('../routes/dev'));
    const request = require('supertest');
    const res = await request(prodApp).post('/api/dev/fix-sequence');
    expect(res.status).toBe(404);
  });
});
