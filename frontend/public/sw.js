// Service Worker — handles Web Push notifications
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'AfriPay', body: event.data.text() }; }

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
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      if (list.length > 0) return list[0].focus();
      return clients.openWindow('/dashboard');
    })
  );
});
