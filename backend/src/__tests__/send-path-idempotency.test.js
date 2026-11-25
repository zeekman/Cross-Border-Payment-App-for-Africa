/**
 * Tests that POST /api/payments/send-path applies idempotency middleware,
 * so a duplicate request with the same Idempotency-Key returns the cached
 * response instead of broadcasting a second path payment to Stellar.
 */
const crypto = require('crypto');
const idempotency = require('../middleware/idempotency');
const db = require('../db');
const cache = require('../utils/cache');

jest.mock('../db');
jest.mock('../utils/cache');

// Valid UUID v4 keys
const KEY_EXISTING = '123e4567-e89b-4d3c-a456-426614174001';
const KEY_NEW = '123e4567-e89b-4d3c-a456-426614174002';

function makeReq({ key, body = {} } = {}) {
  return {
    headers: { 'idempotency-key': key },
    body,
    user: { userId: 'user-1' },
    path: '/api/payments/send-path',
    method: 'POST',
  };
}

function makeRes(statusCode = 200) {
  const jsonSpy = jest.fn();
  const res = {
    statusCode,
    _jsonSpy: jsonSpy,
    status(code) { this.statusCode = code; return this; },
    json: jsonSpy,
    set: jest.fn(),
    on: jest.fn(),
  };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  cache.get.mockResolvedValue(null);
  cache.set.mockResolvedValue(undefined);
  cache.del.mockResolvedValue(undefined);
  db.query.mockResolvedValue({ rows: [] });
});

describe('send-path idempotency', () => {
  const sendPathBody = {
    recipient_address: 'GDEST1234567890123456789012345678901234567890123456',
    source_asset: 'XLM',
    source_amount: '10',
    destination_asset: 'USDC',
    destination_min_amount: '9.5',
  };

  test('returns cached response on duplicate Idempotency-Key for send-path', async () => {
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(sendPathBody))
      .digest('hex');

    const cachedResponse = {
      message: 'Path payment sent successfully',
      transaction: { tx_hash: 'abc123', amount: '10', asset: 'XLM' },
    };

    cache.get.mockImplementation((k) => {
      if (k === `idem:payment:${KEY_EXISTING}`) {
        return Promise.resolve({ statusCode: 200, body: cachedResponse, request_hash: requestHash });
      }
      return Promise.resolve(null);
    });

    const req = makeReq({ key: KEY_EXISTING, body: sendPathBody });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    // Should replay cached response, not call next (i.e. not hit Stellar again)
    expect(next).not.toHaveBeenCalled();
    expect(res._jsonSpy).toHaveBeenCalledWith(cachedResponse);
  });

  test('proceeds to handler and caches response for a new Idempotency-Key', async () => {
    cache.get.mockResolvedValue(null);
    db.query.mockResolvedValue({ rows: [] });

    const req = makeReq({ key: KEY_NEW, body: sendPathBody });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(next).toHaveBeenCalled();

    // Simulate controller responding
    await res.json({ message: 'Path payment sent successfully' });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO idempotency_keys'),
      expect.arrayContaining([KEY_NEW, 'user-1'])
    );
  });
});
