import { describe, expect, it } from 'vitest';
import { fitViewport } from '../../src/render/GLRenderer';

const ASPECT = 160 / 144;

describe('fitViewport', () => {
  it('keeps the console aspect ratio', () => {
    for (const [w, h] of [
      [786, 1380],
      [1179, 2000],
      [900, 400],
      [320, 288],
    ] as const) {
      const rect = fitViewport(w, h);
      expect(rect.width / rect.height).toBeCloseTo(ASPECT, 2);
    }
  });

  it('never draws outside the buffer', () => {
    for (const [w, h] of [
      [786, 1380],
      [900, 400],
      [100, 100],
    ] as const) {
      const rect = fitViewport(w, h);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(w);
      expect(rect.y + rect.height).toBeLessThanOrEqual(h);
    }
  });

  it('snaps to a whole scale when that costs almost nothing', () => {
    // 1179 device px wide (iPhone 15 Pro at 3x) => scale 7.37; snapping to 7
    // gives up 5%, which is worth an even pixel grid.
    const rect = fitViewport(1179, 2000);
    expect(rect.width).toBe(160 * 7);
  });

  it('fills the space when snapping would waste too much', () => {
    // 786 device px wide (393 CSS at 2x) => scale 4.91; snapping to 4 would
    // throw away 19% of the picture, so it must not.
    const rect = fitViewport(786, 1380);
    expect(rect.width).toBeGreaterThan(160 * 4.5);
    expect(rect.width).toBeLessThanOrEqual(786);
  });

  it('handles viewports smaller than the native resolution', () => {
    const rect = fitViewport(80, 72);
    expect(rect.width).toBe(80);
    expect(rect.height).toBe(72);
  });
});
