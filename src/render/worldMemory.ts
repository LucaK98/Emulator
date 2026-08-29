/**
 * Remembers the world the player has already walked through.
 *
 * A console keeps barely more map in memory than it shows — the Game Boy's is
 * 32 tiles square, about one and a half screens — and writes the next column of
 * tiles only just before it scrolls into view. A depth view that reaches past
 * the console's own picture therefore has nothing real to show out there: ask
 * for more and the map simply wraps, so a distant part of the same map appears
 * as if it were the neighbourhood, and changes as the player walks.
 *
 * So this keeps its own copy. Every frame the tiles that are certainly current
 * — the ones actually on screen — are written into a large buffer at their
 * position in the world, and the ground is drawn from that buffer instead. What
 * the player has seen stays put, and the view reaches as far as they have
 * explored.
 *
 * The hard part is forgetting at the right moment. Walking into a house
 * replaces the whole world while the scroll barely moves, and remembered
 * scenery hanging around inside a building would be worse than not remembering
 * at all. Three things trigger a clean slate, described at each check below.
 */

import type { CellArrays, DepthScene, SceneLayer } from './ppu/scene';
import { makeCells } from './ppu/scene';

/**
 * The buffer's size in tiles, and with it how far back the memory goes.
 *
 * 128 tiles is 1024 pixels, several screens in every direction. Positions wrap
 * within it, so walking far enough in one direction eventually overwrites what
 * was there — by which point it is far outside anything the camera can see.
 */
const BUFFER_TILES = 128;
const BUFFER_MASK = BUFFER_TILES - 1;

/** How much world the renderer asks for, in tiles. */
export const WINDOW_COLS = 64;
export const WINDOW_ROWS = 56;

/**
 * A remembered cell is dropped once it is this many frames old.
 *
 * Long enough to walk a good distance and come back, short enough that
 * something missed by the checks below does not haunt the view indefinitely.
 */
const MAX_AGE_FRAMES = 60 * 60;

/**
 * Fraction of the tile art that has to change from one frame to the next for
 * the world to count as replaced.
 *
 * A new area rewrites its tiles wholesale. Animated water or a flickering
 * light touches a handful, which must not be enough.
 */
const TILESET_CHANGE_FRACTION = 0.2;

/**
 * Fraction of remembered cells that has to disagree with what is on screen for
 * the memory to be considered wrong.
 *
 * This is the check that catches a new map with the same tileset. Some
 * disagreement is normal — a door opens, a character's tile is written into
 * the map — so the bar is well above zero.
 */
const DISAGREEMENT_FRACTION = 0.45;

/** Below this many comparable cells the disagreement check says nothing. */
const MIN_CELLS_TO_JUDGE = 24;

/**
 * How far beyond the screen a tile may be and still be worth recording.
 *
 * A console writes the next row of map just before it scrolls into view, so a
 * narrow band outside the picture is already correct and can be shown before
 * the player gets there. How narrow is a measured figure, not a guess: over
 * nine hundred cells that later scrolled into view, everything within two
 * tiles of the edge matched exactly what turned up. Further out there was no
 * evidence either way, so it is not used — showing what has not been written
 * yet is how a house appears out of nowhere.
 */
const LOOKAHEAD_TILES = 2;

/** Bumped when the stored shape changes, so old saves are simply ignored. */
const SNAPSHOT_VERSION = 1;

/** What is written to storage so a map survives closing the app. */
export interface WorldSnapshot {
  version: number;
  /** Identifies the tile art; a map is meaningless against a different set. */
  fingerprint: Uint8Array;
  layers: Array<{
    cells: Uint32Array;
    originX: number;
    originY: number;
    lastScrollX: number;
    lastScrollY: number;
  }>;
}

/**
 * A scroll step larger than this is not walking.
 *
 * On foot a game scrolls a pixel or two a frame. A jump means a warp, a
 * cut to another room, or the screen being repositioned — in every case the
 * surroundings are no longer what was remembered.
 */
const MAX_WALK_STEP_PX = 48;

interface LayerMemory {
  /** Packed tile, palette and flip; zero means nothing was ever recorded. */
  cells: Uint32Array;
  /** Frame number the cell was last seen, for ageing it out. */
  stamp: Int32Array;
  /** The layer's scroll last frame, to measure the step from. */
  lastScrollX: number;
  lastScrollY: number;
  /** Cumulative scroll: where the screen sits in the world, in pixels. */
  originX: number;
  originY: number;
  started: boolean;
}

