/**
 * What a decoded frame looks like, whichever console produced it.
 *
 * The depth renderer works from hardware state rather than from the finished
 * picture, and the two consoles that expose enough of it differ in every
 * dimension: the Game Boy has four colours a palette, one background and one
 * window; the Game Boy Advance has sixteen colours, four background layers
 * with their own scroll and priority, and sprites of nine different sizes.
 *
 * Rather than teach the renderer about either, both decoders describe their
 * frame in these terms and hand over the numbers that differ — atlas shape,
 * palette shape, screen size — as data.
 */

/** Per-cell values the renderer turns into instances. */
export interface CellArrays {
  /** Map column and row within the layer's own map. */
  mapX: Int16Array;
  mapY: Int16Array;
  /** World position of the cell's top-left corner, in screen pixels. */
  worldX: Float32Array;
  worldY: Float32Array;
  /** Absolute tile number into the atlas. */
  tile: Uint16Array;
  palette: Uint8Array;
  flip: Uint8Array; // bit 0 = x, bit 1 = y
  count: number;
}

export interface SpriteArrays {
  /** Top-left of the sprite in screen pixels. */
  x: Float32Array;
  y: Float32Array;
  /** First tile; a sprite wider or taller than one tile follows on from it. */
  tile: Uint16Array;
  palette: Uint8Array;
  flip: Uint8Array;
  /** Size in pixels. The Game Boy only varies the height; the GBA both. */
  width: Uint8Array;
  height: Uint8Array;
  /**
   * How many tiles one row of the object's tile block steps.
   *
   * One on the Game Boy, where a tall object is simply two consecutive tiles.
   * On the GBA it is the object's own width in tiles when object memory is
   * mapped one-dimensionally, and the width of the whole tile grid when it is
   * mapped two-dimensionally.
   */
  tileStride: Uint8Array;
  /** Non-zero when the sprite is drawn behind non-zero background pixels. */
  behindBg: Uint8Array;
  count: number;
}

/**
 * One plane of tiles.
 *
 * The Game Boy contributes one of these as ground and at most one as HUD. The
 * GBA contributes up to four, sorted into the two groups by whether they move
 * with the world.
 */
export interface SceneLayer {
  cells: CellArrays;
  /**
   * Hardware drawing priority, 0 in front. Layers are drawn back to front, so
   * this orders the passes.
   */
  priority: number;
  /** This layer's own scroll, in pixels. Layers move at their own rates. */
  scrollX: number;
  scrollY: number;
  /**
   * The size of the layer's map in pixels, which is also the distance its
   * scroll wraps over. The world memory needs it to tell walking forwards from
   * the map wrapping around.
   */
  mapWidth: number;
  mapHeight: number;
}

/** The fixed shape of a console's tiles, palettes and screen. */
export interface SceneGeometry {
  screenWidth: number;
  screenHeight: number;
  /** Tiles across the atlas texture; the shader needs it as a constant. */
  atlasTilesPerRow: number;
  atlasWidth: number;
  atlasHeight: number;
  /** Colours in one palette: 4 on Game Boy, 16 on GBA. */
  paletteSize: number;
  /** Palettes in each of the two banks, background and object. */
  paletteCount: number;
  /** Highest tile number the atlas can hold; sizes the height model. */
  maxTiles: number;
}

export interface DepthScene {
  geometry: SceneGeometry;
  /** False while the display is off; nothing should be drawn. */
  displayOn: boolean;
  /** Layers that move with the world and receive height. Back to front. */
  ground: SceneLayer[];
  /** Layers pinned to the screen — text boxes, status bars. Back to front. */
  hud: SceneLayer[];
  sprites: SpriteArrays;
  /** One byte per pixel: the palette index within that tile's palette. */
  tileAtlas: Uint8Array;
  /**
   * One colour index per tile, for the sides of an extruded block.
   *
   * A console's tile has no side texture — it was drawn to be seen from above.
   * Stretching one of its rows down the side of a block is what produces the
   * smears under doorways and the stripes on fences. A single colour, taken as
   * the one the tile uses most, reads as solid masonry instead.
   *
   * It doubles as a fingerprint of the tile art. When a game loads a new area
   * it rewrites its tiles, and the world memory has to forget what it knew
   * because the same tile number now draws something else; comparing this
   * against the previous frame's is how that is noticed.
   */
  tileSideIndex: Uint8Array;
  /** paletteCount * paletteSize entries, RGBA8888. */
  bgPalettes: Uint32Array;
  objPalettes: Uint32Array;
  /**
   * Scroll of the layer that carries the world, per scanline.
   *
   * Games change scroll mid-frame, which is what makes a status bar hold still
   * while the map moves. The renderer uses it for parallax; the height model
   * uses it to tell a scrolling world from a static screen.
   */
  scrollXByLine: Int32Array;
  scrollYByLine: Int32Array;
  scrollX: number;
  scrollY: number;
}

export function makeCells(capacity: number): CellArrays {
  return {
    mapX: new Int16Array(capacity),
    mapY: new Int16Array(capacity),
    worldX: new Float32Array(capacity),
    worldY: new Float32Array(capacity),
    tile: new Uint16Array(capacity),
    palette: new Uint8Array(capacity),
    flip: new Uint8Array(capacity),
    count: 0,
  };
}

export function makeSprites(capacity: number): SpriteArrays {
  return {
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    tile: new Uint16Array(capacity),
    palette: new Uint8Array(capacity),
    flip: new Uint8Array(capacity),
    width: new Uint8Array(capacity),
    height: new Uint8Array(capacity),
    tileStride: new Uint8Array(capacity).fill(1),
    behindBg: new Uint8Array(capacity),
    count: 0,
  };
}
