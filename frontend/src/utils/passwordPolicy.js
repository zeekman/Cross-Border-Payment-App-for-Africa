import api from './api';

/**
 * Password policy client.
 *
 * The backend (services/passwordPolicy.js, served via GET /auth/password-policy)
 * is the single source of truth for password-strength rules. The frontend
 * derives all of its checks from the fetched policy instead of maintaining its
 * own copy, so a rule change on the backend can never silently drift from what
 * the frontend validates against.
 *
 * DEFAULT_PASSWORD_POLICY exists only as a render-time fallback so pages can
 * show sensible validation before the fetch resolves (or when the endpoint is
 * unreachable). It mirrors the backend's default configuration and is replaced
 * by the server-provided policy as soon as the fetch succeeds.
 */
export const DEFAULT_PASSWORD_POLICY = {
  min_length: 8,
  rules: {
    uppercase: true,
    lowercase: true,
    number: true,
    special: true,
  },
};

let cachedPolicy = null;
let inFlight = null;

function normalizePolicy(policy) {
  const rules = {};
  Object.entries(policy?.rules || {}).forEach(([rule, enabled]) => {
    rules[rule] = Boolean(enabled);
  });
  const minLength = Number(policy?.min_length);
  return {
    min_length: Number.isFinite(minLength) && minLength > 0 ? minLength : DEFAULT_PASSWORD_POLICY.min_length,
    rules,
  };
}

/**
 * Fetches the password policy from the backend and caches it. Idempotent:
 * concurrent callers share a single in-flight request, and later calls reuse
 * the cached result.
 */
export function loadPasswordPolicy() {
  if (cachedPolicy) return Promise.resolve(cachedPolicy);
  if (inFlight) return inFlight;

  inFlight = api
    .get('/auth/password-policy')
    .then((res) => {
      cachedPolicy = normalizePolicy(res.data);
      return cachedPolicy;
    })
    .catch(() => {
      // Backend unreachable — fall back to the default policy so validation
      // still behaves correctly (the backend remains the authoritative gate).
      cachedPolicy = DEFAULT_PASSWORD_POLICY;
      return cachedPolicy;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Synchronous accessor — returns the cached policy, or the default fallback
 * before the first successful fetch. Use in render paths; call loadPasswordPolicy()
 * (e.g. via the usePasswordPolicy hook) to populate the cache.
 */
export function getPasswordPolicy() {
  return cachedPolicy || DEFAULT_PASSWORD_POLICY;
}
