'use strict';

/**
 * Tests for loyaltyMintJob.js
 *
 * Coverage:
 *  1. Concurrency — two concurrent callers against the same pending row call
 *     mintPoints() exactly once (the second caller finds an empty queue because
 *     the first has already set status='processing' inside its transaction).
 *  2. ON CONFLICT DO NOTHING — enqueueLoyaltyMint() never creates duplicate rows.
 *  3. Status transitions & retry_count — pending→processing→completed,
 *     pending→processing→pending (retry), pending→processing→failed (max retries).
 *  4. claimNextJob — unit tests for BEGIN/COMMIT/ROLLBACK sequencing.
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before any require() calls
// ---------------------------------------------------------------------------

jest.mock('../db', () => ({
  query:        jest.fn(),
  pool:         { connect: jest.fn() },
  getPoolStats: jest.fn(),
}));

jest.mock('../utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
}));

// Disable the distributed lock so concurrency tests are driven purely by the
// DB-transaction logic rather than the Redis layer.
jest.mock('../utils/distributedLock', () => ({
  withLock: jest.fn(async (_key, _ttl, fn) => { await fn(); return true; }),
}));

jest.mock('../services/notificationInbox', () => ({
  persistAndBroadcast: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/loyaltyToken', () => ({
  mintPoints: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const db         = require('../db');
const { mintPoints } = require('../services/loyaltyToken');
const { processLoyaltyMintQueue, enqueueLoyaltyMint, claimNextJob } =
  require('../jobs/loyaltyMintJob');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const JOB_ID   = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';
const WALLET   = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';
const TX_HASH  = 'c'.repeat(64);

const PENDING_JOB = {
  id:            JOB_ID,
  user_id:       USER_ID,
  sender_wallet: WALLET,
  amount:        '10',
  asset:         'XLM',
  retry_count:   0,
  tx_status:     'completed',
  tx_hash:       TX_HASH,
};

// ---------------------------------------------------------------------------
// Global env setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env.LOYALTY_TOKEN_CONTRACT_ID = 'CTEST_CONTRACT_ID';
  process.env.LOYALTY_MINT_CONCURRENCY  = '1'; // keep tests predictable
});

afterAll(() => {
  delete process.env.LOYALTY_TOKEN_CONTRACT_ID;
  delete process.env.LOYALTY_MINT_CONCURRENCY;
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Test client factory
//
// Returns a mock pg PoolClient whose query() method delegates to a
// caller-supplied handler.  BEGIN / COMMIT / ROLLBACK are handled
// automatically so tests only need to supply logic for real SQL statements.
// ---------------------------------------------------------------------------

function makeMockClient(handler) {
  const txState = { inTx: false };
  return {
    txState,
    query: jest.fn(async (sql, params) => {
      const norm = sql.replace(/\s+/g, ' ').trim().toUpperCase();
      if (norm === 'BEGIN')    { txState.inTx = true;  return { rows: [] }; }
      if (norm === 'COMMIT')   { txState.inTx = false; return { rows: [] }; }
      if (norm === 'ROLLBACK') { txState.inTx = false; return { rows: [] }; }
      return handler(sql, params, txState);
    }),
    release: jest.fn(),
  };
}

// ===========================================================================
// 1. CONCURRENCY TEST
// ===========================================================================

describe('processLoyaltyMintQueue — concurrency', () => {
  /**
   * Caller A:  BEGIN → SELECT (finds row) → UPDATE status='processing' → COMMIT
   * Caller B:  BEGIN → SELECT FOR UPDATE SKIP LOCKED (row claimed, returns []) → ROLLBACK
   *
   * We simulate SKIP LOCKED by giving the second pool.connect() a client whose
   * SELECT always returns an empty row set.
   */
  test('mintPoints is called exactly once when two callers race on the same row', async () => {
    mintPoints.mockResolvedValue({ txHash: TX_HASH });
    db.query.mockResolvedValue({ rows: [] });

    const clientA = makeMockClient((sql) =>
      sql.includes('SELECT') && sql.includes('loyalty_mint_queue')
        ? { rows: [PENDING_JOB] }
        : { rows: [] },
    );
    const clientB = makeMockClient(() => ({ rows: [] })); // SKIP LOCKED — empty

    let callCount = 0;
    db.pool.connect.mockImplementation(async () => (++callCount % 2 === 1 ? clientA : clientB));

    await Promise.all([
      processLoyaltyMintQueue(),
      processLoyaltyMintQueue(),
    ]);

    // Primary assertion: only one on-chain mint regardless of concurrency
    expect(mintPoints).toHaveBeenCalledTimes(1);
    expect(mintPoints).toHaveBeenCalledWith({
      recipientWallet: WALLET,
      points:          10,
    });
  });

  test('both concurrent callers resolve without throwing', async () => {
    mintPoints.mockResolvedValue({ txHash: TX_HASH });
    db.query.mockResolvedValue({ rows: [] });

    const clientA = makeMockClient((sql) =>
      sql.includes('SELECT') && sql.includes('loyalty_mint_queue')
        ? { rows: [PENDING_JOB] }
        : { rows: [] },
    );
    const clientB = makeMockClient(() => ({ rows: [] }));

    let n = 0;
    db.pool.connect.mockImplementation(async () => (++n % 2 === 1 ? clientA : clientB));

    await expect(
      Promise.all([processLoyaltyMintQueue(), processLoyaltyMintQueue()]),
    ).resolves.not.toThrow();
  });

  test('BEGIN appears before SELECT, UPDATE appears before COMMIT inside claimNextJob', async () => {
    mintPoints.mockResolvedValue({ txHash: TX_HASH });
    db.query.mockResolvedValue({ rows: [] });

    const clientA = makeMockClient((sql) =>
      sql.includes('SELECT') && sql.includes('loyalty_mint_queue')
        ? { rows: [PENDING_JOB] }
        : { rows: [] },
    );
    db.pool.connect.mockResolvedValue(clientA);

    await processLoyaltyMintQueue();

    const calls = clientA.query.mock.calls.map(([s]) =>
      s.replace(/\s+/g, ' ').trim().toUpperCase(),
    );

    const beginIdx  = calls.findIndex((s) => s === 'BEGIN');
    const selectIdx = calls.findIndex((s) => s.includes('SELECT'));
    const updateIdx = calls.findIndex((s) => s.includes('UPDATE') && s.includes('PROCESSING'));
    const commitIdx = calls.findIndex((s) => s === 'COMMIT');

    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThan(beginIdx);
    expect(updateIdx).toBeGreaterThan(selectIdx);
    expect(commitIdx).toBeGreaterThan(updateIdx);
  });
});

