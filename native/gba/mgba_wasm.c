/*
#include <stdarg.h>
 * Emscripten wrapper around the mGBA core.
 *
 * Mirrors the Game Boy wrapper's contract so the JavaScript side can drive
 * either core through the same worker runtime: one frame per call, frame and
 * audio buffers exposed as pointers into the WASM heap, save data and save
 * states as flat byte buffers.
 *
 * mGBA is used through its public mCore interface, so nothing in the submodule
 * is patched.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten.h>

#include <mgba/core/blip_buf.h>
#include <mgba/core/core.h>
#include <mgba/core/log.h>
#include <mgba/core/serialize.h>
#include <mgba/gba/core.h>
#include <mgba/internal/gba/gba.h>
#include <mgba/internal/gba/input.h>
#include <mgba/internal/gba/memory.h>
#include <mgba/internal/gba/io.h>
#include <mgba/internal/gba/savedata.h>
#include <mgba/internal/gba/video.h>
#include <mgba-util/vfs.h>

#define GBA_SCREEN_W 240
#define GBA_SCREEN_H 160

/* Generous: one frame at 48 kHz is ~800 stereo frames. */
#define AUDIO_CAPACITY_FRAMES 8192
/* mGBA's internal audio buffer, in samples per channel. */
#define CORE_AUDIO_BUFFER 1024

/*
 * Per-scanline register log, for the 2.5D renderer.
 *
 * Games change scroll and layer settings mid-frame — that is how a status bar
 * stays put while the map moves under it — so a single reading taken at the
 * end of a frame describes none of it correctly. Sixteen slots a line leaves
 * room beyond the thirteen in use.
 */
#define GBA_SCANLINES 160
#define GBA_SCANLINE_SLOTS 16

/* Largest GBA save: 128 KiB flash. Smaller carts simply use less of it. */
#define SAVEDATA_CAPACITY SIZE_CART_FLASH1M

typedef struct {
    struct mCore *core;
    bool open;
    bool rom_loaded;

    uint32_t framebuffer[GBA_SCREEN_W * GBA_SCREEN_H];
    int16_t audio[AUDIO_CAPACITY_FRAMES * 2];

    /*
     * mGBA writes cartridge save data straight into this buffer through a
     * memory-backed VFile, so reading the current save is just a copy.
     */
    uint8_t *savedata;

    /*
     * The cartridge, owned here for as long as it is loaded.
     *
     * mGBA maps a GBA ROM rather than copying it: the VFile handed to loadROM
     * stays the backing store for every cartridge read the game makes. The
     * caller's buffer is therefore not enough — it is freed as soon as the
     * load call returns — so the bytes are copied into an allocation that
     * lives exactly as long as the loaded ROM does.
     */
    uint8_t *rom_data;

    unsigned sample_rate;
} core_t;

static core_t gba;

static uint16_t scanline_log[GBA_SCANLINES * GBA_SCANLINE_SLOTS];

/* --- Per-scanline capture ----------------------------------------------- */

/*
 * The renderer's own drawScanline, kept so the hook below can hand the work on.
 *
 * Only the one function pointer is swapped rather than the whole renderer
 * being wrapped in a struct of ours: mGBA fills several fields of that struct
 * during reset, and a copy would go stale the moment it did.
 */
static void (*forward_draw_scanline)(struct GBAVideoRenderer *renderer, int y);

static void logging_draw_scanline(struct GBAVideoRenderer *renderer, int y)
{
    if (y >= 0 && y < GBA_SCANLINES && gba.core && gba.core->board) {
        /* Every video register write passes through memory.io, the write-only
         * scroll registers included, so this is the whole picture. */
        const uint16_t *io = ((struct GBA *)gba.core->board)->memory.io;
        uint16_t *out = &scanline_log[y * GBA_SCANLINE_SLOTS];
        out[0] = io[REG_DISPCNT >> 1];
        for (int i = 0; i < 4; i++) out[1 + i] = io[(REG_BG0CNT >> 1) + i];
        /* BG0HOFS, BG0VOFS, BG1HOFS ... BG3VOFS sit in consecutive slots. */
        for (int i = 0; i < 8; i++) out[5 + i] = io[(REG_BG0HOFS >> 1) + i];
    }
    forward_draw_scanline(renderer, y);
}

