/**
 * Rebuilds the PPU's layers from raw VRAM, OAM and registers.
 *
 * The flat renderer only ever sees the finished picture, where background,
 * window and sprites are already flattened into one image. The 2.5D renderer
 * needs them apart, with tile identities intact, so it can stand sprites up and
 * give tiles height. That is what this decoder produces.
 *
 * Everything is written into buffers allocated once and reused, because this
 * runs sixty times a second.
 */

import { PPU_OFFSETS, Ppu, PpuHeader, GB_SCREEN_HEIGHT, GB_SCREEN_WIDTH } from '../../core/protocol';
import {
  makeCells,
  makeSprites,
  type CellArrays,
  type DepthScene,
  type SceneGeometry,
  type SceneLayer,
  type SpriteArrays,
} from './scene';

export type { CellArrays, SpriteArrays } from './scene';

/** The Game Boy's fixed shape, as the renderer needs to know it. */
export const GB_GEOMETRY: SceneGeometry = {
  screenWidth: GB_SCREEN_WIDTH,
  screenHeight: GB_SCREEN_HEIGHT,
  atlasTilesPerRow: 16,
  atlasWidth: 16 * 8,
  atlasHeight: (768 / 16) * 8,
  paletteSize: 4,
  paletteCount: 8,
  maxTiles: 768,
};

/** Tiles addressable across both VRAM banks. */
export const MAX_TILES = 768;
/** Tile atlas geometry: 16 tiles per row. */
export const ATLAS_TILES_PER_ROW = 16;
export const ATLAS_WIDTH = ATLAS_TILES_PER_ROW * 8;
export const ATLAS_HEIGHT = (MAX_TILES / ATLAS_TILES_PER_ROW) * 8;

/*
 * How much world is decoded around the visible screen.
 *
 * The depth view is not confined to the console's rectangle, so the ground has
 * to reach past every edge or it would end in mid-air. But it can only reach
 * as far as the console actually holds: the Game Boy's background map is 32
 * tiles square — 256 by 256 pixels, barely more than one screen — and it
 * wraps. Asking for more than that does not show more world, it shows the same
 * map again, which is why a window wider than the map made houses appear out
 * of nowhere as the player walked.
 *
 * So the window is the whole map and not one tile more, centred on the screen.
 */
export const VIEW_COLS = 32;
export const VIEW_ROWS = 32;

export const MARGIN_LEFT = Math.floor((VIEW_COLS - 20) / 2);
export const MARGIN_TOP = Math.floor((VIEW_ROWS - 18) / 2);

const MAP_TILES = 32;
const OAM_ENTRIES = 40;

/** LCDC bits, per the Pan Docs. */
const LCDC = {
  BG_ENABLE: 0x01,
  OBJ_ENABLE: 0x02,
  OBJ_TALL: 0x04,
  BG_MAP_HIGH: 0x08,
  TILE_DATA_LOW: 0x10,
  WINDOW_ENABLE: 0x20,
  WINDOW_MAP_HIGH: 0x40,
  LCD_ENABLE: 0x80,
} as const;

export class PpuDecoder {
  readonly geometry = GB_GEOMETRY;

  private readonly bg = makeCells(VIEW_COLS * VIEW_ROWS);
  private readonly window = makeCells(VIEW_COLS * VIEW_ROWS);

  private readonly scene: DepthScene = {
    geometry: GB_GEOMETRY,
    displayOn: false,
    // The Game Boy draws its background behind everything and its window in
    // front of everything, so the two groups have one layer each at most.
    ground: [
      { cells: this.bg, priority: 3, scrollX: 0, scrollY: 0, mapWidth: 256, mapHeight: 256 },
    ],
    hud: [],
    sprites: makeSprites(OAM_ENTRIES),
    tileAtlas: new Uint8Array(ATLAS_WIDTH * ATLAS_HEIGHT),
    tileSideIndex: new Uint8Array(GB_GEOMETRY.maxTiles),
    bgPalettes: new Uint32Array(32),
    objPalettes: new Uint32Array(32),
    scrollXByLine: new Int32Array(GB_SCREEN_HEIGHT),
    scrollYByLine: new Int32Array(GB_SCREEN_HEIGHT),
    scrollX: 0,
    scrollY: 0,
  };

