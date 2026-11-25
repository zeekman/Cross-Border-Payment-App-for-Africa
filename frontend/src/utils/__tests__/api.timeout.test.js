import toast from 'react-hot-toast';

jest.mock('react-hot-toast', () => ({ error: jest.fn(), success: jest.fn() }));
jest.mock('../offlineDB', () => ({ enqueuePayment: jest.fn() }));
jest.mock('../../context/AuthContext', () => ({
  tokenStore: { get: () => null, set: jest.fn(), clear: jest.fn() },
}));

// Helper: re-import api with a specific env value
function loadApi(timeoutEnv) {
  jest.resetModules();
  if (timeoutEnv !== undefined) {
    process.env.REACT_APP_API_TIMEOUT_MS = timeoutEnv;
  } else {
    delete process.env.REACT_APP_API_TIMEOUT_MS;
  }
  // Re-apply mocks after resetModules
  jest.mock('react-hot-toast', () => ({ error: jest.fn(), success: jest.fn() }));
  jest.mock('../offlineDB', () => ({ enqueuePayment: jest.fn() }));
  jest.mock('../../context/AuthContext', () => ({
    tokenStore: { get: () => null, set: jest.fn(), clear: jest.fn() },
  }));
  return require('../api').default;
}

afterEach(() => {
  delete process.env.REACT_APP_API_TIMEOUT_MS;
  jest.resetModules();
});

// ── Timeout configuration ──────────────────────────────────────────────────

test('defaults to 30000ms when REACT_APP_API_TIMEOUT_MS is not set', () => {
  const api = loadApi(undefined);
  expect(api.defaults.timeout).toBe(30000);
});

test('uses REACT_APP_API_TIMEOUT_MS when set to a valid number', () => {
  const api = loadApi('10000');
  expect(api.defaults.timeout).toBe(10000);
});

test('falls back to 30000ms when REACT_APP_API_TIMEOUT_MS is not a number', () => {
  const api = loadApi('abc');
  expect(api.defaults.timeout).toBe(30000);
});

test('falls back to 30000ms when REACT_APP_API_TIMEOUT_MS is zero', () => {
  const api = loadApi('0');
  expect(api.defaults.timeout).toBe(30000);
});

test('falls back to 30000ms when REACT_APP_API_TIMEOUT_MS is negative', () => {
  const api = loadApi('-1000');
  expect(api.defaults.timeout).toBe(30000);
});

// ── Timeout error handling ─────────────────────────────────────────────────

test('shows timeout toast and rejects on ECONNABORTED timeout error', async () => {
  const api = loadApi(undefined);
  const toastMock = require('react-hot-toast');

  const timeoutErr = Object.assign(new Error('timeout of 30000ms exceeded'), {
    code: 'ECONNABORTED',
    config: { url: '/test', _retry: false },
    response: undefined,
  });

  // Trigger the response error interceptor directly
  const interceptor = api.interceptors.response.handlers[
    api.interceptors.response.handlers.length - 1
  ];

  await expect(interceptor.rejected(timeoutErr)).rejects.toThrow('timeout');
  expect(toastMock.error).toHaveBeenCalledWith(
    'Request timed out. Please check your connection.'
  );
});

test('does not show timeout toast for non-timeout errors', async () => {
  const api = loadApi(undefined);
  const toastMock = require('react-hot-toast');

  const networkErr = Object.assign(new Error('Network Error'), {
    code: 'ERR_NETWORK',
    config: { url: '/test', _retry: false },
    response: undefined,
  });

  const interceptor = api.interceptors.response.handlers[
    api.interceptors.response.handlers.length - 1
  ];

  await expect(interceptor.rejected(networkErr)).rejects.toThrow('Network Error');
  expect(toastMock.error).not.toHaveBeenCalledWith(
    'Request timed out. Please check your connection.'
  );
});