static void install_scanline_hook(void)
{
    if (!gba.core || !gba.core->board) return;
    struct GBAVideoRenderer *renderer = ((struct GBA *)gba.core->board)->video.renderer;
    if (!renderer || renderer->drawScanline == logging_draw_scanline) return;
    forward_draw_scanline = renderer->drawScanline;
    renderer->drawScanline = logging_draw_scanline;
}

/* --- Logging ------------------------------------------------------------ */

/*
 * mGBA's default logger writes to stdout, which in a worker means every
 * unimplemented BIOS call and odd DMA in a commercial game floods the console.
 * None of it is actionable here, so it is dropped.
 */
static void discard_log(struct mLogger *logger, int category, enum mLogLevel level,
                        const char *format, va_list args)
{
    (void)logger;
    (void)category;
    (void)level;
    (void)format;
    (void)args;
}

static struct mLogger silent_logger = { .log = discard_log };

/* --- Lifecycle ---------------------------------------------------------- */

static void release(void)
{
    if (!gba.open) return;
    if (gba.core) {
        gba.core->deinit(gba.core);
        gba.core = NULL;
    }
    free(gba.savedata);
    gba.savedata = NULL;
    /* Safe only after deinit above, which is what unmaps the ROM. */
    free(gba.rom_data);
    gba.rom_data = NULL;
    gba.open = false;
    gba.rom_loaded = false;
}

EMSCRIPTEN_KEEPALIVE
void gbaw_init(int model)
{
    (void)model; /* The GBA has no model variants we distinguish. */
    release();

    memset(&gba, 0, sizeof(gba));
    gba.sample_rate = 48000;
    mLogSetDefaultLogger(&silent_logger);

    gba.core = GBACoreCreate();
    if (!gba.core) return;

    gba.core->init(gba.core);
    mCoreInitConfig(gba.core, NULL);
    gba.core->setVideoBuffer(gba.core, gba.framebuffer, GBA_SCREEN_W);
    gba.core->setAudioBufferSize(gba.core, CORE_AUDIO_BUFFER);

    gba.savedata = malloc(SAVEDATA_CAPACITY);
    if (gba.savedata) {
        /* Unwritten flash reads as 0xFF; starting from zeroes looks like a
         * corrupt save to some games. */
        memset(gba.savedata, 0xFF, SAVEDATA_CAPACITY);
    }

    install_scanline_hook();
    gba.open = true;
}

EMSCRIPTEN_KEEPALIVE
void gbaw_deinit(void) { release(); }

static void apply_sample_rate(void)
{
    if (!gba.open || !gba.core) return;
    double clock = gba.core->frequency(gba.core);
    blip_set_rates(gba.core->getAudioChannel(gba.core, 0), clock, gba.sample_rate);
    blip_set_rates(gba.core->getAudioChannel(gba.core, 1), clock, gba.sample_rate);
}

