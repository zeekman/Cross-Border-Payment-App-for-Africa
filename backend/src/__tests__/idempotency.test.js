const idempotency = require('../middleware/idempotency');
const db = require('../db');

jest.mock('../db');

function makeReq({ key, body = { amount: 10, recipient_address: 'GABC' }, userId = 'user-1' } = {}) {
  return {
    headers: { 'idempotency-key': key },
    body,
    user: { userId }
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json: jest.fn()
  };
  return res;
}

beforeEach(() => jest.clearAllMocks());

describe('idempotency middleware', () => {
  test('passes through when no Idempotency-Key header is present', async () => {
    const req = makeReq({ key: undefined });
    const res = makeRes();
    const next = jest.fn();

    db.query.mockResolvedValue({ rows: [] });
    await idempotency(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  test('returns 400 when key exceeds 255 characters', async () => {
    const req = makeReq({ key: 'a'.repeat(256) });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(res.status).toBeDefined();
    expect(next).not.toHaveBeenCalled();
  });

  test('replays cached response for duplicate key with same body', async () => {
    const crypto = require('crypto');
    const body = { amount: 10, recipient_address: 'GABC' };
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

    const cached = { request_hash: requestHash, status_code: 200, response: { message: 'Payment sent successfully' } };

    // First call: purge query, then lookup returns cached row
    db.query
      .mockResolvedValueOnce({ rows: [] })   // purge
      .mockResolvedValueOnce({ rows: [cached] }); // lookup

    const req = makeReq({ key: 'key-123', body });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(cached.response);
  });

  test('returns 400 when same key is reused with different body', async () => {
    const crypto = require('crypto');
    const originalBody = { amount: 10, recipient_address: 'GABC' };
    const differentBody = { amount: 99, recipient_address: 'GXYZ' };
    const originalHash = crypto.createHash('sha256').update(JSON.stringify(originalBody)).digest('hex');

    const cached = { request_hash: originalHash, status_code: 200, response: {} };

    db.query
      .mockResolvedValueOnce({ rows: [] })        // purge
      .mockResolvedValueOnce({ rows: [cached] }); // lookup

    const req = makeReq({ key: 'key-123', body: differentBody });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('different request parameters') })
    );
  });

  test('calls next and caches response for a new key', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })  // purge
      .mockResolvedValueOnce({ rows: [] })  // lookup — no existing record
      .mockResolvedValueOnce({ rows: [] }); // INSERT

    const req = makeReq({ key: 'new-key', body: { amount: 5, recipient_address: 'GDEF' } });
    const res = makeRes();
    const next = jest.fn();

    await idempotency(req, res, next);

    expect(next).toHaveBeenCalled();

    // Simulate the controller calling res.json
    await res.json({ message: 'Payment sent successfully' });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO idempotency_keys'),
      expect.arrayContaining(['new-key', 'user-1'])
    );
  });
});
