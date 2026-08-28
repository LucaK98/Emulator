/*
 * Emscripten wrapper around the melonDS core.
 *
 * Follows the same contract as the Game Boy and Game Boy Advance wrappers so
 * the shared worker runtime drives all three the same way. Three things are
 * genuinely different about the DS and are handled here:
 *
 *   * Two screens. They are composited into one frame buffer, either stacked
 *     or side by side. Both arrangements hold the same number of pixels, so a
 *     single buffer serves either and the layout can change while playing.
 *   * A touch screen, which no other supported system has.
 *   * A fixed audio rate. The Game Boy cores can be retuned to whatever the
 *     AudioContext offers; the DS sound hardware cannot, so its output is
 *     resampled here.
 *
 * melonDS is used through its public NDS class, so the submodule stays
 * unpatched. Its built-in free BIOS and generated firmware mean no proprietary
 * files are needed.
 */

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>

#include <emscripten.h>

#include "Args.h"
#include "NDS.h"
#include "NDSCart.h"
#include "Platform.h"
#include "SPU.h"
#include "Savestate.h"

using melonDS::NDS;
using melonDS::NDSArgs;
using melonDS::Savestate;

#define DS_SCREEN_W 256
#define DS_SCREEN_H 192
#define DS_FRAME_PIXELS (DS_SCREEN_W * DS_SCREEN_H * 2)

/** Stacked (256x384) or side by side (512x192); both hold the same pixels. */
enum Layout { LAYOUT_STACKED = 0, LAYOUT_SIDE_BY_SIDE = 1 };

#define AUDIO_CAPACITY_FRAMES 8192
/** One DS frame yields ~548 samples; this is generous headroom. */
#define SPU_BUFFER_FRAMES 4096

/** melonDS reports frames at this rate. */
static constexpr double DS_FRAME_RATE = 59.8261;

namespace {

struct Core {
    std::unique_ptr<NDS> nds;
    bool open = false;
    bool romLoaded = false;
    int layout = LAYOUT_STACKED;
    unsigned sampleRate = 48000;

    uint32_t framebuffer[DS_FRAME_PIXELS] = {};
    int16_t audio[AUDIO_CAPACITY_FRAMES * 2] = {};
    int16_t spu[SPU_BUFFER_FRAMES * 2] = {};

    /**
     * Last input sample of the previous frame. Resampling frame by frame would
     * otherwise restart from silence at every boundary, which is audible as a
     * faint buzz at the frame rate.
     */
    int16_t tailLeft = 0;
    int16_t tailRight = 0;
    bool hasTail = false;
};

Core core;

/**
 * melonDS writes BGRA; the rest of this project uses RGBA throughout, matching
 * what a WebGL texture and an ImageData both expect.
 */
inline uint32_t bgraToRgba(uint32_t pixel)
{
    return (pixel & 0xFF00FF00u) | ((pixel & 0x00FF0000u) >> 16) | ((pixel & 0x000000FFu) << 16);
}

void compose(const uint32_t *top, const uint32_t *bottom)
{
    if (core.layout == LAYOUT_SIDE_BY_SIDE) {
        for (int y = 0; y < DS_SCREEN_H; y++) {
            uint32_t *row = &core.framebuffer[y * DS_SCREEN_W * 2];
            for (int x = 0; x < DS_SCREEN_W; x++) {
                row[x] = bgraToRgba(top[y * DS_SCREEN_W + x]);
                row[DS_SCREEN_W + x] = bgraToRgba(bottom[y * DS_SCREEN_W + x]);
            }
        }
        return;
    }

    for (int i = 0; i < DS_SCREEN_W * DS_SCREEN_H; i++) {
        core.framebuffer[i] = bgraToRgba(top[i]);
        core.framebuffer[DS_SCREEN_W * DS_SCREEN_H + i] = bgraToRgba(bottom[i]);
    }
}

/**
 * Resamples one frame of SPU output to the number of samples the audio device
 * wants for one frame, linearly.
 *
 * Emitting exactly one frame's worth per video frame keeps playback speed
 * correct whatever the hardware rate is, without tracking a global clock.
 */
int resample(int inputFrames)
{
    if (inputFrames <= 0) return 0;

    const int outputFrames =
        std::min<int>(AUDIO_CAPACITY_FRAMES, static_cast<int>(core.sampleRate / DS_FRAME_RATE));
    if (outputFrames <= 0) return 0;

    const double step = static_cast<double>(inputFrames) / outputFrames;

    for (int i = 0; i < outputFrames; i++) {
        const double position = i * step;
        const int index = static_cast<int>(position);
        const double fraction = position - index;

        int16_t leftA, rightA;
        if (index == 0 && core.hasTail) {
            leftA = core.tailLeft;
            rightA = core.tailRight;
        }
        else {
            const int previous = std::max(0, index - (index == 0 ? 0 : 1));
            leftA = core.spu[previous * 2];
            rightA = core.spu[previous * 2 + 1];
        }

        const int next = std::min(inputFrames - 1, index);
        const int16_t leftB = core.spu[next * 2];
        const int16_t rightB = core.spu[next * 2 + 1];

        core.audio[i * 2] = static_cast<int16_t>(leftA + (leftB - leftA) * fraction);
        core.audio[i * 2 + 1] = static_cast<int16_t>(rightA + (rightB - rightA) * fraction);
    }

    core.tailLeft = core.spu[(inputFrames - 1) * 2];
    core.tailRight = core.spu[(inputFrames - 1) * 2 + 1];
    core.hasTail = true;
    return outputFrames;
}

} // namespace

