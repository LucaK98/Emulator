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

import { GB_SCREEN_HEIGHT, GB_SCREEN_WIDTH } from '../core/protocol';
import { TileHeightModel } from './heightModel';
import {
  ATLAS_HEIGHT,
  ATLAS_TILES_PER_ROW,
  ATLAS_WIDTH,
  PpuDecoder,
  type CellArrays,
  type GbScene,
} from './ppu/decode';
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
const MAX_GROUND_INSTANCES = 22 * 20;
const MAX_SPRITE_INSTANCES = 40;
/** Floats per instance: worldX, worldY, tile, palette, flip, height. */
const INSTANCE_FLOATS = 6;

/* --- Shaders ------------------------------------------------------------ */

const TILE_VERTEX = `#version 300 es
in vec3 a_local;      // unit cube, 0..1 on each axis
in vec2 a_uv;         // where in the tile this vertex samples
in float a_shade;     // face shading, so the sides read as sides

in vec2 a_instPos;    // cell origin in screen pixels
in vec4 a_instData;   // tile, palette, flip bits, height 0..1

uniform mat4 u_viewProj;
uniform float u_extrusion;

out vec2 v_uv;
flat out int v_tile;
flat out int v_palette;
flat out int v_flip;
out float v_shade;

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
}`;

const TILE_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

in vec2 v_uv;
flat in int v_tile;
flat in int v_palette;
flat in int v_flip;
in float v_shade;

uniform usampler2D u_atlas;
uniform sampler2D u_palette;
uniform int u_paletteRow;   // 0 for background palettes, 8 for object palettes
uniform int u_discardZero;  // objects treat colour 0 as transparent

out vec4 outColor;

void main() {
  int tx = int(floor(clamp(v_uv.x, 0.0, 0.9999) * 8.0));
  int ty = int(floor(clamp(v_uv.y, 0.0, 0.9999) * 8.0));
  if ((v_flip & 1) != 0) tx = 7 - tx;
  if ((v_flip & 2) != 0) ty = 7 - ty;

  ivec2 texel = ivec2(
    (v_tile % ${ATLAS_TILES_PER_ROW}) * 8 + tx,
    (v_tile / ${ATLAS_TILES_PER_ROW}) * 8 + ty
  );
  uint index = texelFetch(u_atlas, texel, 0).r;
  if (u_discardZero == 1 && index == 0u) discard;

  vec4 colour = texelFetch(u_palette, ivec2(int(index), u_paletteRow + v_palette), 0);
  outColor = vec4(colour.rgb * v_shade, 1.0);
}`;

const SPRITE_VERTEX = `#version 300 es
in vec2 a_local;      // 0..1 across the sprite, v = 0 at the top

in vec2 a_instPos;    // sprite top-left in screen pixels
in vec4 a_instData;   // tile, palette, flip bits, pixel height (8 or 16)

uniform mat4 u_viewProj;
uniform float u_stand;

out vec2 v_local;
flat out int v_tile;
flat out int v_palette;
flat out int v_flip;
flat out int v_height;

