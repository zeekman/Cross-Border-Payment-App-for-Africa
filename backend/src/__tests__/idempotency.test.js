const crypto = require('crypto');
const idempotency = require('../middleware/idempotency');
const db = require('../db');
const cache = require('../utils/cache');

jest.mock('../db');
jest.mock('../utils/cache');

// Valid UUID v4 for use in tests
const VALID_KEY = '123e4567-e89b-4d3c-a456-426614174000';

function makeReq({ key = VALID_KEY, body = { amount: 10, recipient_address: 'GABC' }, userId = 'user-1', path = '/api/payments/send' } = {}) {
  return {
    headers: { 'idempotency-key': key },
    body,
    user: { userId },
    path,
    method: 'POST',
  };
}

function makeRes() {
  const jsonSpy = jest.fn();
  const res = {
    statusCode: 200,
    _jsonSpy: jsonSpy,
    status(code) { this.statusCode = code; return this; },
    // The middleware replaces res.json, so we expose the original spy separately
    json: jsonSpy,
    set: jest.fn(),
    on: jest.fn(),
  };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no in-flight marker, no Redis cache hit
  cache.get.mockResolvedValue(null);
  cache.set.mockResolvedValue(undefined);
  cache.del.mockResolvedValue(undefined);
  // Default: no DB hit
  db.query.mockResolvedValue({ rows: [] });
});

describe('idempotency middleware', () => {
  test('passes through when no Idempotency-Key header is present', async () => {
    const req = makeReq({ key: undefined });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(next).toHaveBeenCalled();
    // No response sent directly
    expect(res._jsonSpy).not.toHaveBeenCalled();
  });

  test('returns 400 for an invalid (non-UUID v4) Idempotency-Key', async () => {
    const req = makeReq({ key: 'not-a-uuid' });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._jsonSpy).toHaveBeenCalledWith({ error: 'Invalid Idempotency-Key format' });
  });

  test('returns 409 when a request with the same key is already in-flight', async () => {
    cache.get.mockImplementation((k) => {
      if (k.startsWith('idem:inflight:')) return Promise.resolve('1');
      return Promise.resolve(null);
    });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._jsonSpy).toHaveBeenCalledWith({ error: 'Request in progress' });
  });

  // --- Redis cache-hit path ---

  test('replays cached Redis response when same key is reused with the same body', async () => {
    const body = { amount: 10, recipient_address: 'GABC' };
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

    cache.get.mockImplementation((k) => {
      if (k === `idem:payment:${VALID_KEY}`) {
        return Promise.resolve({ statusCode: 200, body: { txHash: 'abc123' }, request_hash: requestHash });
      }
      return Promise.resolve(null);
    });

    const req = makeReq({ body });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith('X-Idempotency-Replayed', 'true');
    expect(res._jsonSpy).toHaveBeenCalledWith({ txHash: 'abc123' });
  });

  test('returns 409 when same key is reused with a different body (Redis cache hit)', async () => {
    const originalBody = { amount: 10, recipient_address: 'GABC' };
    const originalHash = crypto.createHash('sha256').update(JSON.stringify(originalBody)).digest('hex');

    cache.get.mockImplementation((k) => {
      if (k === `idem:payment:${VALID_KEY}`) {
        return Promise.resolve({ statusCode: 200, body: { txHash: 'abc123' }, request_hash: originalHash });
      }
      return Promise.resolve(null);
    });

    const differentBody = { amount: 99, recipient_address: 'GXYZ' };
    const req = makeReq({ body: differentBody });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res._jsonSpy).toHaveBeenCalledWith({
      error: 'Idempotency-Key reused with a different request body',
    });
  });

  // --- DB fallback cache-hit path ---

  test('replays DB-cached response when same key is reused with the same body (DB fallback)', async () => {
    const body = { amount: 10, recipient_address: 'GABC' };
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

    // Redis miss, DB hit
    cache.get.mockResolvedValue(null);
    db.query.mockResolvedValue({
      rows: [{ request_hash: requestHash, status_code: 200, response: { txHash: 'def456' } }],
    });

    const req = makeReq({ body });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith('X-Idempotency-Replayed', 'true');
    expect(res._jsonSpy).toHaveBeenCalledWith({ txHash: 'def456' });
  });

  test('returns 409 when same key is reused with a different body (DB fallback)', async () => {
    const originalBody = { amount: 10, recipient_address: 'GABC' };
    const originalHash = crypto.createHash('sha256').update(JSON.stringify(originalBody)).digest('hex');

    // Redis miss, DB hit with a different hash stored
    cache.get.mockResolvedValue(null);
    db.query.mockResolvedValue({
      rows: [{ request_hash: originalHash, status_code: 200, response: {} }],
    });

    const differentBody = { amount: 99, recipient_address: 'GXYZ' };
    const req = makeReq({ body: differentBody });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res._jsonSpy).toHaveBeenCalledWith({
      error: 'Idempotency-Key reused with a different request body',
    });
  });

  // --- New key (first request) ---

  test('calls next and caches response for a new key', async () => {
    cache.get.mockResolvedValue(null);
    db.query.mockResolvedValue({ rows: [] });

    const req = makeReq({ body: { amount: 5, recipient_address: 'GDEF' } });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(next).toHaveBeenCalled();

    // Simulate the controller calling res.json (the middleware has replaced it)
    await res.json({ message: 'Payment sent successfully' });

    expect(cache.set).toHaveBeenCalledWith(
      expect.stringContaining('idem:payment:'),
      expect.objectContaining({ statusCode: 200, request_hash: expect.any(String) }),
      expect.any(Number)
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO idempotency_keys'),
      expect.arrayContaining([VALID_KEY, 'user-1'])
    );
  });

  // --- Escrow create path (issue #1179) ---

  test('replays cached response for escrow create when same key is reused with the same body', async () => {
    const body = { amount: '12345678.1234567', recipient_address: 'GABC' };
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

    cache.get.mockImplementation((k) => {
      if (k === `idem:escrow:${VALID_KEY}`) {
        return Promise.resolve({ statusCode: 201, body: { escrowId: 'esc-1' }, request_hash: requestHash });
      }
      return Promise.resolve(null);
    });

    const req = makeReq({ body, path: '/api/escrow/create' });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith('X-Idempotency-Replayed', 'true');
    expect(res._jsonSpy).toHaveBeenCalledWith({ escrowId: 'esc-1' });
  });

  test('creates exactly one escrow and caches the response for a new key', async () => {
    cache.get.mockResolvedValue(null);
    db.query.mockResolvedValue({ rows: [] });

    const req = makeReq({ body: { amount: '12345678.1234567', recipient_address: 'GABC' }, path: '/api/escrow/create' });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);

    // Simulate the controller creating the escrow and responding
    await res.json({ escrowId: 'esc-1' });

    expect(cache.set).toHaveBeenCalledWith(
      expect.stringContaining('idem:escrow:'),
      expect.objectContaining({ statusCode: 200, request_hash: expect.any(String) }),
      expect.any(Number)
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO idempotency_keys'),
      expect.arrayContaining([VALID_KEY, 'user-1'])
    );
  });
});
