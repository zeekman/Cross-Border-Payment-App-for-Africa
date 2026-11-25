// Device-level settings that are safe to keep across users on a shared device.
// Everything else in localStorage/sessionStorage is treated as user-scoped and
// is wiped on logout (FE-125) so the next user never inherits flags like the
// previous user's WebAuthn credential or notification preferences.
export const DEVICE_KEYS = new Set([
  'theme',
  'afripay_lang',
  'afripay_sw_update_snoozed_until',
  'stellar_status_cache',
]);

function clearStore(store) {
  if (!store) return;
  try {
    Object.keys(store)
      .filter((key) => !DEVICE_KEYS.has(key))
      .forEach((key) => store.removeItem(key));
  } catch {
    /* storage unavailable (private mode) — nothing to clear */
  }
}

export function clearUserStorage() {
  clearStore(window.localStorage);
  clearStore(window.sessionStorage);
}
