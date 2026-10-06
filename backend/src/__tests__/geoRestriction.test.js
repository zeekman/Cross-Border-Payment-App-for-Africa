/**
 * Unit tests for the geoRestriction middleware.
 *
 * geoip-lite is mocked so that tests are deterministic and don't rely on
 * real MaxMind data.  We verify:
 *   - Allowed countries pass through to next().
 *   - Blocked countries receive HTTP 451 with the correct error body.
 *   - Unknown / unresolvable IPs fail closed (451) when no trusted proxy.
 *   - Spoofed X-Forwarded-For headers are never trusted without `trust proxy`.
 *   - X-Forwarded-For is honored only when Express `trust proxy` is enabled.
 *   - Proxy misconfiguration / fail-closed paths are logged via Winston.
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

jest.mock('../services/audit', () => ({
  auditLog: jest.fn().mockResolvedValue(undefined),
}));

const geoip = require('geoip-lite');
const logger = require('../utils/logger');
const { auditLog } = require('../services/audit');

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

  test('fails closed when IP cannot be determined and no trusted proxy is configured', () => {
    geoip.lookup.mockReturnValue(null);

    const req = makeReq({ ip: undefined, headers: {} });
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(451);
    expect(res.body).toEqual({
      error: 'Service unavailable in your jurisdiction',
    });
  });

  test('does NOT trust a spoofed x-forwarded-for header when trust proxy is unset', () => {
    geoip.lookup.mockReturnValue(null);

    const req = makeReq({
      ip: undefined,
      headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.1' },
    });
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    // X-Forwarded-For is attacker-controlled with no trusted proxy, so the
    // spoofed IP must never be geolocated.
    expect(geoip.lookup).not.toHaveBeenCalledWith('8.8.8.8');
    expect(geoip.lookup).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(451);
    expect(res.body).toEqual({
      error: 'Service unavailable in your jurisdiction',
    });
  });

  test('honors legitimate x-forwarded-for when trust proxy is configured', () => {
    geoip.lookup.mockReturnValue({ country: 'CU' });

    const req = makeReq({
      ip: undefined,
      app: { get: (key) => (key === 'trust proxy' ? true : undefined) },
      headers: { 'x-forwarded-for': '9.8.7.6, 10.0.0.1' },
    });
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    expect(geoip.lookup).toHaveBeenCalledWith('9.8.7.6');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(451);
  });

  test('honors req.ips chain when trust proxy is configured', () => {
    geoip.lookup.mockReturnValue({ country: 'IR' });

    const req = makeReq({
      ip: undefined,
      app: { get: (key) => (key === 'trust proxy' ? true : undefined) },
      ips: ['5.6.7.8', '10.0.0.1'],
      headers: {},
    });
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    expect(geoip.lookup).toHaveBeenCalledWith('5.6.7.8');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(451);
  });

  test('logs a distinct warning when falling back to header-based IP resolution', () => {
    geoip.lookup.mockReturnValue(null);

    const req = makeReq({
      ip: undefined,
      app: { get: (key) => (key === 'trust proxy' ? true : undefined) },
      headers: { 'x-forwarded-for': '9.8.7.6, 10.0.0.1' },
    });
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    expect(logger.warn).toHaveBeenCalledWith(
      'Geo-restriction: resolved client IP from X-Forwarded-For header - verify proxy configuration',
      expect.objectContaining({ ip: '9.8.7.6' })
    );
  });

  test('logs a warning when failing closed on an unresolvable IP', () => {
    const req = makeReq({ ip: undefined, headers: {} });
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    expect(logger.warn).toHaveBeenCalledWith(
      'Geo-restriction: unable to determine client IP - request blocked (fail closed)',
      expect.objectContaining({})
    );
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

// BE-037: denial audit logging and central configurability
describe('geoRestriction compliance audit logging (BE-037)', () => {
  beforeEach(() => {
    auditLog.mockClear();
  });

  test('writes an audit log entry with country and route when a request is denied', () => {
    geoip.lookup.mockReturnValue({ country: 'IR' });

    const req = makeReq({ baseUrl: '/api/payments', originalUrl: '/api/payments/send' });
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    expect(auditLog).toHaveBeenCalledWith(
      req,
      'geo_restriction_denied',
      expect.objectContaining({
        newValue: expect.objectContaining({ country: 'IR', route: '/api/payments' }),
      })
    );
  });

  test('does not write an audit entry when the request is allowed', () => {
    geoip.lookup.mockReturnValue({ country: 'NG' });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    geoRestriction(req, res, next);

    expect(auditLog).not.toHaveBeenCalled();
  });

  test('the blocked-country set is sourced from BLOCKED_COUNTRIES config, not a hardcoded list', () => {
    // reloadBlockedCountries lets ops/tests force a re-read of the env var
    // without restarting the process, proving the list is config-driven.
    expect(typeof geoRestriction.reloadBlockedCountries).toBe('function');

    const previous = process.env.BLOCKED_COUNTRIES;
    process.env.BLOCKED_COUNTRIES = 'NG';
    geoRestriction.reloadBlockedCountries();

    geoip.lookup.mockReturnValue({ country: 'NG' });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();
    geoRestriction(req, res, next);
    expect(res.statusCode).toBe(451);

    // restore
    process.env.BLOCKED_COUNTRIES = previous;
    geoRestriction.reloadBlockedCountries();
  });
});
