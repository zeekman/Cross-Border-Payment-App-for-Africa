/**
 * BE-199: Horizon health classification, every configured endpoint reported,
 * and no timers left pending after a health check.
 */
jest.mock('../src/db');
jest.mock('../src/services/stellar', () => ({
  checkHorizonHealth: jest.fn().mockResolvedValue(true),
  getHorizonEndpoints: jest.fn(),
  getHorizonEndpointStatus: jest.fn(),
}));
jest.mock('../src/services/anchor', () => ({
  getAnchorHealth: jest.fn(() => ({ circuitOpen: false, consecutiveFailures: 0 })),
}));
jest.mock('../src/utils/cache', () => ({ getClient: jest.fn() }));
jest.mock('../src/middleware/rateLimiter', () => ({
  getRateLimiterStatus: jest.fn(() => ({ auth: 'redis' })),
}));

const db = require('../src/db');
const stellar = require('../src/services/stellar');
const cache = require('../src/utils/cache');
const {
  checkHorizonEndpoint,
  checkHorizon,
  checkDatabase,
  checkRedis,
  runDeepHealthChecks,
} = require('../src/services/health');

const PRIMARY = 'https://horizon.example.com/key-abc123';
const FALLBACK = 'https://horizon-backup.example.org';

function response(status) {
  return { ok: status >= 200 && status < 300, status };
}

const realFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn();
  stellar.getHorizonEndpoints.mockReturnValue({ primary: PRIMARY, fallbacks: [FALLBACK] });
  stellar.getHorizonEndpointStatus.mockReturnValue({ node: 'primary', alertExceeded: false });
  db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
  cache.getClient.mockReturnValue({ ping: jest.fn().mockResolvedValue('PONG') });
});

afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('checkHorizonEndpoint status classification', () => {
  test('200 → healthy', async () => {
    global.fetch.mockResolvedValueOnce(response(200));
    const result = await checkHorizonEndpoint(PRIMARY);
    expect(result.status).toBe('healthy');
    expect(result.http_status).toBe(200);
  });

  test('401 (revoked provider key) → unhealthy', async () => {
    global.fetch.mockResolvedValueOnce(response(401));
    const result = await checkHorizonEndpoint(PRIMARY);
    expect(result.status).toBe('unhealthy');
    expect(result.http_status).toBe(401);
  });

  test('403 → unhealthy', async () => {
    global.fetch.mockResolvedValueOnce(response(403));
    expect((await checkHorizonEndpoint(PRIMARY)).status).toBe('unhealthy');
  });

  test('429 → degraded with rate_limited: true', async () => {
    global.fetch.mockResolvedValueOnce(response(429));
    const result = await checkHorizonEndpoint(PRIMARY);
    expect(result.status).toBe('degraded');
    expect(result.rate_limited).toBe(true);
  });

  test('500 → unhealthy', async () => {
    global.fetch.mockResolvedValueOnce(response(500));
    expect((await checkHorizonEndpoint(PRIMARY)).status).toBe('unhealthy');
  });

  test('fetch is given an abort signal so a slow socket is closed on timeout', async () => {
    global.fetch.mockResolvedValueOnce(response(200));
    await checkHorizonEndpoint(PRIMARY);
    const [, options] = global.fetch.mock.calls[0];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  test('a timeout is reported as unhealthy', async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    global.fetch.mockRejectedValueOnce(err);
    const result = await checkHorizonEndpoint(PRIMARY);
    expect(result).toMatchObject({ status: 'unhealthy', error: 'timeout' });
  });

  test('endpoint is reported by origin only (no API key from the path)', async () => {
    global.fetch.mockResolvedValueOnce(response(200));
    const result = await checkHorizonEndpoint(PRIMARY);
    expect(result.url).toBe('https://horizon.example.com');
    expect(JSON.stringify(result)).not.toContain('key-abc123');
  });
});

describe('checkHorizon lists every configured endpoint', () => {
  test('reports primary, fallbacks and the active endpoint', async () => {
    global.fetch.mockImplementation(async () => response(200));
    const result = await checkHorizon();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([PRIMARY, FALLBACK]);
    expect(result.primary).toMatchObject({ url: 'https://horizon.example.com', status: 'healthy' });
    expect(result.fallbacks).toEqual([
      expect.objectContaining({ url: 'https://horizon-backup.example.org', status: 'healthy' }),
    ]);
    expect(result.active).toBe('https://horizon.example.com');
    expect(result.active_node).toBe('primary');
    expect(result.status).toBe('healthy');
  });

  test('running on the fallback marks the fallback active and the check degraded', async () => {
    stellar.getHorizonEndpointStatus.mockReturnValue({ node: 'fallback', alertExceeded: false });
    global.fetch.mockImplementation(async (url) => response(url === PRIMARY ? 503 : 200));

    const result = await checkHorizon();
    expect(result.active).toBe('https://horizon-backup.example.org');
    expect(result.active_node).toBe('fallback');
    expect(result.primary.status).toBe('unhealthy');
    expect(result.status).toBe('degraded');
  });

  test('a rate-limited primary is surfaced as degraded + rate_limited', async () => {
    global.fetch.mockImplementation(async (url) => response(url === PRIMARY ? 429 : 200));
    const result = await checkHorizon();
    expect(result.status).toBe('degraded');
    expect(result.rate_limited).toBe(true);
  });

  test('primary 401 with no fallback configured → unhealthy', async () => {
    stellar.getHorizonEndpoints.mockReturnValue({ primary: PRIMARY, fallbacks: [] });
    global.fetch.mockResolvedValueOnce(response(401));
    const result = await checkHorizon();
    expect(result.status).toBe('unhealthy');
    expect(result.fallbacks).toEqual([]);
  });
});

describe('/health/deep payload', () => {
  test('lists every Horizon endpoint and which one is active', async () => {
    global.fetch.mockImplementation(async () => response(200));
    const health = await runDeepHealthChecks();
    const { horizon } = health.components;
    expect(horizon.primary.url).toBe('https://horizon.example.com');
    expect(horizon.fallbacks.map((f) => f.url)).toEqual(['https://horizon-backup.example.org']);
    expect(horizon.active).toBe('https://horizon.example.com');
  });

  test('a degraded Horizon degrades the overall status without failing readiness', async () => {
    global.fetch.mockImplementation(async (url) => response(url === PRIMARY ? 429 : 200));
    const health = await runDeepHealthChecks();
    expect(health.status).toBe('degraded');
  });
});

describe('no timers left pending (BE-199)', () => {
  beforeEach(() => jest.useFakeTimers());

  test('checkDatabase clears its timeout timer', async () => {
    await checkDatabase();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('checkRedis clears its timeout timer', async () => {
    await checkRedis();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('checkHorizon leaves no timers', async () => {
    global.fetch.mockImplementation(async () => response(200));
    await checkHorizon();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a full deep health check leaves no timers', async () => {
    global.fetch.mockImplementation(async () => response(200));
    await runDeepHealthChecks();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a failing database check still clears its timer', async () => {
    db.query.mockRejectedValueOnce(new Error('connection refused'));
    const result = await checkDatabase();
    expect(result.status).toBe('unhealthy');
    expect(jest.getTimerCount()).toBe(0);
  });
});
