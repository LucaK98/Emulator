/**
 * Aggregated button state.
 *
 * Several sources (touch overlay, keyboard, later a gamepad) contribute
 * independently, so each holds its own mask and the union is what reaches the
 * core. Without that, lifting a finger would clear a key held on a keyboard.
 */

import { bit, type ButtonName } from '../core/systems';

export { bit };

export type InputSource = 'touch' | 'keyboard' | 'gamepad';

export class InputState {
  private masks: Record<InputSource, number> = { touch: 0, keyboard: 0, gamepad: 0 };
  private listeners = new Set<(mask: number) => void>();

  get mask(): number {
    return this.masks.touch | this.masks.keyboard | this.masks.gamepad;
  }

  set(source: InputSource, mask: number): void {
    if (this.masks[source] === mask) return;
    const before = this.mask;
    this.masks[source] = mask;
    const after = this.mask;
    if (before !== after) {
      for (const listener of this.listeners) listener(after);
    }
  }

  clear(): void {
    this.masks = { touch: 0, keyboard: 0, gamepad: 0 };
    for (const listener of this.listeners) listener(0);
  }

  subscribe(listener: (mask: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Desktop keys, for developing without a phone in hand. */
export const KEYBOARD_MAP: Record<string, ButtonName> = {
  ArrowRight: 'Right',
  ArrowLeft: 'Left',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  KeyX: 'A',
  KeyY: 'B',
  KeyZ: 'B',
  Enter: 'Start',
  ShiftRight: 'Select',
  ShiftLeft: 'Select',
  KeyA: 'L',
  KeyS: 'R',
  KeyC: 'X',
  KeyV: 'Y',
};

/** Attaches keyboard handling; returns a disposer. */
export function attachKeyboard(input: InputState, target: Window = window): () => void {
  let mask = 0;

  const update = (event: KeyboardEvent, pressed: boolean) => {
    const button = KEYBOARD_MAP[event.code];
    if (!button) return;
    event.preventDefault();
    mask = pressed ? mask | bit(button) : mask & ~bit(button);
    input.set('keyboard', mask);
  };

  const onDown = (event: KeyboardEvent) => update(event, true);
  const onUp = (event: KeyboardEvent) => update(event, false);
  const onBlur = () => {
    mask = 0;
    input.set('keyboard', 0);
  };

  target.addEventListener('keydown', onDown);
  target.addEventListener('keyup', onUp);
  target.addEventListener('blur', onBlur);

  return () => {
    target.removeEventListener('keydown', onDown);
    target.removeEventListener('keyup', onUp);
    target.removeEventListener('blur', onBlur);
  };
}
