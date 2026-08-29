/**
 * Rebuilds the Game Boy Advance's layers from raw VRAM, OAM and registers.
 *
 * The same job the Game Boy decoder does, against considerably more hardware:
 * four background layers with their own maps, scroll, size and priority;
 * sixteen-colour and 256-colour tiles side by side; objects from 8x8 up to
 * 64x64 in two different memory layouts.
 *
 * What is covered is what a tile-based game uses: mode 0, where all four
 * layers are plain scrolling tile maps. Modes 1 and 2 rotate and scale their
 * layers and modes 3 to 5 are bitmaps — none of which is a grid of identifiable
 * tiles, so there is nothing for the height model to learn about and nothing to
 * extrude. Those modes report themselves unsupported and the player falls back
 * to the flat renderer rather than being shown something wrong.
 */

import { GBA_PPU_OFFSETS, GbaPpu, GbaScanline } from '../../core/protocol';
import {
  makeCells,
  makeSprites,
  type CellArrays,
  type DepthScene,
  type SceneGeometry,
  type SceneLayer,
} from './scene';

const SCREEN_WIDTH = 240;
const SCREEN_HEIGHT = 160;

/**
 * Tiles the atlas holds.
 *
 * Background character data can occupy the first 64 KiB of video memory and
 * object data the 32 KiB above it; at 32 bytes for a sixteen-colour tile that
 * is 2048 plus 1024. Object tiles keep their own numbering on the hardware, so
 * they are placed after the background ones and offset when referenced.
 */
const BG_TILES = 2048;
const OBJ_TILES = 1024;
const MAX_TILES = BG_TILES + OBJ_TILES;
const OBJ_TILE_BASE = BG_TILES;
const ATLAS_TILES_PER_ROW = 32;

/** Object character data starts here, whatever the background uses. */
const OBJ_VRAM_BASE = 0x10000;

export const GBA_GEOMETRY: SceneGeometry = {
  screenWidth: SCREEN_WIDTH,
  screenHeight: SCREEN_HEIGHT,
  atlasTilesPerRow: ATLAS_TILES_PER_ROW,
  atlasWidth: ATLAS_TILES_PER_ROW * 8,
  atlasHeight: (MAX_TILES / ATLAS_TILES_PER_ROW) * 8,
  paletteSize: 16,
  paletteCount: 16,
  maxTiles: MAX_TILES,
};

/*
 * How much world is decoded around the visible screen, per layer.
 *
 * The same reasoning as on the Game Boy: the depth view carries on past every
 * edge of the console's rectangle, furthest at the top, so the ground has to
 * be decoded well beyond what the flat picture shows. Maps wrap, so the margin
 * can never address anything that is not there.
 */
const MARGIN_LEFT = 8;
const MARGIN_RIGHT = 8;
const MARGIN_TOP = 18;
const MARGIN_BOTTOM = 16;

const VIEW_COLS = 30 + MARGIN_LEFT + MARGIN_RIGHT;
const VIEW_ROWS = 20 + MARGIN_TOP + MARGIN_BOTTOM;

const OAM_ENTRIES = 128;

const DISPCNT = {
  MODE: 0x0007,
  /** Objects are addressed as one run of tiles rather than as a 32-tile grid. */
  OBJ_1D_MAP: 0x0040,
  FORCE_BLANK: 0x0080,
  BG_ENABLE: [0x0100, 0x0200, 0x0400, 0x0800],
  OBJ_ENABLE: 0x1000,
} as const;

const BGCNT = {
  PRIORITY: 0x0003,
  CHAR_BASE: 0x000c,
  MOSAIC: 0x0040,
  /** Set for 256-colour tiles, clear for sixteen-colour ones. */
  FULL_COLOUR: 0x0080,
  MAP_BASE: 0x1f00,
  SIZE: 0xc000,
} as const;

