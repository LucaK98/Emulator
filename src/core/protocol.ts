/**
 * Shared layout and message protocol between the main thread, the emulation
 * worker and the audio worklet.
 *
 * When the page is cross-origin isolated everything travels through one
 * SharedArrayBuffer and nothing is copied per frame: the worker writes pixels
 * and audio straight into it, the renderer uploads from it, and the audio
 * worklet drains the ring on the audio thread without waking the main thread.
 *
 * Without isolation the same worker falls back to posting buffers, which costs
 * a copy per frame but keeps the app usable.
 */

export const SCREEN_WIDTH = 160;
export const SCREEN_HEIGHT = 144;
export const FRAME_PIXELS = SCREEN_WIDTH * SCREEN_HEIGHT;

/** Two frame slots so the renderer never reads the buffer being written. */
export const FRAME_SLOTS = 2;

/** Stereo frames held in the audio ring. ~340 ms at 48 kHz. */
export const AUDIO_RING_FRAMES = 16384;
export const AUDIO_CHANNELS = 2;

/**
 * Preferred output rate. The core is retuned to whatever the AudioContext
 * actually gives us, so no resampling is ever needed.
 */
export const PREFERRED_SAMPLE_RATE = 48000;

/* --- Control block ------------------------------------------------------ */

/** Int32 slots in the control block, all accessed via Atomics. */
export const Ctl = {
  /** Incremented once per completed frame; the renderer polls it. */
  FRAME_SEQ: 0,
  /** Which frame slot holds the most recently completed frame. */
  FRAME_SLOT: 1,
  /** Button bitmask, written by the main thread (see Button below). */
  KEY_MASK: 2,
  /** 0 = stopped, 1 = running, 2 = paused. */
  RUN_STATE: 3,
  /** Ring position the worker has written up to, in stereo frames. */
  AUDIO_WRITE: 4,
  /** Ring position the audio worklet has consumed up to, in stereo frames. */
  AUDIO_READ: 5,
  /** Emulation speed in percent; 100 is real time. */
  SPEED: 6,
  /** Total frames emulated since load, for diagnostics. */
  FRAME_COUNT: 7,
  /** Set by the worker when cartridge RAM changed and needs flushing. */
  BATTERY_DIRTY: 8,
} as const;

export const CTL_SLOTS = 16;

export const RunState = { Stopped: 0, Running: 1, Paused: 2 } as const;

/* --- SharedArrayBuffer layout ------------------------------------------- */

const CTL_BYTES = CTL_SLOTS * 4;
const FRAMES_BYTES = FRAME_PIXELS * 4 * FRAME_SLOTS;
const AUDIO_BYTES = AUDIO_RING_FRAMES * AUDIO_CHANNELS * 2; // Int16

export const SHARED_LAYOUT = {
  ctlOffset: 0,
  framesOffset: CTL_BYTES,
  audioOffset: CTL_BYTES + FRAMES_BYTES,
  totalBytes: CTL_BYTES + FRAMES_BYTES + AUDIO_BYTES,
} as const;

export interface SharedViews {
  ctl: Int32Array;
  /** One Uint32Array per frame slot, RGBA8888 little-endian. */
  frames: Uint32Array[];
  /** Interleaved stereo Int16 ring. */
  audio: Int16Array;
}

export function createSharedBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(SHARED_LAYOUT.totalBytes);
}

export function viewShared(buffer: SharedArrayBuffer | ArrayBuffer): SharedViews {
  const frames: Uint32Array[] = [];
  for (let slot = 0; slot < FRAME_SLOTS; slot++) {
    frames.push(
      new Uint32Array(buffer, SHARED_LAYOUT.framesOffset + slot * FRAME_PIXELS * 4, FRAME_PIXELS),
    );
  }
  return {
    ctl: new Int32Array(buffer, SHARED_LAYOUT.ctlOffset, CTL_SLOTS),
    frames,
    audio: new Int16Array(buffer, SHARED_LAYOUT.audioOffset, AUDIO_RING_FRAMES * AUDIO_CHANNELS),
  };
}

/* --- Input -------------------------------------------------------------- */

/** Bit positions match SameBoy's GB_key_t so the mask passes straight through. */
export const Button = {
  Right: 0,
  Left: 1,
  Up: 2,
  Down: 3,
  A: 4,
  B: 5,
  Select: 6,
  Start: 7,
} as const;

export type ButtonName = keyof typeof Button;

export const BUTTON_NAMES = Object.keys(Button) as ButtonName[];

/* --- Messages ----------------------------------------------------------- */

export type ToWorker =
  | { type: 'init'; shared: SharedArrayBuffer | null; coreUrl: string; sampleRate: number }
  | { type: 'load'; rom: ArrayBuffer; model: number; battery: ArrayBuffer | null }
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'setKeys'; mask: number }
  | { type: 'setSpeed'; percent: number }
  | { type: 'requestBattery'; token: number }
  | { type: 'requestState'; token: number }
  | { type: 'loadState'; data: ArrayBuffer; token: number }
  | { type: 'reset' };

export type FromWorker =
  | { type: 'ready'; usingShared: boolean }
  | { type: 'loaded'; frameRate: number; hasBattery: boolean }
  | { type: 'frame'; pixels: ArrayBuffer; seq: number }
  | { type: 'audio'; samples: ArrayBuffer }
  | { type: 'battery'; token: number; data: ArrayBuffer | null }
  | { type: 'state'; token: number; data: ArrayBuffer | null }
  | { type: 'stateLoaded'; token: number; ok: boolean }
  | { type: 'batteryDirty' }
  | { type: 'error'; message: string };
