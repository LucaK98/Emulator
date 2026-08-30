/**
 * On-screen controls.
 *
 * All pointers are tracked on one capturing surface and hit-tested against the
 * control geometry on every move, rather than each button listening for its own
 * events. That is what makes the two things players actually notice work:
 * rolling a thumb from Left into Up gives a clean diagonal, and sliding from B
 * onto A without lifting registers as a press instead of nothing.
 *
 * There is no haptic feedback: iOS Safari does not implement the Vibration API.
 * A brief highlight on each pressed control stands in for it.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { bit, type InputState } from '../input/InputState';
import type { ButtonName } from '../core/systems';

/** Held controls that act on the emulator rather than on the console. */
export type PlayerAction = 'rewind' | 'fastForward';

interface Props {
  input: InputState;
  /** Which emulator actions to offer; rewind is not possible on every system. */
  actions: PlayerAction[];
  /** Called as an action is pressed and released. */
  onAction: (action: PlayerAction, pressed: boolean) => void;
  /** Buttons this console has; the shoulder pair only exists on the GBA. */
  buttons: ButtonName[];
  /** Called when the menu button is tapped. */
  onMenu: () => void;
  /**
   * Set while an overlay covers the screen. The controls stay mounted so the
   * layout does not jump, but stop taking input — otherwise the capturing
   * surface swallows taps meant for the overlay's buttons.
   */
  disabled?: boolean;
}

interface Circle {
  cx: number;
  cy: number;
  r: number;
}

/** Fraction of the d-pad radius that counts as the neutral centre. */
const DPAD_DEADZONE = 0.28;
/** Pressing beyond this fraction of the radius still counts, so thumbs may drift. */
const DPAD_REACH = 1.75;
/** Extra hit radius around the face buttons, in pixels. */
const BUTTON_SLOP = 10;

