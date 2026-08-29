/**
 * The 2.5D renderer.
 *
 * Instead of drawing the emulator's finished picture, it rebuilds the scene
 * from the PPU's own state and gives it depth:
 *
 *   * the background becomes a grid of blocks, each raised by however tall the
 *     height model believes that tile is;
 *   * every hardware sprite becomes a billboard standing on the ground, so
 *     characters stand up instead of lying flat, with a soft shadow beneath;
 *   * the window layer stays flat on top, because that is what games use it
 *     for — dialogue boxes and status bars belong on the glass, not in the
 *     world.
 *
 * Colours come from the palettes the core already resolved, so a scene looks
 * the same here as in the flat renderer apart from the perspective.
 */

import type { SystemSpec } from '../core/systems';
import { TileHeightModel } from './heightModel';
import { PpuDecoder } from './ppu/decode';
import { GbaPpuDecoder } from './ppu/decodeGba';
import type { CellArrays, DepthScene, SceneGeometry } from './ppu/scene';

/**
 * What the renderer needs of a console's decoder: the shape of its tiles and
 * palettes up front, and a decoded frame on demand.
 */
export interface FrameDecoder {
  readonly geometry: SceneGeometry;
  decode(block: Uint8Array): DepthScene;
}
import { fitViewport } from './GLRenderer';
import { identity, lookAt, multiply, orthographic, perspective, type Mat4 } from './mat4';
import type { SceneRenderer } from './SceneRenderer';

export interface DepthSettings {
  /** Camera pitch in degrees; 90 looks straight down, i.e. flat. */
  tiltDegrees: number;
  /** How far tiles rise, in screen pixels, at full height. */
  extrusion: number;
  /** How upright sprites stand: 0 lies flat, 1 stands fully. */
  stand: number;
  /** Opacity of the drop shadows. */
  shadow: number;
}

export const DEFAULT_DEPTH_SETTINGS: DepthSettings = {
  tiltDegrees: 58,
  extrusion: 14,
  stand: 1,
  shadow: 0.35,
};

const FOV_Y = (38 * Math.PI) / 180;
/**
 * One layer's worth of cells.
 *
 * The decoders reach well past the console's rectangle so the tilted ground
 * fills the screen; this has to hold the largest window either of them takes.
 */
const MAX_GROUND_INSTANCES = 64 * 64;
/** The GBA's full object table; the Game Boy uses the first forty. */
const MAX_SPRITE_INSTANCES = 128;
/**
 * Floats per instance: worldX, worldY, tile, palette, flip, height, width and
 * the sprite's tile stride — how many tiles along its rows step.
 */
const INSTANCE_FLOATS = 8;

/* --- Shaders ------------------------------------------------------------ */

const TILE_VERTEX = `#version 300 es
in vec3 a_local;      // unit cube, 0..1 on each axis
in vec2 a_uv;         // where in the tile this vertex samples
in float a_shade;     // face shading, so the sides read as sides
in float a_side;      // 1 on the four walls, 0 on the top

in vec2 a_instPos;    // cell origin in screen pixels
in vec4 a_instData;   // tile, palette, flip bits, height 0..1

uniform mat4 u_viewProj;
uniform float u_extrusion;

out vec2 v_uv;
flat out int v_tile;
flat out int v_palette;
flat out int v_flip;
out float v_shade;
flat out int v_isSide;
out vec2 v_world;

void main() {
  float height = a_instData.w * u_extrusion;
  // Screen Y grows downward; world Y is negated so that lower on screen is
  // nearer the camera.
  vec3 world = vec3(
    a_instPos.x + a_local.x * 8.0,
    -(a_instPos.y + a_local.y * 8.0),
    a_local.z * height
  );
  gl_Position = u_viewProj * vec4(world, 1.0);

  v_uv = a_uv;
  v_tile = int(a_instData.x);
  v_palette = int(a_instData.y);
  v_flip = int(a_instData.z);
  v_shade = a_shade;
  v_isSide = int(a_side);
  // In the console's own screen coordinates, for the edge fade.
  v_world = vec2(world.x, -world.y);
}`;

