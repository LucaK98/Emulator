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

interface Props {
  input: InputState;
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

export function TouchControls({ input, buttons, onMenu, disabled = false }: Props) {
  const hasShoulders = buttons.includes('L');
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dpadRef = useRef<HTMLDivElement>(null);
  const aRef = useRef<HTMLButtonElement>(null);
  const bRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const selectRef = useRef<HTMLButtonElement>(null);
  const shoulderLeftRef = useRef<HTMLButtonElement>(null);
  const shoulderRightRef = useRef<HTMLButtonElement>(null);

  const [pressed, setPressed] = useState(0);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || disabled) {
      input.set('touch', 0);
      setPressed(0);
      return;
    }

    const pointers = new Map<number, { x: number; y: number }>();

    /** Geometry is re-measured lazily; layout only changes on resize/rotate. */
    let geometry = measure();

    function measure() {
      return {
        dpad: circleOf(dpadRef.current),
        a: circleOf(aRef.current, BUTTON_SLOP),
        b: circleOf(bRef.current, BUTTON_SLOP),
        start: rectOf(startRef.current),
        select: rectOf(selectRef.current),
        shoulderLeft: rectOf(shoulderLeftRef.current),
        shoulderRight: rectOf(shoulderRightRef.current),
      };
    }

    const remeasure = () => {
      geometry = measure();
    };

    function maskFor(x: number, y: number): number {
      let mask = 0;
      const { dpad, a, b, start, select, shoulderLeft, shoulderRight } = geometry;

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
      if (start && inRect(start, x, y)) mask |= bit('Start');
      if (select && inRect(select, x, y)) mask |= bit('Select');
      if (shoulderLeft && inRect(shoulderLeft, x, y)) mask |= bit('L');
      if (shoulderRight && inRect(shoulderRight, x, y)) mask |= bit('R');
      return mask;
    }

    function recompute() {
      let mask = 0;
      for (const point of pointers.values()) mask |= maskFor(point.x, point.y);
      input.set('touch', mask);
      setPressed(mask);
    }

    const onPointerDown = (event: PointerEvent) => {
      // Only capture on the control surface, so the menu button still works.
      if (event.target instanceof Element && event.target.closest('[data-passthrough]')) return;
      event.preventDefault();
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
    window.addEventListener('resize', remeasure);
    window.addEventListener('orientationchange', remeasure);

    return () => {
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', onPointerEnd);
      surface.removeEventListener('pointercancel', onPointerEnd);
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('orientationchange', remeasure);
      input.set('touch', 0);
    };
  }, [input, disabled, hasShoulders]);

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

      <div class="face-buttons">
        <button type="button" class={`face-button${on('B')}`} ref={bRef} aria-label="B">
          B
        </button>
        <button type="button" class={`face-button${on('A')}`} ref={aRef} aria-label="A">
          A
        </button>
      </div>

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