// ===========================================================================
// 2. ON CONFLICT DO NOTHING — enqueue path
// ===========================================================================

describe('enqueueLoyaltyMint — ON CONFLICT DO NOTHING', () => {
  test('inserts and returns the id on first call', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: JOB_ID }] });

    const id = await enqueueLoyaltyMint(JOB_ID, USER_ID, WALLET, '10', 'XLM');

    expect(id).toBe(JOB_ID);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/i);
    expect(params[0]).toBe(JOB_ID);
  });

  test('returns undefined (no error) on duplicate — RETURNING returns empty set', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // ON CONFLICT DO NOTHING → no row returned

    const id = await enqueueLoyaltyMint(JOB_ID, USER_ID, WALLET, '10', 'XLM');

    expect(id).toBeUndefined();
    expect(db.query).toHaveBeenCalledTimes(1); // only one INSERT
  });

  test('two calls for the same txId each issue exactly one INSERT, second gets no row', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: JOB_ID }] })
      .mockResolvedValueOnce({ rows: [] });

    const id1 = await enqueueLoyaltyMint(JOB_ID, USER_ID, WALLET, '10', 'XLM');
    const id2 = await enqueueLoyaltyMint(JOB_ID, USER_ID, WALLET, '10', 'XLM');

    expect(id1).toBe(JOB_ID);
    expect(id2).toBeUndefined();
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('returns null immediately when LOYALTY_TOKEN_CONTRACT_ID is unset', async () => {
    const saved = process.env.LOYALTY_TOKEN_CONTRACT_ID;
    delete process.env.LOYALTY_TOKEN_CONTRACT_ID;

    const id = await enqueueLoyaltyMint(JOB_ID, USER_ID, WALLET, '10', 'XLM');

    expect(id).toBeNull();
    expect(db.query).not.toHaveBeenCalled();

    process.env.LOYALTY_TOKEN_CONTRACT_ID = saved;
  });
});

