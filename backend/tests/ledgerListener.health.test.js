/**
 * BE-198: the ledger listener's health must reflect reality.
 *
 * Drives the real ledgerListener + health modules against a mocked Horizon
 * server and a fake clock.
 */

// ── Mocks (names prefixed `mock` so jest allows them inside factories) ───────

const mockHorizon = {
  ledgerSeq: 1002,
  paymentLedger: 1000,
  failPolls: false,
  streams: {},
};

jest.mock('@stellar/stellar-sdk', () => {
  const builder = (key) => {
    const b = {
      order: () => b,
      limit: () => b,
      cursor: () => b,
      forAccount: () => b,
      call: () => {
        if (mockHorizon.failPolls) return Promise.reject(new Error('horizon unreachable'));
        if (key === 'ledgers') return Promise.resolve({ records: [{ sequence: mockHorizon.ledgerSeq }] });
        if (key === 'payments') {
          const token = (BigInt(mockHorizon.paymentLedger) << BigInt(32)).toString();
          return Promise.resolve({ records: [{ paging_token: token }] });
        }
        return Promise.resolve({ records: [] });
      },
      stream: (handlers) => {
        mockHorizon.streams[key] = handlers;
        return jest.fn();
      },
    };
    return b;
  };
  return {
    Horizon: {
      Server: jest.fn(() => ({
        ledgers: () => builder('ledgers'),
        payments: () => builder('payments'),
        transactions: () => builder('transactions'),
        effects: () => builder('effects'),
      })),
    },
  };
});

jest.mock('../src/db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  getPoolStats: jest.fn().mockReturnValue({ total: 1, idle: 1, waiting: 0 }),
}));
jest.mock('../src/utils/cache', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn().mockReturnValue(null),
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/metrics', () => ({
  wsConnections: { set: jest.fn() },
  ledgerListenerLagLedgers: { set: jest.fn() },
  ledgerListenerLastEventTimestampSeconds: { set: jest.fn() },
}));
jest.mock('../src/utils/withTimeout', () => ({ withTimeout: (p) => p }));
jest.mock('../src/services/stellar', () => ({
  checkHorizonHealth: jest.fn().mockResolvedValue(true),
  getHorizonEndpointStatus: jest.fn().mockReturnValue({}),
}));
jest.mock('../src/services/anchor', () => ({ getAnchorHealth: jest.fn().mockReturnValue({}) }));
jest.mock('../src/middleware/rateLimiter', () => ({ getRateLimiterStatus: jest.fn().mockReturnValue({}) }));

// ── Helpers ──────────────────────────────────────────────────────────────────

const START = new Date('2026-11-20T12:00:00.000Z');
const tokenFor = (ledger) => (BigInt(ledger) << BigInt(32)).toString();

let listener;
let health;
let metrics;

/** Let pending promise chains and timers up to `ms` run. */
const advance = (ms) => jest.advanceTimersByTimeAsync(ms);

async function startListener() {
  listener.initStreams();
  await advance(1); // init, cursor lookup, stream open, first poll
}

beforeEach(() => {
  jest.useFakeTimers({ now: START });
  jest.resetModules();
  mockHorizon.ledgerSeq = 1002;
  mockHorizon.paymentLedger = 1000;
  mockHorizon.failPolls = false;
  mockHorizon.streams = {};
  delete process.env.LEDGER_LISTENER_MAX_STALE_MS;
  listener = require('../src/services/ledgerListener');
  health = require('../src/services/health');
  metrics = require('../src/utils/metrics');
});

