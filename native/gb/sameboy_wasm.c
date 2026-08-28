/*
 * Emscripten wrapper around the SameBoy core.
 *
 * One instance per module, because one worker owns exactly one core. The
 * wrapper keeps the frame buffer and the audio buffer as static storage so the
 * JavaScript side can read them straight out of the WASM heap without a copy
 * per frame.
 *
 * Everything here is deliberately thin: no timing, no frame pacing, no
 * resampling. The worker drives `gbw_run_frame` and owns the clock.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten.h>

#include "Core/gb.h"
#include "bootroms.h"

#define GB_SCREEN_W 160
#define GB_SCREEN_H 144

/* One PAL frame at 48 kHz is ~805 stereo samples; leave generous headroom so a
 * long frame (or a higher sample rate) can never overrun. */
#define AUDIO_CAPACITY_FRAMES 8192

typedef struct {
    GB_gameboy_t gb;
    bool open;
    bool rom_loaded;

    uint32_t framebuffer[GB_SCREEN_W * GB_SCREEN_H];

    int16_t audio[AUDIO_CAPACITY_FRAMES * 2];
    unsigned audio_frames; /* stereo frames written during the current run */
} core_t;

static core_t core;

/* --- Callbacks ---------------------------------------------------------- */

/*
 * Little-endian RGBA8888, which is what both a canvas ImageData and a WebGL
 * RGBA/UNSIGNED_BYTE texture expect without any swizzling.
 */
static uint32_t rgb_encode(GB_gameboy_t *gb, uint8_t r, uint8_t g, uint8_t b)
{
    (void)gb;
    return 0xFF000000u | ((uint32_t)b << 16) | ((uint32_t)g << 8) | (uint32_t)r;
}

static void audio_sample(GB_gameboy_t *gb, GB_sample_t *sample)
{
    (void)gb;
    if (core.audio_frames >= AUDIO_CAPACITY_FRAMES) return; /* drop, never overrun */
    core.audio[core.audio_frames * 2] = sample->left;
    core.audio[core.audio_frames * 2 + 1] = sample->right;
    core.audio_frames++;
}

/* --- Boot ROMs ---------------------------------------------------------- */

static void load_boot_rom(GB_model_t model)
{
    const uint8_t *rom;
    size_t size;

    switch (model & GB_MODEL_FAMILY_MASK) {
        case GB_MODEL_CGB_FAMILY:
            if (model == GB_MODEL_CGB_0) {
                rom = cgb0_boot; size = sizeof(cgb0_boot);
            }
            else if ((model & ~GB_MODEL_GBP_BIT) == GB_MODEL_AGB_A) {
                rom = agb_boot; size = sizeof(agb_boot);
            }
            else {
                rom = cgb_boot; size = sizeof(cgb_boot);
            }
            break;
        case GB_MODEL_MGB_FAMILY:
            if ((model & ~(GB_MODEL_NO_SFC_BIT | GB_MODEL_PAL_BIT)) == GB_MODEL_SGB2) {
                rom = sgb2_boot; size = sizeof(sgb2_boot);
            }
            else {
                rom = mgb_boot; size = sizeof(mgb_boot);
            }
            break;
        default:
            if ((model & ~(GB_MODEL_NO_SFC_BIT | GB_MODEL_PAL_BIT)) == GB_MODEL_SGB) {
                rom = sgb_boot; size = sizeof(sgb_boot);
            }
            else {
                rom = dmg_boot; size = sizeof(dmg_boot);
            }
            break;
    }

    GB_load_boot_rom_from_buffer(&core.gb, rom, size);
}

/* --- Lifecycle ---------------------------------------------------------- */

EMSCRIPTEN_KEEPALIVE
void gbw_init(int model)
{
    if (core.open) {
        GB_free(&core.gb);
        core.open = false;
    }
    memset(&core, 0, sizeof(core));

    GB_init(&core.gb, (GB_model_t)model);
    core.open = true;

    /* The Super Game Boy border would change the output dimensions mid-run;
     * the renderer assumes a fixed 160x144, so keep it off. */
    GB_set_border_mode(&core.gb, GB_BORDER_NEVER);
    GB_set_rgb_encode_callback(&core.gb, rgb_encode);
    GB_set_pixels_output(&core.gb, core.framebuffer);
    GB_apu_set_sample_callback(&core.gb, audio_sample);
    GB_set_sample_rate(&core.gb, 48000);
    GB_set_highpass_filter_mode(&core.gb, GB_HIGHPASS_ACCURATE);
    GB_set_color_correction_mode(&core.gb, GB_COLOR_CORRECTION_MODERN_BALANCED);

    load_boot_rom((GB_model_t)model);
}