// ===========================================================================
// 3. STATUS TRANSITIONS & retry_count
// ===========================================================================

describe('processLoyaltyMintQueue — status transitions', () => {
  /** Wire up pool + auto-commit db.query for a single-iteration run */
  function setupPool(jobRow) {
    const client = makeMockClient((sql) =>
      sql.includes('SELECT') && sql.includes('loyalty_mint_queue')
        ? { rows: jobRow ? [jobRow] : [] }
        : { rows: [] },
    );
    db.pool.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });
    return client;
  }

  test('pending → processing → completed when mintPoints succeeds', async () => {
    mintPoints.mockResolvedValue({ txHash: TX_HASH });
    const client = setupPool(PENDING_JOB);

    await processLoyaltyMintQueue();

    // Inside transaction: UPDATE status='processing'
    const processingCall = client.query.mock.calls.find(([s]) =>
      s.toLowerCase().includes('processing'),
    );
    expect(processingCall).toBeDefined();

    // Outside transaction (db.query): UPDATE status='completed'
    const completedCall = db.query.mock.calls.find(([s]) =>
      s.toLowerCase().includes('completed') && !s.toLowerCase().includes('insert'),
    );
    expect(completedCall).toBeDefined();
    expect(completedCall[1][1]).toBe(JOB_ID);
  });

  test('claimNextJob increments retry_count inside the transaction', async () => {
    mintPoints.mockResolvedValue({ txHash: TX_HASH });
    const client = setupPool(PENDING_JOB);

    await processLoyaltyMintQueue();

    const retryIncrement = client.query.mock.calls.find(([s]) =>
      s.includes('retry_count') && s.toLowerCase().includes('processing'),
    );
    expect(retryIncrement).toBeDefined();
    expect(retryIncrement[0]).toMatch(/retry_count\s*=\s*retry_count\s*\+\s*1/i);
  });

  test('pending → processing → pending (retry) when mintPoints throws and retry_count < 3', async () => {
    mintPoints.mockRejectedValue(new Error('soroban rpc timeout'));
    setupPool({ ...PENDING_JOB, retry_count: 0 });

    await processLoyaltyMintQueue();

    const retryUpdate = db.query.mock.calls.find(([s]) =>
      s.toLowerCase().includes("status = 'pending'") ||
      s.toLowerCase().includes("status='pending'"),
    );
    expect(retryUpdate).toBeDefined();
    expect(retryUpdate[1][0]).toMatch(/soroban rpc timeout/);
    expect(retryUpdate[1][1]).toBe(JOB_ID);
  });

  test('pending → processing → failed when mintPoints throws and retry_count >= 3', async () => {
    mintPoints.mockRejectedValue(new Error('permanent failure'));
    setupPool({ ...PENDING_JOB, retry_count: 3 });

    await processLoyaltyMintQueue();

    const failedUpdate = db.query.mock.calls.find(([s]) =>
      s.toLowerCase().includes('failed'),
    );
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate[1][0]).toMatch(/permanent failure/);
    expect(failedUpdate[1][1]).toBe(JOB_ID);
  });

  test('pending → processing → completed (no-op) when mintPoints returns null', async () => {
    mintPoints.mockResolvedValue(null);
    setupPool(PENDING_JOB);

    await processLoyaltyMintQueue();

    // The no-op completion UPDATE has no tx_hash param
    const completedNoTxHash = db.query.mock.calls.find(([s, p]) =>
      s.toLowerCase().includes('completed') &&
      !s.toLowerCase().includes('insert') &&
      p && p.length === 1 && p[0] === JOB_ID,
    );
    expect(completedNoTxHash).toBeDefined();
  });

  test('inserts loyalty_points ledger row after a successful mint', async () => {
    mintPoints.mockResolvedValue({ txHash: TX_HASH });
    setupPool(PENDING_JOB);

    await processLoyaltyMintQueue();

    const ledgerInsert = db.query.mock.calls.find(([s]) =>
      s.includes('INSERT INTO loyalty_points') && s.includes("'mint'"),
    );
    expect(ledgerInsert).toBeDefined();
    const p = ledgerInsert[1];
    expect(p[1]).toBe(USER_ID);
    expect(p[2]).toBe(WALLET);
    expect(p[3]).toBe(10);  // points for 10 XLM
    expect(p[4]).toBe(JOB_ID);
    expect(p[5]).toBe(TX_HASH);
  });

  test('does nothing when queue is empty', async () => {
    setupPool(null);

    await processLoyaltyMintQueue();

    expect(mintPoints).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled(); // no auto-commit calls needed
  });

  test('always releases the pg client regardless of mintPoints outcome', async () => {
    mintPoints.mockRejectedValue(new Error('crash'));
    const client = setupPool({ ...PENDING_JOB, retry_count: 5 }); // → 'failed'

    await processLoyaltyMintQueue();

    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('rolls back the transaction and releases client when claimNextJob throws', async () => {
    const client = makeMockClient((sql) => {
      if (sql.toLowerCase().includes('select')) throw new Error('db connection lost');
      return { rows: [] };
    });
    db.pool.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    await expect(processLoyaltyMintQueue()).resolves.not.toThrow();

    const rollbackCall = client.query.mock.calls.find(([s]) =>
      s.replace(/\s+/g, ' ').trim().toUpperCase() === 'ROLLBACK',
    );
    expect(rollbackCall).toBeDefined();
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 4. claimNextJob — unit tests
// ===========================================================================

describe('claimNextJob', () => {
  test('returns null when SELECT returns no rows', async () => {
    const client = makeMockClient(() => ({ rows: [] }));
    const result = await claimNextJob(client);
    expect(result).toBeNull();
  });

  test('returns the job row when SELECT returns a row', async () => {
    const client = makeMockClient((sql) =>
      sql.toLowerCase().includes('select') ? { rows: [PENDING_JOB] } : { rows: [] },
    );
    const result = await claimNextJob(client);
    expect(result).toMatchObject({ id: JOB_ID });
  });

  test('wraps SELECT and UPDATE inside BEGIN … COMMIT', async () => {
    const client = makeMockClient((sql) =>
      sql.toLowerCase().includes('select') ? { rows: [PENDING_JOB] } : { rows: [] },
    );
    await claimNextJob(client);

    const stmts = client.query.mock.calls.map(([s]) =>
      s.replace(/\s+/g, ' ').trim().toUpperCase(),
    );
    expect(stmts[0]).toBe('BEGIN');
    expect(stmts[stmts.length - 1]).toBe('COMMIT');
  });

  test('issues ROLLBACK (not COMMIT) when SELECT throws', async () => {
    const client = makeMockClient((sql) => {
      if (sql.toLowerCase().includes('select')) throw new Error('db error');
      return { rows: [] };
    });

    await expect(claimNextJob(client)).rejects.toThrow('db error');

    const stmts = client.query.mock.calls.map(([s]) =>
      s.replace(/\s+/g, ' ').trim().toUpperCase(),
    );
    expect(stmts).toContain('ROLLBACK');
    expect(stmts).not.toContain('COMMIT');
  });

  test('SELECT query includes FOR UPDATE … SKIP LOCKED', async () => {
    const client = makeMockClient(() => ({ rows: [] }));
    await claimNextJob(client);

    const selectSql = client.query.mock.calls.find(([s]) =>
      s.toLowerCase().includes('select'),
    )?.[0];
    expect(selectSql).toMatch(/FOR UPDATE/i);
    expect(selectSql).toMatch(/SKIP LOCKED/i);
  });
});