  /* The window is pinned to the screen: it neither scrolls nor wraps. */
  private readonly windowLayer: SceneLayer = {
    cells: this.window,
    priority: 0,
    scrollX: 0,
    scrollY: 0,
    mapWidth: 256,
    mapHeight: 256,
  };

  /** Decodes one captured PPU block. The returned scene is reused each call. */
  decode(block: Uint8Array): DepthScene {
    const header = new Int32Array(block.buffer, block.byteOffset + PPU_OFFSETS.header, 4);
    const vram = block.subarray(PPU_OFFSETS.vram, PPU_OFFSETS.vram + Ppu.VRAM_BYTES);
    const oam = block.subarray(PPU_OFFSETS.oam, PPU_OFFSETS.oam + Ppu.OAM_BYTES);
    const io = block.subarray(PPU_OFFSETS.io, PPU_OFFSETS.io + Ppu.IO_BYTES);
    const scanlines = block.subarray(PPU_OFFSETS.scanlines);

    const scene = this.scene;
    const isCgb = header[PpuHeader.IS_CGB] !== 0;
    const vramSize = header[PpuHeader.VRAM_SIZE] ?? 0x2000;

    // Registers as of the first visible scanline; the per-line log carries the
    // rest for anything that changes mid-frame.
    const lcdc = scanlines[0] ?? io[0x40] ?? 0;
    // The background switch is folded into the display switch: with it off the
    // Game Boy shows white behind the sprites, and an empty ground layer is
    // exactly that.
    scene.displayOn = (lcdc & LCDC.LCD_ENABLE) !== 0;
    const bgEnabled = (lcdc & LCDC.BG_ENABLE) !== 0;
    scene.scrollX = scanlines[1] ?? 0;
    scene.scrollY = scanlines[2] ?? 0;

    for (let line = 0; line < GB_SCREEN_HEIGHT; line++) {
      const base = line * Ppu.SCANLINE_RECORD_BYTES;
      scene.scrollXByLine[line] = scanlines[base + 1] ?? 0;
      scene.scrollYByLine[line] = scanlines[base + 2] ?? 0;
    }

    const windowX = (scanlines[3] ?? 0) - 7;
    const windowY = scanlines[4] ?? 0;
    const windowVisible =
      (lcdc & LCDC.WINDOW_ENABLE) !== 0 && windowY < GB_SCREEN_HEIGHT && windowX < GB_SCREEN_WIDTH;

    decodeTiles(vram, vramSize, scene.tileAtlas, scene.tileSideIndex);
    decodePalettes(block, io, isCgb, scene);

    const signedTiles = (lcdc & LCDC.TILE_DATA_LOW) === 0;
    const reader: MapReader = {
      vram,
      hasAttributes: isCgb && vramSize > 0x2000,
      signedTiles,
    };

    scene.ground[0]!.scrollX = scene.scrollX;
    scene.ground[0]!.scrollY = scene.scrollY;
    if (bgEnabled) {
      decodeBackground(
        reader,
        (lcdc & LCDC.BG_MAP_HIGH) !== 0 ? 0x1c00 : 0x1800,
        scene.scrollX,
        scene.scrollY,
        this.bg,
      );
    }
    else {
      this.bg.count = 0;
    }

    scene.hud.length = 0;
    if (windowVisible) {
      decodeWindow(
        reader,
        (lcdc & LCDC.WINDOW_MAP_HIGH) !== 0 ? 0x1c00 : 0x1800,
        windowX,
        windowY,
        this.window,
      );
      if (this.window.count > 0) scene.hud.push(this.windowLayer);
    }

    decodeSprites(oam, lcdc, isCgb, scene.sprites);

    return scene;
  }
}

