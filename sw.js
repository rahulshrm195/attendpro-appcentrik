// ═══════════════════════════════════════════════
//  AttendPro Service Worker  —  sw.js
//  Version: 1.2.0
//  • Caches app shell for offline use
//  • Handles push notification display
//  • Background sync ready (future)
// ═══════════════════════════════════════════════

const CACHE_NAME    = 'attendpro-v1.21.1';
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

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful responses for the app shell
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline: serve from cache
        return caches.match(event.request).then(cached => {
          return cached || caches.match(OFFLINE_URL);
        });
      })
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
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus existing tab if open
      for (const client of list) {
        if (client.url.includes('index.html') || client.url.endsWith('/')) {
          return client.focus();
        }
      }
      // Otherwise open new tab
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
