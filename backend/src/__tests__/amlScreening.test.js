'use strict';

/**
 * Tests for AML/sanctions screening (backend/src/services/amlScreening.js) and
 * the fail-closed compliance gate (amlRescreenForPayment in kycController).
 *
 * Provider tests cover flagged, clear, and provider-error responses for the
 * ComplyAdvantage and Elliptic integrations.
 */

jest.mock('../utils/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../utils/metrics', () => ({
  amlScreeningsTotal: { inc: jest.fn() },
  amlScreeningCoverageGauge: { set: jest.fn() },
}));
jest.mock('../db', () => ({ query: jest.fn() }));

const logger = require('../utils/logger');
const metrics = require('../utils/metrics');

const WALLET = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';

function mockFetchOk(body) {
  global.fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(body) });
}

function mockFetchError(status, text) {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status, text: async () => text });
}

function mockFetchNetworkError() {
  global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
}

function clearAmlEnv() {
  delete process.env.AML_PROVIDER;
  delete process.env.AML_API_KEY;
  delete process.env.AML_API_SECRET;
  delete process.env.AML_API_URL;
  delete process.env.AML_HIGH_RISK_SCORE;
  delete process.env.AML_API_TIMEOUT_MS;
}

describe('AML screening service', () => {
  let amlScreen;
  let isAmlConfigured;

  beforeEach(() => {
    jest.clearAllMocks();
    clearAmlEnv();
    global.fetch = jest.fn();
    amlScreen = require('../services/amlScreening').amlScreen;
    isAmlConfigured = require('../services/amlScreening').isAmlConfigured;
    require('../services/amlScreening').resetAmlMetricCounters();
  });

  afterAll(() => {
    delete global.fetch;
  });

  // -------------------------------------------------------------------------
  // Unconfigured passthrough
  // -------------------------------------------------------------------------

  test('returns not_screened passthrough when no provider is configured', async () => {
    const result = await amlScreen(WALLET, { userId: 'user-1' });

    expect(result).toMatchObject({
      screened: false,
      status: 'not_screened',
      risk_level: null,
      provider: null,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(metrics.amlScreeningsTotal.inc).toHaveBeenCalledWith({ status: 'not_screened' });
    expect(metrics.amlScreeningCoverageGauge.set).toHaveBeenCalledWith(0);
  });

  test('isAmlConfigured is false without provider or key', () => {
    expect(isAmlConfigured()).toBe(false);
  });

  test('returns not_screened for an unknown provider even with a key set', async () => {
    process.env.AML_PROVIDER = 'unknown';
    process.env.AML_API_KEY = 'some-key';
    const result = await amlScreen(WALLET, { userId: 'user-1' });
    expect(result.status).toBe('not_screened');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns error when a configured provider screens a missing wallet address', async () => {
    process.env.AML_PROVIDER = 'complyadvantage';
    process.env.AML_API_KEY = 'test-key';
    const result = await amlScreen('', { userId: 'user-1' });
    expect(result.status).toBe('error');
    expect(result.error).toBe('missing_wallet_address');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // ComplyAdvantage
  // -------------------------------------------------------------------------

  describe('ComplyAdvantage integration', () => {
    beforeEach(() => {
      process.env.AML_PROVIDER = 'complyadvantage';
      process.env.AML_API_KEY = 'test-ca-key';
    });

    test('isAmlConfigured is true when provider and key are set', () => {
      expect(isAmlConfigured()).toBe(true);
    });

    test('flags a wallet with a true_positive sanctions hit', async () => {
      mockFetchOk({
        status: 'success',
        content: {
          data: {
            id: 12345,
            ref: 'CA12345',
            search_term: WALLET,
            match_status: 'true_positive',
            risk_level: 'high',
            total_hits: 2,
          },
        },
      });

      const result = await amlScreen(WALLET, { userId: 'user-1' });

      expect(result).toMatchObject({
        screened: true,
        status: 'flagged',
        risk_level: 'high',
        provider: 'complyadvantage',
        reference_id: '12345',
      });
      expect(metrics.amlScreeningsTotal.inc).toHaveBeenCalledWith({ status: 'flagged' });
    });

    test('flags a wallet with total_hits > 0 even when match_status is absent', async () => {
      mockFetchOk({ status: 'success', content: { data: { id: 1, total_hits: 1 } } });
      const result = await amlScreen(WALLET, { userId: 'user-1' });
      expect(result.status).toBe('flagged');
    });

    test('returns clear when there are no hits', async () => {
      mockFetchOk({
        status: 'success',
        content: {
          data: { id: 54321, match_status: 'no_match', risk_level: 'low', total_hits: 0, hits: [] },
        },
      });

      const result = await amlScreen(WALLET, { userId: 'user-1' });

      expect(result).toMatchObject({
        screened: true,
        status: 'clear',
        risk_level: 'low',
        provider: 'complyadvantage',
        reference_id: '54321',
      });
      expect(metrics.amlScreeningsTotal.inc).toHaveBeenCalledWith({ status: 'clear' });
      expect(metrics.amlScreeningCoverageGauge.set).toHaveBeenCalledWith(1);
    });

    test('sends the wallet address and auth header to the provider', async () => {
      mockFetchOk({ status: 'success', content: { data: { id: 1, total_hits: 0 } } });

      await amlScreen(WALLET, { userId: 'user-1' });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = global.fetch.mock.calls[0];
      expect(url).toContain('/searches');
      expect(init.headers.Authorization).toBe('Token test-ca-key');
      const body = JSON.parse(init.body);
      expect(body.search_term).toBe(WALLET);
      expect(body.client_ref).toBe('afripay-user-1');
    });

    test('uses full_name as the search term when provided', async () => {
      mockFetchOk({ status: 'success', content: { data: { id: 1, total_hits: 0 } } });
      await amlScreen(WALLET, { userId: 'user-1', full_name: 'Jane Doe' });
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.search_term).toBe('Jane Doe');
    });

    test('returns error on HTTP 500 from the provider', async () => {
      mockFetchError(500, 'Internal Server Error');

      const result = await amlScreen(WALLET, { userId: 'user-1' });

      expect(result).toMatchObject({
        screened: false,
        status: 'error',
        provider: 'complyadvantage',
      });
      expect(result.error).toContain('HTTP 500');
      expect(logger.error).toHaveBeenCalled();
      expect(metrics.amlScreeningsTotal.inc).toHaveBeenCalledWith({ status: 'error' });
    });

    test('returns error on network failure', async () => {
      mockFetchNetworkError();
      const result = await amlScreen(WALLET, { userId: 'user-1' });
      expect(result).toMatchObject({
        screened: false,
        status: 'error',
        provider: 'complyadvantage',
      });
    });

    test('returns error on unparseable provider response', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, text: async () => 'not-json' });
      const result = await amlScreen(WALLET, { userId: 'user-1' });
      expect(result.status).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // Elliptic
  // -------------------------------------------------------------------------

  describe('Elliptic integration', () => {
    beforeEach(() => {
      process.env.AML_PROVIDER = 'elliptic';
      process.env.AML_API_KEY = 'test-elliptic-key';
      process.env.AML_API_SECRET = Buffer.from('this-is-a-test-secret-for-elliptic!').toString(
        'base64'
      );
    });

    test('isAmlConfigured is true when key and secret are set', () => {
      expect(isAmlConfigured()).toBe(true);
    });

    test('isAmlConfigured is false when the secret is missing', () => {
      delete process.env.AML_API_SECRET;
      expect(isAmlConfigured()).toBe(false);
    });

    test('flags a wallet with a high risk score', async () => {
      mockFetchOk({ id: 'ELL-1', risk_score: 95, risk_rules: [] });

      const result = await amlScreen(WALLET, { userId: 'user-1' });

      expect(result).toMatchObject({
        screened: true,
        status: 'flagged',
        risk_level: 'high',
        provider: 'elliptic',
        reference_id: 'ELL-1',
      });
    });

    test('flags a wallet with a high-severity risk rule even at a low score', async () => {
      mockFetchOk({
        id: 'ELL-2',
        risk_score: 20,
        risk_rules: [{ id: 'r1', name: 'sanctions', severity: 'critical' }],
      });
      const result = await amlScreen(WALLET, { userId: 'user-1' });
      expect(result.status).toBe('flagged');
    });

    test('returns clear for a low risk score with no severe rules', async () => {
      mockFetchOk({
        id: 'ELL-3',
        risk_score: 12,
        risk_rules: [{ id: 'r2', name: 'exchange', severity: 'low' }],
      });

      const result = await amlScreen(WALLET, { userId: 'user-1' });

      expect(result).toMatchObject({
        screened: true,
        status: 'clear',
        risk_level: 'low',
        provider: 'elliptic',
      });
    });

    test('signs the request with the configured secret', async () => {
      mockFetchOk({ id: 'ELL-4', risk_score: 0, risk_rules: [] });

      await amlScreen(WALLET, { userId: 'user-1' });

      const [url, init] = global.fetch.mock.calls[0];
      expect(url).toContain('/v2/wallet/synchronous');
      expect(init.headers['x-access-key']).toBe('test-elliptic-key');
      expect(init.headers['x-access-timestamp']).toMatch(/^\d+$/);
      expect(init.headers['x-access-sign']).toBeTruthy();
    });

    test('returns error on HTTP 500 from the provider', async () => {
      mockFetchError(500, 'boom');
      const result = await amlScreen(WALLET, { userId: 'user-1' });
      expect(result).toMatchObject({ screened: false, status: 'error', provider: 'elliptic' });
    });

    test('returns error on network failure', async () => {
      mockFetchNetworkError();
      const result = await amlScreen(WALLET, { userId: 'user-1' });
      expect(result.status).toBe('error');
    });
  });
});

// -------------------------------------------------------------------------
// Fail-closed compliance gate (kycController.amlRescreenForPayment)
// -------------------------------------------------------------------------

describe('amlRescreenForPayment fail-closed gate', () => {
  let amlRescreenForPayment;

  beforeEach(() => {
    jest.clearAllMocks();
    clearAmlEnv();
    global.fetch = jest.fn();
    amlRescreenForPayment = require('../controllers/kycController').amlRescreenForPayment;
    require('../services/amlScreening').resetAmlMetricCounters();
  });

  afterAll(() => {
    delete global.fetch;
  });

  test('returns null below the rescreen threshold even when screening is unconfigured', async () => {
    const result = await amlRescreenForPayment('user-1', WALLET, 999);
    expect(result).toBeNull();
  });

  test('blocks a high-value payment with 403 when screening is not configured', async () => {
    await expect(amlRescreenForPayment('user-1', WALLET, 1500)).rejects.toMatchObject({
      status: 403,
      payload: { code: 'AML_SCREENING_UNAVAILABLE' },
    });
  });

  test('blocks a high-value payment with 403 when the provider flags the wallet', async () => {
    process.env.AML_PROVIDER = 'complyadvantage';
    process.env.AML_API_KEY = 'test-ca-key';
    mockFetchOk({
      status: 'success',
      content: { data: { match_status: 'true_positive', total_hits: 1, risk_level: 'high' } },
    });

    await expect(amlRescreenForPayment('user-1', WALLET, 1500)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('flagged'),
    });
  });

  test('blocks a high-value payment with 503 when the provider errors', async () => {
    process.env.AML_PROVIDER = 'complyadvantage';
    process.env.AML_API_KEY = 'test-ca-key';
    mockFetchNetworkError();

    await expect(amlRescreenForPayment('user-1', WALLET, 1500)).rejects.toMatchObject({
      status: 503,
      payload: { code: 'AML_SCREENING_ERROR' },
    });
  });

  test('passes through a high-value payment when the provider returns clear', async () => {
    process.env.AML_PROVIDER = 'complyadvantage';
    process.env.AML_API_KEY = 'test-ca-key';
    mockFetchOk({
      status: 'success',
      content: { data: { match_status: 'no_match', total_hits: 0 } },
    });

    const result = await amlRescreenForPayment('user-1', WALLET, 1500);
    expect(result).toMatchObject({ screened: true, status: 'clear' });
  });
});
