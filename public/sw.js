// Service worker minimale: cache-first dell'app (è un singolo index.html self-contained).
// Nessuna chiamata di rete necessaria: l'app è 100% locale/offline.
const CACHE = 'zen-finance-v6';
const ASSETS = ['./', './index.html', './manifest.webmanifest',
  './icon-180.png', './icon-512.png', './icon-512-light.png', './icon-512-dark.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// network-first per index (per ricevere aggiornamenti), cache fallback offline
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
