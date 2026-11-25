/**
 * serviceWorker.js
 *
 * Registers the AfriPay service worker (public/sw.js) using workbox-window.
 * When a new SW is waiting to activate, a custom DOM event `swUpdateAvailable`
 * is dispatched so the UpdateBanner component can prompt the user.
 *
 * Call register() once from src/index.js.
 */

import { Workbox } from 'workbox-window';

const SNOOZE_KEY = 'afripay_sw_update_snoozed_until';

let _wb = null;

/** Called by UpdateBanner when the user clicks "Update Now". */
export function skipWaiting() {
  if (_wb) {
    _wb.messageSkipWaiting();
    window.location.reload();
  }
}

export function register() {
  if (
    process.env.NODE_ENV !== 'production' ||
    !('serviceWorker' in navigator)
  ) {
    return;
  }

  _wb = new Workbox(`${process.env.PUBLIC_URL}/sw.js`);

  _wb.addEventListener('waiting', () => {
    const snoozedUntil = parseInt(localStorage.getItem(SNOOZE_KEY) || '0', 10);
    if (Date.now() > snoozedUntil) {
      window.dispatchEvent(new Event('swUpdateAvailable'));
    }
  });

  _wb.addEventListener('activated', (event) => {
    if (!event.isUpdate) {
      console.log('[SW] Service worker activated for the first time.');
    }
  });

  _wb.register().catch((err) => {
    console.error('[SW] Registration failed:', err);
  });
}

export function unregister() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready
      .then((registration) => registration.unregister())
      .catch((err) => console.error('[SW] Unregister failed:', err));
  }
}
