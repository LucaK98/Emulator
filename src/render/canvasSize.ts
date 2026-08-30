/**
 * The canvas's size in device pixels, kept current without asking for it.
 *
 * The render loop needs to know how large the drawing buffer should be, and
 * the obvious way to find out — `getBoundingClientRect()` — forces the browser
 * to lay the page out before it can answer. Doing that once a frame means a
 * forced layout sixty times a second, for a number that changes perhaps twice
 * in a session. It is at its worst exactly where it hurts most: while the
 * device is being turned, the layout is dirty anyway and every one of those
 * reads pays for a full re-layout.
 *
 * A ResizeObserver is handed the new size after layout has happened, so
 * reading it costs nothing. Where there is no ResizeObserver the old
 * measurement stands in — slower, but never wrong.
 */

export class CanvasSize {
  private width = 0;
  private height = 0;
  private readonly observer: ResizeObserver | null;

  constructor(private readonly element: HTMLElement) {
    // Once at the start, because the observer's first callback only arrives
    // after the next layout and the first frame may come before that.
    this.measure();

    if (typeof ResizeObserver === 'undefined') {
      this.observer = null;
      return;
    }
    this.observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // contentBoxSize is what the observer already knows; contentRect is the
      // fallback for the older shape of the API.
      const box = entry.contentBoxSize?.[0];
      if (box) {
        this.width = box.inlineSize;
        this.height = box.blockSize;
      }
      else {
        this.width = entry.contentRect.width;
        this.height = entry.contentRect.height;
      }
    });
    this.observer.observe(this.element);
  }

  /** The element's size in device pixels, at the ratio given. */
  devicePixels(devicePixelRatio: number): { width: number; height: number } {
    // Without an observer there is nothing keeping this current, so it is
    // measured here instead — the behaviour this replaced.
    if (!this.observer) this.measure();
    return {
      width: Math.max(1, Math.round(this.width * devicePixelRatio)),
      height: Math.max(1, Math.round(this.height * devicePixelRatio)),
    };
  }

  dispose(): void {
    this.observer?.disconnect();
  }

  private measure(): void {
    const rect = this.element.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
  }
}