/**
 * Packs a cell into one word. The top bit marks it as recorded.
 *
 * Shifted back to unsigned at the end: JavaScript's bitwise operators produce
 * a signed 32-bit result, so setting the top bit yields a negative number,
 * while the buffer reads back unsigned. Without this the two never compare
 * equal and every frame looks like a different world.
 */
function pack(tile: number, palette: number, flip: number): number {
  return (
    (0x8000_0000 | (tile & 0xffff) | ((palette & 0x1f) << 16) | ((flip & 3) << 21)) >>> 0
  );
}

export class WorldMemory {
  private readonly layers: LayerMemory[] = [];
  private readonly output: CellArrays[] = [];
  private readonly previousFingerprint: Uint8Array;
  private fingerprintSeen = false;
  private frame = 0;

  /** Set for one frame after the memory was cleared; the UI reports it. */
  forgot = false;

  /** A restored map, held until the first frame can vouch for it. */
  private pending: WorldSnapshot | null = null;

  constructor(fingerprintLength: number) {
    this.previousFingerprint = new Uint8Array(fingerprintLength);
  }

  /**
   * Offers a map saved from an earlier session.
   *
   * It is not adopted here: whether it belongs to what is on screen can only
   * be told once there is a frame to compare against, which happens on the
   * next call to expand.
   */
  restore(snapshot: WorldSnapshot): void {
    if (snapshot.version !== SNAPSHOT_VERSION) return;
    this.pending = snapshot;
  }

  /**
   * The current map, for storing. Null while nothing has been recorded.
   *
   * Only the cells travel. The frame stamps do not: they count from this
   * session's start and would age everything out at once on restore, so the
   * restored cells are simply treated as seen just now.
   */
  snapshot(): WorldSnapshot | null {
    if (this.layers.length === 0 || !this.fingerprintSeen) return null;
    return {
      version: SNAPSHOT_VERSION,
      fingerprint: this.previousFingerprint.slice(),
      layers: this.layers.map((memory) => ({
        cells: memory.cells.slice(),
        originX: memory.originX,
        originY: memory.originY,
        lastScrollX: memory.lastScrollX,
        lastScrollY: memory.lastScrollY,
      })),
    };
  }

  /**
   * Folds one frame of a layer in and hands back everything remembered around
   * the player, ready to draw.
   */
  expand(index: number, layer: SceneLayer, scene: DepthScene): CellArrays {
    if (index === 0) {
      this.frame++;
      this.forgot = false;
      this.adoptPending(scene);
      if (this.tilesetChanged(scene)) this.clear();
    }

    const memory = this.layerFor(index);
    this.advanceOrigin(memory, layer);
    if (this.disagrees(memory, layer, scene)) {
      this.clear();
      // Cleared mid-frame: the origin is still good, only the contents went.
      this.record(memory, layer, scene);
    }
    else {
      this.record(memory, layer, scene);
    }
    return this.readOut(memory, index, scene);
  }

  /** Forgets everything. Called on a new area, and when the game is changed. */
  clear(): void {
    for (const memory of this.layers) {
      memory.cells.fill(0);
      memory.stamp.fill(0);
    }
    this.forgot = true;
  }

  /** How many cells are currently remembered, for the diagnostics readout. */
  rememberedCells(): number {
    let count = 0;
    for (const memory of this.layers) {
      for (let i = 0; i < memory.cells.length; i++) if (memory.cells[i] !== 0) count++;
    }
    return count;
  }

  /* --- internals -------------------------------------------------------- */

