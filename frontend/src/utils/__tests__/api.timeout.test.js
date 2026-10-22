import toast from 'react-hot-toast';

vi.mock('react-hot-toast', () => {
  const toast = { error: vi.fn(), success: vi.fn() };
  return { default: toast, ...toast };
});
vi.mock('../offlineDB', () => ({ enqueuePayment: vi.fn() }));
vi.mock('../../context/AuthContext', () => ({
  tokenStore: { get: () => null, set: vi.fn(), clear: vi.fn() },
}));

// Helper: re-import api with a specific env value. Top-level vi.mock()
// registrations survive vi.resetModules(), so they don't need re-applying.
async function loadApi(timeoutEnv) {
  vi.resetModules();
  if (timeoutEnv !== undefined) {
    process.env.REACT_APP_API_TIMEOUT_MS = timeoutEnv;
  } else {
    delete process.env.REACT_APP_API_TIMEOUT_MS;
  }
  return (await import('../api')).default;
}

afterEach(() => {
  delete process.env.REACT_APP_API_TIMEOUT_MS;
  vi.resetModules();
});

// ── Timeout configuration ──────────────────────────────────────────────────

test('defaults to 30000ms when REACT_APP_API_TIMEOUT_MS is not set', async () => {
  const api = await loadApi(undefined);
  expect(api.defaults.timeout).toBe(30000);
});

test('uses REACT_APP_API_TIMEOUT_MS when set to a valid number', async () => {
  const api = await loadApi('10000');
  expect(api.defaults.timeout).toBe(10000);
});

test('falls back to 30000ms when REACT_APP_API_TIMEOUT_MS is not a number', async () => {
  const api = await loadApi('abc');
  expect(api.defaults.timeout).toBe(30000);
});

test('falls back to 30000ms when REACT_APP_API_TIMEOUT_MS is zero', async () => {
  const api = await loadApi('0');
  expect(api.defaults.timeout).toBe(30000);
});

test('falls back to 30000ms when REACT_APP_API_TIMEOUT_MS is negative', async () => {
  const api = await loadApi('-1000');
  expect(api.defaults.timeout).toBe(30000);
});

// ── Timeout error handling ─────────────────────────────────────────────────

test('shows timeout toast and rejects on ECONNABORTED timeout error', async () => {
  const api = await loadApi(undefined);
  const toastMock = (await import('react-hot-toast')).default;

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
  const api = await loadApi(undefined);
  const toastMock = (await import('react-hot-toast')).default;

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
