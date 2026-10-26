/* Camplugie service worker.
   OFFLINE MODE (WhatsApp-style): everything you view is saved on the phone and shown again when
   you have no signal — chats and messages, chat list, listings, posts, groups, profile, photos.
     - data  (Supabase reads)  : network first, saved copy when offline or the network is slow
     - photos (Cloudinary/Supabase storage/Google avatars): saved copy first, refreshed quietly
     - saved data is stored per signed-in user and wiped on sign-out / account deletion

   Chrome requires a fetch handler for the install prompt, and Play Store
   TWA packaging expects a working offline story. Strategy:
     - app shell (HTML/CSS/JS/icons): stale-while-revalidate
     - Supabase + Paystack + any API call: always network, never cached
     - offline navigation: fall back to the cached page, then offline.html
*/

const VERSION = 'camplugie-v8';
const SHELL = [
  '/', '/home.html', '/market.html', '/notifications.html', '/yard.html',
  '/profile.html', '/create.html', '/chat-thread.html', '/group-thread.html',
  '/groups.html', '/call.html', '/wallet.html', '/orders.html', '/cart.html',
  '/listing.html', '/swift.html', '/settings.html', '/offline.html',
  '/style.css', '/config.js', '/payments.js', '/chat-core.js', '/swift-geo.js',
  '/manifest.webmanifest', '/pwa.js', '/download.html', '/privacy-policy.html',
  '/favicon.ico',
  '/icons/icon-96.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];

/* ---------- offline saved data ---------- */
const DATA_CACHE = 'cp-data-v1';
const IMG_CACHE = 'cp-img-v1';
const MAX_DATA = 500;               // saved responses kept (oldest dropped first)
const MAX_IMG = 300;
const SLOW_MS = 6000;               // if the network takes longer than this and we have a saved copy, show it
const NEVER_SAVE_TABLES = ['payout_recipients'];   // bank details are never kept on the device
const IMG_HOSTS = [/\.cloudinary\.com$/, /\.supabase\.co$/, /^lh\d+\.googleusercontent\.com$/];
let putCount = 0;

// Who is asking? (the signed-in user's id, read from the sign-in token) — so one person's saved
// data can never be shown to someone else who signs in on the same phone.
function whoIs(req) {
  try {
    const t = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sub || 'anon';
  } catch (_) { return 'anon'; }
}
const dataKey = (req) => new Request('https://cp-offline.invalid/' + whoIs(req) + '/' + encodeURIComponent(req.url));

function isSavableData(url, req) {
  if (req.method !== 'GET' || req.headers.has('range')) return false;
  if (!/\.supabase\.co$/.test(url.hostname)) return false;
  if (url.pathname === '/auth/v1/user') return true;
  if (!url.pathname.startsWith('/rest/v1/')) return false;
  return !NEVER_SAVE_TABLES.some(t => url.pathname === '/rest/v1/' + t || url.pathname.startsWith('/rest/v1/' + t + '/'));
}

async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// Network first; if offline / failing / very slow, show the saved copy from last time.
async function dataFetch(event) {
  const req = event.request, key = dataKey(req);
  const cache = await caches.open(DATA_CACHE);
  const net = fetch(req.clone()).then((res) => {
    if (res && res.status === 200) {
      cache.put(key, res.clone()).then(() => { if (++putCount % 25 === 0) trim(DATA_CACHE, MAX_DATA); }).catch(() => {});
    }
    return res;
  });
  const slow = new Promise((r) => setTimeout(() => r(null), SLOW_MS));
  const first = await Promise.race([net.catch(() => null), slow]);
  if (first) return first;                         // the network answered (even an error answer is passed on)
  const saved = await cache.match(key);
  if (saved) { event.waitUntil(net.catch(() => {})); return saved; }   // keep refreshing in the background
  return net;                                      // nothing saved yet: wait for the network (or fail like before)
}

// Photos: saved copy first (instant, works offline), refreshed in the background.
async function imageFetch(event) {
  const req = event.request;
  const cache = await caches.open(IMG_CACHE);
  const hit = await cache.match(req.url);
  const refresh = fetch(new Request(req.url, { mode: 'cors', credentials: 'omit' }))   // real (not opaque) response so it can be saved
    .then((res) => { if (res && res.ok) { cache.put(req.url, res.clone()).then(() => { if (++putCount % 25 === 0) trim(IMG_CACHE, MAX_IMG); }); } return res; });
  if (hit) { event.waitUntil(refresh.catch(() => {})); return hit; }
  try { return await refresh; } catch (_) { return fetch(req); }   // host without CORS: show it, just don't save it
}

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
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'cp-push-log' && k !== DATA_CACHE && k !== IMG_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (isSavableData(url, req)) { event.respondWith(dataFetch(event)); return; }            // offline mode: data
  if (req.destination === 'image' && IMG_HOSTS.some(r => r.test(url.hostname)) && !/\/auth\/v1\//.test(url.pathname)) {
    event.respondWith(imageFetch(event)); return;                                          // offline mode: photos
  }
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
  // Signed out / account deleted: forget everything saved for offline use on this phone.
  if (e.data === 'CP_CLEAR_OFFLINE') e.waitUntil(Promise.all([caches.delete(DATA_CACHE), caches.delete(IMG_CACHE)]));
});

