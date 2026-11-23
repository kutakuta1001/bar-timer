/*
 * オフラインでも開けるよう、アプリ一式を端末に保存しておく。
 * 中身を更新したら CACHE の番号を上げる（古い保存分が消える）。
 */
const CACHE = 'bar-timer-v2';
const ASSETS = [
  './',
  './index.html',
  './timer-core.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 保存済みのものをすぐ返し、裏で新しい版を取りに行って次回に備える
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req)
      .then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => hit || Response.error());
    if (hit) {
      event.waitUntil(fresh);
      return hit;
    }
    return fresh;
  })());
});
