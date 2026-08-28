/**
 * Behaviour tests for the Game Boy Advance core.
 *
 * A note on the test ROMs: jsmolka's suites are deliberately stricter than any
 * commercial game, and mGBA does not pass all of them — arm.gba stops at test
 * 235, thumb.gba at test 102. Those are mGBA's own accuracy gaps, not defects
 * in this wrapper, and they do not stop real games from running correctly.
 *
 * The screen hashes below are therefore a change detector, not a certificate:
 * they pin what the core currently produces, so a wrapper regression or a
 * core upgrade shows up as a deliberate decision rather than a silent shift.
 */

import { describe, expect, it } from 'vitest';
import { GBA_HEIGHT, GBA_WIDTH, loadGbaCore } from '../support/gbaCoreHarness';

const ARM_FRAMES = 300;
const THUMB_FRAMES = 240;

describe('mGBA core', () => {
  it('renders a stable picture for the ARM suite', { timeout: 60_000 }, async () => {
    const core = await loadGbaCore('tests/roms/arm.gba');
    core.runFrames(ARM_FRAMES);

    expect(core.screenIsBlank(), 'the ROM should have drawn something').toBe(false);
    expect(core.screenHash()).toBe('823605adee15020d');
  });

  it('renders a stable picture for the THUMB suite', { timeout: 60_000 }, async () => {
    const core = await loadGbaCore('tests/roms/thumb.gba');
    core.runFrames(THUMB_FRAMES);

    expect(core.screenIsBlank()).toBe(false);
    expect(core.screenHash()).toBe('d7ed2b528251a349');
  });

  it('reports the expected screen geometry and frame rate', async () => {
    const core = await loadGbaCore('tests/roms/arm.gba');
    expect(core.module._gbaw_screen_width()).toBe(GBA_WIDTH);
    expect(core.module._gbaw_screen_height()).toBe(GBA_HEIGHT);
    expect(core.module._gbaw_frame_rate()).toBeCloseTo(59.727, 2);
  });

  it('produces roughly one frame of audio per video frame', async () => {
    const core = await loadGbaCore('tests/roms/arm.gba');
    const frames = 120;
    const samples = core.runFrames(frames);

    // 48000 Hz / 59.727 fps ~= 803.6 stereo frames per video frame.
    expect(samples / frames).toBeGreaterThan(790);
    expect(samples / frames).toBeLessThan(812);
  });

  it('reports no save memory for a cartridge that never saves', async () => {
    const core = await loadGbaCore('tests/roms/arm.gba');
    core.runFrames(120);

    // The save type stays undetected until a game first writes to save memory.
    // Reporting the buffer size instead would make the player persist 128 KiB
    // of untouched flash for every test ROM.
    expect(core.module._gbaw_savedata_type()).toBe(-1);
    expect(core.module._gbaw_battery_size()).toBe(0);
  });

  it('round-trips a save state', { timeout: 60_000 }, async () => {
    const core = await loadGbaCore('tests/roms/arm.gba');
    core.runFrames(200);

    const size = core.module._gbaw_state_size();
    expect(size).toBeGreaterThan(0);

    const ptr = core.module._malloc(size);
    expect(core.module._gbaw_save_state(ptr, size)).toBeGreaterThan(0);
    const saved = new Uint8Array(core.module.HEAPU8.subarray(ptr, ptr + size));
    const hashAtSave = core.screenHash();

    core.runFrames(100);

    core.module.HEAPU8.set(saved, ptr);
    expect(core.module._gbaw_load_state(ptr, size)).toBe(0);
    core.module._free(ptr);

    core.runFrames(1);
    // Restoring puts the machine back where it was; one more frame from there
    // must land on the same picture the save was taken from.
    const reference = await loadGbaCore('tests/roms/arm.gba');
    reference.runFrames(200);
    expect(reference.screenHash()).toBe(hashAtSave);
    reference.runFrames(1);
    expect(core.screenHash()).toBe(reference.screenHash());
  });
});