const tileFragment = (g: SceneGeometry) => `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

in vec2 v_uv;
flat in int v_tile;
flat in int v_palette;
flat in int v_flip;
flat in int v_isSide;
in float v_shade;
in vec2 v_world;

uniform vec2 u_screen;      // the console's own picture, in its own pixels
uniform usampler2D u_atlas;
uniform usampler2D u_sideIndex;
uniform sampler2D u_palette;
uniform int u_paletteRow;   // 0 for background palettes, 8 for object palettes
uniform int u_discardZero;  // objects treat colour 0 as transparent

out vec4 outColor;

/*
 * How brightly to draw a point, by how far outside the console's own picture
 * it lies.
 *
 * Beyond that rectangle the map data is real but stale: consoles keep only a
 * little more map in memory than they show, and the border is whatever last
 * scrolled out of view. Fading it makes the edge of what is actually known
 * look deliberate, and stops a house that scrolls into memory from popping up
 * at full brightness some distance from the player.
 */
float edgeFade() {
  vec2 outside = max(-v_world, v_world - u_screen);
  float distance = max(max(outside.x, outside.y), 0.0);
  return mix(1.0, 0.22, clamp(distance / 96.0, 0.0, 1.0));
}

void main() {
  float fade = edgeFade();

  if (v_isSide == 1) {
    // A tile was drawn to be seen from above and has no side texture. Smearing
    // one of its rows down the wall is what makes doorways trail black streaks
    // and fences turn into stripes; one flat colour reads as masonry.
    uint side = texelFetch(
      u_sideIndex,
      ivec2(v_tile % ${g.atlasTilesPerRow}, v_tile / ${g.atlasTilesPerRow}),
      0
    ).r;
    vec4 wall = texelFetch(u_palette, ivec2(int(side), u_paletteRow + v_palette), 0);
    outColor = vec4(wall.rgb * v_shade * fade, 1.0);
    return;
  }

  int tx = int(floor(clamp(v_uv.x, 0.0, 0.9999) * 8.0));
  int ty = int(floor(clamp(v_uv.y, 0.0, 0.9999) * 8.0));
  if ((v_flip & 1) != 0) tx = 7 - tx;
  if ((v_flip & 2) != 0) ty = 7 - ty;

  ivec2 texel = ivec2(
    (v_tile % ${g.atlasTilesPerRow}) * 8 + tx,
    (v_tile / ${g.atlasTilesPerRow}) * 8 + ty
  );
  uint index = texelFetch(u_atlas, texel, 0).r;
  if (u_discardZero == 1 && index == 0u) discard;

  vec4 colour = texelFetch(u_palette, ivec2(int(index), u_paletteRow + v_palette), 0);
  outColor = vec4(colour.rgb * v_shade * fade, 1.0);
}`;

const SPRITE_VERTEX = `#version 300 es
in vec2 a_local;      // 0..1 across the sprite, v = 0 at the top

in vec2 a_instPos;    // sprite top-left in screen pixels
in vec4 a_instData;   // tile, palette, flip bits, pixel height
in vec2 a_instExtra;  // pixel width, tiles one row of its tile block steps

uniform mat4 u_viewProj;
uniform float u_stand;

out vec2 v_local;
flat out int v_tile;
flat out int v_palette;
flat out int v_flip;
flat out int v_height;
flat out int v_width;
flat out int v_stride;

void main() {
  float height = a_instData.w;
  float width = a_instExtra.x;
  float x = a_instPos.x + a_local.x * width;

  // Lying flat, the sprite covers the rows it occupies on screen. Standing up,
  // it is hinged at its feet and rises out of the ground.
  vec3 lying = vec3(x, -(a_instPos.y + a_local.y * height), 0.35);
  vec3 upright = vec3(x, -(a_instPos.y + height), (1.0 - a_local.y) * height);
  gl_Position = u_viewProj * vec4(mix(lying, upright, u_stand), 1.0);

  v_local = a_local;
  v_tile = int(a_instData.x);
  v_palette = int(a_instData.y);
  v_flip = int(a_instData.z);
  v_height = int(height);
  v_width = int(width);
  v_stride = int(a_instExtra.y);
}`;