  /**
   * Decides whether a map from an earlier session belongs to this frame.
   *
   * The tile art has to be the same, or every tile number in the stored map
   * draws something else and nothing about it can be trusted.
   *
   * Where the player is standing is not checked here. The stored position
   * comes with the scroll it was taken at, so the ordinary step calculation
   * that follows carries it forward to wherever the game has resumed — and
   * that calculation already refuses a step too large to be walking, which is
   * what a different save slot or a fresh start looks like. It has to work
   * that way: several frames pass between writing the save state and taking
   * this snapshot, and in a game that scrolls continuously the two never quite
   * agree.
   */
  private adoptPending(scene: DepthScene): void {
    const snapshot = this.pending;
    if (!snapshot) return;
    this.pending = null;

    const fingerprint = scene.tileSideIndex;
    if (snapshot.fingerprint.length !== fingerprint.length) return;
    for (let i = 0; i < fingerprint.length; i++) {
      if (snapshot.fingerprint[i] !== fingerprint[i]) return;
    }

    if (snapshot.layers.length === 0) return;

    snapshot.layers.forEach((stored, index) => {
      const memory = this.layerFor(index);
      if (stored.cells.length !== memory.cells.length) return;
      memory.cells.set(stored.cells);
      // Treated as seen just now, so nothing ages out on the first frame back.
      memory.stamp.fill(this.frame, 0, memory.stamp.length);
      for (let i = 0; i < memory.cells.length; i++) {
        if (memory.cells[i] === 0) memory.stamp[i] = 0;
      }
      memory.originX = stored.originX;
      memory.originY = stored.originY;
      memory.lastScrollX = stored.lastScrollX;
      memory.lastScrollY = stored.lastScrollY;
      memory.started = true;
    });
    this.previousFingerprint.set(fingerprint);
    this.fingerprintSeen = true;
  }

  private layerFor(index: number): LayerMemory {
    let memory = this.layers[index];
    if (!memory) {
      memory = {
        cells: new Uint32Array(BUFFER_TILES * BUFFER_TILES),
        stamp: new Int32Array(BUFFER_TILES * BUFFER_TILES),
        lastScrollX: 0,
        lastScrollY: 0,
        originX: 0,
        originY: 0,
        started: false,
      };
      this.layers[index] = memory;
    }
    return memory;
  }

  /**
   * A new area rewrites the tile art, so the same tile numbers now draw
   * something else and everything remembered is a lie.
   */
  private tilesetChanged(scene: DepthScene): boolean {
    const current = scene.tileSideIndex;
    if (!this.fingerprintSeen) {
      this.previousFingerprint.set(current);
      this.fingerprintSeen = true;
      return false;
    }

    let changed = 0;
    for (let i = 0; i < current.length; i++) {
      if (current[i] !== this.previousFingerprint[i]) changed++;
    }
    this.previousFingerprint.set(current);
    return changed > current.length * TILESET_CHANGE_FRACTION;
  }

  /**
   * Follows the screen's position in the world.
   *
   * The scroll registers wrap at the map's size, so a step from 254 to 2 is two
   * pixels forward and not 252 back. Taking the shorter of the two readings is
   * what turns a wrapping register into a position that keeps counting.
   */
  private advanceOrigin(memory: LayerMemory, layer: SceneLayer): void {
    if (!memory.started) {
      memory.started = true;
      memory.lastScrollX = layer.scrollX;
      memory.lastScrollY = layer.scrollY;
      return;
    }

    const stepX = shortestStep(layer.scrollX - memory.lastScrollX, layer.mapWidth);
    const stepY = shortestStep(layer.scrollY - memory.lastScrollY, layer.mapHeight);
    memory.lastScrollX = layer.scrollX;
    memory.lastScrollY = layer.scrollY;

    if (Math.abs(stepX) > MAX_WALK_STEP_PX || Math.abs(stepY) > MAX_WALK_STEP_PX) {
      // Not walking: a warp, a cut, a screen repositioned. Wherever this is,
      // it is not next to what was remembered.
      this.clear();
    }

    memory.originX += stepX;
    memory.originY += stepY;
  }

  /**
   * Whether what is on screen contradicts what was remembered there.
   *
   * This is what catches a new map drawn with the same tiles — a second floor,
   * a neighbouring route — where nothing else gives it away.
   */
  private disagrees(memory: LayerMemory, layer: SceneLayer, scene: DepthScene): boolean {
    const { screenWidth, screenHeight } = scene.geometry;
    const cells = layer.cells;
    let compared = 0;
    let differing = 0;

    for (let i = 0; i < cells.count; i++) {
      const x = cells.worldX[i]!;
      const y = cells.worldY[i]!;
      if (x < 0 || y < 0 || x >= screenWidth || y >= screenHeight) continue;

      const slot = this.slotFor(memory, x, y);
      const stored = memory.cells[slot]!;
      if (stored === 0) continue;
      compared++;
      if (stored !== pack(cells.tile[i]!, cells.palette[i]!, cells.flip[i]!)) differing++;
    }

    return (
      compared >= MIN_CELLS_TO_JUDGE && differing > compared * DISAGREEMENT_FRACTION
    );
  }

