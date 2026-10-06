import axios from 'axios';
import toast from 'react-hot-toast';
import { enqueuePayment } from './offlineDB';
import { tokenStore } from '../context/AuthContext';

// FE-130: Normalise the base URL so both http://localhost:5000 and
// http://localhost:5000/api are accepted.  The canonical form used by api.js
// is always …/api (no trailing slash), so a missing path suffix is appended
// and a stray trailing slash is stripped at the same time.
function normaliseBaseUrl(raw) {
  let url = (raw || 'http://localhost:5000/api').replace(/\/+$/, '');
  if (!url.endsWith('/api')) {
    // eslint-disable-next-line no-console
    console.warn(
      `[AfriPay] REACT_APP_API_URL "${url}" does not end with /api — appending it. ` +
        'Update CI and .env files to use the full path (e.g. http://localhost:5000/api).',
    );
    url = `${url}/api`;
  }
  return url;
}

const baseURL = normaliseBaseUrl(process.env.REACT_APP_API_URL);

const DEFAULT_TIMEOUT = 30000;
const envTimeout = parseInt(process.env.REACT_APP_API_TIMEOUT_MS, 10);
const timeout = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT;

const api = axios.create({
  baseURL,
  withCredentials: true, // sends httpOnly refresh-token cookie automatically
  timeout,
});

/** Separate client for /auth/refresh — avoids triggering the 401 retry loop */
const refreshClient = axios.create({
  baseURL,
  withCredentials: true,
});

// refreshClient also needs the CSRF header for /auth/refresh
refreshClient.interceptors.request.use((config) => {
  const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  if (csrfMatch) config.headers['X-CSRF-Token'] = decodeURIComponent(csrfMatch[1]);
  return config;
});

let isRefreshing = false;
let failedQueue = [];

function processQueue(error, token = null) {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else resolve(token);
  });
  failedQueue = [];
}

function requestUrl(config) {
  const base = config.baseURL || '';
  const path = config.url || '';
  if (path.startsWith('http')) return path;
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function shouldAttemptRefresh(err, config) {
  if (err.response?.status !== 401) return false;
  if (config._retry) return false;

  const url = requestUrl(config);
  const skipPaths = ['/auth/login', '/auth/register', '/auth/refresh'];
  if (skipPaths.some((p) => url.includes(p))) return false;

  const msg = err.response?.data?.error;
  if (msg === 'Invalid PIN' || msg === 'Invalid email or password') return false;

  return true;
}

// Attach in-memory access token to every request
api.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;

  // Double-submit CSRF cookie: read the non-httpOnly csrf_token cookie and
  // echo it as a header so the backend can verify it wasn't forged cross-origin.
  const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  if (csrfMatch) config.headers['X-CSRF-Token'] = decodeURIComponent(csrfMatch[1]);

  return config;
});

api.interceptors.request.use(
  (config) => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return Promise.reject({
        isOfflineError: true,
        message: 'No internet connection',
        config,
      });
    }
    return config;
  },
  (error) => Promise.reject(error)
);

/**
 * Offline payment interceptor
 *
 * When the device has no network and the request is POST /payments/send,
 * enqueue the payload in IndexedDB and resolve with a synthetic
 * { queued: true } response so the UI can show a "queued" confirmation.
 *
 * The entry is bound to the logged-in user (FE-137). Nothing is replayed
 * automatically: when connectivity returns, OfflineBanner asks that same user
 * to review the queued payments and re-confirm with their PIN.
 */
api.interceptors.request.use(async (config) => {
  const isPaymentSend =
    config.method?.toLowerCase() === 'post' &&
    /\/payments\/send\/?$/.test(config.url || '');

  if (isPaymentSend && !navigator.onLine) {
    try {
      await enqueuePayment(config.data ?? {});
    } catch {
      // No logged-in owner — refuse to queue rather than store an orphan entry.
      return Promise.reject({
        isOfflineError: true,
        message: 'No internet connection',
        config,
      });
    }
    const offlineErr = new Error('OFFLINE_QUEUED');
    offlineErr.isOfflineQueued = true;
    offlineErr.config = config;
    throw offlineErr;
  }

  return config;
});

// Instead of a hard navigation (which loses the current URL, e.g. reset-password
// tokens), signal AuthContext to drop the session. PrivateRoute then redirects
// protected pages to /login while remembering where the user was.
export const SESSION_EXPIRED_EVENT = 'afripay:session-expired';
function notifySessionExpired() {
  tokenStore.clear();
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    // Payment was queued offline — surface a clean resolved response
    if (err.isOfflineQueued) {
      return Promise.resolve({
        data: {
          queued: true,
          message:
            'You are offline. Your payment has been queued. When your connection is restored you will be asked to confirm it with your PIN before it is sent.',
        },
        status: 202,
        config: err.config,
      });
    }

    if (!err.response && typeof navigator !== 'undefined' && !navigator.onLine) {
      return Promise.reject({
        isOfflineError: true,
        message: 'No internet connection',
        config: err.config,
      });
    }

    const originalRequest = err.config;
    if (!originalRequest || !shouldAttemptRefresh(err, originalRequest)) {
      if (err.code === 'ECONNABORTED' && err.message?.includes('timeout')) {
        toast.error('Request timed out. Please check your connection.');
        return Promise.reject(err);
      }
      if (err.response?.status === 401) {
        const url = originalRequest ? requestUrl(originalRequest) : '';
        const silent401 =
          url.includes('/auth/login') ||
          url.includes('/auth/register') ||
          url.includes('/auth/verify-pin') ||
          url.includes('/auth/refresh');
        if (!silent401) notifySessionExpired();
      }
      return Promise.reject(err);
    }

    // Queue concurrent requests while a refresh is in flight
    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      })
        .then((token) => {
          originalRequest.headers.Authorization = `Bearer ${token}`;
          return api.request(originalRequest);
        })
        .catch((e) => Promise.reject(e));
    }

    originalRequest._retry = true;
    isRefreshing = true;

    try {
      const newToken = await refreshSession();
      // Store new token in memory only — never in localStorage
      tokenStore.set(newToken);
      processQueue(null, newToken);
      originalRequest.headers.Authorization = `Bearer ${newToken}`;
      return api.request(originalRequest);
    } catch (refreshErr) {
      processQueue(refreshErr, null);
      notifySessionExpired();
      return Promise.reject(refreshErr);
    } finally {
      isRefreshing = false;
    }
  }
);

/**
 * Refresh the session, serialised across tabs with the Web Locks API so two
 * tabs never present the same refresh cookie at once (BE-137). The second
 * tab waits and then refreshes with the already-rotated cookie.
 */
export async function refreshSession() {
  const doRefresh = async () => {
    const { data } = await refreshClient.post('/auth/refresh', {});
    return data.token;
  };
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('afripay-auth-refresh', doRefresh);
  }
  return doRefresh();
}

export default api;
