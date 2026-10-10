// ═══════════════════════════════════════════════
//  AttendPro Service Worker  —  sw.js
//  Version: 1.2.0
//  • Caches app shell for offline use
//  • Handles push notification display
//  • Background sync ready (future)
// ═══════════════════════════════════════════════

const CACHE_NAME    = 'attendpro-v1.28.0';
const OFFLINE_URL   = './index.html';

// Files to cache on install
const PRECACHE = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// ── INSTALL: pre-cache app shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE.map(url => new Request(url, { cache: 'reload' })));
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: clear old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: network-first, fallback to cache ──
self.addEventListener('fetch', event => {
  // Skip non-GET and Firebase/CDN requests (always fetch live)
  if (event.request.method !== 'GET') return;
  const url = event.request.url;
  if (
    url.includes('firestore.googleapis.com') ||
    url.includes('firebase') ||
    url.includes('googleapis.com') ||
    url.includes('gstatic.com') ||
    url.includes('fonts.googleapis.com') ||
    url.includes('cdnjs.cloudflare.com')
  ) return;

  const network = fetch(event.request)
    .then(response => {
      // Cache successful responses for the app shell
      if (response && response.status === 200 && response.type === 'basic') {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return response;
    });
  const fromCache = () => caches.match(event.request).then(cached => cached || caches.match(OFFLINE_URL));
  // Slow connection: after 4 s serve the saved copy; the download keeps going
  // and the fresh copy is used next time.
  const slow = new Promise(resolve => setTimeout(resolve, 4000))
    .then(() => caches.match(event.request))
    .then(cached => cached || network);
  event.waitUntil(network.catch(() => {}));
  event.respondWith(
    Promise.race([network, slow]).catch(fromCache)
  );
});

// ── PUSH: show notification when received from server ──
self.addEventListener('push', event => {
  let data = { title: 'AttendPro', body: 'You have a new update' };
  try { data = event.data.json(); } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    './icon-192.png',
      badge:   './icon-192.png',
      tag:     data.tag || 'ap-push',
      renotify: true,
      vibrate: [200, 100, 200],
      data:    { url: data.url || './' }
    })
  );
});

// ── NOTIFICATION CLICK: open/focus app ──
// data.url may carry ?open=requests|today — an open app is told by message,
// a closed one is opened at that address.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || './';
  const open = new URL(target, self.registration.scope).searchParams.get('open');
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope)) {
          if (open) client.postMessage({ type: 'open', open });
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});

// ── MESSAGE: version check from app ──
self.addEventListener('message', event => {
  if (event.data === 'GET_VERSION') {
    event.source.postMessage({ version: CACHE_NAME });
  }
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
