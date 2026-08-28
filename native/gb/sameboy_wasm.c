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
 *
 * It also exposes the PPU state the 2.5D renderer needs — VRAM, OAM, the IO
 * registers and a per-scanline record of the scroll registers. All of that
 * comes from SameBoy's public accessors, so the emulator core itself stays
 * unmodified and the submodule can be bumped without carrying a patch.
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

/* Bytes per entry in the per-scanline register log; see scanline_log below. */
#define SCANLINE_RECORD_SIZE 8

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

    /*
     * Scroll and palette registers sampled at the start of every scanline.
     * Games change these mid-frame for parallax and status bars, so a single
     * end-of-frame reading would misplace the ground plane. Layout per line:
     * LCDC, SCX, SCY, WX, WY, BGP, OBP0, OBP1.
     */
    uint8_t scanline_log[GB_SCREEN_H * SCANLINE_RECORD_SIZE];
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

static void scanline_start(GB_gameboy_t *gb, uint8_t line)
{
    if (line >= GB_SCREEN_H) return;

    size_t size = 0;
    uint16_t bank = 0;
    const uint8_t *io = GB_get_direct_access(gb, GB_DIRECT_ACCESS_IO, &size, &bank);
    if (!io) return;

    uint8_t *out = &core.scanline_log[(size_t)line * SCANLINE_RECORD_SIZE];
    out[0] = io[GB_IO_LCDC];
    out[1] = io[GB_IO_SCX];
    out[2] = io[GB_IO_SCY];
    out[3] = io[GB_IO_WX];
    out[4] = io[GB_IO_WY];
    out[5] = io[GB_IO_BGP];
    out[6] = io[GB_IO_OBP0];
    out[7] = io[GB_IO_OBP1];
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
    GB_set_lcd_line_callback(&core.gb, scanline_start);
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

/* --- PPU state for the 2.5D renderer ------------------------------------ */

/*
 * These hand out pointers straight into the core's own memory. They stay valid
 * until the next gbw_init, and the contents are only meaningful between frames
 * — the caller reads them right after gbw_run_frame returns.
 */

static void *direct_access(GB_direct_access_t what, int *size_out)
{
    if (!core.open) {
        if (size_out) *size_out = 0;
        return NULL;
    }
    size_t size = 0;
    uint16_t bank = 0;
    void *pointer = GB_get_direct_access(&core.gb, what, &size, &bank);
    if (size_out) *size_out = (int)size;
    return pointer;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *gbw_vram(void) { return direct_access(GB_DIRECT_ACCESS_VRAM, NULL); }

/** 8 KiB on DMG, 16 KiB on CGB (two banks laid out back to back). */
EMSCRIPTEN_KEEPALIVE
int gbw_vram_size(void)
{
    int size = 0;
    direct_access(GB_DIRECT_ACCESS_VRAM, &size);
    return size;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *gbw_oam(void) { return direct_access(GB_DIRECT_ACCESS_OAM, NULL); }

EMSCRIPTEN_KEEPALIVE
int gbw_oam_size(void)
{
    int size = 0;
    direct_access(GB_DIRECT_ACCESS_OAM, &size);
    return size;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *gbw_io(void) { return direct_access(GB_DIRECT_ACCESS_IO, NULL); }

/*
 * Palettes as SameBoy resolved them: 8 palettes of 4 colours, already run
 * through rgb_encode and the colour-correction curve, in the same RGBA8888
 * layout as the frame buffer. Taking these rather than the raw BGR555 registers
 * means the 2.5D renderer draws in exactly the same colours as the flat one,
 * on both DMG and CGB, with no decoding on the JavaScript side.
 */
EMSCRIPTEN_KEEPALIVE
uint32_t *gbw_bg_palettes_rgb(void)
{
    return core.open ? core.gb.background_palettes_rgb : NULL;
}

EMSCRIPTEN_KEEPALIVE
uint32_t *gbw_obj_palettes_rgb(void)
{
    return core.open ? core.gb.object_palettes_rgb : NULL;
}

/** Colours per palette array (8 palettes x 4 colours). */
EMSCRIPTEN_KEEPALIVE
int gbw_palette_entries(void) { return 0x20; }

/** 144 records of {LCDC, SCX, SCY, WX, WY, BGP, OBP0, OBP1}. */
EMSCRIPTEN_KEEPALIVE
uint8_t *gbw_scanline_log(void) { return core.scanline_log; }

EMSCRIPTEN_KEEPALIVE
int gbw_scanline_record_size(void) { return SCANLINE_RECORD_SIZE; }

/** True when running as Game Boy Color, which changes VRAM and palette layout. */
EMSCRIPTEN_KEEPALIVE
int gbw_is_cgb(void)
{
    return core.open && (GB_get_model(&core.gb) & GB_MODEL_FAMILY_MASK) == GB_MODEL_CGB_FAMILY;
}
