// アプリ本体はオフラインでも開けるようにキャッシュ。画面とデータはネット接続時は常に最新を取得する。
const V = 'econ-cal-v2';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'data/indicators.json', 'data/links.json', 'data/events.json', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  const store = res => { if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); } return res; };
  if (r.mode === 'navigate' || u.pathname.includes('/data/')) {
    // ネットワーク優先（最新を表示）。オフライン時はキャッシュ
    e.respondWith(fetch(r).then(store).catch(() => caches.match(r).then(m => m || caches.match('index.html'))));
  } else {
    // 画像など: キャッシュ優先＋裏で更新
    e.respondWith(caches.match(r).then(m => m || fetch(r).then(store)));
  }
});
