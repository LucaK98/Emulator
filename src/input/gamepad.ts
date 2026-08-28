/**
 * Physical controller support through the Gamepad API, which iOS Safari does
 * implement — an MFi, DualSense or Xbox pad paired over Bluetooth shows up here.
 *
 * The default layout follows the physical arrangement rather than button names:
 * on a Game Boy, A sits up and to the right of B, and on a standard controller
 * so does the right face button relative to the bottom one. Mapping by position
 * keeps muscle memory intact across very differently labelled pads.
 */

import type { ButtonName } from '../core/systems';
import { bit, type InputState } from './InputState';

/** Standard-layout indices, from the Gamepad API's own mapping. */
const DEFAULT_MAPPING: Record<ButtonName, number> = {
  B: 0, // bottom face button
  A: 1, // right face button
  Y: 2, // left face button  — the DS X/Y sit the same way round
  X: 3, // top face button
  L: 4, // left shoulder
  R: 5, // right shoulder
  Select: 8,
  Start: 9,
  Up: 12,
  Down: 13,
  Left: 14,
  Right: 15,
};

/** Past this much stick deflection a direction counts as pressed. */
const STICK_DEADZONE = 0.45;

const MAPPING_KEY = 'gamepad-mapping';

export type GamepadMapping = Record<ButtonName, number>;

export function defaultMapping(): GamepadMapping {
  return { ...DEFAULT_MAPPING };
}

export function loadMapping(): GamepadMapping {
  try {
    const stored = localStorage.getItem(MAPPING_KEY);
    if (stored) return { ...DEFAULT_MAPPING, ...JSON.parse(stored) };
  }
  catch {
    // A corrupt mapping is not worth failing over; fall back to the default.
  }
  return defaultMapping();
}

export function saveMapping(mapping: GamepadMapping): void {
  try {
    localStorage.setItem(MAPPING_KEY, JSON.stringify(mapping));
  }
  catch {
    // Storage full or blocked: the mapping simply does not persist.
  }
}

/** The first connected pad, or null. */
export function firstGamepad(): Gamepad | null {
  if (!navigator.getGamepads) return null;
  for (const pad of navigator.getGamepads()) {
    if (pad?.connected) return pad;
  }
  return null;
}

/**
 * Polls the connected pad and folds it into the shared input state.
 *
 * The Gamepad API has no events for button state, only for connection, so this
 * has to be sampled. It runs on its own animation frame so it keeps working
 * while the emulator is paused — otherwise a pad could not dismiss the menu.
 */
export class GamepadReader {
  private handle = 0;
  private mapping = loadMapping();
  /** Set while waiting for the user to press a button to bind. */
  private capture: ((index: number) => void) | null = null;

  constructor(private readonly input: InputState) {}

  start(): void {
    if (this.handle || !navigator.getGamepads) return;
    const tick = () => {
      this.handle = requestAnimationFrame(tick);
      this.poll();
    };
    this.handle = requestAnimationFrame(tick);
  }

  stop(): void {
    if (!this.handle) return;
    cancelAnimationFrame(this.handle);
    this.handle = 0;
    this.input.set('gamepad', 0);
  }

  setMapping(mapping: GamepadMapping): void {
    this.mapping = mapping;
  }

  /** Resolves with the index of the next button pressed on the pad. */
  captureNextButton(): Promise<number> {
    return new Promise((resolve) => {
      this.capture = resolve;
    });
  }

  cancelCapture(): void {
    this.capture = null;
  }

  private poll(): void {
    const pad = firstGamepad();
    if (!pad) {
      this.input.set('gamepad', 0);
      return;
    }

    if (this.capture) {
      const pressed = pad.buttons.findIndex((button) => button.pressed);
      if (pressed >= 0) {
        const resolve = this.capture;
        this.capture = null;
        resolve(pressed);
      }
      // While binding, do not also feed the press into the game.
      this.input.set('gamepad', 0);
      return;
    }

    let mask = 0;
    for (const [name, index] of Object.entries(this.mapping) as [ButtonName, number][]) {
      if (pad.buttons[index]?.pressed) mask |= bit(name);
    }

    // Many pads report the d-pad only as a stick, or the player simply prefers
    // it, so the left stick always doubles as a d-pad.
    const [x = 0, y = 0] = pad.axes;
    if (x <= -STICK_DEADZONE) mask |= bit('Left');
    if (x >= STICK_DEADZONE) mask |= bit('Right');
    if (y <= -STICK_DEADZONE) mask |= bit('Up');
    if (y >= STICK_DEADZONE) mask |= bit('Down');

    this.input.set('gamepad', mask);
  }
}