/* Web Push — real device notifications that come from the installed app
   (Camplugie icon + name), not from the browser. The server (api/send-push.js
   and api/notify-group-message.js) sends the payload; this worker shows it. */

// Opens/focuses the app at `target`. Prefers a window that is already open
// (so tapping a notification never spawns a second copy of the app).
async function openApp(target) {
  const abs = new URL(target || '/notifications.html', self.location.origin).href;
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of list) {
    if (new URL(c.url).origin !== self.location.origin) continue;
    try { await c.focus(); } catch (_) {}
    if ('navigate' in c) { try { return await c.navigate(abs); } catch (_) {} }
    c.postMessage({ type: 'cp-navigate', url: abs });
    return c;
  }
  return self.clients.openWindow(abs);
}

// Keeps the last few deliveries so Settings → "Send test notification" can show where a
// delay comes from: 'server' = our database/Vercel side, 'phone' = Google's push service +
// your phone's battery saver. (Stored in the Cache API so the page can read it.)
async function logPush(entry) {
  try {
    const cache = await caches.open('cp-push-log');
    const old = await cache.match('/__pushlog');
    const list = old ? await old.json() : [];
    list.unshift(entry);
    await cache.put('/__pushlog', new Response(JSON.stringify(list.slice(0, 8)), { headers: { 'Content-Type': 'application/json' } }));
  } catch (_) {}
}

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (_) { payload = { title: 'Camplugie', body: event.data ? event.data.text() : '' }; }

  const url = payload.url || '/notifications.html';
  const title = payload.title || 'Camplugie';
  const isCall = payload.type === 'call' || payload.type === 'group_call';
  const receivedAt = Date.now();

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.filter((c) => c.visibilityState === 'visible');
    wins.forEach((c) => c.postMessage({ type: 'cp-push', payload }));

    // Delivery timing for the "Send test notification" report.
    logPush({
      at: receivedAt, type: payload.type || 'general', title: String(title).slice(0, 40),
      serverMs: payload.ev && payload.ts ? Math.max(0, payload.ts - payload.ev) : null,   // event saved → push sent
      phoneMs: payload.ts ? Math.max(0, receivedAt - payload.ts) : null,                   // push sent → phone received
    });

    // The app is open and showing something already:
    //  • a call → the in-app ring screen handles it, so no second alert
    //  • anything else → stay quiet only if they're looking at that exact chat/group/order
    if (isCall && visible.length) return;
    const here = new URL(url, self.location.origin);
    const viewing = visible.some((c) => {
      const u = new URL(c.url);
      if (u.pathname !== here.pathname) return false;
      const id = here.searchParams.get('id');
      return id ? u.searchParams.get('id') === id : u.search === here.search;
    });
    if (viewing) return;

    await self.registration.showNotification(title, {
      body: payload.body || '',
      icon: payload.icon || '/icons/icon-192.png',
      badge: '/icons/monochrome-512.png',          // small white status-bar glyph on Android
      tag: payload.tag || 'camplugie',               // same tag = replaces, so a chat never stacks 20 alerts
      renotify: true,
      timestamp: payload.ev || payload.ts || Date.now(),
      data: { url, type: payload.type },
      actions: (payload.actions || []).slice(0, 2),
      vibrate: isCall ? [500, 250, 500, 250, 500, 250, 500, 250, 500] : [180, 90, 180],
      requireInteraction: !!payload.requireInteraction,   // calls stay on screen until answered / declined
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  const action = event.action;
  event.notification.close();
  if (action === 'decline') return;                       // "Decline" on a call just dismisses it
  event.waitUntil(openApp(event.notification.data && event.notification.data.url));
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((c) => c.postMessage({ type: 'cp-push-resubscribe' }));
  })());
});
