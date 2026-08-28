/**
 * WebGL2 renderer for the emulated screen.
 *
 * Deliberately minimal: one texture, one quad, nearest-neighbour sampling.
 * The Game Boy's 160x144 is upscaled by a non-integer factor on most phone
 * screens, so the quad is snapped to whole pixels where it can be and the
 * remainder is letterboxed — that keeps the pixel grid even instead of showing
 * rows of different thickness.
 *
 * The 2.5D renderer of a later phase plugs in alongside this one; both consume
 * the same frame data.
 */

import type { SystemSpec } from '../core/systems';
import type { SceneRenderer } from './SceneRenderer';

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
uniform vec2 u_uvScale;
void main() {
  // Fullscreen triangle-pair in clip space; flip V so row 0 is at the top.
  v_uv = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5) * u_uvScale;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_frame;
uniform vec2 u_frameSize;   // picture size in emulated pixels
uniform float u_grid;       // strength of the LCD grid, 0 disables it
uniform float u_scale;      // how many device pixels one emulated pixel covers
out vec4 outColor;

void main() {
  vec4 colour = texture(u_frame, v_uv);

  if (u_grid > 0.0) {
    // Darken the edge of every emulated pixel, the way the gaps between an
    // LCD's cells read. Below a few device pixels per emulated pixel there is
    // no room for a gap, so the effect fades out rather than muddying the
    // picture.
    vec2 within = fract(v_uv * u_frameSize);
    float edge = min(min(within.x, 1.0 - within.x), min(within.y, 1.0 - within.y));
    float lit = smoothstep(0.0, 0.12, edge);
    float strength = u_grid * clamp((u_scale - 2.0) / 2.0, 0.0, 1.0);
    colour.rgb *= mix(1.0 - strength, 1.0, lit);
  }

  outColor = colour;
}`;

export class GLRenderer implements SceneRenderer {
  readonly needsPpuState = false;

  private gl: WebGL2RenderingContext;
  private texture: WebGLTexture;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private disposed = false;
  private frameWidth: number;
  private frameHeight: number;
  /** LCD grid strength, 0 to 1. */
  gridStrength = 0;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    private readonly spec: SystemSpec,
  ) {
    this.gl = gl;
    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.texture = createScreenTexture(gl, spec.width, spec.height);
    this.frameWidth = spec.width;
    this.frameHeight = spec.height;
    this.vao = createQuad(gl, this.program);

    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_frame'), 0);
    gl.clearColor(0, 0, 0, 1);
  }

  static create(canvas: HTMLCanvasElement, spec: SystemSpec): GLRenderer | null {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      // The browser may composite before we draw the next frame; keeping the
      // buffer avoids a flash of black when the emulator is paused.
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
    });
    if (!gl) return null;
    return new GLRenderer(canvas, gl, spec);
  }

  /** Resizes the drawing buffer to the element's size in device pixels. */
  resize(devicePixelRatio: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * devicePixelRatio));
    const height = Math.max(1, Math.round(rect.height * devicePixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /** Uploads one frame of RGBA8888 pixels and draws it. */
  render(pixels: Uint32Array, _ppuBlock: Uint8Array | null, width: number, height: number): void {
    if (this.disposed) return;
    const gl = this.gl;

    // The texture is allocated once at the system's largest size; a frame that
    // is a different shape (a DS with its screens rearranged) reuses the same
    // storage and only changes which part of it is written and drawn.
    if (width !== this.frameWidth || height !== this.frameHeight) {
      this.frameWidth = width;
      this.frameHeight = height;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.frameWidth,
      this.frameHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    );

    // The depth renderer may have shared this context and left state behind.
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    const view = fitViewport(
      this.canvas.width,
      this.canvas.height,
      this.frameWidth,
      this.frameHeight,
    );
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(view.x, view.y, view.width, view.height);

    gl.useProgram(this.program);
    gl.uniform2f(
      gl.getUniformLocation(this.program, 'u_uvScale'),
      this.frameWidth / this.spec.width,
      this.frameHeight / this.spec.height,
    );
    gl.uniform2f(
      gl.getUniformLocation(this.program, 'u_frameSize'),
      this.spec.width,
      this.spec.height,
    );
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_grid'), this.gridStrength);
    gl.uniform1f(
      gl.getUniformLocation(this.program, 'u_scale'),
      view.width / Math.max(1, this.frameWidth),
    );
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}

/** Give up at most this fraction of the picture to gain an even pixel grid. */
const MAX_SNAP_WASTE = 0.1;

/**
 * Largest centred rectangle with the console's aspect ratio.
 *
 * A whole-number scale keeps every emulated pixel the same size, which matters
 * for pixel art — but insisting on it can throw away a fifth of a phone screen
 * (393 CSS px at 2x device pixels snaps 4.91 down to 4). So it snaps only when
 * that costs little; otherwise it fills the space and lets nearest-neighbour
 * sampling deal with the uneven rows, which is the better trade at the high
 * pixel densities phones actually have.
 */
export function fitViewport(
  bufferWidth: number,
  bufferHeight: number,
  nativeWidth: number,
  nativeHeight: number,
): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(bufferWidth / nativeWidth, bufferHeight / nativeHeight);

  let chosen = scale;
  if (scale >= 1) {
    const snapped = Math.floor(scale);
    if ((scale - snapped) / scale <= MAX_SNAP_WASTE) chosen = snapped;
  }

  const width = Math.round(nativeWidth * chosen);
  const height = Math.round(nativeHeight * chosen);
  return {
    x: Math.round((bufferWidth - width) / 2),
    y: Math.round((bufferHeight - height) / 2),
    width,
    height,
  };
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

function createScreenTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Textur konnte nicht erstellt werden');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );
  // Nearest in both directions: a Game Boy pixel is a square, not a blur.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function createQuad(gl: WebGL2RenderingContext, program: WebGLProgram): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('VAO konnte nicht erstellt werden');
  gl.bindVertexArray(vao);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );

  const location = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

  gl.bindVertexArray(null);
  return vao;
}
