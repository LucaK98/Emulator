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

import { PPU_OFFSETS, Ppu, PpuHeader, SCREEN_HEIGHT, SCREEN_WIDTH } from '../../core/protocol';

/** Tiles addressable across both VRAM banks. */
export const MAX_TILES = 768;
/** Tile atlas geometry: 16 tiles per row. */
export const ATLAS_TILES_PER_ROW = 16;
export const ATLAS_WIDTH = ATLAS_TILES_PER_ROW * 8;
export const ATLAS_HEIGHT = (MAX_TILES / ATLAS_TILES_PER_ROW) * 8;

/** Ground cells decoded per frame: the visible screen plus a one-tile margin. */
export const VIEW_COLS = 22;
export const VIEW_ROWS = 20;

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

/** Per-cell values the renderer turns into instances. */
export interface CellArrays {
  /** Map column and row, wrapped into 0..31. */
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
  tile: Uint16Array;
  palette: Uint8Array;
  flip: Uint8Array;
  /** 8 or 16. */
  height: Uint8Array;
  /** Non-zero when the sprite is drawn behind non-zero background pixels. */
  behindBg: Uint8Array;
  count: number;
}

export interface GbScene {
  isCgb: boolean;
  lcdOn: boolean;
  bgEnabled: boolean;
  windowVisible: boolean;
  /** Window origin on screen; WX is stored biased by 7. */
  windowX: number;
  windowY: number;
  scrollX: number;
  scrollY: number;
  /** Per-scanline SCX/SCY, for parallax. */
  scrollXByLine: Uint8Array;
  scrollYByLine: Uint8Array;
  tileAtlas: Uint8Array;
  /** 8 palettes x 4 colours, RGBA8888, background then objects. */
  bgPalettes: Uint32Array;
  objPalettes: Uint32Array;
  ground: CellArrays;
  window: CellArrays;
  sprites: SpriteArrays;
}

