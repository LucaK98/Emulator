import { describe, expect, it } from 'vitest';
import { fitViewport } from '../../src/render/GLRenderer';
import { SYSTEMS } from '../../src/core/systems';

const GB = SYSTEMS.gb;
const GBA = SYSTEMS.gba;

const fitGb = (w: number, h: number) => fitViewport(w, h, GB.width, GB.height);
const fitGba = (w: number, h: number) => fitViewport(w, h, GBA.width, GBA.height);

describe('fitViewport', () => {
  it('keeps the console aspect ratio', () => {
    for (const [w, h] of [
      [786, 1380],
      [1179, 2000],
      [900, 400],
      [320, 288],
    ] as const) {
      expect(fitGb(w, h).width / fitGb(w, h).height).toBeCloseTo(GB.width / GB.height, 2);
      expect(fitGba(w, h).width / fitGba(w, h).height).toBeCloseTo(GBA.width / GBA.height, 2);
    }
  });

  it('never draws outside the buffer', () => {
    for (const [w, h] of [
      [786, 1380],
      [900, 400],
      [100, 100],
    ] as const) {
      for (const rect of [fitGb(w, h), fitGba(w, h)]) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(w);
        expect(rect.y + rect.height).toBeLessThanOrEqual(h);
      }
    }
  });

  it('snaps to a whole scale when that costs almost nothing', () => {
    // 1179 device px wide (iPhone 15 Pro at 3x) => scale 7.37; snapping to 7
    // gives up 5%, which is worth an even pixel grid.
    expect(fitGb(1179, 2000).width).toBe(GB.width * 7);
  });

  it('fills the space when snapping would waste too much', () => {
    // 786 device px wide (393 CSS at 2x) => scale 4.91; snapping to 4 would
    // throw away 19% of the picture, so it must not.
    const rect = fitGb(786, 1380);
    expect(rect.width).toBeGreaterThan(GB.width * 4.5);
    expect(rect.width).toBeLessThanOrEqual(786);
  });

  it('handles viewports smaller than the native resolution', () => {
    expect(fitGb(80, 72)).toMatchObject({ width: 80, height: 72 });
    expect(fitGba(120, 80)).toMatchObject({ width: 120, height: 80 });
  });

  it('uses the wider Game Boy Advance frame where it fits', () => {
    // A 3:2 screen holds the GBA's 3:2 picture edge to edge.
    const rect = fitGba(720, 480);
    expect(rect.width).toBe(720);
    expect(rect.height).toBe(480);
  });
});