afterEach(() => {
  listener.stopAll();
  jest.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('evaluateLedgerLag', () => {
  test('baselines to Horizon when the stream has no position yet', () => {
    expect(listener.evaluateLedgerLag(null, 1000)).toEqual({ lag: 0, baseline: 1000 });
  });

  test('reports how many ledgers the stream is behind', () => {
    expect(listener.evaluateLedgerLag(1000, 1004)).toEqual({ lag: 4, baseline: 1000 });
  });

  test('never reports negative lag', () => {
    expect(listener.evaluateLedgerLag(1010, 1004).lag).toBe(0);
  });

  test('has nothing to be behind when Horizon has no payments', () => {
    expect(listener.evaluateLedgerLag(null, null)).toEqual({ lag: 0, baseline: null });
  });
});

describe('/health/deep ledger_listener', () => {
  test('is unknown before the listener has started', () => {
    expect(health.checkLedgerListener()).toMatchObject({ status: 'unknown', last_event_at: null });
  });

  test('shows a non-null last_event_at within 10s of startup, with lag details', async () => {
    await startListener();
    await advance(5000);

    const result = health.checkLedgerListener();
    expect(result.status).toBe('healthy');
    expect(result.last_event_at).not.toBeNull();
    expect(Date.parse(result.last_event_at) - START.getTime()).toBeLessThan(10_000);
    expect(result.lag_ledgers).toBe(0);
    expect(result.horizon_latest_ledger).toBe(1002);
  });

  test('stays healthy on a quiet network with no payments for minutes (no flapping)', async () => {
    await startListener();
    await advance(10 * 60_000); // ten minutes, Horizon has no newer payments

    const result = health.checkLedgerListener();
    expect(result.status).toBe('healthy');
    expect(result.lag_ledgers).toBe(0);
    expect(result.stale_ms).toBeLessThan(30_000);
  });

  test('goes degraded within 2 minutes when the stream stops delivering while payments continue', async () => {
    await startListener();
    expect(health.checkLedgerListener().status).toBe('healthy');

    // The stream goes silent, but the network keeps producing payments.
    mockHorizon.paymentLedger = 1010;
    await advance(60_000);
    expect(health.checkLedgerListener().status).toBe('healthy'); // still inside the window

    mockHorizon.paymentLedger = 1030;
    await advance(40_000); // 100s after the last proof of life
    const result = health.checkLedgerListener();
    expect(result.status).toBe('degraded');
    expect(result.lag_ledgers).toBeGreaterThan(0);
    expect(result.stale_ms).toBeLessThan(2 * 60_000);
  });

  test('recovers once the stream delivers again', async () => {
    await startListener();
    mockHorizon.paymentLedger = 1010;
    await advance(100_000);
    expect(health.checkLedgerListener().status).toBe('degraded');

    mockHorizon.streams.payments.onmessage({
      type: 'payment',
      paging_token: tokenFor(1010),
      to: 'GNOTWATCHED',
    });
    expect(health.checkLedgerListener().status).toBe('healthy');
    expect(health.checkLedgerListener().last_ledger_sequence).toBe(1010);
  });

  test('a stream message counts as proof of life on its own', async () => {
    mockHorizon.failPolls = true; // polls cannot help
    await startListener();

    mockHorizon.streams.payments.onmessage({ type: 'path_payment', paging_token: tokenFor(1001) });
    const result = health.checkLedgerListener();
    expect(result.status).toBe('healthy');
    expect(result.last_ledger_sequence).toBe(1001);
  });

  test('is degraded when the listener started but never produced anything', async () => {
    mockHorizon.failPolls = true;
    await startListener();
    expect(health.checkLedgerListener().status).toBe('unknown'); // too early to judge

    await advance(100_000);
    expect(health.checkLedgerListener()).toMatchObject({ status: 'degraded', last_event_at: null });
  });

  test('the staleness threshold is configurable', async () => {
    process.env.LEDGER_LISTENER_MAX_STALE_MS = '20000';
    await startListener();
    mockHorizon.paymentLedger = 1010;
    await advance(30_000);
    expect(health.checkLedgerListener().status).toBe('degraded');
  });

  test('setLastLedgerEvent is exported and feeds the health check', () => {
    health.setLastLedgerEvent(Date.now(), { lastLedgerSequence: 7 });
    expect(health.checkLedgerListener()).toMatchObject({ status: 'healthy', last_ledger_sequence: 7 });
  });
});

describe('ledger_listener_lag_ledgers gauge', () => {
  test('is exported on every poll', async () => {
    await startListener();
    expect(metrics.ledgerListenerLagLedgers.set).toHaveBeenLastCalledWith(0);

    mockHorizon.paymentLedger = 1007;
    await advance(15_000);
    expect(metrics.ledgerListenerLagLedgers.set).toHaveBeenLastCalledWith(7);
  });

  test('records the time of the last proof of life', async () => {
    await startListener();
    const calls = metrics.ledgerListenerLastEventTimestampSeconds.set.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(Math.abs(calls[0][0] - START.getTime() / 1000)).toBeLessThan(1);
  });
});