const spriteFragment = (g: SceneGeometry) => `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

in vec2 v_local;
flat in int v_tile;
flat in int v_palette;
flat in int v_flip;
flat in int v_height;
flat in int v_width;
flat in int v_stride;

uniform usampler2D u_atlas;
uniform sampler2D u_palette;

out vec4 outColor;

void main() {
  // Flipping applies to the whole object, not tile by tile, so it is done to
  // the pixel position before the tile it falls in is worked out.
  int px = int(floor(clamp(v_local.x, 0.0, 0.9999) * float(v_width)));
  int py = int(floor(clamp(v_local.y, 0.0, 0.9999) * float(v_height)));
  if ((v_flip & 1) != 0) px = v_width - 1 - px;
  if ((v_flip & 2) != 0) py = v_height - 1 - py;

  // An object bigger than one tile is a block of them. How far one row of that
  // block steps depends on the console's object mapping, so the stride travels
  // with the object rather than being fixed here.
  int tile = v_tile + (py / 8) * v_stride + (px / 8);

  ivec2 texel = ivec2(
    (tile % ${g.atlasTilesPerRow}) * 8 + (px & 7),
    (tile / ${g.atlasTilesPerRow}) * 8 + (py & 7)
  );
  uint index = texelFetch(u_atlas, texel, 0).r;
  if (index == 0u) discard;   // colour 0 is transparent for objects

  outColor = texelFetch(u_palette, ivec2(int(index), ${g.paletteCount} + v_palette), 0);
}`;

const SHADOW_VERTEX = `#version 300 es
in vec2 a_local;
in vec2 a_instPos;   // where the sprite's feet touch the ground
in vec4 a_instData;  // radius in x/y

uniform mat4 u_viewProj;

out vec2 v_local;

void main() {
  vec2 offset = (a_local - 0.5) * 2.0 * a_instData.xy;
  vec3 world = vec3(a_instPos.x + offset.x, -(a_instPos.y + offset.y), 0.15);
  gl_Position = u_viewProj * vec4(world, 1.0);
  v_local = a_local;
}`;

const SHADOW_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 v_local;
uniform float u_opacity;
out vec4 outColor;

void main() {
  float distance = length(v_local * 2.0 - 1.0);
  float alpha = smoothstep(1.0, 0.25, distance) * u_opacity;
  if (alpha <= 0.004) discard;
  outColor = vec4(0.0, 0.0, 0.0, alpha);
}`;

/*
 * A plain textured quad, for frames the depth renderer cannot take apart.
 *
 * The rotating and bitmap modes have no grid of tiles to give height to, and a
 * game drops into one for a cut scene or a transition without warning. Showing
 * the finished picture for those frames keeps the game watchable instead of
 * going black until it returns to a mode with layers.
 */
const FLAT_VERTEX = `#version 300 es
in vec2 a_local;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_local.x, 1.0 - a_local.y);
  gl_Position = vec4(a_local * 2.0 - 1.0, 0.0, 1.0);
}`;

const FLAT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_frame;
out vec4 outColor;
void main() {
  outColor = vec4(texture(u_frame, v_uv).rgb, 1.0);
}`;

/* --- Renderer ----------------------------------------------------------- */

export class Depth25DRenderer implements SceneRenderer {
  readonly needsPpuState = true;

  settings: DepthSettings = { ...DEFAULT_DEPTH_SETTINGS };
  readonly heights = new TileHeightModel();

  private readonly viewProj: Mat4 = identity();
  private readonly flatProj: Mat4 = identity();
  private readonly view: Mat4 = identity();
  private readonly proj: Mat4 = identity();

  private readonly groundData = new Float32Array(MAX_GROUND_INSTANCES * INSTANCE_FLOATS);
  private readonly windowData = new Float32Array(MAX_GROUND_INSTANCES * INSTANCE_FLOATS);
  private readonly spriteData = new Float32Array(MAX_SPRITE_INSTANCES * INSTANCE_FLOATS);
  private readonly shadowData = new Float32Array(MAX_SPRITE_INSTANCES * INSTANCE_FLOATS);
  /** Sized for the widest palette layout either console uses. */
  private readonly paletteBytes = new Uint8Array(16 * 32 * 4);

  private disposed = false;

  private constructor(
    private readonly decoder: FrameDecoder,
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly tileProgram: WebGLProgram,
    private readonly spriteProgram: WebGLProgram,
    private readonly shadowProgram: WebGLProgram,
    private readonly atlasTexture: WebGLTexture,
    private readonly paletteTexture: WebGLTexture,
    private readonly boxVao: WebGLVertexArrayObject,
    private readonly boxInstances: WebGLBuffer,
    private readonly spriteVao: WebGLVertexArrayObject,
    private readonly spriteInstances: WebGLBuffer,
    private readonly shadowVao: WebGLVertexArrayObject,
    private readonly shadowInstances: WebGLBuffer,
    private readonly flatProgram: WebGLProgram,
    private readonly flatVao: WebGLVertexArrayObject,
    private readonly frameTexture: WebGLTexture,
    private readonly sideTexture: WebGLTexture,
  ) {}

