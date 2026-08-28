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

/* --- PPU capture (for the 2.5D renderer) -------------------------------- */

/**
 * Raw PPU state copied out once per frame when depth rendering is on.
 *
 * The 2.5D renderer cannot work from the finished picture — it needs the layers
 * separately, with tile identities intact. So the worker hands over VRAM, OAM,
 * the IO registers, the resolved palettes and the per-scanline scroll log, and
 * the main thread rebuilds the scene from those. About 18 KiB per frame, which
 * is nothing next to the frame buffer itself, and it is skipped entirely while
 * the flat renderer is active.
 */
export const Ppu = {
  HEADER_BYTES: 16,
  /** 8 KiB on DMG, 16 KiB on CGB; the buffer is always sized for CGB. */
  VRAM_BYTES: 0x4000,
  OAM_BYTES: 0xa0,
  IO_BYTES: 0x80,
  /** 32 colours as RGBA8888, for background and objects each. */
  PALETTE_BYTES: 0x20 * 4,
  SCANLINE_RECORD_BYTES: 8,
  SCANLINES: SCREEN_HEIGHT,
} as const;

export const PPU_OFFSETS = {
  header: 0,
  vram: Ppu.HEADER_BYTES,
  oam: Ppu.HEADER_BYTES + Ppu.VRAM_BYTES,
  io: Ppu.HEADER_BYTES + Ppu.VRAM_BYTES + Ppu.OAM_BYTES,
  bgPalettes: Ppu.HEADER_BYTES + Ppu.VRAM_BYTES + Ppu.OAM_BYTES + Ppu.IO_BYTES,
  objPalettes:
    Ppu.HEADER_BYTES + Ppu.VRAM_BYTES + Ppu.OAM_BYTES + Ppu.IO_BYTES + Ppu.PALETTE_BYTES,
  scanlines:
    Ppu.HEADER_BYTES + Ppu.VRAM_BYTES + Ppu.OAM_BYTES + Ppu.IO_BYTES + Ppu.PALETTE_BYTES * 2,
} as const;

export const PPU_BLOCK_BYTES =
  PPU_OFFSETS.scanlines + Ppu.SCANLINES * Ppu.SCANLINE_RECORD_BYTES;

/** Index into the header, as Int32 slots. */
export const PpuHeader = { IS_CGB: 0, VRAM_SIZE: 1 } as const;

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
  /** Non-zero while the main thread wants per-frame PPU state captured. */
  CAPTURE_PPU: 9,
} as const;

export const CTL_SLOTS = 16;

export const RunState = { Stopped: 0, Running: 1, Paused: 2 } as const;

/* --- SharedArrayBuffer layout ------------------------------------------- */

const CTL_BYTES = CTL_SLOTS * 4;
const FRAMES_BYTES = FRAME_PIXELS * 4 * FRAME_SLOTS;
const AUDIO_BYTES = AUDIO_RING_FRAMES * AUDIO_CHANNELS * 2; // Int16
/** PPU state is double-buffered alongside the frames, using the same slot index. */
const PPU_BYTES = PPU_BLOCK_BYTES * FRAME_SLOTS;

export const SHARED_LAYOUT = {
  ctlOffset: 0,
  framesOffset: CTL_BYTES,
  audioOffset: CTL_BYTES + FRAMES_BYTES,
  ppuOffset: CTL_BYTES + FRAMES_BYTES + AUDIO_BYTES,
  totalBytes: CTL_BYTES + FRAMES_BYTES + AUDIO_BYTES + PPU_BYTES,
} as const;

export interface SharedViews {
  ctl: Int32Array;
  /** One Uint32Array per frame slot, RGBA8888 little-endian. */
  frames: Uint32Array[];
  /** Interleaved stereo Int16 ring. */
  audio: Int16Array;
  /** One raw PPU block per frame slot; see PPU_OFFSETS. */
  ppu: Uint8Array[];
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
  const ppu: Uint8Array[] = [];
  for (let slot = 0; slot < FRAME_SLOTS; slot++) {
    ppu.push(
      new Uint8Array(buffer, SHARED_LAYOUT.ppuOffset + slot * PPU_BLOCK_BYTES, PPU_BLOCK_BYTES),
    );
  }

  return {
    ctl: new Int32Array(buffer, SHARED_LAYOUT.ctlOffset, CTL_SLOTS),
    frames,
    audio: new Int16Array(buffer, SHARED_LAYOUT.audioOffset, AUDIO_RING_FRAMES * AUDIO_CHANNELS),
    ppu,
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
