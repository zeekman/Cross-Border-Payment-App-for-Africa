/**
 * AfriPay Service Worker
 *
 * Responsibilities:
 *  1. Web Push notifications (existing)
 *  2. Offline caching of app shell + API responses (Workbox strategies)
 *  3. Background Sync — replay queued payment requests when connectivity returns
 *
 * Workbox is loaded from the CDN so we don't need to eject CRA.
 * The SW is registered manually via workbox-window in src/serviceWorker.js.
 */

importScripts(
  'https://storage.googleapis.com/workbox-cdn/releases/7.0.0/workbox-sw.js'
);

// ─── Workbox config ──────────────────────────────────────────────────────────
workbox.setConfig({ debug: false });

const { registerRoute } = workbox.routing;
const { CacheFirst, NetworkFirst, StaleWhileRevalidate } = workbox.strategies;
const { ExpirationPlugin } = workbox.expiration;
const { CacheableResponsePlugin } = workbox.cacheableResponse;
const { BackgroundSyncPlugin, Queue } = workbox.backgroundSync;

// ─── Cache names ─────────────────────────────────────────────────────────────
const SHELL_CACHE   = 'afripay-shell-v1';
const API_CACHE     = 'afripay-api-v1';
const SYNC_TAG      = 'afripay-payment-queue';

// ─── App shell — cache-first for static assets ───────────────────────────────
// CRA puts hashed filenames in /static/**, so cache-first is safe.
registerRoute(
  ({ request }) =>
    request.destination === 'script' ||
    request.destination === 'style'  ||
    request.destination === 'font'   ||
    request.destination === 'image',
  new CacheFirst({
    cacheName: SHELL_CACHE,
    plugins: [
      new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 30 * 24 * 60 * 60 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  })
);

// ─── HTML navigation — network-first so the app always gets fresh HTML ───────
registerRoute(
  ({ request }) => request.mode === 'navigate',
  new NetworkFirst({
    cacheName: SHELL_CACHE,
    plugins: [new CacheableResponsePlugin({ statuses: [200] })],
  })
);

// ─── API: wallet balance — network-first, fall back to cache ─────────────────
// Cache key: /api/wallet/balance
registerRoute(
  ({ url }) => url.pathname.includes('/wallet/balance'),
  new NetworkFirst({
    cacheName: API_CACHE,
    networkTimeoutSeconds: 5,
    plugins: [
      new ExpirationPlugin({ maxEntries: 1, maxAgeSeconds: 60 * 60 }),   // 1 h
      new CacheableResponsePlugin({ statuses: [200] }),
    ],
  })
);

// ─── API: payment history — stale-while-revalidate ───────────────────────────
// Users see the last known list instantly; fresh data loads in the background.
registerRoute(
  ({ url }) => url.pathname.includes('/payments/history'),
  new StaleWhileRevalidate({
    cacheName: API_CACHE,
    plugins: [
      new ExpirationPlugin({ maxEntries: 5, maxAgeSeconds: 24 * 60 * 60 }),
      new CacheableResponsePlugin({ statuses: [200] }),
    ],
  })
);

// ─── Background Sync — payment queue ─────────────────────────────────────────
// Any POST to /payments/send that fails while offline is stored in the queue
// and replayed automatically when the network comes back.
const paymentQueue = new Queue(SYNC_TAG, {
  maxRetentionTime: 24 * 60,   // keep for 24 hours (minutes)
  onSync: async ({ queue }) => {
    let entry;
    while ((entry = await queue.shiftRequest())) {
      try {
        await fetch(entry.request.clone());
        // Notify all open clients that a queued payment was replayed
        const clients = await self.clients.matchAll({ type: 'window' });
        clients.forEach((client) =>
          client.postMessage({ type: 'PAYMENT_SYNCED' })
        );
      } catch {
        // Network still down — put it back and stop
        await queue.unshiftRequest(entry);
        throw new Error('Replay failed — network still unavailable');
      }
    }
  },
});

// Intercept POST /payments/send — if the fetch fails, enqueue it
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (
    request.method === 'POST' &&
    request.url.includes('/payments/send')
  ) {
    const bgSyncLogic = async () => {
      try {
        return await fetch(request.clone());
      } catch {
        await paymentQueue.pushRequest({ request });
        // Return a synthetic "queued" response so the UI can react
        return new Response(
          JSON.stringify({ queued: true, message: 'Payment queued for when you are back online.' }),
          {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    };
    event.respondWith(bgSyncLogic());
  }
});

// ─── Web Push (existing) ─────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data = {};
  try {
    data = event.data.json();
  } catch {
    data = { title: 'AfriPay', body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'AfriPay', {
      body: data.body || 'You have a new notification',
      icon: '/logo192.png',
      badge: '/logo192.png',
      data: data.data || {},
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((list) => {
        if (list.length > 0) return list[0].focus();
        return self.clients.openWindow('/dashboard');
      })
  );
});

// ─── Activate — claim clients immediately so the new SW takes effect ─────────
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
