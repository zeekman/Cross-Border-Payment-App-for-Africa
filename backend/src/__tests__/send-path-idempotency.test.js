/**
 * Tests that POST /api/payments/send-path applies idempotency middleware,
 * so a duplicate request with the same Idempotency-Key returns the cached
 * response instead of broadcasting a second path payment to Stellar.
 */
const crypto = require('crypto');
const idempotency = require('../middleware/idempotency');
const db = require('../db');

jest.mock('../db');

function makeReq({ key, body = {} } = {}) {
  return {
    headers: { 'idempotency-key': key },
    body,
    user: { userId: 'user-1' },
  };
}

function makeRes(statusCode = 200) {
  const res = {
    statusCode,
    status(code) { this.statusCode = code; return this; },
    json: jest.fn(),
  };
  return res;
}

beforeEach(() => jest.clearAllMocks());

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

    db.query
      .mockResolvedValueOnce({ rows: [] })  // purge expired keys
      .mockResolvedValueOnce({              // lookup — cached entry found
        rows: [{ request_hash: requestHash, status_code: 200, response: cachedResponse }],
      });

    const req = makeReq({ key: 'idem-key-send-path-1', body: sendPathBody });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    // Should replay cached response, not call next (i.e. not hit Stellar again)
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(cachedResponse);
  });

  test('proceeds to handler and caches response for a new Idempotency-Key', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })  // purge
      .mockResolvedValueOnce({ rows: [] })  // lookup — no existing record
      .mockResolvedValueOnce({ rows: [] }); // INSERT

    const req = makeReq({ key: 'idem-key-send-path-new', body: sendPathBody });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(next).toHaveBeenCalled();

    // Simulate controller responding
    await res.json({ message: 'Path payment sent successfully' });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO idempotency_keys'),
      expect.arrayContaining(['idem-key-send-path-new', 'user-1'])
    );
  });
});
