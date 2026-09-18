/* eslint-env serviceworker */
/**
 * Service Worker für Ganbatte.
 *
 * Zwei Regeln:
 *
 * 1. Die Seite selbst kommt aus dem Netz, wenn es eins gibt (network first).
 *    Sonst zeigt die installierte App nach einem Update wochenlang den alten
 *    Stand, ohne dass man das merkt.
 * 2. Alles andere (CSS, Module, Icons) kommt sofort aus dem Cache und wird im
 *    Hintergrund erneuert. Das ist der Grund, warum die App auch in der U-Bahn
 *    sofort startet.
 *
 * CACHE_VERSION erhöhen, wenn alles neu geholt werden soll.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME = `ganbatte-${CACHE_VERSION}`;

/** Alles, was die App zum Starten braucht - beim Installieren einmal holen. */
const SHELL = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './js/main.js',
  './js/dom.js',
  './js/store.js',
  './js/dates.js',
  './js/srs.js',
  './js/levels.js',
  './js/cognates.js',
  './js/fx.js',
  './js/views/dashboard.js',
  './js/views/vocab.js',
  './js/views/cognates.js',
  './js/views/mnemonics.js',
  './js/views/goal.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Einzeln statt addAll: eine fehlende Datei soll nicht die gesamte
      // Installation scheitern lassen.
      await Promise.all(
        SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('ganbatte-') && n !== CACHE_NAME).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigationen: erst Netz, dann Cache. Ohne Netz die gespeicherte Seite.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          cache.put('./index.html', fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE_NAME);
          return (
            (await cache.match('./index.html')) ||
            (await cache.match('./')) ||
            new Response('Offline', { status: 503, statusText: 'Offline' })
          );
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      // Aus dem Cache antworten, im Hintergrund erneuern.
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      const fresh = await network;
      return fresh || new Response('Offline', { status: 503, statusText: 'Offline' });
    })(),
  );
});
