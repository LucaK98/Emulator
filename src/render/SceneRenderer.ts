/**
 * What the player screen expects of a renderer.
 *
 * Two implementations exist: the flat one that draws the emulator's finished
 * picture, and the depth one that rebuilds the scene from PPU state. The player
 * swaps between them without knowing which is which.
 */
export interface SceneRenderer {
  /** Matches the drawing buffer to the element size in device pixels. */
  resize(devicePixelRatio: number): void;
  /**
   * Draws one frame. `ppuBlock` carries the captured PPU state when depth
   * rendering is active, and is null otherwise.
   */
  render(pixels: Uint32Array, ppuBlock: Uint8Array | null): void;
  dispose(): void;
  /** True when this renderer needs PPU state captured for it. */
  readonly needsPpuState: boolean;
}
