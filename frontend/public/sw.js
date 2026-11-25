/**
 * AfriPay Service Worker
 *
 * Responsibilities:
 *  1. Web Push notifications
 *  2. Offline caching of the static app shell only (plain Cache API — no
 *     third-party scripts, see FE-163)
 *
 * Authenticated API responses are never cached here (FE-162): the cache key
 * is the URL only, so a cached balance/history would leak to the next user on
 * a shared device.
 */

const SHELL_CACHE = 'afripay-shell-v1';
const LEGACY_API_CACHE = 'afripay-api-v1';
const LEGACY_SYNC_DB = 'workbox-background-sync';

const isStaticAsset = (request) =>
  ['script', 'style', 'font', 'image'].includes(request.destination);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (isStaticAsset(request)) {
    // CRA emits hashed filenames, so cache-first is safe.
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      })
    );
  } else if (request.mode === 'navigate') {
    // Network-first so the app always gets fresh HTML.
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) caches.open(SHELL_CACHE).then((c) => c.put(request, res.clone()));
          return res;
        })
        .catch(() => caches.match(request))
    );
  }
});

// Clear caches/queues left behind by earlier versions: the API cache (FE-162)
// and the legacy Workbox background-sync payment queue (FE-137).
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.delete(LEGACY_API_CACHE),
      new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(LEGACY_SYNC_DB);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      }),
      self.clients.claim(),
    ])
  );
});

// Allow the app to purge user-scoped caches on logout.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CLEAR_USER_CACHE') {
    event.waitUntil(caches.delete(LEGACY_API_CACHE));
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
      badge: '/badge.png',
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
