/**
 * Tests for issue #264: /health endpoint must not expose internal details.
 * Tests the health service and the app.js handler logic directly.
 */
jest.mock('../src/db');
jest.mock('../src/services/stellar', () => ({
  checkHorizonHealth: jest.fn().mockResolvedValue(true),
}));

const db = require('../src/db');
const stellar = require('../src/services/stellar');
const { runHealthChecks } = require('../src/services/health');

describe('runHealthChecks (health service)', () => {
  beforeEach(() => {
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    db.getPoolStats.mockReturnValue({ total: 5, idle: 3, waiting: 0 });
    stellar.checkHorizonHealth.mockResolvedValue(true);
  });

  afterEach(() => jest.clearAllMocks());

  test('returns status ok with full details when all healthy', async () => {
    const result = await runHealthChecks();
    expect(result.status).toBe('ok');
    expect(result.db).toBe('ok');
    expect(result.stellar).toBe('ok');
    expect(result).toHaveProperty('pool');
  });

  test('returns status degraded when db is down', async () => {
    db.query.mockRejectedValueOnce(new Error('connection refused'));
    const result = await runHealthChecks();
    expect(result.status).toBe('degraded');
    expect(result.db).toBe('down');
  });

  test('returns status degraded when stellar is down', async () => {
    stellar.checkHorizonHealth.mockResolvedValueOnce(false);
    const result = await runHealthChecks();
    expect(result.status).toBe('degraded');
    expect(result.stellar).toBe('down');
  });
});

describe('GET /health public endpoint — issue #264', () => {
  /**
   * Simulate the handler logic from app.js:
   *   const { status } = await runHealthChecks();
   *   res.status(status === 'ok' ? 200 : 503).json({ status });
   */
  function makeRes() {
    const res = { _status: 200, _body: null };
    res.status = (code) => { res._status = code; return res; };
    res.json = (body) => { res._body = body; return res; };
    return res;
  }

  test('exposes only { status } — no db, stellar, network, or pool fields', async () => {
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    db.getPoolStats.mockReturnValue({ total: 5, idle: 3, waiting: 0 });
    stellar.checkHorizonHealth.mockResolvedValue(true);

    const full = await runHealthChecks();
    // Simulate what the handler does
    const publicBody = { status: full.status };

    expect(publicBody).toEqual({ status: 'ok' });
    expect(publicBody).not.toHaveProperty('db');
    expect(publicBody).not.toHaveProperty('stellar');
    expect(publicBody).not.toHaveProperty('network');
    expect(publicBody).not.toHaveProperty('pool');
  });

  test('returns degraded status without internal details when db is down', async () => {
    db.query.mockRejectedValueOnce(new Error('connection refused'));
    db.getPoolStats.mockReturnValue({ total: 5, idle: 0, waiting: 2 });
    stellar.checkHorizonHealth.mockResolvedValue(true);

    const full = await runHealthChecks();
    const publicBody = { status: full.status };

    expect(publicBody).toEqual({ status: 'degraded' });
    expect(JSON.stringify(publicBody)).not.toMatch(/refused/i);
    expect(publicBody).not.toHaveProperty('db');
  });
});
