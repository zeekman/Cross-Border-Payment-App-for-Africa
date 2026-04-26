/**
 * Unit tests for the geoRestriction middleware.
 *
 * geoip-lite is mocked so that tests are deterministic and don't rely on
 * real MaxMind data.  We verify:
 *   - Allowed countries pass through to next().
 *   - Blocked countries receive HTTP 451 with the correct error body.
 *   - Unknown / unresolvable IPs pass through (fail-open).
 *   - Blocked attempts are logged via Winston.
 */

// Set env BEFORE any module loads so the middleware caches the correct list.
process.env.BLOCKED_COUNTRIES = 'KP,IR,CU,RU,SY';

jest.mock('geoip-lite', () => ({
  lookup: jest.fn(),
}));

jest.mock('../utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const geoip = require('geoip-lite');
const logger = require('../utils/logger');

// Now require the middleware — it will read the env var we set above.
let geoRestriction;
beforeAll(() => {
  // Clear any previous cached version and re-require.
  delete require.cache[require.resolve('../middleware/geoRestriction')];
  geoRestriction = require('../middleware/geoRestriction');
});

// ---------- helpers ----------
function makeReq(overrides = {}) {
  return {
    ip: '1.2.3.4',
    headers: {},
    requestId: 'test-request-id',
    method: 'POST',
    originalUrl: '/api/auth/register',
    ...overrides,
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
  return res;
}

// ---------- tests ----------

beforeEach(() => jest.clearAllMocks());

describe('geoRestriction middleware', () => {
  test('allows request from a non-blocked country', () => {
    geoip.lookup.mockReturnValue({ country: 'US' });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('blocks request from a sanctioned country (IR) with 451', () => {
    geoip.lookup.mockReturnValue({ country: 'IR' });

    const req = makeReq({ ip: '5.6.7.8' });
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(451);
    expect(res.body).toEqual({
      error: 'Service unavailable in your jurisdiction',
    });
  });

  test('blocks request from North Korea (KP)', () => {
    geoip.lookup.mockReturnValue({ country: 'KP' });

    const req = makeReq({ ip: '175.45.176.1' });
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(451);
  });

  test('logs blocked attempts with audit-relevant details', () => {
    geoip.lookup.mockReturnValue({ country: 'SY' });

    const req = makeReq({
      ip: '10.0.0.1',
      requestId: 'audit-req-123',
      method: 'POST',
      originalUrl: '/api/auth/login',
    });
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    expect(logger.warn).toHaveBeenCalledWith(
      'Blocked request from sanctioned country',
      expect.objectContaining({
        requestId: 'audit-req-123',
        ip: '10.0.0.1',
        country: 'SY',
        method: 'POST',
        path: '/api/auth/login',
      })
    );
  });

  test('allows request when geoip lookup returns null (unknown IP)', () => {
    geoip.lookup.mockReturnValue(null);

    const req = makeReq({ ip: '127.0.0.1' });
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  test('allows request when IP cannot be determined', () => {
    geoip.lookup.mockReturnValue(null);

    const req = makeReq({ ip: undefined, headers: {} });
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('reads IP from x-forwarded-for when req.ip is missing', () => {
    geoip.lookup.mockReturnValue({ country: 'CU' });

    const req = makeReq({
      ip: undefined,
      headers: { 'x-forwarded-for': '9.8.7.6, 10.0.0.1' },
    });
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    // The middleware should use the first IP in x-forwarded-for
    expect(geoip.lookup).toHaveBeenCalledWith('9.8.7.6');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(451);
  });

  test('country code comparison is case-insensitive', () => {
    geoip.lookup.mockReturnValue({ country: 'ru' }); // lowercase from geoip

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(451);
  });

  test('allows request from an African country (NG)', () => {
    geoip.lookup.mockReturnValue({ country: 'NG' });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});
