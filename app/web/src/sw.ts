/// <reference lib="webworker" />

/**
 * The service worker. M0-12.
 *
 * Its only job is to make the app **openable** with no network. Without it, a handset that
 * closed the browser during a shutdown cannot reach the app at all — the queued report is
 * safe on disk and completely unreachable, which in this district is a failure.
 *
 * The single most important rule in this file is the one that says what NOT to cache.
 */

declare const self: ServiceWorkerGlobalScope;

/** Bump to ship a new shell. Old caches are deleted on activate. */
// v3: the responsive shell (M4), and `/dashboard` and `/status` joining NEVER_CACHE. A
// browser holding an older cache keeps serving the stale shell until this version changes.
const CACHE = 'dnc-shell-v3';

const SHELL = ['/', '/index.html', '/app.js', '/manifest.webmanifest'];

/**
 * Paths that must **never** be served from cache, under any circumstances.
 *
 * `/sync` — a cached response is not a stale page. It is a client being told its emergency
 * was accepted when it was not. The outbox would then delete the entry (it releases only
 * what the server confirms it holds), and the report would be gone. INV-01 violated by a
 * caching layer, silently, with no error anywhere.
 *
 * `/auth` — `/auth/me` is a GET, so it would otherwise be cached like any other. A cached
 * identity means a handset showing the previous holder as signed in after a shift change,
 * and every report captured on it attributed to someone who has gone home. On a shared
 * device that is not a staleness bug, it is a false record.
 *
 * `/incidents` — `GET /incidents/:id` is the incident's live state and its history. A
 * cached copy is a screen showing an emergency as unacknowledged when someone is already
 * on the way, or as open when it was closed an hour ago. That is INV-02 exactly: stale
 * data rendered as current, and here it would be rendered on the screen an operator uses
 * to decide whether to send anyone.
 *
 * Network-only. If the network is down the request fails, which is correct: the outbox
 * treats a failed push as "still queued" and tries again.
 */
const NEVER_CACHE = [
  '/sync',
  '/health',
  '/auth',
  '/incidents',
  '/notifications',
  '/admin',
  '/roster',
  '/fleet',
  /**
   * `/dashboard` and `/status` — added after they shipped without being here (M4).
   *
   * Both are live district state. Cached, the dashboard shows counts and a weather reading
   * from whenever the page was last online while its own "as of" clock ticks forward — the
   * exact stale-but-confident failure this whole feature was built to prevent (INV-02).
   *
   * `/status` was worse. An officer set a service's owning department, the write succeeded,
   * and the screen kept showing "nobody assigned" — because the reload after the write was
   * answered from cache. It looked like a save that silently did nothing, which is the one
   * outcome that makes people stop trusting a form.
   */
  '/dashboard',
  '/status',
  '/contacts',
];

function isNeverCache(url: URL): boolean {
  return NEVER_CACHE.some(
    (p) =>
      url.pathname === p || url.pathname.startsWith(`${p}/`) || url.pathname.startsWith(`${p}?`),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      // Take over immediately. An operator should not have to close every tab to get a fix.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Same-origin only. Never interpose on anything else.
  if (url.origin !== self.location.origin) return;

  // A write never comes out of a cache, and a POSTed form navigation is still a write.
  if (request.method !== 'GET') return;

  // A navigation must always resolve to the shell, even offline. This is the line that
  // makes the app openable during a shutdown.
  //
  // **This is checked before `isNeverCache`, and the order is load-bearing.** Adding
  // `/incidents` to the never-cache list broke exactly this: an operator opening the app at
  // `/incidents/<id>` during an outage got ERR_INTERNET_DISCONNECTED, because the path was
  // network-only and a navigation is a request like any other. The two cases are genuinely
  // different and the URL alone does not distinguish them — `GET /incidents/:id` as a data
  // fetch must never be served stale (INV-02), while the same URL as a *navigation* is a
  // person opening the app and must always resolve. The shell it gets is not incident data;
  // it fetches that fresh, or shows that it cannot.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cached = await caches.match('/index.html');
        if (cached) return cached;
        return fetch(request);
      })(),
    );
    return;
  }

  if (isNeverCache(url)) {
    // Explicitly not handled — straight to the network, and allowed to fail.
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) {
        // Refresh in the background so the next launch is current, without ever making
        // the operator wait on the network.
        void (async () => {
          try {
            const fresh = await fetch(request);
            if (fresh.ok) await (await caches.open(CACHE)).put(request, fresh.clone());
          } catch {
            // Offline. The cached copy already served; nothing to do.
          }
        })();
        return cached;
      }

      const response = await fetch(request);
      if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
      return response;
    })(),
  );
});

export {};
