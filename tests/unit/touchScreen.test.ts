/**
 * The touch mapping is the one piece of DS input that can be checked without a
 * device: a tap has to land where the player thinks it landed, in both screen
 * arrangements and with the letterbox taken into account.
 */

import { describe, expect, it } from 'vitest';
import { Layout, mapToTouchScreen } from '../../src/input/touchScreen';

const STACKED = { width: 256, height: 384 };
const SIDE_BY_SIDE = { width: 512, height: 192 };

describe('mapToTouchScreen', () => {
  describe('stacked', () => {
    // A canvas exactly the frame's shape, so there is no letterbox to unpick.
    const canvas = { width: 256, height: 384 };

    it('ignores taps on the upper screen', () => {
      expect(mapToTouchScreen({ x: 128, y: 10 }, canvas, STACKED, Layout.Stacked)).toBeNull();
      expect(mapToTouchScreen({ x: 128, y: 191 }, canvas, STACKED, Layout.Stacked)).toBeNull();
    });

    it('maps the lower screen to console coordinates', () => {
      expect(mapToTouchScreen({ x: 0, y: 192 }, canvas, STACKED, Layout.Stacked)).toEqual({
        x: 0,
        y: 0,
      });
      expect(mapToTouchScreen({ x: 255, y: 383 }, canvas, STACKED, Layout.Stacked)).toEqual({
        x: 255,
        y: 191,
      });
      expect(mapToTouchScreen({ x: 128, y: 288 }, canvas, STACKED, Layout.Stacked)).toEqual({
        x: 128,
        y: 96,
      });
    });
  });

  describe('side by side', () => {
    const canvas = { width: 512, height: 192 };

    it('takes the right-hand screen as the touch screen', () => {
      expect(
        mapToTouchScreen({ x: 100, y: 96 }, canvas, SIDE_BY_SIDE, Layout.SideBySide),
      ).toBeNull();
      expect(
        mapToTouchScreen({ x: 256, y: 0 }, canvas, SIDE_BY_SIDE, Layout.SideBySide),
      ).toEqual({ x: 0, y: 0 });
      expect(
        mapToTouchScreen({ x: 511, y: 191 }, canvas, SIDE_BY_SIDE, Layout.SideBySide),
      ).toEqual({ x: 255, y: 191 });
    });
  });

  it('accounts for the letterbox on a differently shaped canvas', () => {
    // 400x400 holding a 256x384 picture: the drawn rectangle is centred with
    // bars down the sides.
    const canvas = { width: 400, height: 400 };
    expect(mapToTouchScreen({ x: 5, y: 200 }, canvas, STACKED, Layout.Stacked)).toBeNull();

    const centre = mapToTouchScreen({ x: 200, y: 300 }, canvas, STACKED, Layout.Stacked);
    expect(centre).not.toBeNull();
    expect(centre!.x).toBeGreaterThan(120);
    expect(centre!.x).toBeLessThan(136);
  });

  it('ignores taps outside the picture entirely', () => {
    const canvas = { width: 256, height: 384 };
    expect(mapToTouchScreen({ x: -5, y: 300 }, canvas, STACKED, Layout.Stacked)).toBeNull();
    expect(mapToTouchScreen({ x: 300, y: 300 }, canvas, STACKED, Layout.Stacked)).toBeNull();
  });
});