extern "C" {

/* --- Lifecycle ---------------------------------------------------------- */

EMSCRIPTEN_KEEPALIVE
void ndsw_init(int model)
{
    (void)model;

    core.nds.reset();
    core.romLoaded = false;
    core.hasTail = false;
    std::memset(core.framebuffer, 0, sizeof(core.framebuffer));

    NDSArgs args {};
    // The JIT cannot exist in WebAssembly, and asking for it would only make
    // melonDS allocate structures it never uses.
    args.JIT = std::nullopt;

    core.nds = std::make_unique<NDS>(std::move(args));
    core.nds->Reset();
    core.open = true;
}

EMSCRIPTEN_KEEPALIVE
void ndsw_deinit(void)
{
    core.nds.reset();
    core.open = false;
    core.romLoaded = false;
}

EMSCRIPTEN_KEEPALIVE
int ndsw_load_rom(const uint8_t *data, int size)
{
    if (!core.open || !core.nds || size <= 0) return -1;

    auto cart = melonDS::NDSCart::ParseROM(data, static_cast<melonDS::u32>(size));
    if (!cart) return -1;

    core.nds->SetNDSCart(std::move(cart));
    core.nds->Reset();

    // Without a real BIOS and firmware there is no menu to boot through, so the
    // cartridge is started directly. melonDS says when that is required.
    //
    // The overload taking a name is the one that matters: the parameterless
    // variant only prepares main RAM, while this one also copies both CPU
    // binaries out of the cartridge and jumps to their entry points.
    if (core.nds->NeedsDirectBoot()) core.nds->SetupDirectBoot("cart.nds");

    core.nds->Start();
    core.romLoaded = true;
    core.hasTail = false;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
void ndsw_reset(void)
{
    if (!core.open || !core.nds || !core.romLoaded) return;
    core.nds->Reset();
    if (core.nds->NeedsDirectBoot()) core.nds->SetupDirectBoot("cart.nds");
    core.nds->Start();
    core.hasTail = false;
}

/* --- Running ------------------------------------------------------------ */

EMSCRIPTEN_KEEPALIVE
int ndsw_run_frame(void)
{
    if (!core.open || !core.nds || !core.romLoaded) return 0;

    core.nds->RunFrame();

    const int front = core.nds->GPU.FrontBuffer;
    const uint32_t *top = core.nds->GPU.Framebuffer[front][0].get();
    const uint32_t *bottom = core.nds->GPU.Framebuffer[front][1].get();
    if (top && bottom) compose(top, bottom);

    const int available = core.nds->SPU.ReadOutput(core.spu, SPU_BUFFER_FRAMES);
    return resample(available);
}

EMSCRIPTEN_KEEPALIVE
uint32_t *ndsw_framebuffer(void) { return core.framebuffer; }

EMSCRIPTEN_KEEPALIVE
int16_t *ndsw_audio_buffer(void) { return core.audio; }

EMSCRIPTEN_KEEPALIVE
int ndsw_audio_capacity(void) { return AUDIO_CAPACITY_FRAMES; }

EMSCRIPTEN_KEEPALIVE
int ndsw_screen_width(void)
{
    return core.layout == LAYOUT_SIDE_BY_SIDE ? DS_SCREEN_W * 2 : DS_SCREEN_W;
}

EMSCRIPTEN_KEEPALIVE
int ndsw_screen_height(void)
{
    return core.layout == LAYOUT_SIDE_BY_SIDE ? DS_SCREEN_H : DS_SCREEN_H * 2;
}

/** 0 = stacked, 1 = side by side. Safe to change while a game is running. */
EMSCRIPTEN_KEEPALIVE
void ndsw_set_layout(int layout)
{
    core.layout = layout == LAYOUT_SIDE_BY_SIDE ? LAYOUT_SIDE_BY_SIDE : LAYOUT_STACKED;
}

EMSCRIPTEN_KEEPALIVE
double ndsw_frame_rate(void) { return DS_FRAME_RATE; }

EMSCRIPTEN_KEEPALIVE
void ndsw_set_sample_rate(int rate)
{
    if (rate > 0) core.sampleRate = static_cast<unsigned>(rate);
}

/* --- Input -------------------------------------------------------------- */

/*
 * The shared mask uses the Game Boy's bit order extended with L, R, X and Y.
 * The DS register is active low and in its own order, so it is built here.
 */
EMSCRIPTEN_KEEPALIVE
void ndsw_set_key_mask(int mask)
{
    if (!core.open || !core.nds) return;

    // Shared bit -> DS KEYINPUT bit.
    static const int native[12] = {
        4,  // Right
        5,  // Left
        6,  // Up
        7,  // Down
        0,  // A
        1,  // B
        2,  // Select
        3,  // Start
        9,  // L
        8,  // R
        10, // X
        11, // Y
    };

    // Every bit set means nothing pressed; a press clears its bit.
    uint32_t keys = 0xFFF;
    for (int shared = 0; shared < 12; shared++) {
        if (mask & (1 << shared)) keys &= ~(1u << native[shared]);
    }
    core.nds->SetKeyMask(keys);
}

/** Screen coordinates within the lower screen, 0..255 by 0..191. */
EMSCRIPTEN_KEEPALIVE
void ndsw_touch(int x, int y)
{
    if (!core.open || !core.nds) return;
    const int clampedX = std::clamp(x, 0, DS_SCREEN_W - 1);
    const int clampedY = std::clamp(y, 0, DS_SCREEN_H - 1);
    core.nds->TouchScreen(static_cast<melonDS::u16>(clampedX), static_cast<melonDS::u16>(clampedY));
}

EMSCRIPTEN_KEEPALIVE
void ndsw_release_touch(void)
{
    if (core.open && core.nds) core.nds->ReleaseScreen();
}

/* --- Cartridge save data ------------------------------------------------ */

EMSCRIPTEN_KEEPALIVE
int ndsw_battery_size(void)
{
    if (!core.open || !core.nds) return 0;
    const auto *cart = core.nds->GetNDSCart();
    return cart ? static_cast<int>(cart->GetSaveMemoryLength()) : 0;
}

EMSCRIPTEN_KEEPALIVE
int ndsw_save_battery(uint8_t *dst, int size)
{
    if (!core.open || !core.nds || size <= 0) return -1;
    const auto *cart = core.nds->GetNDSCart();
    if (!cart) return -1;

    const uint8_t *memory = cart->GetSaveMemory();
    const int length = static_cast<int>(cart->GetSaveMemoryLength());
    if (!memory || length <= 0) return -1;

    const int count = std::min(length, size);
    std::memcpy(dst, memory, count);
    return count;
}

/**
 * Restored after the ROM, because the cartridge object that owns the save
 * memory only exists once the ROM has been parsed.
 */
EMSCRIPTEN_KEEPALIVE
void ndsw_load_battery(const uint8_t *src, int size)
{
    if (!core.open || !core.nds || size <= 0) return;
    auto *cart = core.nds->GetNDSCart();
    if (cart) cart->SetSaveMemory(src, static_cast<melonDS::u32>(size));
}

/* --- Save states -------------------------------------------------------- */

EMSCRIPTEN_KEEPALIVE
int ndsw_state_size(void)
{
    if (!core.open || !core.nds || !core.romLoaded) return 0;
    Savestate state;
    if (!core.nds->DoSavestate(&state) || state.Error) return 0;
    return static_cast<int>(state.Length());
}

EMSCRIPTEN_KEEPALIVE
int ndsw_save_state(uint8_t *dst, int size)
{
    if (!core.open || !core.nds || !core.romLoaded || size <= 0) return -1;

    Savestate state;
    if (!core.nds->DoSavestate(&state) || state.Error) return -1;

    const int length = static_cast<int>(state.Length());
    if (length > size) return -1;
    std::memcpy(dst, state.Buffer(), length);
    return length;
}

EMSCRIPTEN_KEEPALIVE
int ndsw_load_state(const uint8_t *src, int size)
{
    if (!core.open || !core.nds || !core.romLoaded || size <= 0) return -1;

    // The Savestate reads from this buffer; it is not modified.
    Savestate state(const_cast<uint8_t *>(src), static_cast<melonDS::u32>(size), false);
    if (state.Error) return -1;
    if (!core.nds->DoSavestate(&state) || state.Error) return -1;

    core.hasTail = false;
    return 0;
}

} // extern "C"
