/**
 * Maps a tap on the canvas to a position on the console's touch screen.
 *
 * The canvas shows the whole composed picture letterboxed, so a tap has to be
 * translated twice: from the element into the drawn rectangle, and from there
 * into the lower screen — which sits in a different place depending on how the
 * two screens are arranged.
 */

import { fitViewport } from '../render/GLRenderer';
import { NDS_SCREEN } from '../core/systems';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Screen arrangements, matching the ids the core uses. */
export const Layout = { Stacked: 0, SideBySide: 1 } as const;

/**
 * Returns the touch position in the console's own coordinates, or null when
 * the tap was outside the lower screen — on the upper screen, or in the
 * letterbox around the picture.
 */
export function mapToTouchScreen(
  pointer: Point,
  canvas: Size,
  frame: Size,
  layout: number,
): Point | null {
  const view = fitViewport(canvas.width, canvas.height, frame.width, frame.height);
  if (view.width <= 0 || view.height <= 0) return null;

  // Into the drawn rectangle, then into frame pixels.
  const frameX = ((pointer.x - view.x) / view.width) * frame.width;
  const frameY = ((pointer.y - view.y) / view.height) * frame.height;
  if (frameX < 0 || frameY < 0 || frameX >= frame.width || frameY >= frame.height) return null;

  const originX = layout === Layout.SideBySide ? NDS_SCREEN.width : 0;
  const originY = layout === Layout.SideBySide ? 0 : NDS_SCREEN.height;

  const x = frameX - originX;
  const y = frameY - originY;
  if (x < 0 || y < 0 || x >= NDS_SCREEN.width || y >= NDS_SCREEN.height) return null;

  return { x: Math.floor(x), y: Math.floor(y) };
}
