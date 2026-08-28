/**
 * Copies the PPU state the depth renderer needs out of the core.
 *
 * Lives apart from the worker so the test suite can capture the same block
 * straight from a Node-hosted core and check the decoder against the
 * emulator's own output.
 *
 * Everything read here points into the core's own memory and is only coherent
 * between frames, which is when this is called.
 */

import { PPU_OFFSETS, Ppu, PpuHeader } from '../../core/protocol';
import type { SameBoyModule } from './sameboyModule';

export function capturePpu(module: SameBoyModule, target: Uint8Array): void {
  const heap = module.HEAPU8;

  const header = new Int32Array(target.buffer, target.byteOffset + PPU_OFFSETS.header, 4);
  const vramSize = Math.min(module._gbw_vram_size(), Ppu.VRAM_BYTES);
  header[PpuHeader.IS_CGB] = module._gbw_is_cgb();
  header[PpuHeader.VRAM_SIZE] = vramSize;

  const copy = (pointer: number, offset: number, length: number) => {
    if (pointer === 0 || length <= 0) return;
    target.set(heap.subarray(pointer, pointer + length), offset);
  };

  copy(module._gbw_vram(), PPU_OFFSETS.vram, vramSize);
  copy(module._gbw_oam(), PPU_OFFSETS.oam, Ppu.OAM_BYTES);
  copy(module._gbw_io(), PPU_OFFSETS.io, Ppu.IO_BYTES);
  copy(module._gbw_bg_palettes_rgb(), PPU_OFFSETS.bgPalettes, Ppu.PALETTE_BYTES);
  copy(module._gbw_obj_palettes_rgb(), PPU_OFFSETS.objPalettes, Ppu.PALETTE_BYTES);
  copy(
    module._gbw_scanline_log(),
    PPU_OFFSETS.scanlines,
    Ppu.SCANLINES * Ppu.SCANLINE_RECORD_BYTES,
  );
}
