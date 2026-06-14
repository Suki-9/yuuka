const CACHE = 'yuuka-v8';
const PRECACHE = [
  '/',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/materials/yuka.webp',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// アプリシェル（HTML・JS・CSS）かどうかを判定する。
// これらは network-first で配信し、サーバー側の更新が確実に反映されるようにする。
function isAppShell(url) {
  if (url.pathname === '/' || url.pathname === '/index.html') return true;
  return /\.(?:js|css|html)$/.test(url.pathname);
}

self.addEventListener('fetch', e => {
  // API・認証・外部リクエストはキャッシュしない
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;
  if (url.pathname.includes('/api/')) return;
  if (url.pathname.startsWith('/hook/')) return;

  // アプリシェルは network-first（最新を優先・失敗時のみキャッシュへフォールバック）
  if (isAppShell(url)) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(e.request).then(cached => cached || caches.match('/'))
        )
    );
    return;
  }

  // その他の静的アセットは cache-first（stale-while-revalidate）
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
