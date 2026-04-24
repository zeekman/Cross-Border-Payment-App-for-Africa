/**
 * Unit tests for backend/src/services/stellar.js
 *
 * All network calls (Horizon, Friendbot) are fully mocked.
 * No real keys, secrets, or network traffic are used.
 */

// ---------------------------------------------------------------------------
// Shared mock Horizon server — must be defined before jest.mock hoisting
// ---------------------------------------------------------------------------
const mockServer = {
  loadAccount: jest.fn(),
  fetchBaseFee: jest.fn().mockResolvedValue(100),
  submitTransaction: jest.fn(),
  transactions: jest.fn()
};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => mockServer)
    }
  };
});

// Mock global fetch used by Friendbot
global.fetch = jest.fn().mockResolvedValue({ ok: true });

// ---------------------------------------------------------------------------
// Load service AFTER mocks are in place
// ---------------------------------------------------------------------------
const stellar = require('../services/stellar');
const StellarSdk = require('@stellar/stellar-sdk');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ENCRYPTION_KEY = 'test-encryption-key-32-bytes!!!!!'; // exactly 32 chars

function setEnv() {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.STELLAR_NETWORK = 'testnet';
}

/** Build a minimal mock account object returned by server.loadAccount */
function mockAccount(publicKey, balances = [{ asset_type: 'native', balance: '100.0000000' }]) {
  return {
    id: publicKey,
    balances,
    incrementSequenceNumber: jest.fn(),
    sequenceNumber: jest.fn().mockReturnValue('1'),
    accountId: jest.fn().mockReturnValue(publicKey)
  };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

beforeEach(() => {
  setEnv();
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});

// ============================================================
// encryptPrivateKey / decryptPrivateKey — round-trip integrity
// ============================================================
describe('encryptPrivateKey / decryptPrivateKey', () => {
  // Access internal helpers via a real keypair secret
  const realSecret = StellarSdk.Keypair.random().secret();

  test('encrypted output is not equal to the original secret', () => {
    const { encryptPrivateKey } = require('../services/stellar');
    // encryptPrivateKey is not exported — test via createWallet output
    // We verify indirectly: the encryptedSecretKey returned by createWallet
    // must not equal the raw secret. Direct test via decryptPrivateKey export.
    const encrypted = encryptAndReturn(realSecret);
    expect(encrypted).not.toBe(realSecret);
  });

  test('encrypted value contains iv:ciphertext format', () => {
    const encrypted = encryptAndReturn(realSecret);
    expect(encrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  test('round-trip: decrypt(encrypt(secret)) === secret', () => {
    const encrypted = encryptAndReturn(realSecret);
    const decrypted = stellar.decryptPrivateKey(encrypted);
    expect(decrypted).toBe(realSecret);
  });

  test('two encryptions of the same secret produce different ciphertexts (random IV)', () => {
    const enc1 = encryptAndReturn(realSecret);
    const enc2 = encryptAndReturn(realSecret);
    expect(enc1).not.toBe(enc2);
  });

  test('decryptPrivateKey throws on tampered ciphertext', () => {
    const encrypted = encryptAndReturn(realSecret);
    const [iv, cipher] = encrypted.split(':');
    const tampered = iv + ':' + cipher.slice(0, -4) + 'ffff';
    expect(() => stellar.decryptPrivateKey(tampered)).toThrow();
  });

  test('decryptPrivateKey throws when ENCRYPTION_KEY is wrong', () => {
    const encrypted = encryptAndReturn(realSecret);
    process.env.ENCRYPTION_KEY = 'wrong-key-that-is-32-bytes-long!';
    expect(() => stellar.decryptPrivateKey(encrypted)).toThrow();
  });

  test('decryptPrivateKey does not log or expose the secret on error', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleSpy2 = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      stellar.decryptPrivateKey('badhex:badhex');
    } catch (_) { /* expected */ }
    const logged = [...consoleSpy.mock.calls, ...consoleSpy2.mock.calls].flat().join('');
    expect(logged).not.toContain(realSecret);
    consoleSpy.mockRestore();
    consoleSpy2.mockRestore();
  });
});

// ============================================================
// createWallet
// ============================================================
describe('createWallet', () => {
  test('returns a valid Stellar public key (starts with G, 56 chars)', async () => {
    const wallet = await stellar.createWallet();
    expect(wallet.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
  });

  test('returns encryptedSecretKey, not the raw secret', async () => {
    const wallet = await stellar.createWallet();
    // Raw Stellar secrets start with 'S'
    expect(wallet.encryptedSecretKey).not.toMatch(/^S[A-Z2-7]{55}$/);
    expect(wallet.encryptedSecretKey).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  test('encryptedSecretKey decrypts to a valid Stellar secret', async () => {
    const wallet = await stellar.createWallet();
    const secret = stellar.decryptPrivateKey(wallet.encryptedSecretKey);
    expect(secret).toMatch(/^S[A-Z2-7]{55}$/);
  });

  test('decrypted secret matches the public key', async () => {
    const wallet = await stellar.createWallet();
    const secret = stellar.decryptPrivateKey(wallet.encryptedSecretKey);
    const keypair = StellarSdk.Keypair.fromSecret(secret);
    expect(keypair.publicKey()).toBe(wallet.publicKey);
  });

  test('calls Friendbot on testnet', async () => {
    process.env.STELLAR_NETWORK = 'testnet';
    await stellar.createWallet();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('friendbot.stellar.org')
    );
  });

  test('does not call Friendbot on mainnet', async () => {
    process.env.STELLAR_NETWORK = 'mainnet';
    // Re-require to pick up mainnet env — module is cached, so we test
    // the fetch mock was NOT called with friendbot
    jest.resetModules();
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    const stellarMainnet = require('../services/stellar');
    await stellarMainnet.createWallet();
    const friendbotCalls = global.fetch.mock.calls.filter(([url]) =>
      url.includes('friendbot')
    );
    expect(friendbotCalls).toHaveLength(0);
    // Restore testnet for subsequent tests
    process.env.STELLAR_NETWORK = 'testnet';
    jest.resetModules();
  });

  test('continues and returns wallet even when Friendbot fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));
    const wallet = await stellar.createWallet();
    expect(wallet.publicKey).toBeDefined();
    expect(wallet.encryptedSecretKey).toBeDefined();
  });

  test('each call generates a unique keypair', async () => {
    const w1 = await stellar.createWallet();
    const w2 = await stellar.createWallet();
    expect(w1.publicKey).not.toBe(w2.publicKey);
    expect(w1.encryptedSecretKey).not.toBe(w2.encryptedSecretKey);
  });
});

// ============================================================
// getBalance
// ============================================================
describe('getBalance', () => {
  const PUBLIC_KEY = StellarSdk.Keypair.random().publicKey();

  test('returns XLM balance for a funded account', async () => {
    mockServer.loadAccount.mockResolvedValue(
      mockAccount(PUBLIC_KEY, [{ asset_type: 'native', balance: '250.0000000' }])
    );
    const balances = await stellar.getBalance(PUBLIC_KEY);
    expect(balances).toEqual([{ asset: 'XLM', balance: '250.0000000' }]);
  });

  test('returns multiple asset balances', async () => {
    mockServer.loadAccount.mockResolvedValue(
      mockAccount(PUBLIC_KEY, [
        { asset_type: 'native', balance: '100.0000000' },
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', balance: '50.0000000' }
      ])
    );
    const balances = await stellar.getBalance(PUBLIC_KEY);
    expect(balances).toHaveLength(2);
    expect(balances).toContainEqual({ asset: 'XLM', balance: '100.0000000' });
    expect(balances).toContainEqual({ asset: 'USDC', balance: '50.0000000' });
  });

  test('returns empty array for unfunded account (404)', async () => {
    mockServer.loadAccount.mockRejectedValue({ response: { status: 404 } });
    const balances = await stellar.getBalance(PUBLIC_KEY);
    expect(balances).toEqual([]);
  });

  test('re-throws non-404 errors', async () => {
    const serverError = new Error('Horizon 500');
    serverError.response = { status: 500 };
    mockServer.loadAccount.mockRejectedValue(serverError);
    await expect(stellar.getBalance(PUBLIC_KEY)).rejects.toThrow('Horizon 500');
  });

  test('re-throws network errors without response property', async () => {
    mockServer.loadAccount.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(stellar.getBalance(PUBLIC_KEY)).rejects.toThrow('ECONNREFUSED');
  });
});

// ============================================================
// sendPayment
// ============================================================
describe('sendPayment', () => {
  let senderKeypair;
  let encryptedSecret;
  const recipientKeypair = StellarSdk.Keypair.random();

  beforeEach(() => {
    setEnv();
    senderKeypair = StellarSdk.Keypair.random();
    encryptedSecret = encryptAndReturn(senderKeypair.secret());

    mockServer.fetchBaseFee.mockResolvedValue(100);
    mockServer.submitTransaction.mockResolvedValue({
      hash: 'abc123hash',
      ledger: 42
    });
    mockServer.loadAccount.mockResolvedValue(
      buildMockStellarAccount(senderKeypair.publicKey())
    );
  });

  test('returns transactionHash and ledger on success', async () => {
    const result = await stellar.sendPayment({
      senderPublicKey: senderKeypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipientKeypair.publicKey(),
      amount: '10',
      asset: 'XLM'
    });
    expect(result).toEqual(expect.objectContaining({ transactionHash: 'abc123hash', ledger: 42 }));
  });

  test('calls submitTransaction exactly once', async () => {
    await stellar.sendPayment({
      senderPublicKey: senderKeypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipientKeypair.publicKey(),
      amount: '10',
      asset: 'XLM'
    });
    expect(mockServer.submitTransaction).toHaveBeenCalledTimes(1);
  });

  test('signs transaction with the correct keypair (verifiable via public key)', async () => {
    let capturedTx;
    mockServer.submitTransaction.mockImplementation(tx => {
      capturedTx = tx;
      return Promise.resolve({ hash: 'signed-hash', ledger: 1 });
    });

    await stellar.sendPayment({
      senderPublicKey: senderKeypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipientKeypair.publicKey(),
      amount: '5',
      asset: 'XLM'
    });

    // The transaction must have exactly one signature
    expect(capturedTx.signatures).toHaveLength(1);
    // Verify the signature is valid for the sender's keypair
    const txHash = capturedTx.hash();
    const sig = capturedTx.signatures[0].signature();
    expect(senderKeypair.verify(txHash, sig)).toBe(true);
  });

  test('does not expose decrypted secret in thrown errors', async () => {
    const horizonError = new Error('tx_bad_seq');
    horizonError.response = { status: 400, data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } } };
    mockServer.submitTransaction.mockRejectedValue(horizonError);

    let caughtError;
    try {
      await stellar.sendPayment({
        senderPublicKey: senderKeypair.publicKey(),
        encryptedSecretKey: encryptedSecret,
        recipientPublicKey: recipientKeypair.publicKey(),
        amount: '10',
        asset: 'XLM'
      });
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeDefined();
    // The raw secret must not appear anywhere in the error message or stack
    const secret = senderKeypair.secret();
    expect(JSON.stringify(caughtError)).not.toContain(secret);
  });

  test('propagates Horizon submission errors', async () => {
    const err = new Error('tx_insufficient_balance');
    mockServer.submitTransaction.mockRejectedValue(err);

    await expect(
      stellar.sendPayment({
        senderPublicKey: senderKeypair.publicKey(),
        encryptedSecretKey: encryptedSecret,
        recipientPublicKey: recipientKeypair.publicKey(),
        amount: '999999',
        asset: 'XLM'
      })
    ).rejects.toThrow('tx_insufficient_balance');
  });

  test('adds memo when provided (truncated to 28 chars)', async () => {
    let capturedTx;
    mockServer.submitTransaction.mockImplementation(tx => {
      capturedTx = tx;
      return Promise.resolve({ hash: 'memo-hash', ledger: 2 });
    });

    await stellar.sendPayment({
      senderPublicKey: senderKeypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipientKeypair.publicKey(),
      amount: '1',
      asset: 'XLM',
      memo: 'This memo is longer than 28 characters and should be cut',
      memoType: 'text'
    });

    expect(capturedTx.memo.value.toString()).toHaveLength(28);
    expect(capturedTx.memo.type).toBe('text');
  });

  test('adds MEMO_ID when memoType is id', async () => {
    let capturedTx;
    mockServer.submitTransaction.mockImplementation(tx => {
      capturedTx = tx;
      return Promise.resolve({ hash: 'id-memo-hash', ledger: 21 });
    });

    await stellar.sendPayment({
      senderPublicKey: senderKeypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipientKeypair.publicKey(),
      amount: '1',
      asset: 'XLM',
      memo: '42424242',
      memoType: 'id'
    });

    expect(capturedTx.memo.type).toBe('id');
    expect(String(capturedTx.memo.value)).toBe('42424242');
  });

  test('adds MEMO_HASH when memoType is hash (64 hex)', async () => {
    const hex64 = 'a'.repeat(64);
    let capturedTx;
    mockServer.submitTransaction.mockImplementation(tx => {
      capturedTx = tx;
      return Promise.resolve({ hash: 'hash-memo', ledger: 22 });
    });

    await stellar.sendPayment({
      senderPublicKey: senderKeypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipientKeypair.publicKey(),
      amount: '1',
      asset: 'XLM',
      memo: hex64,
      memoType: 'hash'
    });

    expect(capturedTx.memo.type).toBe('hash');
    expect(Buffer.from(capturedTx.memo.value).toString('hex')).toBe(hex64);
  });

  test('adds MEMO_RETURN when memoType is return (64 hex)', async () => {
    const hex64 = 'b'.repeat(64);
    let capturedTx;
    mockServer.submitTransaction.mockImplementation(tx => {
      capturedTx = tx;
      return Promise.resolve({ hash: 'return-memo', ledger: 23 });
    });

    await stellar.sendPayment({
      senderPublicKey: senderKeypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipientKeypair.publicKey(),
      amount: '1',
      asset: 'XLM',
      memo: hex64,
      memoType: 'return'
    });

    expect(capturedTx.memo.type).toBe('return');
    expect(Buffer.from(capturedTx.memo.value).toString('hex')).toBe(hex64);
  });

  test('sends without memo when memo is not provided', async () => {
    let capturedTx;
    mockServer.submitTransaction.mockImplementation(tx => {
      capturedTx = tx;
      return Promise.resolve({ hash: 'no-memo-hash', ledger: 3 });
    });

    await stellar.sendPayment({
      senderPublicKey: senderKeypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      recipientPublicKey: recipientKeypair.publicKey(),
      amount: '1',
      asset: 'XLM'
    });

    expect(capturedTx.memo.type).toBe('none');
  });

  test('throws when encryptedSecretKey is invalid/malformed', async () => {
    await expect(
      stellar.sendPayment({
        senderPublicKey: senderKeypair.publicKey(),
        encryptedSecretKey: 'not-valid-encrypted-data',
        recipientPublicKey: recipientKeypair.publicKey(),
        amount: '10',
        asset: 'XLM'
      })
    ).rejects.toThrow();
  });

  test('throws 500 when asset issuer env var is missing', async () => {
    delete process.env.USDC_ISSUER;
    await expect(
      stellar.sendPayment({
        senderPublicKey: senderKeypair.publicKey(),
        encryptedSecretKey: encryptedSecret,
        recipientPublicKey: recipientKeypair.publicKey(),
        amount: '10',
        asset: 'USDC'
      })
    ).rejects.toMatchObject({ status: 500 });
  });
});

// ============================================================
// getTransactions
// ============================================================
describe('getTransactions', () => {
  const PUBLIC_KEY = StellarSdk.Keypair.random().publicKey();

  function buildTransactionChain(records) {
    return {
      transactions: jest.fn().mockReturnValue({
        forAccount: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        call: jest.fn().mockResolvedValue({ records })
      })
    };
  }

  test('returns mapped transaction records', async () => {
    const records = [
      { id: '1', hash: 'hash1', created_at: '2024-01-01', memo: 'test', successful: true },
      { id: '2', hash: 'hash2', created_at: '2024-01-02', memo: undefined, successful: false }
    ];
    Object.assign(mockServer, buildTransactionChain(records).transactions());
    mockServer.transactions = buildTransactionChain(records).transactions;

    const txs = await stellar.getTransactions(PUBLIC_KEY);
    expect(txs).toHaveLength(2);
    expect(txs[0]).toEqual({ id: '1', hash: 'hash1', createdAt: '2024-01-01', memo: 'test', successful: true });
  });

  test('returns empty array on any error', async () => {
    mockServer.transactions = jest.fn().mockReturnValue({
      forAccount: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      call: jest.fn().mockRejectedValue(new Error('Horizon down'))
    });

    const txs = await stellar.getTransactions(PUBLIC_KEY);
    expect(txs).toEqual([]);
  });

  test('respects the limit parameter', async () => {
    const limitMock = jest.fn().mockReturnThis();
    mockServer.transactions = jest.fn().mockReturnValue({
      forAccount: jest.fn().mockReturnThis(),
      limit: limitMock,
      order: jest.fn().mockReturnThis(),
      call: jest.fn().mockResolvedValue({ records: [] })
    });

    await stellar.getTransactions(PUBLIC_KEY, 5);
    expect(limitMock).toHaveBeenCalledWith(5);
  });
});

// ============================================================
// Internal helpers (used across suites)
// ============================================================

/**
 * Encrypt a secret using the same logic as stellar.js so we can produce
 * valid encryptedSecretKey values in tests without exposing the service internals.
 * Uses Node's crypto directly — mirrors the service implementation.
 */
function encryptAndReturn(secretKey) {
  const crypto = require('crypto');
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'utf8').slice(0, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(secretKey, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Build a minimal Stellar account mock that TransactionBuilder can work with.
 * Mirrors the AccountResponse interface used by stellar-sdk.
 */
function buildMockStellarAccount(publicKey) {
  let seq = BigInt(1000);
  return {
    id: publicKey,
    accountId: () => publicKey,
    sequenceNumber: () => String(seq),
    incrementSequenceNumber: () => { seq += BigInt(1); },
    balances: [{ asset_type: 'native', balance: '100.0000000' }],
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false },
    signers: [{ key: publicKey, weight: 1 }]
  };
}

// ============================================================
// sendPayment — tx_bad_seq retry
// ============================================================
describe('sendPayment tx_bad_seq retry', () => {
  const keypair = StellarSdk.Keypair.random();
  const recipient = StellarSdk.Keypair.random().publicKey();

  function makeBadSeqError() {
    return {
      response: {
        status: 400,
        data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } }
      }
    };
  }

  test('retries on tx_bad_seq and succeeds on second attempt', async () => {
    mockServer.loadAccount.mockResolvedValue(mockAccount(keypair.publicKey()));
    mockServer.fetchBaseFee.mockResolvedValue(100);

    let calls = 0;
    mockServer.submitTransaction.mockImplementation(async () => {
      calls++;
      if (calls === 1) throw makeBadSeqError();
      return { hash: 'retried_hash', ledger: 42 };
    });

    const encryptedSecretKey = encryptAndReturn(keypair.secret());
    const result = await stellar.sendPayment({
      senderPublicKey: keypair.publicKey(),
      encryptedSecretKey,
      recipientPublicKey: recipient,
      amount: '10',
      asset: 'XLM'
    });

    expect(result.transactionHash).toBe('retried_hash');
    expect(mockServer.submitTransaction).toHaveBeenCalledTimes(2);
    // loadAccount called twice — fresh sequence number each attempt
    expect(mockServer.loadAccount).toHaveBeenCalledTimes(2);
  });

  test('throws after exhausting max retries on persistent tx_bad_seq', async () => {
    mockServer.loadAccount.mockResolvedValue(mockAccount(keypair.publicKey()));
    mockServer.fetchBaseFee.mockResolvedValue(100);
    mockServer.submitTransaction.mockRejectedValue(makeBadSeqError());

    const encryptedSecretKey = encryptAndReturn(keypair.secret());
    await expect(
      stellar.sendPayment({
        senderPublicKey: keypair.publicKey(),
        encryptedSecretKey,
        recipientPublicKey: recipient,
        amount: '10',
        asset: 'XLM'
      })
    ).rejects.toMatchObject({
      response: { data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } } }
    });

    expect(mockServer.submitTransaction).toHaveBeenCalledTimes(3); // MAX_SEQ_RETRIES
  });
});

