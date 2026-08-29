/**
 * Drives the built mGBA WASM core directly from Node.
 *
 * Same idea as the Game Boy harness: no browser, so core behaviour is tested
 * apart from anything the UI does.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { GBA_PPU_BLOCK_BYTES } from '../../src/core/protocol';
import { SYSTEMS } from '../../src/core/systems';
import { capturePpu } from '../../src/cores/gba/capturePpu';
import { GbaPpuDecoder } from '../../src/render/ppu/decodeGba';
import type { DepthScene } from '../../src/render/ppu/scene';
import type { MgbaFactory, MgbaModule } from '../../src/cores/gba/mgbaModule';
import { REPO_ROOT } from './gbCoreHarness';

export const GBA_WIDTH = SYSTEMS.gba.width;
export const GBA_HEIGHT = SYSTEMS.gba.height;

export interface LoadedGbaCore {
  module: MgbaModule;
  runFrames(count: number): number;
  framebuffer(): Uint32Array;
  screenHash(): string;
  /** True when every pixel is the same colour, i.e. nothing was drawn. */
  screenIsBlank(): boolean;
  /** Decodes the current PPU state back into separate layers. */
  scene(): DepthScene;
  /** False when the frame used a mode the depth decoder does not cover. */
  sceneSupported(): boolean;
}

export async function loadGbaCore(romPath: string): Promise<LoadedGbaCore> {
  const coreUrl = new URL(`file://${resolve(REPO_ROOT, 'public/cores/mgba.js')}`).href;
  const factory: MgbaFactory = (await import(coreUrl)).default;
  const module = await factory();

  module._gbaw_init(0);
  module._gbaw_set_sample_rate(48000);

  const rom = readFileSync(resolve(REPO_ROOT, romPath));
  const ptr = module._malloc(rom.length);
  module.HEAPU8.set(rom, ptr);
  const result = module._gbaw_load_rom(ptr, rom.length);
  module._free(ptr);
  if (result !== 0) throw new Error(`ROM konnte nicht geladen werden: ${romPath}`);

  const framebuffer = () => {
    const pixelPtr = module._gbaw_framebuffer();
    return module.HEAPU32.subarray(pixelPtr >>> 2, (pixelPtr >>> 2) + GBA_WIDTH * GBA_HEIGHT);
  };

  const ppuBlock = new Uint8Array(GBA_PPU_BLOCK_BYTES);
  const decoder = new GbaPpuDecoder();

  return {
    module,
    runFrames(count: number) {
      let audio = 0;
      for (let i = 0; i < count; i++) audio += module._gbaw_run_frame();
      return audio;
    },
    framebuffer,
    screenHash() {
      const pixels = framebuffer();
      const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    },
    screenIsBlank() {
      const pixels = framebuffer();
      const first = pixels[0];
      for (let i = 1; i < pixels.length; i++) if (pixels[i] !== first) return false;
      return true;
    },
    scene() {
      capturePpu(module, ppuBlock);
      return decoder.decode(ppuBlock);
    },
    sceneSupported() {
      return decoder.supported;
    },
  };
}
