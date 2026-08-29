/**
 * The world memory: what it keeps, and — the part that matters — when it lets
 * go.
 *
 * The scenes here are built by hand rather than driven from a ROM. Forgetting
 * has to happen on a map change, a warp and a new tileset, and no test ROM
 * offers those on demand; a made-up world does.
 */

import { describe, expect, it } from 'vitest';
import { WorldMemory } from '../../src/render/worldMemory';
import { makeCells, makeSprites } from '../../src/render/ppu/scene';
import type { DepthScene, SceneGeometry } from '../../src/render/ppu/scene';

const GEOMETRY: SceneGeometry = {
  screenWidth: 160,
  screenHeight: 144,
  atlasTilesPerRow: 16,
  atlasWidth: 128,
  atlasHeight: 384,
  paletteSize: 4,
  paletteCount: 8,
  maxTiles: 768,
};

const SCREEN_COLS = 20;
const SCREEN_ROWS = 18;
const FINGERPRINT_LENGTH = 768;

/**
 * A frame of a scrolling world.
 *
 * `tileAt` decides what stands at a world position, so a test can change the
 * world under the memory's feet the way walking into a building does.
 */
function frameAt(
  scrollX: number,
  scrollY: number,
  tileAt: (worldTileX: number, worldTileY: number) => number,
  fingerprint = 1,
  /** How far past the screen the console's own map reaches, in tiles. */
  margin = 0,
): { scene: DepthScene; layer: DepthScene['ground'][number] } {
  const cells = makeCells(64 * 64);
  const firstCol = Math.floor(scrollX / 8) - margin;
  const firstRow = Math.floor(scrollY / 8) - margin;

  let count = 0;
  for (let row = 0; row <= SCREEN_ROWS + margin * 2; row++) {
    for (let column = 0; column <= SCREEN_COLS + margin * 2; column++) {
      const tileX = firstCol + column;
      const tileY = firstRow + row;
      cells.mapX[count] = tileX;
      cells.mapY[count] = tileY;
      cells.worldX[count] = tileX * 8 - scrollX;
      cells.worldY[count] = tileY * 8 - scrollY;
      cells.tile[count] = tileAt(tileX, tileY);
      cells.palette[count] = 0;
      cells.flip[count] = 0;
      count++;
    }
  }
  cells.count = count;

  const layer = {
    cells,
    priority: 3,
    scrollX: ((scrollX % 256) + 256) % 256,
    scrollY: ((scrollY % 256) + 256) % 256,
    mapWidth: 256,
    mapHeight: 256,
  };

  const scene: DepthScene = {
    geometry: GEOMETRY,
    displayOn: true,
    ground: [layer],
    hud: [],
    sprites: makeSprites(40),
    tileAtlas: new Uint8Array(GEOMETRY.atlasWidth * GEOMETRY.atlasHeight),
    tileSideIndex: new Uint8Array(FINGERPRINT_LENGTH).fill(fingerprint),
    bgPalettes: new Uint32Array(32),
    objPalettes: new Uint32Array(32),
    scrollXByLine: new Int32Array(144),
    scrollYByLine: new Int32Array(144),
    scrollX: layer.scrollX,
    scrollY: layer.scrollY,
  };
  return { scene, layer };
}

/** A world where every position holds a tile of its own. */
const distinctWorld = (x: number, y: number) => 1 + (((x * 7 + y * 13) % 200) + 200) % 200;

/** Walks the memory forward one pixel at a time. */
function walk(
  memory: WorldMemory,
  pixels: number,
  tileAt: (x: number, y: number) => number,
  fingerprint = 1,
  startAt = 0,
): number {
  let clears = 0;
  for (let i = 0; i <= pixels; i++) {
    const { scene, layer } = frameAt(startAt + i, 0, tileAt, fingerprint);
    memory.expand(0, layer, scene);
    if (memory.forgot) clears++;
  }
  return clears;
}

