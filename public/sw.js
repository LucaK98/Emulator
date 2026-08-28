/* eslint-env serviceworker */
/**
 * Service worker with two jobs:
 *
 * 1. Cross-origin isolation. SharedArrayBuffer (used to hand framebuffers and
 *    audio from the emulator worker to the main thread) requires COOP/COEP
 *    response headers. GitHub Pages cannot serve custom headers, so we add them
 *    to every response on the way through. This is the well-known
 *    "coi-serviceworker" trick, inlined here so we only ship one worker.
 *
 * 2. Offline caching. The WASM cores are large; once fetched they should never
 *    be downloaded again. Everything same-origin is cached
 *    stale-while-revalidate, navigations fall back to the cached shell.
 *
 * Bump CACHE_VERSION to invalidate everything.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME = `emu-${CACHE_VERSION}`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

/** Re-wrap a response with the isolation headers. Opaque responses pass through. */
function withIsolationHeaders(response) {
  if (response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Devtools issues these; responding would throw.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  event.respondWith(
    (async () => {
      // Cross-origin: pass through, just add the headers so COEP does not
      // reject the page itself.
      if (!sameOrigin) {
        return withIsolationHeaders(await fetch(request));
      }

      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);

      const network = fetch(request)
        .then((response) => {
          // Only cache complete, successful, non-range responses.
          if (response.ok && response.status === 200 && response.type === 'basic') {
            cache.put(request, response.clone()).catch(() => {});
          }
          return response;
        })
        .catch(() => undefined);

      if (cached) {
        // Stale-while-revalidate: serve the cache now, refresh in the background.
        event.waitUntil(network);
        return withIsolationHeaders(cached);
      }

      const fresh = await network;
      if (fresh) return withIsolationHeaders(fresh);

      // Offline and uncached. For navigations fall back to the app shell so the
      // installed PWA still opens.
      if (request.mode === 'navigate') {
        const shell = await cache.match(new URL('./index.html', self.registration.scope).href);
        if (shell) return withIsolationHeaders(shell);
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    })(),
  );
});
