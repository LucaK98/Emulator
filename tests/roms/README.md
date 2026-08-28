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

The built `.gb` files are committed so the suite needs no assembler.

## Note on redistribution

The blargg ROMs are the only third-party binaries here, and the only exception
to the "no ROMs in this repository" rule; `.gitignore` re-includes
`tests/roms/` explicitly.