  static create(canvas: HTMLCanvasElement, spec: SystemSpec): Depth25DRenderer | null {
    const decoder: FrameDecoder =
      spec.id === 'gba' ? new GbaPpuDecoder() : new PpuDecoder();
    const geometry = decoder.geometry;

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      depth: true,
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
    });
    if (!gl) return null;

    // The atlas and palette shapes differ per console, and the shader needs
    // them as compile-time constants, so the programs are built per system.
    const tileProgram = createProgram(gl, TILE_VERTEX, tileFragment(geometry));
    const spriteProgram = createProgram(gl, SPRITE_VERTEX, spriteFragment(geometry));
    const shadowProgram = createProgram(gl, SHADOW_VERTEX, SHADOW_FRAGMENT);

    const atlasTexture = createAtlasTexture(gl, geometry);
    const paletteTexture = createPaletteTexture(gl, geometry);

    const flatProgram = createProgram(gl, FLAT_VERTEX, FLAT_FRAGMENT);
    const flatVao = createFlatQuad(gl, flatProgram);
    const frameTexture = createFrameTexture(gl, geometry);
    const sideTexture = createSideTexture(gl, geometry);

    const box = createBoxGeometry(gl, tileProgram);
    const sprite = createQuadGeometry(gl, spriteProgram);
    const shadow = createQuadGeometry(gl, shadowProgram);

    return new Depth25DRenderer(
      decoder,
      canvas,
      gl,
      tileProgram,
      spriteProgram,
      shadowProgram,
      atlasTexture,
      paletteTexture,
      box.vao,
      box.instances,
      sprite.vao,
      sprite.instances,
      shadow.vao,
      shadow.instances,
      flatProgram,
      flatVao,
      frameTexture,
      sideTexture,
    );
  }

  resize(devicePixelRatio: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * devicePixelRatio));
    const height = Math.max(1, Math.round(rect.height * devicePixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  render(pixels: Uint32Array, ppuBlock: Uint8Array | null): void {
    if (this.disposed || !ppuBlock) return;

    const scene = this.decoder.decode(ppuBlock);
    if (!scene.displayOn) {
      // Nothing to build a scene from: either the display is off, or the game
      // is in a mode with no tiles. Either way the finished picture is the
      // honest thing to show.
      this.drawFlat(pixels);
      return;
    }
    this.heights.update(scene);

    const gl = this.gl;
    this.uploadAtlas(scene);
    this.uploadPalettes(scene);
    this.uploadSideColours(scene);
    this.buildCamera();

    // The world is not letterboxed into the console's rectangle: a tilted
    // ground plane looks like a diorama in a box that way, and the black bars
    // above and below are wasted screen. It fills the canvas instead, so the
    // view reaches further up the map and further to the sides — which is the
    // whole point of standing the world up.
    const geometry = this.decoder.geometry;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.scissor(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.clearColor(0.03, 0.04, 0.06, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);

    // Back to front, so a layer the hardware draws in front covers the ones
    // behind it. Only the hindmost carries height: raising every layer would
    // extrude the same scenery several times over.
    for (let i = 0; i < scene.ground.length; i++) {
      const layer = scene.ground[i]!;
      if (layer.cells.count === 0) continue;
      const count = this.fillCells(layer.cells, this.groundData, i === 0);
      this.drawTiles(
        this.groundData,
        count,
        this.viewProj,
        this.settings.extrusion,
        0,
        // Everything above the hindmost layer has a transparent colour zero;
        // without discarding it the layers below would be painted over.
        i > 0,
      );
    }

    if (this.settings.shadow > 0) this.drawShadows(scene);
    this.drawSprites(scene);

    // A HUD layer is glass, not world: flat, unlit, and always on top. It
    // keeps the console's own rectangle rather than being stretched across the
    // screen — a text box drawn for 240 pixels stays legible at 240 pixels.
    if (scene.hud.length > 0) {
      const box = fitViewport(
        this.canvas.width,
        this.canvas.height,
        geometry.screenWidth,
        geometry.screenHeight,
      );
      gl.viewport(box.x, box.y, box.width, box.height);
      gl.disable(gl.DEPTH_TEST);
      for (const layer of scene.hud) {
        if (layer.cells.count === 0) continue;
        const count = this.fillCells(layer.cells, this.windowData, false);
        this.drawTiles(this.windowData, count, this.flatProj, 0, 0, false);
      }
      gl.enable(gl.DEPTH_TEST);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    gl.disable(gl.SCISSOR_TEST);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteProgram(this.tileProgram);
    gl.deleteProgram(this.spriteProgram);
    gl.deleteProgram(this.shadowProgram);
    gl.deleteTexture(this.atlasTexture);
    gl.deleteTexture(this.paletteTexture);
    gl.deleteVertexArray(this.boxVao);
    gl.deleteVertexArray(this.spriteVao);
    gl.deleteVertexArray(this.shadowVao);
    gl.deleteBuffer(this.boxInstances);
    gl.deleteBuffer(this.spriteInstances);
    gl.deleteBuffer(this.shadowInstances);
  }

  /** Draws the emulator's own picture, for frames with no layers to rebuild. */
  private drawFlat(pixels: Uint32Array): void {
    const gl = this.gl;
    const { screenWidth, screenHeight } = this.decoder.geometry;
    if (pixels.length < screenWidth * screenHeight) return;

    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      screenWidth,
      screenHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(pixels.buffer, pixels.byteOffset, screenWidth * screenHeight * 4),
    );

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const frame = fitViewport(this.canvas.width, this.canvas.height, screenWidth, screenHeight);
    gl.viewport(frame.x, frame.y, frame.width, frame.height);

    gl.useProgram(this.flatProgram);
    gl.bindVertexArray(this.flatVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.uniform1i(this.uniform(this.flatProgram, 'u_frame'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.enable(gl.DEPTH_TEST);
  }

  /* --- internals ------------------------------------------------------- */

  private buildCamera(): void {
    // The viewport is always the console's aspect ratio, so the scene sits in
    // the same rectangle as the flat picture.
    const { screenWidth, screenHeight } = this.decoder.geometry;
    // The frustum matches the canvas, and the console's rectangle is what gets
    // framed inside it. On a tall phone that means the extra room goes into
    // seeing further up the map rather than into black bars.
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const centreX = screenWidth / 2;
    const centreY = -screenHeight / 2;
    const tilt = (this.settings.tiltDegrees * Math.PI) / 180;

    // Frame the screen area by fitting it, then correcting once for how much of
    // the frustum it actually filled. One correction is enough because at these
    // distances the projected size is very nearly inversely proportional to
    // the camera distance.
    let distance = (screenHeight / 2 / Math.tan(FOV_Y / 2)) * 1.2;
    for (let pass = 0; pass < 2; pass++) {
      this.placeCamera(distance, tilt, centreX, centreY, aspect);
      const fill = this.projectedFill();
      if (fill > 0) distance *= fill / 0.94;
    }
    this.placeCamera(distance, tilt, centreX, centreY, aspect);

    orthographic(this.flatProj, 0, screenWidth, -screenHeight, 0, -1, 1);
  }

  private placeCamera(
    distance: number,
    tilt: number,
    centreX: number,
    centreY: number,
    aspect: number,
  ): void {
    const eye: [number, number, number] = [
      centreX,
      centreY - distance * Math.cos(tilt),
      distance * Math.sin(tilt),
    ];
    perspective(this.proj, FOV_Y, aspect, 1, distance * 6);
    lookAt(this.view, eye, [centreX, centreY, 0], [0, 0, 1]);
    multiply(this.viewProj, this.proj, this.view);
  }

  /**
   * How much of the frustum the screen area currently covers, as a fraction
   * where 1 means it exactly touches the edges. Measured from the corners of
   * the visible ground including the tallest possible extrusion.
   */
  private projectedFill(): number {
    const { screenWidth, screenHeight } = this.decoder.geometry;
    const top = this.settings.extrusion;
    let extent = 0;
    for (const x of [0, screenWidth]) {
      for (const y of [0, -screenHeight]) {
        for (const z of [0, top]) {
          const clipX =
            this.viewProj[0]! * x + this.viewProj[4]! * y + this.viewProj[8]! * z + this.viewProj[12]!;
          const clipY =
            this.viewProj[1]! * x + this.viewProj[5]! * y + this.viewProj[9]! * z + this.viewProj[13]!;
          const clipW =
            this.viewProj[3]! * x + this.viewProj[7]! * y + this.viewProj[11]! * z + this.viewProj[15]!;
          if (clipW <= 0.0001) return 0;
          extent = Math.max(extent, Math.abs(clipX / clipW), Math.abs(clipY / clipW));
        }
      }
    }
    return extent;
  }

  private fillCells(cells: CellArrays, target: Float32Array, withHeight: boolean): number {
    for (let i = 0; i < cells.count; i++) {
      const base = i * INSTANCE_FLOATS;
      target[base] = cells.worldX[i]!;
      target[base + 1] = cells.worldY[i]!;
      target[base + 2] = cells.tile[i]!;
      target[base + 3] = cells.palette[i]!;
      target[base + 4] = cells.flip[i]!;
      target[base + 5] = withHeight ? this.heights.heightOf(cells.tile[i]!) : 0;
    }
    return cells.count;
  }

  private drawTiles(
    data: Float32Array,
    count: number,
    viewProj: Mat4,
    extrusion: number,
    paletteRow: number,
    discardZero: boolean,
  ): void {
    if (count === 0) return;
    const gl = this.gl;

    gl.useProgram(this.tileProgram);
    gl.bindVertexArray(this.boxVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxInstances);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * INSTANCE_FLOATS);

    gl.uniformMatrix4fv(this.uniform(this.tileProgram, 'u_viewProj'), false, viewProj);
    gl.uniform1f(this.uniform(this.tileProgram, 'u_extrusion'), extrusion);
    gl.uniform1i(this.uniform(this.tileProgram, 'u_paletteRow'), paletteRow);
    gl.uniform1i(this.uniform(this.tileProgram, 'u_discardZero'), discardZero ? 1 : 0);
    const { screenWidth, screenHeight } = this.decoder.geometry;
    gl.uniform2f(this.uniform(this.tileProgram, 'u_screen'), screenWidth, screenHeight);
    this.bindTextures(this.tileProgram);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 30, count);
  }

  private drawSprites(scene: DepthScene): void {
    const sprites = scene.sprites;
    if (sprites.count === 0) return;

    for (let i = 0; i < sprites.count; i++) {
      const base = i * INSTANCE_FLOATS;
      this.spriteData[base] = sprites.x[i]!;
      this.spriteData[base + 1] = sprites.y[i]!;
      this.spriteData[base + 2] = sprites.tile[i]!;
      this.spriteData[base + 3] = sprites.palette[i]!;
      this.spriteData[base + 4] = sprites.flip[i]!;
      this.spriteData[base + 5] = sprites.height[i]!;
      this.spriteData[base + 6] = sprites.width[i]!;
      this.spriteData[base + 7] = sprites.tileStride[i]!;
    }

    const gl = this.gl;
    gl.useProgram(this.spriteProgram);
    gl.bindVertexArray(this.spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteInstances);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.spriteData, 0, sprites.count * INSTANCE_FLOATS);

    gl.uniformMatrix4fv(this.uniform(this.spriteProgram, 'u_viewProj'), false, this.viewProj);
    gl.uniform1f(this.uniform(this.spriteProgram, 'u_stand'), this.settings.stand);
    this.bindTextures(this.spriteProgram);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, sprites.count);
  }

  private drawShadows(scene: DepthScene): void {
    const sprites = scene.sprites;
    if (sprites.count === 0) return;

    for (let i = 0; i < sprites.count; i++) {
      const base = i * INSTANCE_FLOATS;
      this.shadowData[base] = sprites.x[i]! + sprites.width[i]! / 2;
      this.shadowData[base + 1] = sprites.y[i]! + sprites.height[i]! - 2;
      // Roughly the object's own footprint, squashed to lie on the ground.
      this.shadowData[base + 2] = sprites.width[i]! * 0.4;
      this.shadowData[base + 3] = sprites.width[i]! * 0.2;
      this.shadowData[base + 4] = 0;
      this.shadowData[base + 5] = 0;
    }

    const gl = this.gl;
    gl.useProgram(this.shadowProgram);
    gl.bindVertexArray(this.shadowVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowInstances);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.shadowData, 0, sprites.count * INSTANCE_FLOATS);

    gl.uniformMatrix4fv(this.uniform(this.shadowProgram, 'u_viewProj'), false, this.viewProj);
    gl.uniform1f(this.uniform(this.shadowProgram, 'u_opacity'), this.settings.shadow);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, sprites.count);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  private bindTextures(program: WebGLProgram): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.uniform1i(this.uniform(program, 'u_atlas'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.uniform1i(this.uniform(program, 'u_palette'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.sideTexture);
    gl.uniform1i(this.uniform(program, 'u_sideIndex'), 2);
  }

  private uploadAtlas(scene: DepthScene): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      scene.geometry.atlasWidth,
      scene.geometry.atlasHeight,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      scene.tileAtlas,
    );
  }

  /** One texel per tile: the colour its extruded walls are painted with. */
  private uploadSideColours(scene: DepthScene): void {
    const gl = this.gl;
    const { atlasTilesPerRow, maxTiles } = scene.geometry;
    gl.bindTexture(gl.TEXTURE_2D, this.sideTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      atlasTilesPerRow,
      maxTiles / atlasTilesPerRow,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      scene.tileSideIndex,
    );
  }

  private uploadPalettes(scene: DepthScene): void {
    // One row per palette: the background bank first, then the object bank.
    const { paletteSize, paletteCount } = scene.geometry;
    const entries = paletteSize * paletteCount;

    const write = (source: Uint32Array, rowOffset: number) => {
      for (let entry = 0; entry < entries; entry++) {
        const colour = source[entry]! >>> 0;
        const target = (rowOffset * paletteSize + entry) * 4;
        this.paletteBytes[target] = colour & 0xff;
        this.paletteBytes[target + 1] = (colour >> 8) & 0xff;
        this.paletteBytes[target + 2] = (colour >> 16) & 0xff;
        this.paletteBytes[target + 3] = 255;
      }
    };
    write(scene.bgPalettes, 0);
    write(scene.objPalettes, paletteCount);

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      paletteSize,
      paletteCount * 2,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.paletteBytes,
    );
  }

  private uniform(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    return this.gl.getUniformLocation(program, name);
  }
}

