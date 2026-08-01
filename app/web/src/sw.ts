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
const CACHE = 'dnc-shell-v1';

const SHELL = ['/', '/index.html', '/app.js', '/manifest.webmanifest'];

/**
 * Paths that must **never** be served from cache, under any circumstances.
 *
 * A cached `/sync` response is not a stale page — it is a client being told its emergency
 * was accepted when it was not. The outbox would then delete the entry (it releases only
 * what the server confirms it holds), and the report would be gone. That is INV-01
 * violated by a caching layer, silently, with no error anywhere.
 *
 * Network-only. If the network is down the request fails, which is correct: the outbox is
 * built to treat a failed push as "still queued" and try again.
 */
const NEVER_CACHE = ['/sync', '/health'];

function isNeverCache(url: URL): boolean {
  return NEVER_CACHE.some((p) => url.pathname === p || url.pathname.startsWith(`${p}?`));
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

  if (isNeverCache(url)) {
    // Explicitly not handled — straight to the network, and allowed to fail.
    return;
  }

  if (request.method !== 'GET') return;

  // A navigation must always resolve to the shell, even offline. This is the line that
  // makes the app openable during a shutdown.
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
