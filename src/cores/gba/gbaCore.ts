/**
 * Adapts the mGBA WASM module to the shared core interface.
 */

import { AUDIO_CHANNELS, SYSTEMS } from '../../core/protocol';
import { readHeapBuffer, withHeapBuffer, type EmulatorCore } from '../EmulatorCore';
import { capturePpu } from './capturePpu';
import type { MgbaFactory, MgbaModule } from './mgbaModule';

const FRAME_PIXELS = SYSTEMS.gba.width * SYSTEMS.gba.height;

export async function createGbaCore(coreUrl: string): Promise<EmulatorCore> {
  const factory: MgbaFactory = (await import(/* @vite-ignore */ coreUrl)).default;
  const module = await factory();
  return new GbaCore(module);
}

class GbaCore implements EmulatorCore {
  /**
   * mGBA maps the save buffer while the ROM is loading, so restoring a save
   * afterwards would be ignored for some save types.
   */
  readonly batteryBeforeRom = true;

  constructor(private readonly module: MgbaModule) {}

  init(model: number): void {
    this.module._gbaw_init(model);
  }

  deinit(): void {
    this.module._gbaw_deinit();
  }

  loadRom(bytes: Uint8Array): boolean {
    return (
      withHeapBuffer(this.module, bytes, (ptr) =>
        this.module._gbaw_load_rom(ptr, bytes.length),
      ) === 0
    );
  }

  reset(): void {
    this.module._gbaw_reset();
  }

  runFrame(): number {
    return this.module._gbaw_run_frame();
  }

  framePixels(): Uint32Array {
    const ptr = this.module._gbaw_framebuffer();
    return this.module.HEAPU32.subarray(ptr >>> 2, (ptr >>> 2) + FRAME_PIXELS);
  }

  audioSamples(frames: number): Int16Array {
    const ptr = this.module._gbaw_audio_buffer();
    return this.module.HEAP16.subarray(ptr >> 1, (ptr >> 1) + frames * AUDIO_CHANNELS);
  }

  setKeyMask(mask: number): void {
    // The wrapper translates the shared bit order to the GBA's own.
    this.module._gbaw_set_key_mask(mask);
  }

  setSampleRate(rate: number): void {
    this.module._gbaw_set_sample_rate(rate);
  }

  frameSize(): { width: number; height: number } {
    return { width: SYSTEMS.gba.width, height: SYSTEMS.gba.height };
  }

  frameRate(): number {
    return this.module._gbaw_frame_rate();
  }

  batterySize(): number {
    return this.module._gbaw_battery_size();
  }

  readBattery(): ArrayBuffer | null {
    const size = this.module._gbaw_battery_size();
    return readHeapBuffer(this.module, size, (ptr) => this.module._gbaw_save_battery(ptr, size));
  }

  loadBattery(bytes: Uint8Array): void {
    withHeapBuffer(this.module, bytes, (ptr) => this.module._gbaw_load_battery(ptr, bytes.length));
  }

  readState(): ArrayBuffer | null {
    const size = this.module._gbaw_state_size();
    return readHeapBuffer(this.module, size, (ptr) => this.module._gbaw_save_state(ptr, size));
  }

  loadState(bytes: Uint8Array): boolean {
    return (
      withHeapBuffer(this.module, bytes, (ptr) =>
        this.module._gbaw_load_state(ptr, bytes.length),
      ) === 0
    );
  }

  capturePpu(target: Uint8Array): void {
    capturePpu(this.module, target);
  }
}
