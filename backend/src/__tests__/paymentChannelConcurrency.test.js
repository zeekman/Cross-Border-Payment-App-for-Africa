/**
 * Concurrency tests for payment channel service
 *
 * These tests verify that the SELECT ... FOR UPDATE locking in transact() and
 * closeChannel() correctly serialises concurrent access to the same channel
 * row.  Because there is no live database in the unit-test environment, we
 * simulate DB-level serialisation by controlling when each mock client's
 * SELECT … FOR UPDATE resolves: the second caller blocks until the first has
 * committed, at which point the second caller receives the updated row.
 *
 * Key assertions:
 *   transact()      – two simultaneous calls that together exceed sender_balance
 *                     must result in exactly one success; the balance must never
 *                     go negative.
 *   closeChannel()  – two simultaneous close requests must result in exactly one
 *                     on-chain settlement submission.
 */

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any require()
// ---------------------------------------------------------------------------
jest.mock('../db');
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock the entire Stellar SDK to avoid needing real network objects
jest.mock('@stellar/stellar-sdk', () => ({
  Networks: { TESTNET: 'Test SDF Network ; September 2015', PUBLIC: 'Public Global Stellar Network ; September 2015' },
  Keypair: { fromSecret: jest.fn(() => ({ publicKey: () => 'GSENDER', sign: jest.fn() })) },
  Asset: { native: jest.fn(() => ({ code: 'XLM' })) },
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn(() => ({ sign: jest.fn(), toXDR: jest.fn(() => 'mock-xdr') })),
  })),
  Transaction: jest.fn().mockImplementation(() => ({ sign: jest.fn() })),
  Operation: {
    payment: jest.fn(() => ({})),
  },
}));

