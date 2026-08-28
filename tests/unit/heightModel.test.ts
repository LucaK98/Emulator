/**
 * Checks that the height model separates ground from scenery on its own.
 *
 * It is driven with the real decoder on tests/roms/overworld-probe.gb, a
 * scrolling map where a character walks a corridor of ground tiles past
 * scattered scenery. Nothing in the ROM says which tile is which — that is the
 * whole point — so the model has to work it out from where the character can
 * be.
 */

import { describe, expect, it } from 'vitest';
import { GB_MODEL_DMG_B, loadCore } from '../support/gbCoreHarness';
import { TileHeightModel } from '../../src/render/heightModel';

/** Tile numbers the probe ROM uses, with unsigned ($8000) addressing. */
const GROUND_TILES = [0, 1];
const SCENERY_TILE = 4;

/** Long enough for evidence to accumulate and heights to finish rising. */
const OBSERVED_FRAMES = 400;

async function observe(rom: string, frames: number): Promise<TileHeightModel> {
  const core = await loadCore(rom, GB_MODEL_DMG_B);
  const model = new TileHeightModel();
  // Skip the ROM's own setup, which runs with the LCD off.
  core.runFrames(30);
  for (let i = 0; i < frames; i++) {
    core.runFrames(1);
    model.update(core.scene());
  }
  return model;
}

describe('TileHeightModel', () => {
  it('raises scenery and leaves walkable ground flat', { timeout: 60_000 }, async () => {
    const model = await observe('tests/roms/overworld-probe.gb', OBSERVED_FRAMES);

    expect(model.heightOf(SCENERY_TILE)).toBeGreaterThan(0.9);
    for (const tile of GROUND_TILES) {
      expect(model.heightOf(tile), `ground tile ${tile} should stay flat`).toBeLessThan(0.1);
    }
    expect(model.raisedTileCount()).toBe(1);
  });

  it('learns while the map is scrolling', { timeout: 60_000 }, async () => {
    const model = await observe('tests/roms/overworld-probe.gb', 120);
    expect(model.learning).toBe(true);
  });

  it(
    'stays flat on a screen that never scrolls, so menus are not extruded',
    { timeout: 60_000 },
    async () => {
      // The PPU probe draws a static screen full of tiles nobody stands on.
      // Treating those as scenery would turn a menu into a wall of blocks.
      const model = await observe('tests/roms/ppu-probe.gb', OBSERVED_FRAMES);

      expect(model.learning).toBe(false);
      expect(model.raisedTileCount()).toBe(0);
    },
  );

  it('forgets everything on reset', { timeout: 60_000 }, async () => {
    const model = await observe('tests/roms/overworld-probe.gb', OBSERVED_FRAMES);
    expect(model.raisedTileCount()).toBeGreaterThan(0);

    model.reset();
    expect(model.raisedTileCount()).toBe(0);
    expect(model.heightOf(SCENERY_TILE)).toBe(0);
    expect(model.learning).toBe(false);
  });
});
