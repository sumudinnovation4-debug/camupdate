/* Camplugie service worker.
   Chrome requires a fetch handler for the install prompt, and Play Store
   TWA packaging expects a working offline story. Strategy:
     - app shell (HTML/CSS/JS/icons): stale-while-revalidate
     - Supabase + Paystack + any API call: always network, never cached
     - offline navigation: fall back to the cached page, then offline.html
*/

const VERSION = 'camplugie-v4';
const SHELL = [
  '/', '/home.html', '/market.html', '/notifications.html', '/yard.html',
  '/profile.html', '/create.html', '/chat-thread.html', '/group-thread.html',
  '/groups.html', '/call.html', '/wallet.html', '/orders.html', '/cart.html',
  '/listing.html', '/swift.html', '/settings.html', '/offline.html',
  '/style.css', '/config.js', '/payments.js', '/chat-core.js',
  '/manifest.webmanifest', '/pwa.js', '/download.html', '/privacy-policy.html',
  '/favicon.ico',
  '/icons/icon-96.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];

// Never cache: auth tokens, realtime, payments, serverless endpoints.
const NEVER_CACHE = [
  'supabase.co', 'supabase.in', 'paystack.co', 'paystack.com',
  '/api/', 'expressturn.com', 'google.com/recaptcha',
  '/downloads/', '.apk', '.aab',            // big installers must never be cached by the service worker
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u)))) // one 404 must not abort install
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (NEVER_CACHE.some(p => url.href.includes(p))) return;          // straight to network
  if (url.origin !== self.location.origin) return;                   // don't cache CDNs' opaque responses

  // Navigations: network first so students always get the latest build.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('/offline.html')))
    );
    return;
  }

  // Assets: serve cached instantly, refresh in the background.
  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req)
        .then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(VERSION).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// Lets a new version take over without the user force-closing the app.
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

/* Web Push — real device notifications, WhatsApp-style. The server (api/send-push.js,
   notify-message.js, notify-call.js, notify-group-message.js) sends the payload; this
   shows it even when Camplugie is closed. */
self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch (_) { p = { title: 'Camplugie', body: event.data ? event.data.text() : '' }; }
  const url = p.url || '/notifications.html';
  const isCall = p.type === 'call';

  event.waitUntil((async () => {
    // If the person is looking at this exact screen right now (e.g. the open chat), the
    // page already shows it live — don't also buzz a banner. Calls always ring.
    if (!isCall) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const here = wins.some(c => c.visibilityState === 'visible' && c.focused && new URL(c.url).pathname + new URL(c.url).search === url);
      if (here) return;
    }
    await self.registration.showNotification(p.title || 'Camplugie', {
      body: p.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      tag: p.tag || 'camplugie',
      renotify: true,                       // same tag still buzzes again for a new message
      requireInteraction: !!p.requireInteraction,   // calls stay on screen until answered/dismissed
      vibrate: isCall ? [400, 200, 400, 200, 400, 200, 400] : [180, 90, 180],
      data: { url, type: p.type, ...(p.data || {}) },
      timestamp: Date.now(),
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/notifications.html', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
          return c.focus().then(w => (w && 'navigate' in w ? w.navigate(target) : null)).catch(() => self.clients.openWindow(target));
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

// Browsers sometimes rotate a push subscription silently. Re-subscribe and tell the
// server, otherwise this device would stop getting notifications with no error anywhere.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      wins.forEach(c => c.postMessage({ type: 'PUSH_RESUBSCRIBE' }));
    } catch (_) {}
  })());
});