/** Object sizes, indexed by the shape and size fields of the attributes. */
const OBJ_SIZES: Array<Array<[number, number]>> = [
  [
    [8, 8],
    [16, 16],
    [32, 32],
    [64, 64],
  ],
  [
    [16, 8],
    [32, 8],
    [32, 16],
    [64, 32],
  ],
  [
    [8, 16],
    [8, 32],
    [16, 32],
    [32, 64],
  ],
];

/** Map size field to the map's width and height in tiles. */
const MAP_SIZES: Array<[number, number]> = [
  [32, 32],
  [64, 32],
  [32, 64],
  [64, 64],
];

/**
 * How still a layer's scroll has to be across a frame to count as pinned.
 *
 * A status bar or a text box is held at a fixed scroll while the map moves
 * under it, which is exactly what separates glass from world. Zero would be too
 * strict: a layer can be nudged by a pixel for a shake effect and still be
 * furniture.
 */
const HUD_SCROLL_TOLERANCE = 1;

export class GbaPpuDecoder {
  readonly geometry = GBA_GEOMETRY;

  private readonly layerCells = [
    makeCells(VIEW_COLS * VIEW_ROWS),
    makeCells(VIEW_COLS * VIEW_ROWS),
    makeCells(VIEW_COLS * VIEW_ROWS),
    makeCells(VIEW_COLS * VIEW_ROWS),
  ];

  /**
   * Previous video memory, so only tiles whose bytes changed are decoded again.
   *
   * Decoding all three thousand tiles every frame is roughly two hundred
   * thousand writes; comparing them first is a fraction of that, and between
   * two frames of a game almost nothing changes.
   */
  private readonly previousVram = new Uint32Array(GbaPpu.VRAM_BYTES / 4);
  private vramSeen = false;

  private readonly scene: DepthScene = {
    geometry: GBA_GEOMETRY,
    displayOn: false,
    ground: [],
    hud: [],
    sprites: makeSprites(OAM_ENTRIES),
    tileAtlas: new Uint8Array(GBA_GEOMETRY.atlasWidth * GBA_GEOMETRY.atlasHeight),
    tileSideIndex: new Uint8Array(MAX_TILES),
    bgPalettes: new Uint32Array(16 * 16),
    objPalettes: new Uint32Array(16 * 16),
    scrollXByLine: new Int32Array(SCREEN_HEIGHT),
    scrollYByLine: new Int32Array(SCREEN_HEIGHT),
    scrollX: 0,
    scrollY: 0,
  };

  /** True when the last decoded frame used a mode this decoder understands. */
  supported = true;