// Mock withFallback from the stellar service
jest.mock('../services/stellar', () => ({
  withFallback: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
const db = require('../db');
const { withFallback } = require('../services/stellar');
const { transact, closeChannel } = require('../services/paymentChannel');

// Clear mock call history and one-time return-value queues between tests.
// We use clearAllMocks (not resetAllMocks) so that implementations defined
// in jest.mock() factories (e.g. TransactionBuilder, Keypair.fromSecret)
// are preserved; only call history and mockOnce queues are wiped.
beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Default stellar mock — returns a hash for submitTransaction
// ---------------------------------------------------------------------------
let submitCount = 0;
function setupStellarMock() {
  submitCount = 0;
  withFallback.mockImplementation(async (fn) => {
    const stellarMock = {
      loadAccount: jest.fn(async () => ({})),
      fetchBaseFee: jest.fn(async () => 100),
      submitTransaction: jest.fn(async () => {
        submitCount++;
        return { hash: 'tx-hash-' + submitCount };
      }),
    };
    return fn(stellarMock);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock pg client.  Each call to client.query() dispatches to the
 * provided handler map keyed on the first SQL keyword of the statement.
 */
function makeMockClient(handlers) {
  return {
    query: jest.fn(async (sql, params) => {
      const keyword = sql.trim().split(/\s+/)[0].toUpperCase();
      if (handlers[keyword]) {
        return handlers[keyword](sql, params);
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// transact() concurrency tests
// ---------------------------------------------------------------------------
describe('transact() — concurrency', () => {
  const CHANNEL_ID = 'channel-uuid-1';
  const USER_ID = 'user-uuid-1';
  const SENDER_BALANCE = 10; // total available

  /**
   * Simulates two concurrent transact() calls.
   *
   * DB-level serialisation:
   *   - caller-1's SELECT ... FOR UPDATE resolves immediately with current balance.
   *   - caller-2's SELECT ... FOR UPDATE blocks until caller-1 commits, then
   *     resolves with the post-commit balance.
   */
  async function runConcurrentTransact(amount1, amount2) {
    let resolveBlocker;
    const blockerPromise = new Promise(resolve => { resolveBlocker = resolve; });

    let currentBalance = SENDER_BALANCE;

    const client1 = makeMockClient({
      SELECT: async () => ({
        rows: [{
          id: CHANNEL_ID, user_id: USER_ID, status: 'open',
          sender_balance: String(currentBalance), recipient_balance: '0',
        }],
      }),
      UPDATE: async (_sql, params) => {
        currentBalance -= parseFloat(params[0]);
        return {
          rows: [{
            id: CHANNEL_ID,
            sender_balance: String(currentBalance),
            recipient_balance: String(SENDER_BALANCE - currentBalance),
          }],
        };
      },
      COMMIT: async () => {
        resolveBlocker();
        return { rows: [] };
      },
    });

    const client2 = makeMockClient({
      SELECT: async () => {
        await blockerPromise; // blocked until caller-1 commits
        return {
          rows: [{
            id: CHANNEL_ID, user_id: USER_ID, status: 'open',
            sender_balance: String(currentBalance),
            recipient_balance: String(SENDER_BALANCE - currentBalance),
          }],
        };
      },
      UPDATE: async (_sql, params) => {
        currentBalance -= parseFloat(params[0]);
        return {
          rows: [{
            id: CHANNEL_ID,
            sender_balance: String(currentBalance),
            recipient_balance: String(SENDER_BALANCE - currentBalance),
          }],
        };
      },
    });

    db.pool.connect
      .mockResolvedValueOnce(client1)
      .mockResolvedValueOnce(client2);

    const [result1, result2] = await Promise.allSettled([
      transact({ channelId: CHANNEL_ID, userId: USER_ID, amount: amount1 }),
      transact({ channelId: CHANNEL_ID, userId: USER_ID, amount: amount2 }),
    ]);

    return { result1, result2, finalBalance: currentBalance };
  }

  test('both calls succeed when combined amount <= balance', async () => {
    const { result1, result2, finalBalance } = await runConcurrentTransact(4, 4);
    expect(result1.status).toBe('fulfilled');
    expect(result2.status).toBe('fulfilled');
    expect(finalBalance).toBe(2);
    expect(finalBalance).toBeGreaterThanOrEqual(0);
  });

  test('second call fails when combined amount exceeds balance', async () => {
    // caller-1 takes 7 → remaining 3; caller-2 requests 7 — must fail
    const { result1, result2, finalBalance } = await runConcurrentTransact(7, 7);

    expect(result1.status).toBe('fulfilled');
    expect(result2.status).toBe('rejected');
    expect(result2.reason.message).toMatch(/insufficient/i);
    expect(finalBalance).toBe(3);
    expect(finalBalance).toBeGreaterThanOrEqual(0);
  });

  test('balance never goes negative when both callers request the full balance', async () => {
    const { finalBalance } = await runConcurrentTransact(SENDER_BALANCE, SENDER_BALANCE);
    expect(finalBalance).toBeGreaterThanOrEqual(0);
  });

  test('second transact sees post-commit balance (serialisation confirmed)', async () => {
    // caller-1 takes 6 (leaving 4); caller-2 requests 5 — must be rejected
    const { result1, result2, finalBalance } = await runConcurrentTransact(6, 5);

    expect(result1.status).toBe('fulfilled');
    expect(result2.status).toBe('rejected');
    expect(result2.reason.status).toBe(400);
    expect(finalBalance).toBe(4);
  });

  test('transact() uses SELECT ... FOR UPDATE', async () => {
    const client = makeMockClient({
      SELECT: async () => ({
        rows: [{ id: CHANNEL_ID, user_id: USER_ID, status: 'open', sender_balance: '10', recipient_balance: '0' }],
      }),
      UPDATE: async () => ({
        rows: [{ id: CHANNEL_ID, sender_balance: '8', recipient_balance: '2' }],
      }),
    });
    db.pool.connect.mockResolvedValueOnce(client);

    await transact({ channelId: CHANNEL_ID, userId: USER_ID, amount: 2 });

    const selectCall = client.query.mock.calls.find(c =>
      c[0].trim().toUpperCase().startsWith('SELECT')
    );
    expect(selectCall).toBeDefined();
    expect(selectCall[0].toUpperCase()).toContain('FOR UPDATE');
  });

  test('transact() wraps work in BEGIN / COMMIT', async () => {
    const client = makeMockClient({
      SELECT: async () => ({
        rows: [{ id: CHANNEL_ID, user_id: USER_ID, status: 'open', sender_balance: '10', recipient_balance: '0' }],
      }),
      UPDATE: async () => ({
        rows: [{ id: CHANNEL_ID, sender_balance: '7', recipient_balance: '3' }],
      }),
    });
    db.pool.connect.mockResolvedValueOnce(client);

    await transact({ channelId: CHANNEL_ID, userId: USER_ID, amount: 3 });

    const keywords = client.query.mock.calls.map(c =>
      c[0].trim().toUpperCase().split(/\s+/)[0]
    );
    expect(keywords).toContain('BEGIN');
    expect(keywords).toContain('COMMIT');
  });

  test('transact() issues ROLLBACK and releases client on error', async () => {
    const client = makeMockClient({
      SELECT: async () => ({ rows: [] }), // channel not found
    });
    db.pool.connect.mockResolvedValueOnce(client);

    await expect(
      transact({ channelId: CHANNEL_ID, userId: USER_ID, amount: 1 })
    ).rejects.toThrow('Channel not found or not open');

    const keywords = client.query.mock.calls.map(c =>
      c[0].trim().toUpperCase().split(/\s+/)[0]
    );
    expect(keywords).toContain('BEGIN');
    expect(keywords).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// closeChannel() concurrency tests
// ---------------------------------------------------------------------------
describe('closeChannel() — concurrency', () => {
  const CHANNEL_ID = 'channel-uuid-2';
  const USER_ID = 'user-uuid-2';

  const CHANNEL_ROW = {
    id: CHANNEL_ID,
    user_id: USER_ID,
    status: 'open',
    sender_public_key: 'GSENDER',
    recipient_public_key: 'GRECIPIENT',
    asset: 'XLM',
    recipient_balance: '5',
    closing_tx_xdr: 'mock-closing-xdr',
  };

  // AES-256-CBC requires:
  //   key  — 32 bytes  (ENCRYPTION_KEY is 32 ASCII chars)
  //   IV   — 16 bytes  (32 hex chars)
  //   ciphertext — must decrypt to valid UTF-8 but we mock Keypair.fromSecret
  //                so the actual decrypted value does not matter; it just
  //                needs to not throw during decryption.
  //
  // We generate a real AES-256-CBC ciphertext in beforeEach so that
  // decryptPrivateKey() succeeds and execution reaches withFallback/stellar.
  let ENCRYPTED_SECRET;

  function buildEncryptedSecret(keyStr) {
    const crypto = require('crypto');
    const key = Buffer.from(keyStr, 'utf8').slice(0, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const plaintext = 'STEST_SECRET_KEY_PLACEHOLDER_XYZ'; // 32 chars, valid stellar secret shape
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
  }

  beforeEach(() => {
    // 32 printable ASCII characters → valid AES-256 key
    process.env.ENCRYPTION_KEY = 'aaaabbbbccccddddeeeeffffgggghhhh';
    ENCRYPTED_SECRET = buildEncryptedSecret(process.env.ENCRYPTION_KEY);
    setupStellarMock();
  });

  /**
   * Simulates two concurrent closeChannel() calls.
   *
   * Caller-1 proceeds immediately and commits.  Caller-2 blocks on
   * SELECT … FOR UPDATE until caller-1 commits, then receives an empty
   * row set (simulating WHERE status='open' returning nothing after the
   * channel has already been closed).
   */
  async function runConcurrentClose() {
    let resolveBlocker;
    const blockerPromise = new Promise(resolve => { resolveBlocker = resolve; });

    // Reset the counter so each test starts clean
    submitCount = 0;

    // Intercept withFallback to count submitTransaction invocations
    withFallback.mockImplementation(async (fn) => {
      const stellarMock = {
        loadAccount: jest.fn(async () => ({})),
        fetchBaseFee: jest.fn(async () => 100),
        submitTransaction: jest.fn(async () => {
          submitCount++;
          return { hash: 'tx-hash-' + submitCount };
        }),
      };
      return fn(stellarMock);
    });

    const client1 = makeMockClient({
      SELECT: async () => ({ rows: [CHANNEL_ROW] }),
      UPDATE: async () => ({
        rows: [{ ...CHANNEL_ROW, status: 'closed', settlement_tx_hash: 'tx-hash-1' }],
      }),
      COMMIT: async () => {
        resolveBlocker();
        return { rows: [] };
      },
    });

    // Caller-2 blocks on SELECT until caller-1 commits, then sees no open channel
    const client2 = makeMockClient({
      SELECT: async () => {
        await blockerPromise;
        return { rows: [] }; // channel already closed
      },
    });

    db.pool.connect
      .mockResolvedValueOnce(client1)
      .mockResolvedValueOnce(client2);

    const [result1, result2] = await Promise.allSettled([
      closeChannel({ channelId: CHANNEL_ID, userId: USER_ID, encryptedSecretKey: ENCRYPTED_SECRET }),
      closeChannel({ channelId: CHANNEL_ID, userId: USER_ID, encryptedSecretKey: ENCRYPTED_SECRET }),
    ]);

    return { result1, result2 };
  }

  test('only one settlement transaction is submitted when two close requests race', async () => {
    const { result1, result2 } = await runConcurrentClose();

    expect(result1.status).toBe('fulfilled');
    expect(result2.status).toBe('rejected');
    expect(result2.reason.message).toMatch(/not found|already closed/i);
    expect(submitCount).toBe(1);
  });

  test('first caller receives the closed channel, second receives a 404', async () => {
    const { result1, result2 } = await runConcurrentClose();

    expect(result1.status).toBe('fulfilled');
    expect(result1.value.status).toBe('closed');

    expect(result2.status).toBe('rejected');
    expect(result2.reason.status).toBe(404);
  });

  test('closeChannel() uses SELECT ... FOR UPDATE', async () => {
    const client = makeMockClient({
      SELECT: async () => ({ rows: [] }), // not found — we just inspect the query
    });
    db.pool.connect.mockResolvedValueOnce(client);

    await expect(
      closeChannel({ channelId: CHANNEL_ID, userId: USER_ID, encryptedSecretKey: ENCRYPTED_SECRET })
    ).rejects.toThrow();

    const selectCall = client.query.mock.calls.find(c =>
      c[0].trim().toUpperCase().startsWith('SELECT')
    );
    expect(selectCall).toBeDefined();
    expect(selectCall[0].toUpperCase()).toContain('FOR UPDATE');
  });

  test('closeChannel() wraps work in BEGIN / COMMIT', async () => {
    const client = makeMockClient({
      SELECT: async () => ({ rows: [CHANNEL_ROW] }),
      UPDATE: async () => ({
        rows: [{ ...CHANNEL_ROW, status: 'closed', settlement_tx_hash: 'tx-hash-1' }],
      }),
    });
    db.pool.connect.mockResolvedValueOnce(client);

    await closeChannel({ channelId: CHANNEL_ID, userId: USER_ID, encryptedSecretKey: ENCRYPTED_SECRET });

    const keywords = client.query.mock.calls.map(c =>
      c[0].trim().toUpperCase().split(/\s+/)[0]
    );
    expect(keywords).toContain('BEGIN');
    expect(keywords).toContain('COMMIT');
  });

  test('closeChannel() issues ROLLBACK and releases client on error', async () => {
    const client = makeMockClient({
      SELECT: async () => ({ rows: [] }), // channel not found
    });
    db.pool.connect.mockResolvedValueOnce(client);

    await expect(
      closeChannel({ channelId: CHANNEL_ID, userId: USER_ID, encryptedSecretKey: ENCRYPTED_SECRET })
    ).rejects.toThrow('Channel not found or already closed');

    const keywords = client.query.mock.calls.map(c =>
      c[0].trim().toUpperCase().split(/\s+/)[0]
    );
    expect(keywords).toContain('BEGIN');
    expect(keywords).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('client is always released even when stellar submission throws', async () => {
    const client = makeMockClient({
      SELECT: async () => ({ rows: [CHANNEL_ROW] }),
    });
    db.pool.connect.mockResolvedValueOnce(client);

    // Make every withFallback call throw
    withFallback.mockRejectedValue(new Error('Horizon unavailable'));

    await expect(
      closeChannel({ channelId: CHANNEL_ID, userId: USER_ID, encryptedSecretKey: ENCRYPTED_SECRET })
    ).rejects.toThrow('Horizon unavailable');

    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
