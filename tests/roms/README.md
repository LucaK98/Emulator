# Test ROMs

These are Shay Green's ("blargg") Game Boy hardware test ROMs, which the author
released for free distribution and which are bundled with most open-source Game
Boy emulators for exactly this purpose. They contain no commercial game code.

Source: https://github.com/retrio/gb-test-roms

| File | What it proves |
| --- | --- |
| `cpu_instrs.gb` | All SM83 instructions behave correctly (11 sub-suites). |
| `instr_timing.gb` | Instruction cycle timings are correct. |

Both render their verdict to the screen, so the suite compares the resulting
framebuffer against a stored reference. A mismatch means the core changed
behaviour — regenerate the reference only after confirming the new output is
correct.

## Game Boy Advance

`arm.gba` and `thumb.gba` are from [jsmolka/gba-tests](https://github.com/jsmolka/gba-tests),
MIT licensed.

They are deliberately stricter than any commercial game, and mGBA does not pass
them in full: `arm.gba` stops at test 235, `thumb.gba` at test 102. Those are
mGBA's own accuracy gaps, not defects in this project's wrapper, and they do not
stop real games from running. The suite therefore pins the screen each ROM
currently produces as a **change detector** — a wrapper regression or a core
upgrade shows up as a deliberate decision instead of a silent shift — and
asserts the things that must hold outright: geometry, frame rate, audio rate,
save-state round-trip, and that a cartridge without save memory reports none.

## Purpose-built probes

`ppu-probe.gb` and `overworld-probe.gb` are written for this project; their
sources are in `src/` and they are assembled with [RGBDS](https://github.com/gbdev/rgbds):

```bash
rgbasm -o probe.o src/ppu-probe.asm && rgblink -o ppu-probe.gb probe.o && rgbfix -v -p 0xFF probe.gb
```

| File | What it proves |
| --- | --- |
| `ppu-probe.gb` | The layer decoder reads signed tile addressing, an off-grid scroll, a window at a non-zero origin, and 8x16 objects with flips and priority — checked by flattening the decoded layers and comparing to the emulator's own output. |
| `overworld-probe.gb` | The height model separates ground from scenery with no per-game knowledge: a character walks a corridor of ground tiles past scattered scenery, and only the scenery may rise. |
| `nds-probe.nds` | Both DS screens are composed correctly and both arrangements work: a colour gradient on the engine A screen, a flat backdrop on the engine B screen, so the two can never be confused. |
| `gba-farcart-probe.gba` | A GBA cartridge stays mapped over its whole length. mGBA does not copy a ROM, so the buffer handed to it has to outlive the load call; this probe stores four colours 4, 8, 12 and nearly 16 MiB in and paints them as four bands, so a cartridge that stops being readable shows up as the wrong picture rather than as nothing at all. |

`gba-farcart-probe.gba` is assembled and packed by `scripts/build-gba-probe.py`,
which needs the same `arm-none-eabi-gcc`. It is 16 MiB of mostly 0xFF, which is
what unused cartridge space reads as; git stores that in a few kilobytes. Its
header carries no Nintendo logo — that is what a real BIOS checks before
handing over control, and it is not ours to reproduce, so this is an emulator
test ROM rather than something a console would boot.

`nds-probe.nds` is assembled from `src/nds-probe-arm9.s` and
`src/nds-probe-arm7.s` and packed by `scripts/build-nds-probe.py`, which also
writes the cartridge header. It needs `arm-none-eabi-gcc` (Debian/Ubuntu:
`apt install gcc-arm-none-eabi`); the finished `.nds` is committed, so the suite
does not.

The built `.gb` files are committed so the suite needs no assembler.

## Note on redistribution

The blargg ROMs are the only third-party binaries here, and the only exception
to the "no ROMs in this repository" rule; `.gitignore` re-includes
`tests/roms/` explicitly.