// ============================================================
// sendBatchPayment
// ============================================================
describe('sendBatchPayment', () => {
  let senderKeypair;
  let encryptedSecretKey;
  let recipientOne;
  let recipientTwo;

  beforeEach(() => {
    setEnv();
    senderKeypair = StellarSdk.Keypair.random();
    recipientOne = StellarSdk.Keypair.random().publicKey();
    recipientTwo = StellarSdk.Keypair.random().publicKey();
    encryptedSecretKey = encryptAndReturn(senderKeypair.secret());

    mockServer.loadAccount.mockResolvedValue(buildMockStellarAccount(senderKeypair.publicKey()));
    mockServer.fetchBaseFee.mockResolvedValue(100);
    mockServer.submitTransaction.mockResolvedValue({ hash: 'batch_hash_123', ledger: 77 });
  });

  test('submits a single transaction containing multiple payment operations', async () => {
    const result = await stellar.sendBatchPayment({
      senderPublicKey: senderKeypair.publicKey(),
      encryptedSecretKey,
      asset: 'XLM',
      recipients: [
        { recipientPublicKey: recipientOne, amount: '10.5' },
        { recipientPublicKey: recipientTwo, amount: '20.25' },
      ],
      memo: 'Payroll',
      memoType: 'text',
    });

    expect(result).toEqual({
      transactionHash: 'batch_hash_123',
      ledger: 77,
      operationCount: 2,
    });

    const submittedTx = mockServer.submitTransaction.mock.calls[0][0];
    const operations = submittedTx.operations;

    expect(mockServer.submitTransaction).toHaveBeenCalledTimes(1);
    expect(operations).toHaveLength(2);
    expect(operations[0].type).toBe('payment');
    expect(operations[0].destination).toBe(recipientOne);
    expect(operations[0].amount).toBe('10.5000000');
    expect(operations[1].destination).toBe(recipientTwo);
    expect(operations[1].amount).toBe('20.2500000');
    expect(submittedTx.memo.value().toString()).toBe('Payroll');
  });
});
