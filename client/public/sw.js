/* KIOKU™ Service Worker — Push Notifications */
/* eslint-disable no-restricted-globals */

const CACHE_NAME = 'kioku-v1';

// Push event — show notification
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'KIOKU™', body: event.data.text() };
  }

  const options = {
    body: data.body || '',
    icon: './icons/icon-192x192.png',
    badge: './icons/icon-72x72.png',
    data: {
      url: data.url || './#/',
      category: data.category || 'general',
    },
    vibrate: [100, 50, 100],
    tag: data.category || 'kioku-notification',
    renotify: true,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'KIOKU™', options)
  );
});

// Notification click — navigate to URL
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url || './#/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus existing window if available
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      // Open new window
      return self.clients.openWindow(url);
    })
  );
});

// Install — activate immediately
self.addEventListener('install', () => {
  self.skipWaiting();
});

// Activate — claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
