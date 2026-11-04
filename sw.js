/* MIC staff — service worker
   Only the staff tablet page registers this. It does not intercept page
   loads, so the public site behaves exactly as if it were not there. Its one
   job is to turn a push message into a notification, and to open the staff
   screen when that notification is tapped. */

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (_) { d = { title: 'MIC', body: e.data ? e.data.text() : '' }; }

  e.waitUntil(
    self.registration.showNotification(d.title || 'New task', {
      body: d.body || '',
      icon: '/staff-icon-192.png',
      badge: '/staff-badge-96.png',
      tag: d.tag || 'mic-task',          // a second push about the same task replaces the first
      renotify: true,
      requireInteraction: !!d.urgent,    // urgent tasks stay on screen until dealt with
      data: { url: d.url || '/staff.html' }
    }).then(function () {
      // an open staff screen refreshes straight away instead of on its next poll
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    }).then(function (list) {
      list.forEach(function (c) { c.postMessage({ type: 'mic-push', tag: d.tag || '' }); });
    })
  );
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || '/staff.html', self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf('/staff') !== -1) {
          list[i].postMessage({ type: 'mic-open', url: url });
          return list[i].focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
