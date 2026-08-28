/**
 * Turns an emulator frame into a data URL for library tiles and save-state
 * previews. Drawn at 2x so the tile still looks like pixel art rather than a
 * blurry postage stamp.
 */

import type { SystemSpec } from '../core/systems';

const SCALE = 2;

export function frameToDataUrl(pixels: Uint32Array, spec: SystemSpec): string | null {
  const source = document.createElement('canvas');
  source.width = spec.width;
  source.height = spec.height;
  const sourceCtx = source.getContext('2d');
  if (!sourceCtx) return null;

  // ImageData must not be backed by a SharedArrayBuffer, and constructing a
  // Uint8ClampedArray from a typed array copies into a fresh, unshared buffer.
  const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const rgba = new Uint8ClampedArray(bytes);
  sourceCtx.putImageData(new ImageData(rgba, spec.width, spec.height), 0, 0);

  const scaled = document.createElement('canvas');
  scaled.width = spec.width * SCALE;
  scaled.height = spec.height * SCALE;
  const scaledCtx = scaled.getContext('2d');
  if (!scaledCtx) return null;
  scaledCtx.imageSmoothingEnabled = false;
  scaledCtx.drawImage(source, 0, 0, scaled.width, scaled.height);

  return scaled.toDataURL('image/png');
}
