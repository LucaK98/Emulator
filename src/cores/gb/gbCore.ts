/**
 * Adapts the SameBoy WASM module to the shared core interface.
 */

import { AUDIO_CHANNELS, GB_SCREEN_HEIGHT, GB_SCREEN_WIDTH } from '../../core/protocol';
import { readHeapBuffer, withHeapBuffer, type EmulatorCore } from '../EmulatorCore';
import { capturePpu } from './capturePpu';
import type { SameBoyFactory, SameBoyModule } from './sameboyModule';

const FRAME_PIXELS = GB_SCREEN_WIDTH * GB_SCREEN_HEIGHT;

export async function createGbCore(coreUrl: string): Promise<EmulatorCore> {
  const factory: SameBoyFactory = (await import(/* @vite-ignore */ coreUrl)).default;
  const module = await factory();
  return new GbCore(module);
}

class GbCore implements EmulatorCore {
  /** SameBoy takes cartridge RAM after the ROM is in place. */
  readonly batteryBeforeRom = false;

  constructor(private readonly module: SameBoyModule) {}

  init(model: number): void {
    this.module._gbw_init(model);
  }

  deinit(): void {
    this.module._gbw_deinit();
  }

  loadRom(bytes: Uint8Array): boolean {
    return withHeapBuffer(this.module, bytes, (ptr) =>
      this.module._gbw_load_rom(ptr, bytes.length),
    ) === 0;
  }

  reset(): void {
    this.module._gbw_reset();
  }

  runFrame(): number {
    return this.module._gbw_run_frame();
  }

  framePixels(): Uint32Array {
    const ptr = this.module._gbw_framebuffer();
    return this.module.HEAPU32.subarray(ptr >>> 2, (ptr >>> 2) + FRAME_PIXELS);
  }

  audioSamples(frames: number): Int16Array {
    const ptr = this.module._gbw_audio_buffer();
    return this.module.HEAP16.subarray(ptr >> 1, (ptr >> 1) + frames * AUDIO_CHANNELS);
  }

  setKeyMask(mask: number): void {
    // SameBoy has no shoulder buttons; the extra bits are simply ignored.
    this.module._gbw_set_key_mask(mask & 0xff);
  }

  setSampleRate(rate: number): void {
    this.module._gbw_set_sample_rate(rate);
  }

  frameSize(): { width: number; height: number } {
    return { width: GB_SCREEN_WIDTH, height: GB_SCREEN_HEIGHT };
  }

  frameRate(): number {
    return this.module._gbw_frame_rate();
  }

  batterySize(): number {
    return this.module._gbw_battery_size();
  }

  readBattery(): ArrayBuffer | null {
    const size = this.module._gbw_battery_size();
    return readHeapBuffer(this.module, size, (ptr) => this.module._gbw_save_battery(ptr, size));
  }

  loadBattery(bytes: Uint8Array): void {
    withHeapBuffer(this.module, bytes, (ptr) => this.module._gbw_load_battery(ptr, bytes.length));
  }

  readState(): ArrayBuffer | null {
    return readHeapBuffer(this.module, this.module._gbw_state_size(), (ptr) =>
      this.module._gbw_save_state(ptr),
    );
  }

  loadState(bytes: Uint8Array): boolean {
    return (
      withHeapBuffer(this.module, bytes, (ptr) =>
        this.module._gbw_load_state(ptr, bytes.length),
      ) === 0
    );
  }

  capturePpu(target: Uint8Array): void {
    capturePpu(this.module, target);
  }
}