/* --- Geometry and GL helpers -------------------------------------------- */

/**
 * A unit box as five faces: the top, plus four sides that sample the tile's
 * edge row or column so an extruded tile looks like the pixel art it came
 * from, with each face shaded differently so the form reads.
 */
function boxVertices(): Float32Array {
  const data: number[] = [];

  const quad = (
    corners: [number, number, number][],
    uvs: [number, number][],
    shade: number,
    side = 1,
  ) => {
    const order = [0, 1, 2, 0, 2, 3];
    for (const i of order) {
      const c = corners[i]!;
      const uv = uvs[i]!;
      data.push(c[0], c[1], c[2], uv[0], uv[1], shade, side);
    }
  };

  // Top face: the tile as drawn.
  quad(
    [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    1.0,
    0,
  );

  /*
   * Front face: the tile again, standing upright.
   *
   * These games draw a building's lower rows as a facade — a door is drawn
   * front-on, a window is drawn front-on — while the ground is drawn from
   * above. So the face turned towards the camera is exactly where that art
   * belongs, and a raised door tile becomes a door in a wall instead of a
   * dark streak under one.
   */
  quad(
    [
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
      [0, 1, 0],
    ],
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    0.86,
    0,
  );

  /*
   * The other three walls carry no art.
   *
   * They are turned away from the camera, and there is nothing to put on them:
   * stretching a row of the tile down a wall is what produced the smears this
   * replaces. They take the tile's own dominant colour instead, shaded.
   */
  quad(
    [
      [1, 0, 1],
      [0, 0, 1],
      [0, 0, 0],
      [1, 0, 0],
    ],
    [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    0.5,
  );
  quad(
    [
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
      [0, 0, 0],
    ],
    [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    0.6,
  );
  quad(
    [
      [1, 1, 1],
      [1, 0, 1],
      [1, 0, 0],
      [1, 1, 0],
    ],
    [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    0.66,
  );

  return new Float32Array(data);
}

function createBoxGeometry(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): { vao: WebGLVertexArrayObject; instances: WebGLBuffer } {
  const vao = gl.createVertexArray();
  const vertices = gl.createBuffer();
  const instances = gl.createBuffer();
  if (!vao || !vertices || !instances) throw new Error('WebGL-Puffer konnten nicht angelegt werden');

  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bufferData(gl.ARRAY_BUFFER, boxVertices(), gl.STATIC_DRAW);
  const stride = 7 * 4;
  bindAttribute(gl, program, 'a_local', 3, stride, 0);
  bindAttribute(gl, program, 'a_uv', 2, stride, 3 * 4);
  bindAttribute(gl, program, 'a_shade', 1, stride, 5 * 4);
  bindAttribute(gl, program, 'a_side', 1, stride, 6 * 4);

  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  gl.bufferData(gl.ARRAY_BUFFER, MAX_GROUND_INSTANCES * INSTANCE_FLOATS * 4, gl.DYNAMIC_DRAW);
  bindInstanceAttributes(gl, program);

  gl.bindVertexArray(null);
  return { vao, instances };
}

function createQuadGeometry(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): { vao: WebGLVertexArrayObject; instances: WebGLBuffer } {
  const vao = gl.createVertexArray();
  const vertices = gl.createBuffer();
  const instances = gl.createBuffer();
  if (!vao || !vertices || !instances) throw new Error('WebGL-Puffer konnten nicht angelegt werden');

  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
    gl.STATIC_DRAW,
  );
  bindAttribute(gl, program, 'a_local', 2, 2 * 4, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  gl.bufferData(gl.ARRAY_BUFFER, MAX_SPRITE_INSTANCES * INSTANCE_FLOATS * 4, gl.DYNAMIC_DRAW);
  bindInstanceAttributes(gl, program);

  gl.bindVertexArray(null);
  return { vao, instances };
}

function bindInstanceAttributes(gl: WebGL2RenderingContext, program: WebGLProgram): void {
  const stride = INSTANCE_FLOATS * 4;
  bindAttribute(gl, program, 'a_instPos', 2, stride, 0, 1);
  bindAttribute(gl, program, 'a_instData', 4, stride, 2 * 4, 1);
  // Only the sprite program declares this one; the helper skips it elsewhere.
  bindAttribute(gl, program, 'a_instExtra', 2, stride, 6 * 4, 1);
}

function bindAttribute(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
  size: number,
  stride: number,
  offset: number,
  divisor = 0,
): void {
  const location = gl.getAttribLocation(program, name);
  if (location < 0) return; // optimised out of this program
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
  if (divisor) gl.vertexAttribDivisor(location, divisor);
}

function createAtlasTexture(
  gl: WebGL2RenderingContext,
  geometry: SceneGeometry,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Textur konnte nicht erstellt werden');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // R8UI: colour indices, not colours. Integer textures must sample NEAREST.
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, geometry.atlasWidth, geometry.atlasHeight);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function createPaletteTexture(
  gl: WebGL2RenderingContext,
  geometry: SceneGeometry,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Textur konnte nicht erstellt werden');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, geometry.paletteSize, geometry.paletteCount * 2);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Shader konnte nicht erstellt werden');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader-Fehler: ${log}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('Programm konnte nicht erstellt werden');
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vs);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Link-Fehler: ${log}`);
  }
  return program;
}

/** A screen-filling quad for the flat fallback. */
function createFlatQuad(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  const vertices = gl.createBuffer();
  if (!vao || !vertices) throw new Error('WebGL-Puffer konnten nicht angelegt werden');

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
    gl.STATIC_DRAW,
  );
  bindAttribute(gl, program, 'a_local', 2, 2 * 4, 0);
  gl.bindVertexArray(null);
  return vao;
}

/** Holds the emulator's finished picture for the flat fallback. */
function createFrameTexture(
  gl: WebGL2RenderingContext,
  geometry: SceneGeometry,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('WebGL-Textur konnte nicht angelegt werden');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, geometry.screenWidth, geometry.screenHeight);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** One texel per tile, holding the colour index its walls are painted with. */
function createSideTexture(
  gl: WebGL2RenderingContext,
  geometry: SceneGeometry,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('WebGL-Textur konnte nicht angelegt werden');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(
    gl.TEXTURE_2D,
    1,
    gl.R8UI,
    geometry.atlasTilesPerRow,
    geometry.maxTiles / geometry.atlasTilesPerRow,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return texture;
}
