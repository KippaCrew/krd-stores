/* KRD Stores service worker.
   Network-first for the app files (so updates show up straight away),
   falling back to the cache when there's no signal. API calls are never cached. */
var CACHE = 'krd-stores-v1';
var SHELL = ['./', 'index.html', 'styles.css', 'config.js', 'js/api.js', 'js/demo.js', 'js/app.js',
             'manifest.webmanifest', 'icons/mark.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];

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
