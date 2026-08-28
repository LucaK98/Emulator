/**
 * What the worker runtime needs from a core, whichever console it emulates.
 *
 * Both wrappers expose the same shape — one frame per call, buffers as views
 * into the WASM heap, save data and save states as flat bytes — so the pacing,
 * the shared-memory transport and the message handling are written once.
 */

export interface EmulatorCore {
  /** Called once before a ROM is loaded. `model` is core-specific. */
  init(model: number): void;
  deinit(): void;

  /** Returns false when the image was rejected. */
  loadRom(bytes: Uint8Array): boolean;
  reset(): void;

  /** Emulates one video frame; returns the stereo audio frames produced. */
  runFrame(): number;
  /** The completed frame, as a view into the WASM heap. */
  framePixels(): Uint32Array;
  /** The audio produced by the last frame, interleaved stereo. */
  audioSamples(frames: number): Int16Array;

  setKeyMask(mask: number): void;
  setSampleRate(rate: number): void;
  frameRate(): number;

  /**
   * Whether cartridge save data must be restored before the ROM is attached.
   * mGBA maps the save buffer while loading the ROM, so writing into it
   * afterwards would be ignored; SameBoy takes it after loading.
   */
  readonly batteryBeforeRom: boolean;
  batterySize(): number;
  readBattery(): ArrayBuffer | null;
  loadBattery(bytes: Uint8Array): void;

  readState(): ArrayBuffer | null;
  loadState(bytes: Uint8Array): boolean;

  /** Present only on cores that can feed the 2.5D renderer. */
  capturePpu?(target: Uint8Array): void;
}

/** Copies bytes into the WASM heap, runs `use` with the pointer, then frees. */
export function withHeapBuffer<T>(
  module: { _malloc(size: number): number; _free(ptr: number): void; HEAPU8: Uint8Array },
  bytes: Uint8Array,
  use: (ptr: number) => T,
): T {
  const ptr = module._malloc(bytes.length);
  try {
    module.HEAPU8.set(bytes, ptr);
    return use(ptr);
  }
  finally {
    module._free(ptr);
  }
}

/** Reads `size` bytes back out of the heap after `fill` writes them. */
export function readHeapBuffer(
  module: { _malloc(size: number): number; _free(ptr: number): void; HEAPU8: Uint8Array },
  size: number,
  fill: (ptr: number) => void,
): ArrayBuffer | null {
  if (size <= 0) return null;
  const ptr = module._malloc(size);
  try {
    fill(ptr);
    return new Uint8Array(module.HEAPU8.subarray(ptr, ptr + size)).buffer;
  }
  finally {
    module._free(ptr);
  }
}