/** Unpacks 2bpp tile data into one byte per pixel, laid out as an atlas. */
function decodeTiles(
  vram: Uint8Array,
  vramSize: number,
  atlas: Uint8Array,
  sideIndex: Uint8Array,
): void {
  const banks = vramSize > 0x2000 ? 2 : 1;
  const histogram = new Uint8Array(4);

  for (let bank = 0; bank < banks; bank++) {
    const bankBase = bank * 0x2000;
    for (let tile = 0; tile < 384; tile++) {
      const absolute = bank * 384 + tile;
      const source = bankBase + tile * 16;
      const atlasCol = (absolute % ATLAS_TILES_PER_ROW) * 8;
      const atlasRow = Math.floor(absolute / ATLAS_TILES_PER_ROW) * 8;

      histogram.fill(0);
      for (let y = 0; y < 8; y++) {
        const low = vram[source + y * 2] ?? 0;
        const high = vram[source + y * 2 + 1] ?? 0;
        const rowBase = (atlasRow + y) * ATLAS_WIDTH + atlasCol;
        for (let x = 0; x < 8; x++) {
          const shift = 7 - x;
          const index = ((low >> shift) & 1) | (((high >> shift) & 1) << 1);
          atlas[rowBase + x] = index;
          histogram[index]!++;
        }
      }
      sideIndex[absolute] = dominantIndex(histogram);
    }
  }

  // Second bank absent on DMG: leave it blank rather than showing bank 0 twice.
  if (banks === 1) {
    atlas.fill(0, ATLAS_WIDTH * (ATLAS_HEIGHT / 2));
    sideIndex.fill(0, 384);
  }
}

/**
 * The colour a tile uses most, which is what its sides are painted with.
 *
 * Colour zero is skipped where the tile has anything else: on a mostly empty
 * tile it is the background showing through, and a block whose sides are the
 * background colour looks like a hole.
 */
function dominantIndex(histogram: Uint8Array): number {
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

/**
 * Resolves palettes to RGBA.
 *
 * On Game Boy Color the core's palettes are already per-palette colours. On the
 * original Game Boy they are a four-shade ramp, and BGP/OBP map a tile's colour
 * index onto that ramp — so the mapping is applied here, which leaves both
 * models with the same eight-palettes-of-four structure for the shader.
 */
function decodePalettes(
  block: Uint8Array,
  io: Uint8Array,
  isCgb: boolean,
  scene: DepthScene,
): void {
  const bgSource = new Uint32Array(
    block.buffer,
    block.byteOffset + PPU_OFFSETS.bgPalettes,
    Ppu.PALETTE_BYTES / 4,
  );
  const objSource = new Uint32Array(
    block.buffer,
    block.byteOffset + PPU_OFFSETS.objPalettes,
    Ppu.PALETTE_BYTES / 4,
  );

  if (isCgb) {
    scene.bgPalettes.set(bgSource);
    scene.objPalettes.set(objSource);
    return;
  }

  const bgp = io[0x47] ?? 0xe4;
  const obp0 = io[0x48] ?? 0xe4;
  const obp1 = io[0x49] ?? 0xe4;

  for (let index = 0; index < 4; index++) {
    scene.bgPalettes[index] = bgSource[(bgp >> (index * 2)) & 3] ?? 0;
    scene.objPalettes[index] = objSource[(obp0 >> (index * 2)) & 3] ?? 0;
    scene.objPalettes[4 + index] = objSource[4 + ((obp1 >> (index * 2)) & 3)] ?? 0;
  }
}

interface MapReader {
  vram: Uint8Array;
  hasAttributes: boolean;
  signedTiles: boolean;
}

/** Resolves one map entry into an absolute tile number and its attributes. */
function readCell(
  reader: MapReader,
  mapBase: number,
  mapX: number,
  mapY: number,
): { tile: number; palette: number; flip: number } {
  const entry = mapBase + mapY * MAP_TILES + mapX;
  const raw = reader.vram[entry] ?? 0;
  const attributes = reader.hasAttributes ? (reader.vram[0x2000 + entry] ?? 0) : 0;

  // 0x8800 addressing treats the index as signed around tile 256.
  let tile = reader.signedTiles ? (raw < 128 ? raw + 256 : raw) : raw;
  if (attributes & 0x08) tile += 384; // second VRAM bank

  return {
    tile,
    palette: attributes & 0x07,
    flip: ((attributes >> 5) & 1) | (((attributes >> 6) & 1) << 1),
  };
}

/**
 * Walks the visible part of the scrolling background map.
 *
 * The map is 32x32 tiles and wraps in both directions, so the visible window
 * can straddle the seam; map coordinates are taken modulo 32 for that reason.
 */
function decodeBackground(
  reader: MapReader,
  mapBase: number,
  scrollX: number,
  scrollY: number,
  cells: CellArrays,
): void {
  const firstCol = Math.floor(scrollX / 8) - MARGIN_LEFT;
  const firstRow = Math.floor(scrollY / 8) - MARGIN_TOP;

  let count = 0;
  for (let row = 0; row < VIEW_ROWS; row++) {
    for (let col = 0; col < VIEW_COLS; col++) {
      const mapX = (((firstCol + col) % MAP_TILES) + MAP_TILES) % MAP_TILES;
      const mapY = (((firstRow + row) % MAP_TILES) + MAP_TILES) % MAP_TILES;
      const cell = readCell(reader, mapBase, mapX, mapY);

      cells.mapX[count] = mapX;
      cells.mapY[count] = mapY;
      cells.worldX[count] = (firstCol + col) * 8 - scrollX;
      cells.worldY[count] = (firstRow + row) * 8 - scrollY;
      cells.tile[count] = cell.tile;
      cells.palette[count] = cell.palette;
      cells.flip[count] = cell.flip;
      count++;
    }
  }
  cells.count = count;
}

/**
 * Walks the window map.
 *
 * Unlike the background the window does not scroll and does not wrap: its map
 * cell (0,0) is always drawn at (WX-7, WY), and the map is simply clipped at
 * the screen edge.
 */
function decodeWindow(
  reader: MapReader,
  mapBase: number,
  originX: number,
  originY: number,
  cells: CellArrays,
): void {
  const cols = Math.min(VIEW_COLS, Math.ceil((GB_SCREEN_WIDTH - originX) / 8) + 1);
  const rows = Math.min(VIEW_ROWS, Math.ceil((GB_SCREEN_HEIGHT - originY) / 8) + 1);

  let count = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (col >= MAP_TILES || row >= MAP_TILES) continue;
      const cell = readCell(reader, mapBase, col, row);

      cells.mapX[count] = col;
      cells.mapY[count] = row;
      cells.worldX[count] = originX + col * 8;
      cells.worldY[count] = originY + row * 8;
      cells.tile[count] = cell.tile;
      cells.palette[count] = cell.palette;
      cells.flip[count] = cell.flip;
      count++;
    }
  }
  cells.count = count;
}

