/**
 * Flattens a decoded Game Boy Advance scene back into a picture.
 *
 * The point is the comparison: if the decoder read the hardware correctly, the
 * layers it hands out must go back together into the exact image mGBA drew.
 * Anything the decoder gets wrong — a map block in the wrong place, a palette
 * off by a bank, a tile addressed at the wrong depth — shows up as differing
 * pixels rather than as a picture that merely looks a bit odd.
 *
 * It is a checking tool, not a renderer: it composes in the obvious order and
 * ignores the effects the depth renderer does not model either (blending,
 * windows, mosaic), so frames using those are not comparable and the tests say
 * so rather than pretending otherwise.
 */

import type { DepthScene } from '../../src/render/ppu/scene';

const WIDTH = 240;
const HEIGHT = 160;

function tilePixel(scene: DepthScene, tile: number, x: number, y: number, flip: number): number {
  const { atlasTilesPerRow, atlasWidth } = scene.geometry;
  const tx = flip & 1 ? 7 - x : x;
  const ty = flip & 2 ? 7 - y : y;
  const col = (tile % atlasTilesPerRow) * 8 + tx;
  const row = Math.floor(tile / atlasTilesPerRow) * 8 + ty;
  return scene.tileAtlas[row * atlasWidth + col] ?? 0;
}

/** Colour of one layer at a screen position, or null where it draws nothing. */
function layerColourAt(
  scene: DepthScene,
  cells: DepthScene['ground'][number]['cells'],
  x: number,
  y: number,
): number | null {
  for (let i = 0; i < cells.count; i++) {
    const cx = cells.worldX[i]!;
    const cy = cells.worldY[i]!;
    if (x < cx || x >= cx + 8 || y < cy || y >= cy + 8) continue;
    const index = tilePixel(scene, cells.tile[i]!, x - cx, y - cy, cells.flip[i]!);
    // Colour zero is transparent in every background layer.
    if (index === 0) return null;
    return scene.bgPalettes[cells.palette[i]! * 16 + index] ?? 0;
  }
  return null;
}

export function compositeGbaScene(scene: DepthScene): Uint32Array {
  const out = new Uint32Array(WIDTH * HEIGHT);
  const backdrop = scene.bgPalettes[0] ?? 0;

  // Back to front: ground layers, then the HUD, with objects interleaved by
  // their own priority flag.
  const layers = [...scene.ground, ...scene.hud];
  const sprites = scene.sprites;

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      let colour = backdrop;
      let painted = false;
      for (const layer of layers) {
        const value = layerColourAt(scene, layer.cells, x, y);
        if (value !== null) {
          colour = value;
          painted = true;
        }
      }

      // Objects last. Lowest object number wins where two overlap, which is
      // the hardware's rule.
      for (let i = 0; i < sprites.count; i++) {
        const sx = sprites.x[i]!;
        const sy = sprites.y[i]!;
        const w = sprites.width[i]!;
        const h = sprites.height[i]!;
        if (x < sx || x >= sx + w || y < sy || y >= sy + h) continue;
        if (sprites.behindBg[i] && painted) continue;

        let px = x - sx;
        let py = y - sy;
        const flip = sprites.flip[i]!;
        if (flip & 1) px = w - 1 - px;
        if (flip & 2) py = h - 1 - py;

        const tile =
          sprites.tile[i]! + Math.floor(py / 8) * sprites.tileStride[i]! + Math.floor(px / 8);
        const index = tilePixel(scene, tile, px & 7, py & 7, 0);
        if (index === 0) continue;
        colour = scene.objPalettes[sprites.palette[i]! * 16 + index] ?? 0;
        break;
      }

      out[y * WIDTH + x] = colour;
    }
  }
  return out;
}

/**
 * How many pixels differ between the rebuilt picture and the emulator's.
 *
 * Only the colour channels are compared. mGBA leaves its own value in the top
 * byte rather than a full alpha — 0xF8 and 0xFC turn up there — and nothing
 * downstream reads it, so a mismatch there would be noise rather than a defect.
 */
export function countDifferences(a: Uint32Array, b: Uint32Array): number {
  let differences = 0;
  for (let i = 0; i < a.length; i++) {
    if ((a[i]! & 0xffffff) !== (b[i]! & 0xffffff)) differences++;
  }
  return differences;
}