EMSCRIPTEN_KEEPALIVE
void gbw_deinit(void)
{
    if (!core.open) return;
    GB_free(&core.gb);
    core.open = false;
    core.rom_loaded = false;
}

EMSCRIPTEN_KEEPALIVE
int gbw_load_rom(const uint8_t *data, int size)
{
    if (!core.open || size <= 0) return -1;
    GB_load_rom_from_buffer(&core.gb, data, (size_t)size);
    core.rom_loaded = true;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
void gbw_reset(void)
{
    if (core.open) GB_reset(&core.gb);
}

/* --- Running ------------------------------------------------------------ */

/* Runs one video frame. Returns the number of stereo audio frames produced,
 * which the caller reads from gbw_audio_buffer(). */
EMSCRIPTEN_KEEPALIVE
int gbw_run_frame(void)
{
    if (!core.open || !core.rom_loaded) return 0;
    core.audio_frames = 0;
    GB_run_frame(&core.gb);
    return (int)core.audio_frames;
}

EMSCRIPTEN_KEEPALIVE
uint32_t *gbw_framebuffer(void) { return core.framebuffer; }

EMSCRIPTEN_KEEPALIVE
int16_t *gbw_audio_buffer(void) { return core.audio; }

EMSCRIPTEN_KEEPALIVE
int gbw_audio_capacity(void) { return AUDIO_CAPACITY_FRAMES; }

EMSCRIPTEN_KEEPALIVE
int gbw_screen_width(void) { return GB_SCREEN_W; }

EMSCRIPTEN_KEEPALIVE
int gbw_screen_height(void) { return GB_SCREEN_H; }

EMSCRIPTEN_KEEPALIVE
double gbw_frame_rate(void)
{
    return core.open ? GB_get_usual_frame_rate(&core.gb) : 0.0;
}

EMSCRIPTEN_KEEPALIVE
void gbw_set_sample_rate(int rate)
{
    if (core.open && rate > 0) GB_set_sample_rate(&core.gb, (unsigned)rate);
}

/* --- Input -------------------------------------------------------------- */

/* Bit order matches GB_key_t: right, left, up, down, a, b, select, start. */
EMSCRIPTEN_KEEPALIVE
void gbw_set_key_mask(int mask)
{
    if (core.open) GB_set_key_mask(&core.gb, (GB_key_mask_t)mask);
}

/* --- Battery-backed cartridge RAM --------------------------------------- */

EMSCRIPTEN_KEEPALIVE
int gbw_battery_size(void)
{
    return core.open ? GB_save_battery_size(&core.gb) : 0;
}

EMSCRIPTEN_KEEPALIVE
int gbw_save_battery(uint8_t *dst, int size)
{
    if (!core.open || size <= 0) return -1;
    return GB_save_battery_to_buffer(&core.gb, dst, (size_t)size);
}

EMSCRIPTEN_KEEPALIVE
void gbw_load_battery(const uint8_t *src, int size)
{
    if (core.open && size > 0) GB_load_battery_from_buffer(&core.gb, src, (size_t)size);
}

/* --- Save states -------------------------------------------------------- */

EMSCRIPTEN_KEEPALIVE
int gbw_state_size(void)
{
    return core.open ? (int)GB_get_save_state_size(&core.gb) : 0;
}

EMSCRIPTEN_KEEPALIVE
void gbw_save_state(uint8_t *dst)
{
    if (core.open) GB_save_state_to_buffer(&core.gb, dst);
}

EMSCRIPTEN_KEEPALIVE
int gbw_load_state(const uint8_t *src, int size)
{
    if (!core.open || size <= 0) return -1;
    return GB_load_state_from_buffer(&core.gb, src, (size_t)size);
}
