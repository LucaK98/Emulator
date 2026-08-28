/**
 * Adapts the melonDS WASM module to the shared core interface.
 */

import { AUDIO_CHANNELS, SYSTEMS } from '../../core/protocol';
import { readHeapBuffer, withHeapBuffer, type EmulatorCore } from '../EmulatorCore';
import type { MelonDsFactory, MelonDsModule } from './melondsModule';

const FRAME_PIXELS = SYSTEMS.nds.width * SYSTEMS.nds.height;

export async function createNdsCore(coreUrl: string): Promise<EmulatorCore> {
  const factory: MelonDsFactory = (await import(/* @vite-ignore */ coreUrl)).default;
  const module = await factory();
  return new NdsCore(module);
}

class NdsCore implements EmulatorCore {
  /**
   * The cartridge object that owns the save memory only exists once the ROM is
   * parsed, so a save can only be restored afterwards.
   */
  readonly batteryBeforeRom = false;

  constructor(private readonly module: MelonDsModule) {}

  init(model: number): void {
    this.module._ndsw_init(model);
  }

  deinit(): void {
    this.module._ndsw_deinit();
  }

  loadRom(bytes: Uint8Array): boolean {
    return (
      withHeapBuffer(this.module, bytes, (ptr) =>
        this.module._ndsw_load_rom(ptr, bytes.length),
      ) === 0
    );
  }

  reset(): void {
    this.module._ndsw_reset();
  }

  runFrame(): number {
    return this.module._ndsw_run_frame();
  }

  framePixels(): Uint32Array {
    const ptr = this.module._ndsw_framebuffer();
    // Both arrangements hold the same pixels, so the length never changes.
    return this.module.HEAPU32.subarray(ptr >>> 2, (ptr >>> 2) + FRAME_PIXELS);
  }

  audioSamples(frames: number): Int16Array {
    const ptr = this.module._ndsw_audio_buffer();
    return this.module.HEAP16.subarray(ptr >> 1, (ptr >> 1) + frames * AUDIO_CHANNELS);
  }

  setKeyMask(mask: number): void {
    this.module._ndsw_set_key_mask(mask);
  }

  setSampleRate(rate: number): void {
    this.module._ndsw_set_sample_rate(rate);
  }

  frameSize(): { width: number; height: number } {
    return {
      width: this.module._ndsw_screen_width(),
      height: this.module._ndsw_screen_height(),
    };
  }

  setLayout(layout: number): void {
    this.module._ndsw_set_layout(layout);
  }

  touch(x: number, y: number): void {
    this.module._ndsw_touch(Math.round(x), Math.round(y));
  }

  releaseTouch(): void {
    this.module._ndsw_release_touch();
  }

  frameRate(): number {
    return this.module._ndsw_frame_rate();
  }

  batterySize(): number {
    return this.module._ndsw_battery_size();
  }

  readBattery(): ArrayBuffer | null {
    const size = this.module._ndsw_battery_size();
    return readHeapBuffer(this.module, size, (ptr) => this.module._ndsw_save_battery(ptr, size));
  }

  loadBattery(bytes: Uint8Array): void {
    withHeapBuffer(this.module, bytes, (ptr) => this.module._ndsw_load_battery(ptr, bytes.length));
  }

  readState(): ArrayBuffer | null {
    const size = this.module._ndsw_state_size();
    return readHeapBuffer(this.module, size, (ptr) => this.module._ndsw_save_state(ptr, size));
  }

  loadState(bytes: Uint8Array): boolean {
    return (
      withHeapBuffer(this.module, bytes, (ptr) =>
        this.module._ndsw_load_state(ptr, bytes.length),
      ) === 0
    );
  }
}
