/**
 * Accuracy and API tests for the Game Boy core.
 *
 * blargg's suites render a verdict to the screen, so the check is a hash of the
 * final framebuffer. A mismatch means emulation behaviour changed: dump the
 * ASCII screen the failure prints and confirm it still reads "Passed" before
 * touching the expected hash.
 */

import { describe, expect, it } from 'vitest';
import {
  GB_MODEL_DMG_B,
  loadCore,
  screenToAscii,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
} from '../support/gbCoreHarness';

/** Frames needed for each suite to finish and settle on its result screen. */
const CPU_INSTRS_FRAMES = 3600;
const INSTR_TIMING_FRAMES = 600;

describe('SameBoy core', () => {
  it('passes blargg cpu_instrs', { timeout: 120_000 }, async () => {
    const core = await loadCore('tests/roms/cpu_instrs.gb', GB_MODEL_DMG_B);
    core.runFrames(CPU_INSTRS_FRAMES);

    // Verified by eye: the screen reads "cpu_instrs / 01..11 ok / Passed all tests".
    const screen = screenToAscii(core.framebuffer());
    expect(core.screenHash(), `screen was:\n${screen}`).toBe('a7cfdf69f29cb3b9');
  });

  it('passes blargg instr_timing', { timeout: 60_000 }, async () => {
    const core = await loadCore('tests/roms/instr_timing.gb', GB_MODEL_DMG_B);
    core.runFrames(INSTR_TIMING_FRAMES);

    // Verified by eye: the screen reads "instr_timing / Passed".
    const screen = screenToAscii(core.framebuffer());
    expect(core.screenHash(), `screen was:\n${screen}`).toBe('36d2df0098d970dd');
  });

  it('produces roughly one frame of audio per video frame', async () => {
    const core = await loadCore('tests/roms/cpu_instrs.gb');
    const frames = 120;
    const samples = core.runFrames(frames);

    // 48000 Hz / 59.727 fps ~= 803.6 stereo frames per video frame.
    expect(samples / frames).toBeGreaterThan(795);
    expect(samples / frames).toBeLessThan(812);
  });

  it('reports the expected screen geometry and frame rate', async () => {
    const core = await loadCore('tests/roms/cpu_instrs.gb');
    expect(core.module._gbw_screen_width()).toBe(SCREEN_WIDTH);
    expect(core.module._gbw_screen_height()).toBe(SCREEN_HEIGHT);
    expect(core.module._gbw_frame_rate()).toBeCloseTo(59.727, 2);
  });

  it('round-trips a save state', async () => {
    const core = await loadCore('tests/roms/cpu_instrs.gb');
    core.runFrames(400);

    const size = core.module._gbw_state_size();
    expect(size).toBeGreaterThan(0);

    const ptr = core.module._malloc(size);
    core.module._gbw_save_state(ptr);
    const saved = new Uint8Array(core.module.HEAPU8.subarray(ptr, ptr + size));
    const hashAtSave = core.screenHash();

    // Diverge, then restore and confirm we are back exactly where we were.
    core.runFrames(200);
    expect(core.screenHash()).not.toBe(hashAtSave);

    core.module.HEAPU8.set(saved, ptr);
    expect(core.module._gbw_load_state(ptr, size)).toBe(0);
    core.module._free(ptr);

    // The restored state renders the same screen on the very next frame.
    core.runFrames(1);
    const restored = await replayFromSameState(hashAtSave, core);
    expect(restored).toBe(true);
  });
});

/**
 * A save state restores the whole machine, so running one frame from the
 * restored state must land on the same screen as running one frame from the
 * original — compared after one frame because the LCD content at the moment of
 * the save is mid-scanline.
 */
async function replayFromSameState(
  hashAtSave: string,
  core: Awaited<ReturnType<typeof loadCore>>,
): Promise<boolean> {
  const reference = await loadCore('tests/roms/cpu_instrs.gb');
  reference.runFrames(400);
  if (reference.screenHash() !== hashAtSave) return false;
  reference.runFrames(1);
  return reference.screenHash() === core.screenHash();
}
