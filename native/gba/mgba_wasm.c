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
#include <mgba/internal/gba/savedata.h>
#include <mgba-util/vfs.h>

#define GBA_SCREEN_W 240
#define GBA_SCREEN_H 160

/* Generous: one frame at 48 kHz is ~800 stereo frames. */
#define AUDIO_CAPACITY_FRAMES 8192
/* mGBA's internal audio buffer, in samples per channel. */
#define CORE_AUDIO_BUFFER 1024

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

    unsigned sample_rate;
} core_t;

static core_t gba;

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

    struct VFile *rom = VFileFromConstMemory(data, (size_t)size);
    if (!rom) return -1;
    if (!gba.core->loadROM(gba.core, rom)) {
        rom->close(rom);
        return -1;
    }

    /* Save data must be attached after the ROM, so the core knows the cart's
     * save type before it maps the buffer. */
    if (gba.savedata) {
        struct VFile *save = VFileFromMemory(gba.savedata, SAVEDATA_CAPACITY);
        if (save) gba.core->loadSave(gba.core, save);
    }

    gba.core->reset(gba.core);
    apply_sample_rate();
    gba.rom_loaded = true;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
void gbaw_reset(void)
{
    if (gba.open && gba.core && gba.rom_loaded) gba.core->reset(gba.core);
}

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
