/**
 * Device and display-mode detection.
 *
 * The distinction that matters most here is "running from the iOS home screen"
 * versus "running in a Safari tab": only the former is exempt from WebKit's
 * 7-day eviction of script-writable storage, so a tab-launched app cannot be
 * trusted to keep save games.
 */

/** iPhone/iPad, including iPadOS which reports itself as a Mac with touch. */
export function isIOS(): boolean {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** True when launched from the home screen (or any standalone display mode). */
export function isStandalone(): boolean {
  // Safari on iOS predates display-mode and uses a non-standard flag.
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone;
  if (legacy === true) return true;
  return ['standalone', 'fullscreen', 'minimal-ui'].some(
    (mode) => window.matchMedia(`(display-mode: ${mode})`).matches,
  );
}

/**
 * Storage survives long gaps only when the app was installed to the home
 * screen. On every other platform the browser's own persistence rules apply and
 * we do not warn.
 */
export function storageIsAtRiskOfEviction(): boolean {
  return isIOS() && !isStandalone();
}
