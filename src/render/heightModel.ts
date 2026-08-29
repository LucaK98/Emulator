/**
 * Works out which background tiles are floor and which stand up.
 *
 * There is no height information anywhere in a Game Boy cartridge, and the
 * point of this feature is that it works without per-game tables. So the height
 * is inferred from something the hardware does tell us: where characters can
 * be.
 *
 * A tile that a sprite has stood on is floor — you cannot walk through a tree.
 * A tile that keeps appearing on screen but never has anyone standing on it is
 * a wall, a tree, a cliff or water. That single signal turns out to separate
 * an overworld into ground and scenery on its own, and it costs nothing per
 * game.
 *
 * Evidence decays, so walking into a cave or a battle re-learns rather than
 * carrying stale heights forward, and heights move gradually so nothing pops.
 */

import type { CellArrays, DepthScene } from './ppu/scene';

/**
 * Tiles the model can track.
 *
 * Sized for the largest atlas any console produces rather than per system: the
 * arrays are a few kilobytes either way, and one constant is easier to reason
 * about than a model that has to be rebuilt when the console changes.
 */
const MAX_TILES = 3072;

/** Appearances before a never-stood-on tile is allowed to rise. */
const SEEN_THRESHOLD = 90;
/** Multiplied into every counter periodically so old evidence fades. */
const DECAY = 0.985;
const DECAY_INTERVAL_FRAMES = 30;
/** Per-frame step of the smoothed height, so tiles rise and sink gradually. */
const HEIGHT_STEP = 0.02;
/**
 * Frames of stillness after which learning pauses. Menus and battle screens are
 * full of tiles nobody stands on, and treating those as scenery would extrude
 * a wall of text. A scrolling map is the signal that we are in a world.
 */
const STILL_FRAMES_BEFORE_PAUSE = 240;
/**
 * How much sustained scrolling counts as "walking around a map".
 *
 * A single change is not enough: setting up a screen, or a status bar shifting
 * once, moves the scroll registers exactly one time. Scoring changes with decay
 * separates that from a map being walked through, which moves them again and
 * again.
 */
const SCROLL_ACTIVITY_DECAY = 0.98;
const SCROLL_ACTIVITY_THRESHOLD = 3;

export class TileHeightModel {
  private readonly seen = new Float32Array(MAX_TILES);
  private readonly floor = new Float32Array(MAX_TILES);
  private readonly height = new Float32Array(MAX_TILES);

  private frames = 0;
  private framesSinceScroll = Number.MAX_SAFE_INTEGER;
  private lastScrollX = -1;
  private lastScrollY = -1;
  /**
   * Decayed count of recent scroll changes. A screen that never moves is a
   * menu, a title card or a battle backdrop — full of tiles nobody stands on,
   * which would otherwise all be read as scenery and extruded into a wall.
   */
  private scrollActivity = 0;

  /** True while the model is gathering evidence rather than idling. */
  learning = false;

  reset(): void {
    this.seen.fill(0);
    this.floor.fill(0);
    this.height.fill(0);
    this.frames = 0;
    this.framesSinceScroll = Number.MAX_SAFE_INTEGER;
    this.lastScrollX = -1;
    this.lastScrollY = -1;
    this.scrollActivity = 0;
    this.learning = false;
  }

  /** Folds one frame of evidence in and advances the smoothed heights. */
  update(scene: DepthScene): void {
    this.frames++;

    const moved = scene.scrollX !== this.lastScrollX || scene.scrollY !== this.lastScrollY;
    const firstReading = this.lastScrollX < 0;
    this.lastScrollX = scene.scrollX;
    this.lastScrollY = scene.scrollY;

    this.scrollActivity *= SCROLL_ACTIVITY_DECAY;
    if (moved && !firstReading) {
      this.scrollActivity += 1;
      this.framesSinceScroll = 0;
    }
    else if (this.framesSinceScroll < Number.MAX_SAFE_INTEGER) {
      this.framesSinceScroll++;
    }

    // A world has a moving viewpoint and characters in it; a menu has neither.
    this.learning =
      this.scrollActivity >= SCROLL_ACTIVITY_THRESHOLD &&
      scene.sprites.count > 0 &&
      this.framesSinceScroll < STILL_FRAMES_BEFORE_PAUSE;

    if (this.learning) {
      this.observe(scene);
    }
    this.advanceHeights();

    if (this.frames % DECAY_INTERVAL_FRAMES === 0) {
      for (let i = 0; i < MAX_TILES; i++) {
        this.seen[i] = this.seen[i]! * DECAY;
        this.floor[i] = this.floor[i]! * DECAY;
      }
    }
  }

  /** Smoothed height of a tile, 0 (floor) to 1 (full height). */
  heightOf(tile: number): number {
    return this.height[tile] ?? 0;
  }

  /** Number of tiles currently standing up; used by the diagnostics readout. */
  raisedTileCount(): number {
    let count = 0;
    for (let i = 0; i < MAX_TILES; i++) if (this.height[i]! > 0.5) count++;
    return count;
  }

  private observe(scene: DepthScene): void {
    const { screenWidth, screenHeight } = scene.geometry;

    for (const layer of scene.ground) {
      const cells = layer.cells;
      for (let i = 0; i < cells.count; i++) {
        // Only cells actually on screen count, not the off-screen margin.
        const x = cells.worldX[i]!;
        const y = cells.worldY[i]!;
        if (x < -8 || x > screenWidth || y < -8 || y > screenHeight) continue;
        const tile = cells.tile[i]!;
        if (tile < MAX_TILES) this.seen[tile] = this.seen[tile]! + 1;
      }
    }

    // Wherever a character's feet are, the tile underneath is walkable. Every
    // world layer is marked, because a character stands on the composite of
    // them, not on any one in particular.
    const sprites = scene.sprites;
    for (let s = 0; s < sprites.count; s++) {
      const footX = sprites.x[s]! + sprites.width[s]! / 2;
      const footY = sprites.y[s]! + sprites.height[s]! - 2;
      for (const layer of scene.ground) {
        const tile = tileAt(layer.cells, footX, footY);
        if (tile >= 0 && tile < MAX_TILES) this.floor[tile] = this.floor[tile]! + 1;
      }
    }
  }

  private advanceHeights(): void {
    for (let tile = 0; tile < MAX_TILES; tile++) {
      const seen = this.seen[tile]!;
      const floor = this.floor[tile]!;
      // Familiar, and nobody has ever stood on it.
      const target = seen >= SEEN_THRESHOLD && floor < 1 ? 1 : 0;

      const current = this.height[tile]!;
      if (current < target) this.height[tile] = Math.min(target, current + HEIGHT_STEP);
      else if (current > target) this.height[tile] = Math.max(target, current - HEIGHT_STEP);
    }
  }
}

/** Tile number of the ground cell containing a screen position, or -1. */
function tileAt(cells: CellArrays, x: number, y: number): number {
  for (let i = 0; i < cells.count; i++) {
    const cx = cells.worldX[i]!;
    const cy = cells.worldY[i]!;
    if (x >= cx && x < cx + 8 && y >= cy && y < cy + 8) return cells.tile[i]!;
  }
  return -1;
}
