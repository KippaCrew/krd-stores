/* Kippa Crew service worker.
   Network-first for the app files (so updates show up straight away),
   falling back to the cache when there's no signal. API calls are never cached. */
var CACHE = 'kippa-crew-v5';
var SHELL = ['./', 'index.html', 'styles.css', 'config.js', 'js/api.js', 'js/demo.js', 'js/app.js',
             'manifest.webmanifest', 'icons/mark.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png', 'icons/badge-96.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.pathname.indexOf('/rest/v1/') >= 0) return;          // never cache data
  var cacheable = url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net/.test(url.host);
  if (!cacheable) return;
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && (res.ok || res.type === 'opaque')) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) { return hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined); });
    })
  );
});

/* ---------- Phone notifications ---------- */
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Kippa Crew', body: e.data ? e.data.text() : '' }; }
  // Every push must show a notification (phones stop delivering to apps that don't).
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || 'Kippa Crew', {
      body: d.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-96.png',
      tag: d.tag || 'kippa',
      renotify: true,
      requireInteraction: !!d.urgent,
      data: { url: d.url || '#/' }
    }),
    // if the app is open, let it refresh its badges straight away
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
      wins.forEach(function (w) { w.postMessage({ type: 'push', data: d }); });
    })
  ]));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var hash = (e.notification.data && e.notification.data.url) || '#/';
  var target = new URL(hash, self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
    for (var i = 0; i < wins.length; i++) {
      if (wins[i].url.indexOf(self.registration.scope) === 0 && 'focus' in wins[i]) {
        wins[i].postMessage({ type: 'open', hash: hash });
        return wins[i].focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