void main() {
  float height = a_instData.w;
  float x = a_instPos.x + a_local.x * 8.0;

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
}`;

const SPRITE_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

in vec2 v_local;
flat in int v_tile;
flat in int v_palette;
flat in int v_flip;
flat in int v_height;

uniform usampler2D u_atlas;
uniform sampler2D u_palette;

out vec4 outColor;

void main() {
  float v = clamp(v_local.y, 0.0, 0.9999);
  int row = int(floor(v * float(v_height)));
  int column = int(floor(clamp(v_local.x, 0.0, 0.9999) * 8.0));
  if ((v_flip & 1) != 0) column = 7 - column;
  if ((v_flip & 2) != 0) row = v_height - 1 - row;

  // A tall object is two tiles stacked; the row decides which half.
  int tile = v_tile + (row >= 8 ? 1 : 0);
  int ty = row & 7;

  ivec2 texel = ivec2(
    (tile % ${ATLAS_TILES_PER_ROW}) * 8 + column,
    (tile / ${ATLAS_TILES_PER_ROW}) * 8 + ty
  );
  uint index = texelFetch(u_atlas, texel, 0).r;
  if (index == 0u) discard;   // colour 0 is transparent for objects

  outColor = texelFetch(u_palette, ivec2(int(index), 8 + v_palette), 0);
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

/* --- Renderer ----------------------------------------------------------- */

export class Depth25DRenderer implements SceneRenderer {
  readonly needsPpuState = true;

  settings: DepthSettings = { ...DEFAULT_DEPTH_SETTINGS };
  readonly heights = new TileHeightModel();

  private readonly decoder = new PpuDecoder();
  private readonly viewProj: Mat4 = identity();
  private readonly flatProj: Mat4 = identity();
  private readonly view: Mat4 = identity();
  private readonly proj: Mat4 = identity();

  private readonly groundData = new Float32Array(MAX_GROUND_INSTANCES * INSTANCE_FLOATS);
  private readonly windowData = new Float32Array(MAX_GROUND_INSTANCES * INSTANCE_FLOATS);
  private readonly spriteData = new Float32Array(MAX_SPRITE_INSTANCES * INSTANCE_FLOATS);
  private readonly shadowData = new Float32Array(MAX_SPRITE_INSTANCES * INSTANCE_FLOATS);
  private readonly paletteBytes = new Uint8Array(4 * 16 * 4);

  private disposed = false;

  private constructor(
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
  ) {}

  static create(canvas: HTMLCanvasElement): Depth25DRenderer | null {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      depth: true,
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
    });
    if (!gl) return null;

    const tileProgram = createProgram(gl, TILE_VERTEX, TILE_FRAGMENT);
    const spriteProgram = createProgram(gl, SPRITE_VERTEX, SPRITE_FRAGMENT);
    const shadowProgram = createProgram(gl, SHADOW_VERTEX, SHADOW_FRAGMENT);

    const atlasTexture = createAtlasTexture(gl);
    const paletteTexture = createPaletteTexture(gl);

    const box = createBoxGeometry(gl, tileProgram);
    const sprite = createQuadGeometry(gl, spriteProgram);
    const shadow = createQuadGeometry(gl, shadowProgram);

    return new Depth25DRenderer(
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

  render(_pixels: Uint32Array, ppuBlock: Uint8Array | null): void {
    if (this.disposed || !ppuBlock) return;

    const scene = this.decoder.decode(ppuBlock);
    this.heights.update(scene);

    const gl = this.gl;
    this.uploadAtlas(scene);
    this.uploadPalettes(scene);
    this.buildCamera();

    // The scene occupies exactly the rectangle the flat renderer would use, so
    // toggling between the two does not move or resize the picture.
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const frame = fitViewport(
      this.canvas.width,
      this.canvas.height,
      GB_SCREEN_WIDTH,
      GB_SCREEN_HEIGHT,
    );
    gl.viewport(frame.x, frame.y, frame.width, frame.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(frame.x, frame.y, frame.width, frame.height);
    gl.clearColor(0.03, 0.04, 0.06, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);

    if (scene.bgEnabled) {
      const count = this.fillCells(scene.ground, this.groundData, true);
      this.drawTiles(this.groundData, count, this.viewProj, this.settings.extrusion, 0, false);
    }

    if (this.settings.shadow > 0) this.drawShadows(scene);
    this.drawSprites(scene);

    if (scene.window.count > 0) {
      // The window is glass, not world: flat, unlit, and always on top.
      const count = this.fillCells(scene.window, this.windowData, false);
      gl.disable(gl.DEPTH_TEST);
      this.drawTiles(this.windowData, count, this.flatProj, 0, 0, false);
      gl.enable(gl.DEPTH_TEST);
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

  /* --- internals ------------------------------------------------------- */

  private buildCamera(): void {
    // The viewport is always the console's aspect ratio, so the scene sits in
    // the same rectangle as the flat picture.
    const aspect = GB_SCREEN_WIDTH / GB_SCREEN_HEIGHT;
    const centreX = GB_SCREEN_WIDTH / 2;
    const centreY = -GB_SCREEN_HEIGHT / 2;
    const tilt = (this.settings.tiltDegrees * Math.PI) / 180;

    // Frame the screen area by fitting it, then correcting once for how much of
    // the frustum it actually filled. One correction is enough because at these
    // distances the projected size is very nearly inversely proportional to
    // the camera distance.
    let distance = (GB_SCREEN_HEIGHT / 2 / Math.tan(FOV_Y / 2)) * 1.2;
    for (let pass = 0; pass < 2; pass++) {
      this.placeCamera(distance, tilt, centreX, centreY, aspect);
      const fill = this.projectedFill();
      if (fill > 0) distance *= fill / 0.94;
    }
    this.placeCamera(distance, tilt, centreX, centreY, aspect);

    orthographic(this.flatProj, 0, GB_SCREEN_WIDTH, -GB_SCREEN_HEIGHT, 0, -1, 1);
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
    const top = this.settings.extrusion;
    let extent = 0;
    for (const x of [0, GB_SCREEN_WIDTH]) {
      for (const y of [0, -GB_SCREEN_HEIGHT]) {
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
    this.bindTextures(this.tileProgram);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 30, count);
  }

  private drawSprites(scene: GbScene): void {
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

  private drawShadows(scene: GbScene): void {
    const sprites = scene.sprites;
    if (sprites.count === 0) return;

    for (let i = 0; i < sprites.count; i++) {
      const base = i * INSTANCE_FLOATS;
      this.shadowData[base] = sprites.x[i]! + 4;
      this.shadowData[base + 1] = sprites.y[i]! + sprites.height[i]! - 2;
      this.shadowData[base + 2] = 6; // radius x
      this.shadowData[base + 3] = 3; // radius y, squashed to sit on the ground
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
  }

  private uploadAtlas(scene: GbScene): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      ATLAS_WIDTH,
      ATLAS_HEIGHT,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      scene.tileAtlas,
    );
  }

  private uploadPalettes(scene: GbScene): void {
    // Rows 0..7 are background palettes, 8..15 objects; four colours each.
    const write = (source: Uint32Array, rowOffset: number) => {
      for (let entry = 0; entry < 32; entry++) {
        const colour = source[entry]! >>> 0;
        const target = (rowOffset * 4 + entry) * 4;
        this.paletteBytes[target] = colour & 0xff;
        this.paletteBytes[target + 1] = (colour >> 8) & 0xff;
        this.paletteBytes[target + 2] = (colour >> 16) & 0xff;
        this.paletteBytes[target + 3] = 255;
      }
    };
    write(scene.bgPalettes, 0);
    write(scene.objPalettes, 8);

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4, 16, gl.RGBA, gl.UNSIGNED_BYTE, this.paletteBytes);
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
  ) => {
    const order = [0, 1, 2, 0, 2, 3];
    for (const i of order) {
      const c = corners[i]!;
      const uv = uvs[i]!;
      data.push(c[0], c[1], c[2], uv[0], uv[1], shade);
    }
  };

  // Top face: sampled as the tile itself.
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
  );

  // Front (towards the camera): repeats the tile's bottom row.
  quad(
    [
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
      [0, 1, 0],
    ],
    [
      [0, 0.99],
      [1, 0.99],
      [1, 0.99],
      [0, 0.99],
    ],
    0.74,
  );

  // Back: the tile's top row.
  quad(
    [
      [1, 0, 1],
      [0, 0, 1],
      [0, 0, 0],
      [1, 0, 0],
    ],
    [
      [1, 0],
      [0, 0],
      [0, 0],
      [1, 0],
    ],
    0.5,
  );

  // Left and right: the tile's edge columns.
  quad(
    [
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
      [0, 0, 0],
    ],
    [
      [0, 0],
      [0, 1],
      [0, 1],
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
      [0.99, 1],
      [0.99, 0],
      [0.99, 0],
      [0.99, 1],
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
  const stride = 6 * 4;
  bindAttribute(gl, program, 'a_local', 3, stride, 0);
  bindAttribute(gl, program, 'a_uv', 2, stride, 3 * 4);
  bindAttribute(gl, program, 'a_shade', 1, stride, 5 * 4);

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

function createAtlasTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Textur konnte nicht erstellt werden');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // R8UI: colour indices, not colours. Integer textures must sample NEAREST.
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, ATLAS_WIDTH, ATLAS_HEIGHT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function createPaletteTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Textur konnte nicht erstellt werden');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 4, 16);
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
