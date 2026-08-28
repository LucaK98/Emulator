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

This is the only exception to the "no ROMs in this repository" rule; `.gitignore`
re-includes `tests/roms/` explicitly.
