/**
 * Behaviour tests for the Nintendo DS core.
 *
 * tests/roms/nds-probe.nds is written for this: it paints a colour gradient on
 * the engine A screen and a flat colour on the engine B screen, so both the
 * screen compositing and the two arrangements can be checked from the pixels
 * alone.
 */

import { describe, expect, it } from 'vitest';
import { SYSTEMS } from '../../src/core/systems';
import { loadNdsCore } from '../support/ndsCoreHarness';

const ROM = 'tests/roms/nds-probe.nds';
/** Enough for the probe to finish painting. */
const SETTLE_FRAMES = 30;

describe('melonDS core', () => {
  it('boots a cartridge and draws both screens', { timeout: 60_000 }, async () => {
    const core = await loadNdsCore(ROM);
    core.runFrames(SETTLE_FRAMES);

    const pixels = core.framebuffer();
    const screen = SYSTEMS.nds.width * 192;

    // The upper screen carries a gradient, so it holds many colours; the lower
    // one is a single backdrop colour. Anything else means direct boot failed
    // or the screens were composed the wrong way round.
    const upper = new Set(pixels.subarray(0, screen));
    const lower = new Set(pixels.subarray(screen));
    expect(upper.size).toBeGreaterThan(100);
    expect(lower.size).toBe(1);
  });

  it('rearranges the screens without changing the pixel count', { timeout: 60_000 }, async () => {
    const core = await loadNdsCore(ROM);
    core.runFrames(SETTLE_FRAMES);

    expect(core.module._ndsw_screen_width()).toBe(256);
    expect(core.module._ndsw_screen_height()).toBe(384);

    core.module._ndsw_set_layout(1);
    core.runFrames(1);
    expect(core.module._ndsw_screen_width()).toBe(512);
    expect(core.module._ndsw_screen_height()).toBe(192);

    // Side by side, the first row crosses both screens: gradient then backdrop.
    const pixels = core.framebuffer();
    const leftHalf = new Set(pixels.subarray(0, 256));
    const rightHalf = new Set(pixels.subarray(256, 512));
    expect(leftHalf.size).toBeGreaterThan(1);
    expect(rightHalf.size).toBe(1);
  });

  it('reports the expected frame rate and audio rate', { timeout: 60_000 }, async () => {
    const core = await loadNdsCore(ROM);
    expect(core.module._ndsw_frame_rate()).toBeCloseTo(59.8261, 3);

    const frames = 60;
    const samples = core.runFrames(frames);
    // The DS sound hardware runs at a fixed rate, so the wrapper resamples to
    // one frame's worth of output per video frame.
    expect(samples / frames).toBeCloseTo(48000 / 59.8261, 0);
  });

  it('round-trips a save state', { timeout: 120_000 }, async () => {
    const core = await loadNdsCore(ROM);
    core.runFrames(SETTLE_FRAMES);

    const size = core.module._ndsw_state_size();
    expect(size).toBeGreaterThan(0);

    const ptr = core.module._malloc(size);
    expect(core.module._ndsw_save_state(ptr, size)).toBeGreaterThan(0);
    const saved = new Uint8Array(core.module.HEAPU8.subarray(ptr, ptr + size));
    const hashAtSave = core.screenHash();

    core.runFrames(20);
    core.module.HEAPU8.set(saved, ptr);
    expect(core.module._ndsw_load_state(ptr, size)).toBe(0);
    core.module._free(ptr);

    core.runFrames(1);
    const reference = await loadNdsCore(ROM);
    reference.runFrames(SETTLE_FRAMES);
    expect(reference.screenHash()).toBe(hashAtSave);
    reference.runFrames(1);
    expect(core.screenHash()).toBe(reference.screenHash());
  });

  it('exposes cartridge save memory', { timeout: 60_000 }, async () => {
    const core = await loadNdsCore(ROM);
    core.runFrames(SETTLE_FRAMES);
    expect(core.module._ndsw_battery_size()).toBeGreaterThan(0);
  });
});