describe('WorldMemory', () => {
  it('keeps what has been walked past, well beyond one screen', () => {
    const memory = new WorldMemory(FINGERPRINT_LENGTH);
    const oneScreen = SCREEN_COLS * SCREEN_ROWS;

    const clears = walk(memory, 400, distinctWorld);

    expect(clears, 'nothing here should look like a new area').toBe(0);
    // 400 pixels is fifty tiles of new ground on top of the first screen.
    expect(memory.rememberedCells()).toBeGreaterThan(oneScreen * 2);
  });

  /*
   * A regression: the packed cell sets its top bit, and JavaScript's bitwise
   * operators return that as a negative number while the buffer reads back
   * unsigned. The two then never compared equal, every frame looked like a
   * different world, and the memory cleared itself sixty times a second — so
   * it held exactly one screen, for ever.
   */
  it('recognises its own recordings again', () => {
    const memory = new WorldMemory(FINGERPRINT_LENGTH);
    walk(memory, 200, distinctWorld);
    const after = memory.rememberedCells();

    // Standing still adds nothing and must take nothing away either.
    const clears = walk(memory, 30, distinctWorld, 1, 200);
    expect(clears).toBe(0);
    expect(memory.rememberedCells()).toBeGreaterThanOrEqual(after);
  });

  it('forgets when the tile art is replaced', () => {
    const memory = new WorldMemory(FINGERPRINT_LENGTH);
    walk(memory, 200, distinctWorld);
    expect(memory.rememberedCells()).toBeGreaterThan(SCREEN_COLS * SCREEN_ROWS);

    // A new area rewrites the tiles: the same numbers now draw something else.
    const { scene, layer } = frameAt(200, 0, distinctWorld, 9);
    memory.expand(0, layer, scene);

    expect(memory.forgot).toBe(true);
    // Only what this frame showed survives.
    expect(memory.rememberedCells()).toBeLessThanOrEqual((SCREEN_COLS + 1) * (SCREEN_ROWS + 1));
  });

  it('forgets on a jump too large to be walking', () => {
    const memory = new WorldMemory(FINGERPRINT_LENGTH);
    walk(memory, 200, distinctWorld);

    // A warp: the view moves half a screen in a single frame.
    const { scene, layer } = frameAt(200 + 120, 0, distinctWorld);
    memory.expand(0, layer, scene);

    expect(memory.forgot).toBe(true);
  });

  it('forgets a different map drawn with the same tiles', () => {
    const memory = new WorldMemory(FINGERPRINT_LENGTH);
    walk(memory, 200, distinctWorld);

    // Same tileset, same position, different building: this is the case no
    // other signal catches, so the contents themselves have to be compared.
    const otherWorld = (x: number, y: number) => 1 + (((x * 3 + y * 5 + 77) % 200) + 200) % 200;
    const { scene, layer } = frameAt(200, 0, otherWorld);
    memory.expand(0, layer, scene);

    expect(memory.forgot).toBe(true);
  });

  /*
   * A console writes the next row of map just before it scrolls into view, so
   * a narrow band outside the picture is already correct. How narrow is
   * measured rather than assumed: two tiles held in every one of nine hundred
   * cells checked against what later appeared, and beyond that there was no
   * evidence, so beyond that nothing is taken.
   */
  it('takes the narrow band the console has already written, and no more', () => {
    const memory = new WorldMemory(FINGERPRINT_LENGTH);

    // A single frame whose map reaches eight tiles past the screen.
    const { scene, layer } = frameAt(0, 0, distinctWorld, 1, 8);
    memory.expand(0, layer, scene);

    // Two tiles of it are kept beyond the screen on every side, not eight.
    const kept = memory.rememberedCells();
    const screen = (SCREEN_COLS + 1) * (SCREEN_ROWS + 1);
    const withLookahead = (SCREEN_COLS + 1 + 4) * (SCREEN_ROWS + 1 + 4);
    const withEverything = (SCREEN_COLS + 1 + 16) * (SCREEN_ROWS + 1 + 16);

    expect(kept).toBeGreaterThan(screen);
    expect(kept).toBeLessThanOrEqual(withLookahead);
    expect(kept).toBeLessThan(withEverything);
  });

  it('is not upset by a few tiles changing, as a door or a sign would', () => {
    const memory = new WorldMemory(FINGERPRINT_LENGTH);
    walk(memory, 200, distinctWorld);
    const before = memory.rememberedCells();

    // One tile in ten becomes something else — an animation, an opened door.
    const nudged = (x: number, y: number) =>
      (x + y) % 10 === 0 ? 500 : distinctWorld(x, y);
    const { scene, layer } = frameAt(200, 0, nudged);
    memory.expand(0, layer, scene);

    expect(memory.forgot).toBe(false);
    expect(memory.rememberedCells()).toBeGreaterThanOrEqual(before);
  });
});
