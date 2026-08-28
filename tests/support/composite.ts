/**
 * Flat compositor used as a test oracle.
 *
 * Takes the layers the decoder produced and flattens them the way the hardware
 * does. If the decoder read VRAM, OAM, the maps and the palettes correctly, the
 * result must match the emulator's own frame buffer exactly — which is what
 * makes this a real check on the decoder rather than a restatement of it.
 *
 * Test-only: the app never flattens the layers, it renders them in 3D.
 */

import type { GbScene } from '../../src/render/ppu/decode';
import { ATLAS_TILES_PER_ROW, ATLAS_WIDTH } from '../../src/render/ppu/decode';
import { GB_SCREEN_HEIGHT, GB_SCREEN_WIDTH } from '../../src/core/protocol';

/** Objects the hardware can draw on one scanline. */
const SPRITES_PER_LINE = 10;

/** Reads one pixel of a tile from the atlas, honouring flips. */
function tilePixel(scene: GbScene, tile: number, x: number, y: number, flip: number): number {
  const px = flip & 1 ? 7 - x : x;
  const py = flip & 2 ? 7 - y : y;
  const col = (tile % ATLAS_TILES_PER_ROW) * 8 + px;
  const row = Math.floor(tile / ATLAS_TILES_PER_ROW) * 8 + py;
  return scene.tileAtlas[row * ATLAS_WIDTH + col] ?? 0;
}

/** Colour index of the background/window at a screen position, or 0. */
function backgroundIndexAt(scene: GbScene, x: number, y: number): { index: number; palette: number } {
  if (!scene.bgEnabled) return { index: 0, palette: 0 };

  // The window, where visible, replaces the background entirely.
  if (scene.windowVisible && y >= scene.windowY && x >= scene.windowX) {
    const cells = scene.window;
    for (let i = 0; i < cells.count; i++) {
      const cx = cells.worldX[i]!;
      const cy = cells.worldY[i]!;
      if (x >= cx && x < cx + 8 && y >= cy && y < cy + 8) {
        return {
          index: tilePixel(scene, cells.tile[i]!, x - cx, y - cy, cells.flip[i]!),
          palette: cells.palette[i]!,
        };
      }
    }
  }

  const cells = scene.ground;
  for (let i = 0; i < cells.count; i++) {
    const cx = cells.worldX[i]!;
    const cy = cells.worldY[i]!;
    if (x >= cx && x < cx + 8 && y >= cy && y < cy + 8) {
      return {
        index: tilePixel(scene, cells.tile[i]!, x - cx, y - cy, cells.flip[i]!),
        palette: cells.palette[i]!,
      };
    }
  }

  return { index: 0, palette: 0 };
}

export function compositeScene(scene: GbScene): Uint32Array {
  const out = new Uint32Array(GB_SCREEN_WIDTH * GB_SCREEN_HEIGHT);
  const sprites = scene.sprites;

  for (let y = 0; y < GB_SCREEN_HEIGHT; y++) {
    // Hardware scans OAM in order and keeps the first ten objects on this line.
    const onLine: number[] = [];
    for (let i = 0; i < sprites.count && onLine.length < SPRITES_PER_LINE; i++) {
      const top = sprites.y[i]!;
      if (y >= top && y < top + sprites.height[i]!) onLine.push(i);
    }
    // On DMG the leftmost object wins, ties broken by OAM order.
    onLine.sort((a, b) => sprites.x[a]! - sprites.x[b]! || a - b);

    for (let x = 0; x < GB_SCREEN_WIDTH; x++) {
      const bg = backgroundIndexAt(scene, x, y);
      let colour = scene.bgPalettes[bg.palette * 4 + bg.index] ?? 0;

      for (const i of onLine) {
        const left = sprites.x[i]!;
        if (x < left || x >= left + 8) continue;

        const height = sprites.height[i]!;
        const flip = sprites.flip[i]!;
        let localY = y - sprites.y[i]!;
        if (flip & 2) localY = height - 1 - localY;

        // A tall object is two stacked tiles; the flip above already picked
        // which half we are in.
        const tile = sprites.tile[i]! + (localY >= 8 ? 1 : 0);
        const index = tilePixel(scene, tile, x - left, localY & 7, flip & 1);
        if (index === 0) continue; // colour 0 is transparent for objects
        if (sprites.behindBg[i] && bg.index !== 0) break;

        colour = scene.objPalettes[sprites.palette[i]! * 4 + index] ?? 0;
        break; // first (highest priority) opaque object wins
      }

      out[y * GB_SCREEN_WIDTH + x] = colour;
    }
  }

  return out;
}
