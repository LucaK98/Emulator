/**
 * Service worker registration and cross-origin isolation.
 *
 * The emulator workers hand framebuffers and audio to the main thread through a
 * SharedArrayBuffer, which the browser only exposes when the document is
 * cross-origin isolated (COOP + COEP). GitHub Pages serves no custom headers,
 * so public/sw.js adds them to every response and we reload once so the
 * document is re-fetched through the worker.
 *
 * Without isolation the app still runs — the core falls back to copying frames
 * via postMessage — so nothing here is fatal.
 */

const RELOAD_GUARD = 'coi-reload-attempted';

export type IsolationState =
  | { status: 'isolated' }
  | { status: 'reloading' }
  | { status: 'unsupported'; reason: string };

export function isCrossOriginIsolated(): boolean {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
}

/** True when SharedArrayBuffer is actually usable, not merely defined. */
export function hasSharedArrayBuffer(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && isCrossOriginIsolated();
}

/**
 * Registers the service worker and, if the document is not yet isolated,
 * reloads once so it is served through the worker. The reload is guarded by a
 * session flag so a browser that refuses the headers cannot loop.
 */
export async function ensureIsolation(): Promise<IsolationState> {
  if (isCrossOriginIsolated()) return { status: 'isolated' };

  if (!('serviceWorker' in navigator)) {
    return { status: 'unsupported', reason: 'Kein Service-Worker-Support' };
  }
  if (!window.isSecureContext) {
    return { status: 'unsupported', reason: 'Kein sicherer Kontext (HTTPS erforderlich)' };
  }

  try {
    const base = import.meta.env.BASE_URL;
    const registration = await navigator.serviceWorker.register(`${base}sw.js`, { scope: base });
    await registration.update().catch(() => {});

    if (sessionStorage.getItem(RELOAD_GUARD)) {
      return { status: 'unsupported', reason: 'Service Worker konnte die Header nicht setzen' };
    }

    // The worker only sees requests once it controls the page.
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        });
        // Do not hang forever if activation never completes.
        setTimeout(resolve, 3000);
      });
    }

    if (!navigator.serviceWorker.controller) {
      return { status: 'unsupported', reason: 'Service Worker wurde nicht aktiv' };
    }

    sessionStorage.setItem(RELOAD_GUARD, '1');
    location.reload();
    return { status: 'reloading' };
  } catch (error) {
    return { status: 'unsupported', reason: String(error) };
  }
}

/** Registers the worker for offline caching without forcing a reload. */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const base = import.meta.env.BASE_URL;
  await navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {});
}