  decode(block: Uint8Array): DepthScene {
    const vram = block.subarray(
      GBA_PPU_OFFSETS.vram,
      GBA_PPU_OFFSETS.vram + GbaPpu.VRAM_BYTES,
    );
    const oam = block.subarray(GBA_PPU_OFFSETS.oam, GBA_PPU_OFFSETS.oam + GbaPpu.OAM_BYTES);
    const palette = new Uint16Array(
      block.buffer,
      block.byteOffset + GBA_PPU_OFFSETS.palette,
      GbaPpu.PALETTE_BYTES / 2,
    );
    const lines = new Uint16Array(
      block.buffer,
      block.byteOffset + GBA_PPU_OFFSETS.scanlines,
      SCREEN_HEIGHT * GbaScanline.WORDS,
    );

    const scene = this.scene;
    scene.ground.length = 0;
    scene.hud.length = 0;

    const dispcnt = lines[GbaScanline.DISPCNT] ?? 0;
    const mode = dispcnt & DISPCNT.MODE;
    this.supported = mode === 0;
    scene.displayOn = (dispcnt & DISPCNT.FORCE_BLANK) === 0 && this.supported;
    if (!scene.displayOn) {
      scene.sprites.count = 0;
      return scene;
    }

    decodePalettes(palette, scene);
    this.decodeTiles(vram);

    // Sort the enabled layers into world and glass, then hand them over back
    // to front. Equal priorities are broken by layer number, which is how the
    // hardware resolves them too.
    const layers: Array<{ layer: SceneLayer; pinned: boolean; index: number }> = [];
    for (let bg = 0; bg < 4; bg++) {
      if ((dispcnt & DISPCNT.BG_ENABLE[bg]!) === 0) continue;
      const control = lines[GbaScanline.BG_CONTROL + bg] ?? 0;
      const cells = this.layerCells[bg]!;

      const scrollX = lines[GbaScanline.SCROLL + bg * 2] ?? 0;
      const scrollY = lines[GbaScanline.SCROLL + bg * 2 + 1] ?? 0;
      decodeLayer(vram, control, scrollX, scrollY, cells);
      if (cells.count === 0) continue;

      layers.push({
        layer: { cells, priority: control & BGCNT.PRIORITY },
        pinned: layerIsPinned(lines, bg),
        index: bg,
      });
    }

    layers.sort((a, b) => b.layer.priority - a.layer.priority || b.index - a.index);
    for (const entry of layers) {
      (entry.pinned ? scene.hud : scene.ground).push(entry.layer);
    }

    // Parallax follows whichever world layer sits furthest back, since that is
    // the one the ground is built from.
    const world = layers.find((entry) => !entry.pinned);
    const bg = world ? world.index : 0;
    for (let line = 0; line < SCREEN_HEIGHT; line++) {
      const base = line * GbaScanline.WORDS;
      scene.scrollXByLine[line] = lines[base + GbaScanline.SCROLL + bg * 2] ?? 0;
      scene.scrollYByLine[line] = lines[base + GbaScanline.SCROLL + bg * 2 + 1] ?? 0;
    }
    scene.scrollX = scene.scrollXByLine[0]!;
    scene.scrollY = scene.scrollYByLine[0]!;

    decodeSprites(oam, dispcnt, scene.sprites);
    return scene;
  }

  /**
   * Expands changed tiles into the atlas, one byte of palette index a pixel.
   *
   * Both tile depths land in the same atlas: a 256-colour tile is stored as its
   * low nibble with palette zero, which is how the hardware reads it too.
   */
  private decodeTiles(vram: Uint8Array): void {
    const words = new Uint32Array(vram.buffer, vram.byteOffset, GbaPpu.VRAM_BYTES / 4);
    const atlas = this.scene.tileAtlas;
    const atlasWidth = GBA_GEOMETRY.atlasWidth;
    const histogram = new Uint16Array(16);
    const first = !this.vramSeen;
    this.vramSeen = true;

    for (let tile = 0; tile < MAX_TILES; tile++) {
      const address =
        tile < OBJ_TILE_BASE ? tile * 32 : OBJ_VRAM_BASE + (tile - OBJ_TILE_BASE) * 32;
      const word = address >> 2;
      if (word + 8 > words.length) break;

      let changed = first;
      for (let i = 0; i < 8 && !changed; i++) {
        if (words[word + i] !== this.previousVram[word + i]) changed = true;
      }
      if (!changed) continue;
      for (let i = 0; i < 8; i++) this.previousVram[word + i] = words[word + i]!;

      const originX = (tile % ATLAS_TILES_PER_ROW) * 8;
      const originY = Math.floor(tile / ATLAS_TILES_PER_ROW) * 8;
      histogram.fill(0);
      for (let row = 0; row < 8; row++) {
        let target = (originY + row) * atlasWidth + originX;
        const source = address + row * 4;
        for (let pair = 0; pair < 4; pair++) {
          const byte = vram[source + pair] ?? 0;
          const low = byte & 0x0f;
          const high = byte >> 4;
          atlas[target++] = low;
          atlas[target++] = high;
          histogram[low]!++;
          histogram[high]!++;
        }
      }
      this.scene.tileSideIndex[tile] = dominantIndex(histogram);
    }
  }
}

/**
 * The colour a tile uses most, which is what the sides of a raised block are
 * painted with.
 *
 * Colour zero is skipped where the tile has anything else: it is transparent,
 * and a block whose sides are transparent looks like a hole.
 */
