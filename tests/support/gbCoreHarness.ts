/**
 * Drives the built SameBoy WASM core directly from Node, without a browser.
 *
 * The module is built with ENVIRONMENT=worker,node precisely so the accuracy
 * suite can run here: it is far faster than a browser and it isolates core
 * behaviour from anything the UI does.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { SameBoyFactory, SameBoyModule } from '../../src/cores/gb/sameboyModule';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../..');

export const SCREEN_WIDTH = 160;
export const SCREEN_HEIGHT = 144;
export const GB_MODEL_DMG_B = 0x002;
export const GB_MODEL_CGB_E = 0x205;

export interface LoadedCore {
  module: SameBoyModule;
  runFrames(count: number): number;
  framebuffer(): Uint32Array;
  /** Stable hash of the current screen contents. */
  screenHash(): string;
}

export async function loadCore(romPath: string, model = GB_MODEL_DMG_B): Promise<LoadedCore> {
  const coreUrl = new URL(`file://${resolve(REPO_ROOT, 'public/cores/sameboy.js')}`).href;
  const factory: SameBoyFactory = (await import(coreUrl)).default;
  const module = await factory();

  module._gbw_init(model);
  module._gbw_set_sample_rate(48000);

  const rom = readFileSync(resolve(REPO_ROOT, romPath));
  const ptr = module._malloc(rom.length);
  module.HEAPU8.set(rom, ptr);
  const result = module._gbw_load_rom(ptr, rom.length);
  module._free(ptr);
  if (result !== 0) throw new Error(`ROM konnte nicht geladen werden: ${romPath}`);

  module._gbw_reset();

  const framebuffer = () => {
    const pixelPtr = module._gbw_framebuffer();
    return module.HEAPU32.subarray(pixelPtr >>> 2, (pixelPtr >>> 2) + SCREEN_WIDTH * SCREEN_HEIGHT);
  };

  return {
    module,
    runFrames(count: number) {
      let audio = 0;
      for (let i = 0; i < count; i++) audio += module._gbw_run_frame();
      return audio;
    },
    framebuffer,
    screenHash() {
      const pixels = framebuffer();
      const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    },
  };
}

/** Renders the screen as ASCII, so a failing assertion is readable in the log. */
export function screenToAscii(pixels: Uint32Array): string {
  const ramp = ' .:-=+*#%@';
  const rows: string[] = [];
  // Sample every other pixel horizontally to keep the aspect roughly square.
  for (let y = 0; y < SCREEN_HEIGHT; y += 3) {
    let row = '';
    for (let x = 0; x < SCREEN_WIDTH; x += 2) {
      const pixel = pixels[y * SCREEN_WIDTH + x] ?? 0;
      const r = pixel & 0xff;
      const g = (pixel >> 8) & 0xff;
      const b = (pixel >> 16) & 0xff;
      const luma = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      row += ramp[Math.min(ramp.length - 1, Math.round((1 - luma) * (ramp.length - 1)))];
    }
    rows.push(row);
  }
  return rows.join('\n');
}
