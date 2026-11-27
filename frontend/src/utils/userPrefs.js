/**
 * Small per-user preferences that must survive logout on a shared device
 * (auto-lock timeout, install-banner dismissal). Keys are namespaced by user
 * id under `afripay_pref:` — a prefix `clearUserStorage()` preserves — so one
 * household member's choice never applies to another.
 *
 * Only non-sensitive values belong here.
 */
export const USER_PREF_PREFIX = 'afripay_pref:';

function prefKey(userId, name) {
  return `${USER_PREF_PREFIX}${userId || 'anonymous'}:${name}`;
}

export function getUserPref(userId, name, fallback = null) {
  try {
    const raw = window.localStorage.getItem(prefKey(userId, name));
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function setUserPref(userId, name, value) {
  try {
    window.localStorage.setItem(prefKey(userId, name), JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode) — preference just won't persist */
  }
}

/** Remove every preference for one user (used when the account itself is deleted). */
export function clearUserPrefs(userId) {
  try {
    const prefix = `${USER_PREF_PREFIX}${userId || 'anonymous'}:`;
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith(prefix))
      .forEach((key) => window.localStorage.removeItem(key));
  } catch {
    /* ignore */
  }
}
