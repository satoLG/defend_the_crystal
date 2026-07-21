/* ============================================================
 * Service worker — offline play for Defend the Crystal.
 *
 * The production build hashes every asset filename, so we can't
 * ship a fixed precache list. Instead we cache at runtime:
 *   - navigations  → network-first, falling back to the cached
 *     shell so the game still opens with no connection;
 *   - same-origin assets (JS, CSS, models, images, fonts) →
 *     stale-while-revalidate: served instantly from cache and
 *     refreshed in the background. After one full play session
 *     every asset is cached, so the game runs fully offline.
 *
 * Cross-origin requests (Trystero's WebRTC signalling relays)
 * are left untouched — multiplayer still needs the network, but
 * single-player runs offline once cached.
 *
 * Bump CACHE when the caching logic itself changes to evict the
 * old store on activate.
 * ============================================================ */

const CACHE = 'dtc-cache-v1';

// the minimal shell pre-cached on install so the very first
// offline launch has something to boot from
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
  './img/crystal-logo.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // individual misses (e.g. a renamed file) must not abort the
      // whole install, so cache them one by one and swallow failures
      .then((cache) => Promise.allSettled(CORE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // only handle our own origin — never intercept the P2P relays
  if (url.origin !== self.location.origin) return;

  // page navigations: try the network (fresh deploys win), fall back
  // to the cached page when offline
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html'))),
    );
    return;
  }

  // static assets: stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

// lets the page tell a freshly-installed worker to take over at once
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