function dominantIndex(histogram: Uint16Array): number {
  let best = 0;
  let bestCount = -1;
  for (let index = 1; index < histogram.length; index++) {
    if (histogram[index]! > bestCount) {
      bestCount = histogram[index]!;
      best = index;
    }
  }
  return bestCount > 0 ? best : 0;
}

/** Whether a layer's scroll held still across the whole frame. */
function layerIsPinned(lines: Uint16Array, bg: number): boolean {
  const slot = GbaScanline.SCROLL + bg * 2;
  const firstX = lines[slot] ?? 0;
  const firstY = lines[slot + 1] ?? 0;
  for (let line = 1; line < SCREEN_HEIGHT; line++) {
    const base = line * GbaScanline.WORDS;
    if (Math.abs((lines[base + slot] ?? 0) - firstX) > HUD_SCROLL_TOLERANCE) return false;
    if (Math.abs((lines[base + slot + 1] ?? 0) - firstY) > HUD_SCROLL_TOLERANCE) return false;
  }
  // A layer that never scrolls at all and sits at the origin is furniture: a
  // text box, a status bar, the letterbox of a cut scene.
  return firstX === 0 && firstY === 0;
}

function decodePalettes(palette: Uint16Array, scene: DepthScene): void {
  for (let i = 0; i < 256; i++) {
    scene.bgPalettes[i] = bgr555ToRgba(palette[i] ?? 0);
    scene.objPalettes[i] = bgr555ToRgba(palette[256 + i] ?? 0);
  }
}

/** The hardware stores five bits a channel, blue first. */
function bgr555ToRgba(value: number): number {
  const r = value & 0x1f;
  const g = (value >> 5) & 0x1f;
  const b = (value >> 10) & 0x1f;
  const expand = (channel: number) => (channel << 3) | (channel >> 2);
  return (0xff << 24) | (expand(b) << 16) | (expand(g) << 8) | expand(r);
}

/** Reads one text-mode layer's visible cells. */
function decodeLayer(
  vram: Uint8Array,
  control: number,
  scrollX: number,
  scrollY: number,
  cells: CellArrays,
): void {
  const mapBase = ((control & BGCNT.MAP_BASE) >> 8) * 0x800;
  const charBase = ((control & BGCNT.CHAR_BASE) >> 2) * 0x4000;
  const fullColour = (control & BGCNT.FULL_COLOUR) !== 0;
  const [mapWidth, mapHeight] = MAP_SIZES[(control & BGCNT.SIZE) >> 14]!;

  // A 256-colour tile is twice the size, so a tile number addresses half as
  // far; expressing it as a tile step keeps the atlas indexing uniform.
  const tileStep = fullColour ? 2 : 1;
  const charTile = charBase / 32;

  const firstColumn = Math.floor(scrollX / 8) - MARGIN_LEFT;
  const firstRow = Math.floor(scrollY / 8) - MARGIN_TOP;
  const offsetX = scrollX - Math.floor(scrollX / 8) * 8;
  const offsetY = scrollY - Math.floor(scrollY / 8) * 8;

  let count = 0;
  for (let row = 0; row < VIEW_ROWS; row++) {
    for (let column = 0; column < VIEW_COLS; column++) {
      const mapX = (((firstColumn + column) % mapWidth) + mapWidth) % mapWidth;
      const mapY = (((firstRow + row) % mapHeight) + mapHeight) % mapHeight;
      const entry = readMapEntry(vram, mapBase, mapX, mapY, mapWidth);
      if (entry === null) continue;

      const tile = charTile + (entry & 0x03ff) * tileStep;
      if (tile >= MAX_TILES) continue;

      cells.mapX[count] = mapX;
      cells.mapY[count] = mapY;
      cells.worldX[count] = (column - MARGIN_LEFT) * 8 - offsetX;
      cells.worldY[count] = (row - MARGIN_TOP) * 8 - offsetY;
      cells.tile[count] = tile;
      // A 256-colour tile indexes the whole bank, which is palette zero here.
      cells.palette[count] = fullColour ? 0 : (entry >> 12) & 0x0f;
      cells.flip[count] = ((entry >> 10) & 1) | (((entry >> 11) & 1) << 1);
      count++;
    }
  }
  cells.count = count;
}

