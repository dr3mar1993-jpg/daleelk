const C = 'kfmmc-map-v3';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(C)
      .then((c) => c.addAll(['./', './index.html', './manifest.webmanifest', './icon-192.png']))
      .catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((n) => n !== C).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const isDoc = req.mode === 'navigate' || req.destination === 'document';
  if (isDoc) {
    // Network-first for the page: always latest when online, cache when offline
    e.respondWith(
      fetch(req)
        .then((res) => {
          const cp = res.clone();
          caches.open(C).then((c) => c.put(req, cp)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }
  // Cache-first for other assets (icons, fonts)
  e.respondWith(
    caches.match(req).then((r) =>
      r ||
      fetch(req).then((res) => {
        if (res.ok) {
          const cp = res.clone();
          caches.open(C).then((c) => c.put(req, cp)).catch(() => {});
        }
        return res;
      }).catch(() => r)
    )
  );
});
