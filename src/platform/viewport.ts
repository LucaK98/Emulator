/**
 * Keeping the player over the part of the screen the player can actually see.
 *
 * A `position: fixed` element is placed against the *layout* viewport, which on
 * iOS is the page at its largest — as if the browser's toolbar were not there.
 * The toolbar then covers the bottom of it, which is exactly where the buttons
 * are, and every time it slides in or out the controls move with it. Pinch
 * zoom and the keyboard do the same thing.
 *
 * `visualViewport` is the part actually on screen, and its offset within the
 * layout viewport is what has to be cancelled out. Mirroring it into custom
 * properties lets the layout stay in CSS: nothing here decides where anything
 * goes, it only reports where the screen currently is.
 *
 * Where there is no `visualViewport` the properties stay unset and the
 * stylesheet's fallbacks — the full layout viewport — apply, which is the
 * behaviour this replaces.
 */

export function trackVisualViewport(): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  const root = document.documentElement;
  let frame = 0;

  const apply = () => {
    frame = 0;
    root.style.setProperty('--vv-top', `${viewport.offsetTop}px`);
    root.style.setProperty('--vv-left', `${viewport.offsetLeft}px`);
    root.style.setProperty('--vv-width', `${viewport.width}px`);
    root.style.setProperty('--vv-height', `${viewport.height}px`);
  };

  /*
   * These events arrive in bursts — a toolbar sliding away fires one a frame —
   * and each one writes four custom properties that invalidate the layout. One
   * write a frame is all that can be seen anyway.
   */
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(apply);
  };

  apply();
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    viewport.removeEventListener('resize', schedule);
    viewport.removeEventListener('scroll', schedule);
    window.removeEventListener('orientationchange', schedule);
  };
}