/**
 * One entry of a text-mode map.
 *
 * A map wider or taller than 32 tiles is stored as separate 32x32 blocks of
 * 2 KiB, laid out left to right then top to bottom, rather than as one grid.
 */
function readMapEntry(
  vram: Uint8Array,
  mapBase: number,
  mapX: number,
  mapY: number,
  mapWidth: number,
): number | null {
  const block = (mapY >= 32 ? (mapWidth > 32 ? 2 : 1) : 0) + (mapX >= 32 ? 1 : 0);
  const address =
    mapBase + block * 0x800 + ((mapY & 31) * 32 + (mapX & 31)) * 2;
  if (address + 1 >= vram.length) return null;
  return (vram[address] ?? 0) | ((vram[address + 1] ?? 0) << 8);
}

function decodeSprites(
  oam: Uint8Array,
  dispcnt: number,
  sprites: ReturnType<typeof makeSprites>,
): void {
  if ((dispcnt & DISPCNT.OBJ_ENABLE) === 0) {
    sprites.count = 0;
    return;
  }
  const oneDimensional = (dispcnt & DISPCNT.OBJ_1D_MAP) !== 0;

  let count = 0;
  for (let entry = 0; entry < OAM_ENTRIES; entry++) {
    const base = entry * 8;
    const attr0 = (oam[base] ?? 0) | ((oam[base + 1] ?? 0) << 8);
    const attr1 = (oam[base + 2] ?? 0) | ((oam[base + 3] ?? 0) << 8);
    const attr2 = (oam[base + 4] ?? 0) | ((oam[base + 5] ?? 0) << 8);

    // Bit 8 is the affine flag; with it clear, bit 9 disables the object.
    const affine = (attr0 & 0x0100) !== 0;
    if (!affine && (attr0 & 0x0200) !== 0) continue;
    // The object window is a mask, not something drawn.
    if (((attr0 >> 10) & 3) === 2) continue;

    const shape = (attr0 >> 14) & 3;
    const size = (attr1 >> 14) & 3;
    const dimensions = OBJ_SIZES[shape]?.[size];
    if (!dimensions) continue;
    const [width, height] = dimensions;

    // Both coordinates wrap, which is how an object leaves the screen at the
    // top or the left.
    let y = attr0 & 0xff;
    if (y >= SCREEN_HEIGHT) y -= 256;
    let x = attr1 & 0x1ff;
    if (x >= SCREEN_WIDTH) x -= 512;
    if (y <= -height || y >= SCREEN_HEIGHT || x <= -width || x >= SCREEN_WIDTH) continue;

    const fullColour = (attr0 & 0x2000) !== 0;
    let tile = attr2 & 0x03ff;
    // 256-colour objects address in pairs of tiles.
    if (fullColour) tile &= ~1;

    sprites.x[count] = x;
    sprites.y[count] = y;
    sprites.tile[count] = OBJ_TILE_BASE + tile;
    sprites.palette[count] = fullColour ? 0 : (attr2 >> 12) & 0x0f;
    // An affine object carries transformation indices where the flip bits are.
    sprites.flip[count] = affine
      ? 0
      : ((attr1 >> 12) & 1) | (((attr1 >> 13) & 1) << 1);
    sprites.width[count] = width;
    sprites.height[count] = height;
    sprites.tileStride[count] = oneDimensional ? (width / 8) * (fullColour ? 2 : 1) : 32;
    // Priority 3 puts an object behind every background layer that has
    // anything to draw, which is what the height model reads as "stands
    // behind scenery".
    sprites.behindBg[count] = ((attr2 >> 10) & 3) === 3 ? 1 : 0;
    count++;
  }
  sprites.count = count;
}