export function TouchControls({
  input,
  buttons,
  actions,
  onAction,
  onMenu,
  disabled = false,
}: Props) {
  const hasShoulders = buttons.includes('L');
  const hasDiamond = buttons.includes('X');
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dpadRef = useRef<HTMLDivElement>(null);
  const aRef = useRef<HTMLButtonElement>(null);
  const bRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const selectRef = useRef<HTMLButtonElement>(null);
  const shoulderLeftRef = useRef<HTMLButtonElement>(null);
  const shoulderRightRef = useRef<HTMLButtonElement>(null);
  const xRef = useRef<HTMLButtonElement>(null);
  const yRef = useRef<HTMLButtonElement>(null);
  const rewindRef = useRef<HTMLButtonElement>(null);
  const forwardRef = useRef<HTMLButtonElement>(null);

  const [pressed, setPressed] = useState(0);
  const [held, setHeld] = useState<PlayerAction[]>([]);
  const heldRef = useRef<PlayerAction[]>([]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || disabled) {
      input.set('touch', 0);
      setPressed(0);
      return;
    }

    const pointers = new Map<number, { x: number; y: number }>();

    /*
     * Geometry is measured only when a hit test is about to use it.
     *
     * Measuring forces the browser to lay the page out, and the events that
     * move the controls — a visual-viewport scroll, a resize — arrive in
     * bursts, most thickly while the device is being turned, which is exactly
     * when the layout is dirty and each read is at its most expensive. So they
     * only mark the measurement stale; the reading itself happens at the next
     * press or move, of which there is at most one a frame.
     */
    let geometry = measure();
    let stale = false;

    function measure() {
      return {
        dpad: circleOf(dpadRef.current),
        a: circleOf(aRef.current, BUTTON_SLOP),
        b: circleOf(bRef.current, BUTTON_SLOP),
        start: rectOf(startRef.current),
        select: rectOf(selectRef.current),
        shoulderLeft: rectOf(shoulderLeftRef.current),
        shoulderRight: rectOf(shoulderRightRef.current),
        x: circleOf(xRef.current, BUTTON_SLOP),
        y: circleOf(yRef.current, BUTTON_SLOP),
        rewind: rectOf(rewindRef.current),
        forward: rectOf(forwardRef.current),
      };
    }

    /** The controls have moved; whatever was measured no longer describes them. */
    const invalidate = () => {
      stale = true;
    };

    /*
     * A turn of the device leaves any finger already down in a place that no
     * longer means anything: the controls are somewhere else now, and the last
     * known coordinate can easily fall on a different button than the one being
     * held — pressing up and walking down. There is no way to know where the
     * finger is until it moves or lifts, so the press is dropped.
     */
    const forgetPointers = () => {
      invalidate();
      if (pointers.size === 0) return;
      pointers.clear();
      recompute();
    };

    function maskFor(x: number, y: number): number {
      let mask = 0;
      const { dpad, a, b, start, select, shoulderLeft, shoulderRight } = geometry;
      const { x: xButton, y: yButton } = geometry;

      if (dpad) {
        const dx = x - dpad.cx;
        const dy = y - dpad.cy;
        const distance = Math.hypot(dx, dy);
        if (distance <= dpad.r * DPAD_REACH && distance > dpad.r * DPAD_DEADZONE) {
          // Eight-way: a direction counts when the pointer is far enough along
          // that axis, so both fire in the diagonal wedges.
          const angle = Math.atan2(dy, dx);
          const octant = Math.round((angle * 4) / Math.PI + 8) % 8;
          const names: ButtonName[][] = [
            ['Right'],
            ['Right', 'Down'],
            ['Down'],
            ['Left', 'Down'],
            ['Left'],
            ['Left', 'Up'],
            ['Up'],
            ['Right', 'Up'],
          ];
          for (const name of names[octant] ?? []) mask |= bit(name);
        }
      }

      if (a && inCircle(a, x, y)) mask |= bit('A');
      if (b && inCircle(b, x, y)) mask |= bit('B');
      if (xButton && inCircle(xButton, x, y)) mask |= bit('X');
      if (yButton && inCircle(yButton, x, y)) mask |= bit('Y');
      if (start && inRect(start, x, y)) mask |= bit('Start');
      if (select && inRect(select, x, y)) mask |= bit('Select');
      if (shoulderLeft && inRect(shoulderLeft, x, y)) mask |= bit('L');
      if (shoulderRight && inRect(shoulderRight, x, y)) mask |= bit('R');
      return mask;
    }

    /** Which emulator actions the current pointers are holding down. */
    function heldActions(): PlayerAction[] {
      const { rewind, forward } = geometry;
      const active: PlayerAction[] = [];
      for (const point of pointers.values()) {
        if (rewind && inRect(rewind, point.x, point.y) && !active.includes('rewind')) {
          active.push('rewind');
        }
        if (forward && inRect(forward, point.x, point.y) && !active.includes('fastForward')) {
          active.push('fastForward');
        }
      }
      return active;
    }

    function recompute() {
      if (stale) {
        geometry = measure();
        stale = false;
      }
      let mask = 0;
      for (const point of pointers.values()) mask |= maskFor(point.x, point.y);
      input.set('touch', mask);
      setPressed(mask);

      const active = heldActions();
      const previous = heldRef.current;
      for (const action of active) if (!previous.includes(action)) onAction(action, true);
      for (const action of previous) if (!active.includes(action)) onAction(action, false);
      heldRef.current = active;
      setHeld(active);
    }

    const onPointerDown = (event: PointerEvent) => {
      // Only capture on the control surface, so the menu button still works.
      if (event.target instanceof Element && event.target.closest('[data-passthrough]')) return;
      event.preventDefault();
      // Measure afresh on every press rather than trusting the last measurement.
      // The controls can move for reasons no event announces — an errant scroll
      // or zoom from a double tap, the dynamic toolbar, the visual viewport
      // shifting under the layout — and a stale rectangle means the button is
      // simply dead. A press is rare enough that measuring is free; what it
      // buys is that a press is always tested against where the buttons are.
      stale = true;
      surface.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      recompute();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      event.preventDefault();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      recompute();
    };

    const onPointerEnd = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return;
      recompute();
    };

    surface.addEventListener('pointerdown', onPointerDown);
    surface.addEventListener('pointermove', onPointerMove);
    surface.addEventListener('pointerup', onPointerEnd);
    surface.addEventListener('pointercancel', onPointerEnd);
    window.addEventListener('resize', forgetPointers);
    window.addEventListener('orientationchange', forgetPointers);
    // A scroll anywhere in the page moves the controls with it, and iOS scrolls
    // the page on its own account often enough to matter. Capture, because the
    // scroll usually happens on an inner element and does not bubble.
    window.addEventListener('scroll', invalidate, true);
    // Pinch-zoom and the on-screen keyboard move the visual viewport without
    // resizing the layout viewport, so window resize never fires.
    visualViewport?.addEventListener('resize', invalidate);
    visualViewport?.addEventListener('scroll', invalidate);

    return () => {
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', onPointerEnd);
      surface.removeEventListener('pointercancel', onPointerEnd);
      window.removeEventListener('resize', forgetPointers);
      window.removeEventListener('orientationchange', forgetPointers);
      window.removeEventListener('scroll', invalidate, true);
      visualViewport?.removeEventListener('resize', invalidate);
      visualViewport?.removeEventListener('scroll', invalidate);
      input.set('touch', 0);
    };
  }, [input, disabled, hasShoulders, hasDiamond, actions.length, onAction]);

  const on = (name: ButtonName) => ((pressed & bit(name)) !== 0 ? ' is-pressed' : '');

  return (
    <div class="touch-surface no-select" ref={surfaceRef} data-disabled={disabled || undefined}>
      {hasShoulders && (
        <div class="shoulders">
          <button type="button" class={`shoulder${on('L')}`} ref={shoulderLeftRef} aria-label="L">
            L
          </button>
          <button type="button" class={`shoulder${on('R')}`} ref={shoulderRightRef} aria-label="R">
            R
          </button>
        </div>
      )}

      <div class="dpad" ref={dpadRef}>
        <span class={`dpad-arm dpad-vertical${on('Up') || on('Down') ? ' is-pressed' : ''}`} />
        <span class={`dpad-arm dpad-horizontal${on('Left') || on('Right') ? ' is-pressed' : ''}`} />
        <span class={`dpad-cap dpad-up${on('Up')}`} />
        <span class={`dpad-cap dpad-down${on('Down')}`} />
        <span class={`dpad-cap dpad-left${on('Left')}`} />
        <span class={`dpad-cap dpad-right${on('Right')}`} />
      </div>

      {hasDiamond ? (
        // Four face buttons sit in a diamond, as on the hardware.
        <div class="face-diamond">
          <button type="button" class={`face-button${on('X')}`} ref={xRef} aria-label="X">
            X
          </button>
          <button type="button" class={`face-button${on('Y')}`} ref={yRef} aria-label="Y">
            Y
          </button>
          <button type="button" class={`face-button${on('A')}`} ref={aRef} aria-label="A">
            A
          </button>
          <button type="button" class={`face-button${on('B')}`} ref={bRef} aria-label="B">
            B
          </button>
        </div>
      ) : (
        <div class="face-buttons">
          <button type="button" class={`face-button${on('B')}`} ref={bRef} aria-label="B">
            B
          </button>
          <button type="button" class={`face-button${on('A')}`} ref={aRef} aria-label="A">
            A
          </button>
        </div>
      )}

      <div class="system-buttons">
        <button type="button" class={`pill${on('Select')}`} ref={selectRef} aria-label="Select">
          Select
        </button>
        <button type="button" class={`pill${on('Start')}`} ref={startRef} aria-label="Start">
          Start
        </button>
        <button type="button" class="pill pill-menu" data-passthrough onClick={onMenu}>
          Menü
        </button>

        {actions.length > 0 && (
          <div class="action-pills">
            {actions.includes('rewind') && (
              <button
                type="button"
                class={`pill pill-action${held.includes('rewind') ? ' is-pressed' : ''}`}
                ref={rewindRef}
                aria-label="Zurückspulen"
              >
                ⏪
              </button>
            )}
            {actions.includes('fastForward') && (
              <button
                type="button"
                class={`pill pill-action${held.includes('fastForward') ? ' is-pressed' : ''}`}
                ref={forwardRef}
                aria-label="Vorspulen"
              >
                ⏩
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function circleOf(element: Element | null, slop = 0): Circle | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    cx: rect.left + rect.width / 2,
    cy: rect.top + rect.height / 2,
    r: Math.max(rect.width, rect.height) / 2 + slop,
  };
}

function rectOf(element: Element | null): DOMRect | null {
  return element ? element.getBoundingClientRect() : null;
}

function inCircle(circle: Circle, x: number, y: number): boolean {
  return Math.hypot(x - circle.cx, y - circle.cy) <= circle.r;
}

function inRect(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