EMSCRIPTEN_KEEPALIVE
int gbaw_load_rom(const uint8_t *data, int size)
{
    if (!gba.open || !gba.core || size <= 0) return -1;

    /* A previous cartridge, if any, is only unmapped by unloadROM. */
    gba.core->unloadROM(gba.core);
    free(gba.rom_data);
    gba.rom_data = malloc((size_t)size);
    if (!gba.rom_data) return -1;
    memcpy(gba.rom_data, data, (size_t)size);

    struct VFile *rom = VFileFromConstMemory(gba.rom_data, (size_t)size);
    if (!rom) return -1;
    if (!gba.core->loadROM(gba.core, rom)) {
        rom->close(rom);
        free(gba.rom_data);
        gba.rom_data = NULL;
        return -1;
    }

    /* Save data must be attached after the ROM, so the core knows the cart's
     * save type before it maps the buffer. */
    if (gba.savedata) {
        struct VFile *save = VFileFromMemory(gba.savedata, SAVEDATA_CAPACITY);
        if (save) gba.core->loadSave(gba.core, save);
    }

    gba.core->reset(gba.core);
    install_scanline_hook();
    apply_sample_rate();
    gba.rom_loaded = true;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
void gbaw_reset(void)
{
    if (!gba.open || !gba.core || !gba.rom_loaded) return;
    gba.core->reset(gba.core);
    install_scanline_hook();
}

/* --- PPU state, for the 2.5D renderer ----------------------------------- */

/*
 * The depth renderer rebuilds the scene from hardware state rather than from
 * the finished picture, so it needs the memory the picture was drawn from.
 * These hand out pointers into the core's own buffers; the worker copies from
 * them and never writes.
 */

static struct GBAVideoRenderer *video_renderer(void)
{
    if (!gba.open || !gba.core || !gba.core->board) return NULL;
    return ((struct GBA *)gba.core->board)->video.renderer;
}

EMSCRIPTEN_KEEPALIVE
uint16_t *gbaw_vram(void)
{
    struct GBAVideoRenderer *renderer = video_renderer();
    return renderer ? renderer->vram : NULL;
}

EMSCRIPTEN_KEEPALIVE
uint16_t *gbaw_palette(void)
{
    struct GBAVideoRenderer *renderer = video_renderer();
    return renderer ? renderer->palette : NULL;
}

EMSCRIPTEN_KEEPALIVE
uint16_t *gbaw_oam(void)
{
    struct GBAVideoRenderer *renderer = video_renderer();
    return renderer ? (uint16_t *)renderer->oam : NULL;
}

EMSCRIPTEN_KEEPALIVE
uint16_t *gbaw_io(void)
{
    if (!gba.open || !gba.core || !gba.core->board) return NULL;
    return ((struct GBA *)gba.core->board)->memory.io;
}

EMSCRIPTEN_KEEPALIVE
uint16_t *gbaw_scanline_log(void) { return scanline_log; }

EMSCRIPTEN_KEEPALIVE
int gbaw_vram_bytes(void) { return SIZE_VRAM; }

EMSCRIPTEN_KEEPALIVE
int gbaw_oam_bytes(void) { return SIZE_OAM; }

EMSCRIPTEN_KEEPALIVE
int gbaw_palette_bytes(void) { return SIZE_PALETTE_RAM; }

/* --- Running ------------------------------------------------------------ */

EMSCRIPTEN_KEEPALIVE
int gbaw_run_frame(void)
{
    if (!gba.open || !gba.core || !gba.rom_loaded) return 0;

    gba.core->runFrame(gba.core);

    blip_t *left = gba.core->getAudioChannel(gba.core, 0);
    blip_t *right = gba.core->getAudioChannel(gba.core, 1);
    int available = blip_samples_avail(left);
    if (available > AUDIO_CAPACITY_FRAMES) available = AUDIO_CAPACITY_FRAMES;
    if (available <= 0) return 0;

    /* Interleaved: the two channels are read into alternating slots. */
    blip_read_samples(left, gba.audio, available, true);
    blip_read_samples(right, gba.audio + 1, available, true);
    return available;
}

EMSCRIPTEN_KEEPALIVE
uint32_t *gbaw_framebuffer(void) { return gba.framebuffer; }

EMSCRIPTEN_KEEPALIVE
int16_t *gbaw_audio_buffer(void) { return gba.audio; }

EMSCRIPTEN_KEEPALIVE
int gbaw_audio_capacity(void) { return AUDIO_CAPACITY_FRAMES; }

EMSCRIPTEN_KEEPALIVE
int gbaw_screen_width(void) { return GBA_SCREEN_W; }

EMSCRIPTEN_KEEPALIVE
int gbaw_screen_height(void) { return GBA_SCREEN_H; }

EMSCRIPTEN_KEEPALIVE
double gbaw_frame_rate(void)
{
    if (!gba.open || !gba.core) return 0.0;
    return gba.core->frequency(gba.core) / (double)gba.core->frameCycles(gba.core);
}

EMSCRIPTEN_KEEPALIVE
void gbaw_set_sample_rate(int rate)
{
    if (rate <= 0) return;
    gba.sample_rate = (unsigned)rate;
    apply_sample_rate();
}

/* --- Input -------------------------------------------------------------- */

/*
 * The shared button mask uses the Game Boy's bit order, extended with L and R:
 * right, left, up, down, a, b, select, start, l, r. The GBA's own KEYINPUT
 * order differs, so it is translated here rather than in JavaScript.
 */
EMSCRIPTEN_KEEPALIVE
void gbaw_set_key_mask(int mask)
{
    if (!gba.open || !gba.core) return;

    static const int native_bit[10] = {
        GBA_KEY_RIGHT, GBA_KEY_LEFT, GBA_KEY_UP, GBA_KEY_DOWN, GBA_KEY_A,
        GBA_KEY_B, GBA_KEY_SELECT, GBA_KEY_START, GBA_KEY_L, GBA_KEY_R,
    };

    uint32_t keys = 0;
    for (int bit = 0; bit < 10; bit++) {
        if (mask & (1 << bit)) keys |= 1u << native_bit[bit];
    }
    gba.core->setKeys(gba.core, keys);
}

/* --- Cartridge save data ------------------------------------------------ */

/*
 * Size of the cartridge's save memory, or zero when the game has none.
 *
 * The save type is detected the first time a game touches its save memory. Up
 * to that point it reads as AUTODETECT, and mGBA would report the size of the
 * buffer we handed it rather than a real save — so a game that never saves
 * would otherwise appear to have 128 KiB worth of save data to persist.
 */
static size_t savedata_size(void)
{
    if (!gba.open || !gba.core || !gba.core->board) return 0;
    struct GBA *board = (struct GBA *)gba.core->board;
    switch (board->memory.savedata.type) {
        case SAVEDATA_AUTODETECT:
        case SAVEDATA_FORCE_NONE:
            return 0;
        default:
            return GBASavedataSize(&board->memory.savedata);
    }
}

/** The detected save type, for diagnostics. -1 means "not yet known". */
EMSCRIPTEN_KEEPALIVE
int gbaw_savedata_type(void)
{
    if (!gba.open || !gba.core || !gba.core->board) return SAVEDATA_AUTODETECT;
    return (int)((struct GBA *)gba.core->board)->memory.savedata.type;
}

EMSCRIPTEN_KEEPALIVE
int gbaw_battery_size(void) { return (int)savedata_size(); }

EMSCRIPTEN_KEEPALIVE
int gbaw_save_battery(uint8_t *dst, int size)
{
    size_t available = savedata_size();
    if (!gba.savedata || available == 0 || size <= 0) return -1;
    if ((size_t)size < available) available = (size_t)size;
    memcpy(dst, gba.savedata, available);
    return (int)available;
}

/*
 * Restoring must happen before the ROM is attached, because loadSave hands the
 * buffer to the core. The worker therefore calls this first and then loads the
 * ROM; calling it afterwards would write into a buffer the core has already
 * mapped, which some save types cache.
 */
EMSCRIPTEN_KEEPALIVE
void gbaw_load_battery(const uint8_t *src, int size)
{
    if (!gba.savedata || size <= 0) return;
    size_t count = (size_t)size;
    if (count > SAVEDATA_CAPACITY) count = SAVEDATA_CAPACITY;
    memcpy(gba.savedata, src, count);
}

/* --- Save states -------------------------------------------------------- */

/* Includes save data and the real-time clock, so a state is self-contained. */
#define STATE_FLAGS (SAVESTATE_SAVEDATA | SAVESTATE_RTC)

EMSCRIPTEN_KEEPALIVE
int gbaw_state_size(void)
{
    if (!gba.open || !gba.core || !gba.rom_loaded) return 0;
    struct VFile *chunk = VFileMemChunk(NULL, 0);
    if (!chunk) return 0;
    mCoreSaveStateNamed(gba.core, chunk, STATE_FLAGS);
    int size = (int)chunk->size(chunk);
    chunk->close(chunk);
    return size;
}

EMSCRIPTEN_KEEPALIVE
int gbaw_save_state(uint8_t *dst, int size)
{
    if (!gba.open || !gba.core || !gba.rom_loaded || size <= 0) return -1;

    struct VFile *chunk = VFileMemChunk(NULL, 0);
    if (!chunk) return -1;
    mCoreSaveStateNamed(gba.core, chunk, STATE_FLAGS);

    ssize_t written = chunk->size(chunk);
    if (written > size) {
        chunk->close(chunk);
        return -1;
    }
    chunk->seek(chunk, 0, SEEK_SET);
    chunk->read(chunk, dst, (size_t)written);
    chunk->close(chunk);
    return (int)written;
}

EMSCRIPTEN_KEEPALIVE
int gbaw_load_state(const uint8_t *src, int size)
{
    if (!gba.open || !gba.core || !gba.rom_loaded || size <= 0) return -1;

    struct VFile *chunk = VFileMemChunk(src, (size_t)size);
    if (!chunk) return -1;
    bool ok = mCoreLoadStateNamed(gba.core, chunk, STATE_FLAGS);
    chunk->close(chunk);
    return ok ? 0 : -1;
}
