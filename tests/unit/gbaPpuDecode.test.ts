/**
 * The Game Boy Advance layer decoder, checked against the emulator itself.
 *
 * The decoder's job is to take VRAM, object memory and the registers apart into
 * layers the depth renderer can stand up. There is one way to know it read the
 * hardware the way the hardware reads it: put the layers back together and
 * compare with the picture mGBA drew. A decoder that mixes up a map block,
 * takes a palette from the wrong bank or addresses a tile at the wrong depth
 * produces differing pixels, not merely a picture that looks a bit off.
 */

import { describe, expect, it } from 'vitest';
import { loadGbaCore } from '../support/gbaCoreHarness';
import { compositeGbaScene, countDifferences } from '../support/compositeGba';

const PROBE = 'tests/roms/gba-depth-probe.gba';
/** Long enough for the probe to have written every register and both maps. */
const SETTLE_FRAMES = 10;

describe('GBA layer decoder', () => {
  it('reproduces the emulator picture from the decoded layers', async () => {
    const core = await loadGbaCore(PROBE);
    core.runFrames(SETTLE_FRAMES);

    const rebuilt = compositeGbaScene(core.scene());
    const differences = countDifferences(rebuilt, core.framebuffer());

    expect(differences).toBe(0);
  });

  it('separates the scrolling world from the layer pinned to the screen', async () => {
    const core = await loadGbaCore(PROBE);
    core.runFrames(SETTLE_FRAMES);
    const scene = core.scene();

    expect(core.sceneSupported()).toBe(true);
    // BG1 scrolls, so it is world; BG0 never moves, so it is furniture.
    expect(scene.ground).toHaveLength(1);
    expect(scene.hud).toHaveLength(1);
    // BG1 is the one behind, and BG0 the one in front.
    expect(scene.ground[0]!.priority).toBe(1);
    expect(scene.hud[0]!.priority).toBe(0);

    expect(scene.scrollX).toBe(13);
    expect(scene.scrollY).toBe(6);

    // The layer is scrolled off the tile grid in both axes, and the cells must
    // carry that: 13 is five pixels into a tile, 6 is six. Asserting the
    // alignment rather than the first cell's position keeps this independent
    // of how far past the screen the decoder reaches.
    const ground = scene.ground[0]!.cells;
    const align = (value: number) => ((value % 8) + 8) % 8;
    expect(align(ground.worldX[0]!)).toBe(align(-5));
    expect(align(ground.worldY[0]!)).toBe(align(-6));

    // And it reaches past every edge, so a tilted ground plane has world to
    // stand on wherever the camera looks.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < ground.count; i++) {
      minX = Math.min(minX, ground.worldX[i]!);
      minY = Math.min(minY, ground.worldY[i]!);
      maxX = Math.max(maxX, ground.worldX[i]! + 8);
      maxY = Math.max(maxY, ground.worldY[i]! + 8);
    }
    expect(minX).toBeLessThan(-32);
    expect(minY).toBeLessThan(-32);
    expect(maxX).toBeGreaterThan(240 + 32);
    expect(maxY).toBeGreaterThan(160 + 32);
  });

  it('reads object sizes, flips and priority', async () => {
    const core = await loadGbaCore(PROBE);
    core.runFrames(SETTLE_FRAMES);
    const sprites = core.scene().sprites;

    // Three objects; the other 125 are switched off and must not appear.
    expect(sprites.count).toBe(3);
    expect([...sprites.width.slice(0, 3)]).toEqual([8, 16, 32]);
    expect([...sprites.height.slice(0, 3)]).toEqual([8, 16, 16]);
    // Only the middle one is mirrored.
    expect([...sprites.flip.slice(0, 3)]).toEqual([0, 1, 0]);
    // Only the last sits behind the background.
    expect([...sprites.behindBg.slice(0, 3)]).toEqual([0, 0, 1]);
    // Objects are mapped one-dimensionally, so a row steps the object's own
    // width in tiles rather than the full 32-tile grid.
    expect([...sprites.tileStride.slice(0, 3)]).toEqual([1, 2, 4]);
  });

  it('reports a mode it cannot take apart rather than guessing', async () => {
    // The far-cartridge probe runs in mode 3, a plain bitmap: no tile grid, so
    // nothing to give height to. The player falls back to the flat renderer.
    const core = await loadGbaCore('tests/roms/gba-farcart-probe.gba');
    core.runFrames(SETTLE_FRAMES);
    core.scene();

    expect(core.sceneSupported()).toBe(false);
  });
});