function makeCells(capacity: number): CellArrays {
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

export class PpuDecoder {
  private readonly scene: GbScene = {
    isCgb: false,
    lcdOn: false,
    bgEnabled: true,
    windowVisible: false,
    windowX: 0,
    windowY: 0,
    scrollX: 0,
    scrollY: 0,
    scrollXByLine: new Uint8Array(SCREEN_HEIGHT),
    scrollYByLine: new Uint8Array(SCREEN_HEIGHT),
    tileAtlas: new Uint8Array(ATLAS_WIDTH * ATLAS_HEIGHT),
    bgPalettes: new Uint32Array(32),
    objPalettes: new Uint32Array(32),
    ground: makeCells(VIEW_COLS * VIEW_ROWS),
    window: makeCells(VIEW_COLS * VIEW_ROWS),
    sprites: {
      x: new Float32Array(OAM_ENTRIES),
      y: new Float32Array(OAM_ENTRIES),
      tile: new Uint16Array(OAM_ENTRIES),
      palette: new Uint8Array(OAM_ENTRIES),
      flip: new Uint8Array(OAM_ENTRIES),
      height: new Uint8Array(OAM_ENTRIES),
      behindBg: new Uint8Array(OAM_ENTRIES),
      count: 0,
    },
  };

  /** Decodes one captured PPU block. The returned scene is reused each call. */
  decode(block: Uint8Array): GbScene {
    const header = new Int32Array(block.buffer, block.byteOffset + PPU_OFFSETS.header, 4);
    const vram = block.subarray(PPU_OFFSETS.vram, PPU_OFFSETS.vram + Ppu.VRAM_BYTES);
    const oam = block.subarray(PPU_OFFSETS.oam, PPU_OFFSETS.oam + Ppu.OAM_BYTES);
    const io = block.subarray(PPU_OFFSETS.io, PPU_OFFSETS.io + Ppu.IO_BYTES);
    const scanlines = block.subarray(PPU_OFFSETS.scanlines);

    const scene = this.scene;
    scene.isCgb = header[PpuHeader.IS_CGB] !== 0;
    const vramSize = header[PpuHeader.VRAM_SIZE] ?? 0x2000;

    // Registers as of the first visible scanline; the per-line log carries the
    // rest for anything that changes mid-frame.
    const lcdc = scanlines[0] ?? io[0x40] ?? 0;
    scene.lcdOn = (lcdc & LCDC.LCD_ENABLE) !== 0;
    scene.bgEnabled = (lcdc & LCDC.BG_ENABLE) !== 0;
    scene.scrollX = scanlines[1] ?? 0;
    scene.scrollY = scanlines[2] ?? 0;

    for (let line = 0; line < SCREEN_HEIGHT; line++) {
      const base = line * Ppu.SCANLINE_RECORD_BYTES;
      scene.scrollXByLine[line] = scanlines[base + 1] ?? 0;
      scene.scrollYByLine[line] = scanlines[base + 2] ?? 0;
    }

    const windowX = (scanlines[3] ?? 0) - 7;
    const windowY = scanlines[4] ?? 0;
    scene.windowVisible =
      (lcdc & LCDC.WINDOW_ENABLE) !== 0 && windowY < SCREEN_HEIGHT && windowX < SCREEN_WIDTH;
    scene.windowX = windowX;
    scene.windowY = windowY;

    decodeTiles(vram, vramSize, scene.tileAtlas);
    decodePalettes(block, io, scene);

    const signedTiles = (lcdc & LCDC.TILE_DATA_LOW) === 0;
    const reader: MapReader = {
      vram,
      hasAttributes: scene.isCgb && vramSize > 0x2000,
      signedTiles,
    };

    decodeBackground(
      reader,
      (lcdc & LCDC.BG_MAP_HIGH) !== 0 ? 0x1c00 : 0x1800,
      scene.scrollX,
      scene.scrollY,
      scene.ground,
    );

    if (scene.windowVisible) {
      decodeWindow(
        reader,
        (lcdc & LCDC.WINDOW_MAP_HIGH) !== 0 ? 0x1c00 : 0x1800,
        windowX,
        windowY,
        scene.window,
      );
    }
    else {
      scene.window.count = 0;
    }

    decodeSprites(oam, lcdc, scene.isCgb, scene.sprites);

    return scene;
  }
}

/** Unpacks 2bpp tile data into one byte per pixel, laid out as an atlas. */
function decodeTiles(vram: Uint8Array, vramSize: number, atlas: Uint8Array): void {
  const banks = vramSize > 0x2000 ? 2 : 1;

  for (let bank = 0; bank < banks; bank++) {
    const bankBase = bank * 0x2000;
    for (let tile = 0; tile < 384; tile++) {
      const absolute = bank * 384 + tile;
      const source = bankBase + tile * 16;
      const atlasCol = (absolute % ATLAS_TILES_PER_ROW) * 8;
      const atlasRow = Math.floor(absolute / ATLAS_TILES_PER_ROW) * 8;

      for (let y = 0; y < 8; y++) {
        const low = vram[source + y * 2] ?? 0;
        const high = vram[source + y * 2 + 1] ?? 0;
        const rowBase = (atlasRow + y) * ATLAS_WIDTH + atlasCol;
        for (let x = 0; x < 8; x++) {
          const shift = 7 - x;
          atlas[rowBase + x] = ((low >> shift) & 1) | (((high >> shift) & 1) << 1);
        }
      }
    }
  }

  // Second bank absent on DMG: leave it blank rather than showing bank 0 twice.
  if (banks === 1) atlas.fill(0, ATLAS_WIDTH * (ATLAS_HEIGHT / 2));
}

/**
 * Resolves palettes to RGBA.
 *
 * On Game Boy Color the core's palettes are already per-palette colours. On the
 * original Game Boy they are a four-shade ramp, and BGP/OBP map a tile's colour
 * index onto that ramp — so the mapping is applied here, which leaves both
 * models with the same eight-palettes-of-four structure for the shader.
 */
function decodePalettes(block: Uint8Array, io: Uint8Array, scene: GbScene): void {
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

  if (scene.isCgb) {
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
  const firstCol = Math.floor(scrollX / 8);
  const firstRow = Math.floor(scrollY / 8);

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
  const cols = Math.min(VIEW_COLS, Math.ceil((SCREEN_WIDTH - originX) / 8) + 1);
  const rows = Math.min(VIEW_ROWS, Math.ceil((SCREEN_HEIGHT - originY) / 8) + 1);

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
    if (y <= -height || y >= SCREEN_HEIGHT || x <= -8 || x >= SCREEN_WIDTH) continue;

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
    sprites.height[count] = height;
    sprites.behindBg[count] = (attributes >> 7) & 1;
    count++;
  }
  sprites.count = count;
}
