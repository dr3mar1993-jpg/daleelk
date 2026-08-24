/* دليلك — Service Worker (شبكة أولًا، ويحدّث نفسه فورًا) */
const CACHE = 'daleelk-v8';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;          // لا تخزّن الخادم
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req, { cache: 'no-store' });   // الشبكة أولًا دائمًا
      if (fresh && fresh.ok && url.origin === location.origin) {
        const c = await caches.open(CACHE); c.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(req);
      return cached || new Response('غير متصل', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
