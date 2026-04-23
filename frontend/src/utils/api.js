import axios from 'axios';

const baseURL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const api = axios.create({
  baseURL,
  withCredentials: true,
});

/** No auth interceptors — used only for POST /auth/refresh to avoid loops */
const refreshClient = axios.create({
  baseURL,
  withCredentials: true,
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

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const originalRequest = err.config;
    if (!originalRequest || !shouldAttemptRefresh(err, originalRequest)) {
      if (err.response?.status === 401) {
        const url = originalRequest ? requestUrl(originalRequest) : '';
        const silent401 =
          url.includes('/auth/login') ||
          url.includes('/auth/register') ||
          url.includes('/auth/verify-pin');
        if (!silent401) {
          localStorage.removeItem('token');
          window.location.href = '/login';
        }
      }
      return Promise.reject(err);
    }

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
      const { data } = await refreshClient.post('/auth/refresh', {});
      const newToken = data.token;
      localStorage.setItem('token', newToken);
      processQueue(null, newToken);
      originalRequest.headers.Authorization = `Bearer ${newToken}`;
      return api.request(originalRequest);
    } catch (refreshErr) {
      processQueue(refreshErr, null);
      localStorage.removeItem('token');
      window.location.href = '/login';
      return Promise.reject(refreshErr);
    } finally {
      isRefreshing = false;
    }
  }
);

export default api;
