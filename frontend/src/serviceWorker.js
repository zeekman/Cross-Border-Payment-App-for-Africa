/**
 * serviceWorker.js
 *
 * Registers the AfriPay service worker (public/sw.js) using workbox-window.
 * workbox-window handles:
 *  - Waiting for the SW to be installed before prompting
 *  - Detecting when a new SW is waiting (for future update prompts)
 *  - Logging in development
 *
 * Call register() once from src/index.js.
 */

import { Workbox } from 'workbox-window';

export function register() {
  // Only register in production and when the browser supports service workers.
  // In development CRA serves files from memory, so the SW would intercept
  // hot-reload requests and break the dev experience.
  if (
    process.env.NODE_ENV !== 'production' ||
    !('serviceWorker' in navigator)
  ) {
    return;
  }

  const wb = new Workbox(`${process.env.PUBLIC_URL}/sw.js`);

  // When a new SW has installed and is waiting to activate, you could show
  // an "Update available — reload?" prompt here. For now we skip-wait
  // automatically so users always get the latest SW without manual action.
  wb.addEventListener('waiting', () => {
    wb.messageSkipWaiting();
  });

  wb.addEventListener('activated', (event) => {
    // On first activation claim all open clients immediately
    if (!event.isUpdate) {
      console.log('[SW] Service worker activated for the first time.');
    }
  });

  wb.register().catch((err) => {
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