  /** Writes the cells that are certainly current into the world buffer. */
  private record(memory: LayerMemory, layer: SceneLayer, scene: DepthScene): void {
    const { screenWidth, screenHeight } = scene.geometry;
    const cells = layer.cells;

    // The screen, plus the narrow band beyond it the console has already
    // written. Everything further out is whatever last scrolled out of its
    // memory, which is exactly what must not be kept.
    const reach = LOOKAHEAD_TILES * 8;

    for (let i = 0; i < cells.count; i++) {
      const x = cells.worldX[i]!;
      const y = cells.worldY[i]!;
      if (
        x < -8 - reach ||
        y < -8 - reach ||
        x >= screenWidth + reach ||
        y >= screenHeight + reach
      ) {
        continue;
      }

      const slot = this.slotFor(memory, x, y);
      memory.cells[slot] = pack(cells.tile[i]!, cells.palette[i]!, cells.flip[i]!);
      memory.stamp[slot] = this.frame;
    }
  }

  /** Buffer slot for a cell at a screen position. */
  private slotFor(memory: LayerMemory, screenX: number, screenY: number): number {
    const tileX = Math.round((memory.originX + screenX) / 8) & BUFFER_MASK;
    const tileY = Math.round((memory.originY + screenY) / 8) & BUFFER_MASK;
    return tileY * BUFFER_TILES + tileX;
  }

  /** Collects everything remembered around the screen into drawable cells. */
  private readOut(memory: LayerMemory, index: number, scene: DepthScene): CellArrays {
    let out = this.output[index];
    if (!out) {
      out = makeCells(WINDOW_COLS * WINDOW_ROWS);
      this.output[index] = out;
    }

    const { screenWidth, screenHeight } = scene.geometry;
    // Centre the window on the screen, then bias it upwards: the camera looks
    // along the world away from the player, so that is where the room is
    // wanted.
    const marginLeft = Math.floor((WINDOW_COLS - screenWidth / 8) / 2);
    const marginTop = Math.floor((WINDOW_ROWS - screenHeight / 8) * 0.62);

    const firstTileX = Math.floor(memory.originX / 8) - marginLeft;
    const firstTileY = Math.floor(memory.originY / 8) - marginTop;
    const offsetX = memory.originX - Math.floor(memory.originX / 8) * 8;
    const offsetY = memory.originY - Math.floor(memory.originY / 8) * 8;

    let count = 0;
    for (let row = 0; row < WINDOW_ROWS; row++) {
      for (let column = 0; column < WINDOW_COLS; column++) {
        const tileX = firstTileX + column;
        const tileY = firstTileY + row;
        const slot = (tileY & BUFFER_MASK) * BUFFER_TILES + (tileX & BUFFER_MASK);
        const stored = memory.cells[slot]!;
        if (stored === 0) continue;
        if (this.frame - memory.stamp[slot]! > MAX_AGE_FRAMES) continue;

        out.mapX[count] = tileX;
        out.mapY[count] = tileY;
        out.worldX[count] = (column - marginLeft) * 8 - offsetX;
        out.worldY[count] = (row - marginTop) * 8 - offsetY;
        out.tile[count] = stored & 0xffff;
        out.palette[count] = (stored >> 16) & 0x1f;
        out.flip[count] = (stored >> 21) & 3;
        count++;
      }
    }
    out.count = count;
    // The layer keeps its own identity; only the extent grew.
    return out;
  }
}

/**
 * The smaller of the two readings of a step across a wrapping register.
 *
 * With a map 256 pixels wide, 254 to 2 is four pixels forward, not 252 back.
 */
function shortestStep(delta: number, wrap: number): number {
  if (wrap <= 0) return delta;
  const half = wrap / 2;
  let step = delta % wrap;
  if (step > half) step -= wrap;
  if (step < -half) step += wrap;
  return step;
}
