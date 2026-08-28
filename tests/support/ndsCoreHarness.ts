/**
 * Drives the built melonDS WASM core directly from Node.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { SYSTEMS } from '../../src/core/systems';
import type { MelonDsFactory, MelonDsModule } from '../../src/cores/nds/melondsModule';
import { REPO_ROOT } from './gbCoreHarness';

export const NDS_FRAME_PIXELS = SYSTEMS.nds.width * SYSTEMS.nds.height;

export interface LoadedNdsCore {
  module: MelonDsModule;
  runFrames(count: number): number;
  framebuffer(): Uint32Array;
  screenHash(): string;
  /** Distinct colours on screen; one means nothing was drawn. */
  colourCount(): number;
}

export async function loadNdsCore(romPath: string): Promise<LoadedNdsCore> {
  const coreUrl = new URL(`file://${resolve(REPO_ROOT, 'public/cores/melonds.js')}`).href;
  const factory: MelonDsFactory = (await import(coreUrl)).default;
  const module = await factory();

  module._ndsw_init(0);
  module._ndsw_set_sample_rate(48000);

  const rom = readFileSync(resolve(REPO_ROOT, romPath));
  const ptr = module._malloc(rom.length);
  module.HEAPU8.set(rom, ptr);
  const result = module._ndsw_load_rom(ptr, rom.length);
  module._free(ptr);
  if (result !== 0) throw new Error(`ROM konnte nicht geladen werden: ${romPath}`);

  const framebuffer = () => {
    const pixelPtr = module._ndsw_framebuffer();
    return module.HEAPU32.subarray(pixelPtr >>> 2, (pixelPtr >>> 2) + NDS_FRAME_PIXELS);
  };

  return {
    module,
    runFrames(count: number) {
      let audio = 0;
      for (let i = 0; i < count; i++) audio += module._ndsw_run_frame();
      return audio;
    },
    framebuffer,
    screenHash() {
      const pixels = framebuffer();
      const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    },
    colourCount() {
      const seen = new Set<number>();
      for (const pixel of framebuffer()) seen.add(pixel);
      return seen.size;
    },
  };
}
