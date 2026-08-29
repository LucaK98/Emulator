/**
 * Copies the PPU state the depth renderer needs out of the Game Boy Advance
 * core.
 *
 * The counterpart of the Game Boy's capture, and split out for the same
 * reason: the test suite drives a Node-hosted core through it and checks the
 * decoder against the emulator's own picture, which is the only way to know
 * the decoder reads the hardware the way the hardware is read.
 *
 * Everything here points into the core's own memory and is only coherent
 * between frames, which is when this is called.
 */

import { GBA_PPU_OFFSETS, GbaPpu } from '../../core/protocol';
import type { MgbaModule } from './mgbaModule';

export function capturePpu(module: MgbaModule, target: Uint8Array): void {
  const heap = module.HEAPU8;

  const copy = (pointer: number, offset: number, length: number) => {
    if (pointer === 0 || length <= 0) return;
    target.set(heap.subarray(pointer, pointer + length), offset);
  };

  copy(module._gbaw_vram(), GBA_PPU_OFFSETS.vram, GbaPpu.VRAM_BYTES);
  copy(module._gbaw_oam(), GBA_PPU_OFFSETS.oam, GbaPpu.OAM_BYTES);
  copy(module._gbaw_palette(), GBA_PPU_OFFSETS.palette, GbaPpu.PALETTE_BYTES);
  copy(module._gbaw_io(), GBA_PPU_OFFSETS.io, GbaPpu.IO_BYTES);
  copy(
    module._gbaw_scanline_log(),
    GBA_PPU_OFFSETS.scanlines,
    GbaPpu.SCANLINES * GbaPpu.SCANLINE_RECORD_BYTES,
  );
}