/** Reads the 40 OAM entries, keeping the ones actually on screen. */
function decodeSprites(
  oam: Uint8Array,
  lcdc: number,
  isCgb: boolean,
  sprites: SpriteArrays,
): void {
  if ((lcdc & LCDC.OBJ_ENABLE) === 0) {
    sprites.count = 0;
    return;
  }

  const tall = (lcdc & LCDC.OBJ_TALL) !== 0;
  const height = tall ? 16 : 8;

  let count = 0;
  for (let entry = 0; entry < OAM_ENTRIES; entry++) {
    const base = entry * 4;
    const y = (oam[base] ?? 0) - 16;
    const x = (oam[base + 1] ?? 0) - 8;
    if (y <= -height || y >= GB_SCREEN_HEIGHT || x <= -8 || x >= GB_SCREEN_WIDTH) continue;

    const rawTile = oam[base + 2] ?? 0;
    const attributes = oam[base + 3] ?? 0;
    // Tall sprites ignore the low bit and occupy two consecutive tiles.
    let tile = tall ? rawTile & 0xfe : rawTile;
    if (isCgb && attributes & 0x08) tile += 384;

    sprites.x[count] = x;
    sprites.y[count] = y;
    sprites.tile[count] = tile;
    sprites.palette[count] = isCgb ? attributes & 0x07 : (attributes >> 4) & 1;
    sprites.flip[count] = ((attributes >> 5) & 1) | (((attributes >> 6) & 1) << 1);
    sprites.width[count] = 8;
    sprites.height[count] = height;
    // A tall Game Boy object is two consecutive tiles, so one row steps one.
    sprites.tileStride[count] = 1;
    sprites.behindBg[count] = (attributes >> 7) & 1;
    count++;
  }
  sprites.count = count;
}
