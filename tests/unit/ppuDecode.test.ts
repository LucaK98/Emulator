/**
 * Checks the PPU layer decoder against the emulator itself.
 *
 * The decoder reads VRAM, OAM and the registers back into separate layers so
 * the 2.5D renderer can give them depth. Flattening those layers again has to
 * reproduce the emulator's own picture exactly — any mistake in tile
 * addressing, map wrapping, flips, palettes or object priority shows up as
 * differing pixels.
 *
 * tests/roms/ppu-probe.gb exists for this: it deliberately uses signed tile
 * addressing, a background scrolled off the tile grid, a window at a non-zero
 * origin and 8x16 objects with flips and priority.
 */

import { describe, expect, it } from 'vitest';
import { GB_MODEL_DMG_B, loadCore, SCREEN_HEIGHT, SCREEN_WIDTH } from '../support/gbCoreHarness';
import { compositeScene } from '../support/composite';

/** Frames to let the ROM finish drawing and settle. */
const SETTLE_FRAMES = 240;

function differingPixels(a: Uint32Array, b: Uint32Array): number {
  let count = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++;
  return count;
}

describe('PPU layer decoder', () => {
  it('reproduces the emulator picture from the decoded layers', async () => {
    const core = await loadCore('tests/roms/ppu-probe.gb', GB_MODEL_DMG_B);
    core.runFrames(SETTLE_FRAMES);

    const scene = core.scene();
    const rebuilt = compositeScene(scene);
    const actual = core.framebuffer();

    const wrong = differingPixels(rebuilt, actual);
    expect(wrong, `${wrong} of ${SCREEN_WIDTH * SCREEN_HEIGHT} pixels differ`).toBe(0);
  });

  it('picks up the scene structure the probe ROM sets up', async () => {
    const core = await loadCore('tests/roms/ppu-probe.gb', GB_MODEL_DMG_B);
    core.runFrames(SETTLE_FRAMES);
    const scene = core.scene();

    expect(scene.lcdOn).toBe(true);
    expect(scene.bgEnabled).toBe(true);
    expect(scene.isCgb).toBe(false);

    // Scrolled off the tile grid in both axes.
    expect(scene.scrollX).toBe(3);
    expect(scene.scrollY).toBe(5);

    // Window at WX-7 = 40, WY = 96.
    expect(scene.windowVisible).toBe(true);
    expect(scene.windowX).toBe(40);
    expect(scene.windowY).toBe(96);

    // Eight objects, all 8x16, and the ones flagged as background-priority
    // must be recognised as such.
    expect(scene.sprites.count).toBe(8);
    expect([...scene.sprites.height.slice(0, 8)]).toEqual(Array(8).fill(16));
    expect([...scene.sprites.behindBg.slice(0, 8)]).toEqual([0, 0, 0, 0, 1, 0, 1, 0]);

    // Signed tile addressing: background indices 0..7 resolve to 256..263.
    expect(Math.min(...scene.ground.tile.slice(0, scene.ground.count))).toBe(256);
    expect(Math.max(...scene.ground.tile.slice(0, scene.ground.count))).toBe(263);
  });

  it('covers the whole screen with ground cells', async () => {
    const core = await loadCore('tests/roms/ppu-probe.gb', GB_MODEL_DMG_B);
    core.runFrames(SETTLE_FRAMES);
    const cells = core.scene().ground;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < cells.count; i++) {
      minX = Math.min(minX, cells.worldX[i]!);
      minY = Math.min(minY, cells.worldY[i]!);
      maxX = Math.max(maxX, cells.worldX[i]! + 8);
      maxY = Math.max(maxY, cells.worldY[i]! + 8);
    }

    expect(minX).toBeLessThanOrEqual(0);
    expect(minY).toBeLessThanOrEqual(0);
    expect(maxX).toBeGreaterThanOrEqual(SCREEN_WIDTH);
    expect(maxY).toBeGreaterThanOrEqual(SCREEN_HEIGHT);
  });
});
