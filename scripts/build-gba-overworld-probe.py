#!/usr/bin/env python3
"""Assembles tests/roms/gba-overworld-probe.gba.

A miniature overworld: a scrolling map of ground tiles with scenery scattered
through it, and one character whose feet only ever cross ground. What the
height model is meant to read, with nothing in the cartridge saying which tile
is which.

Requires arm-none-eabi-gcc. The finished .gba is committed.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "tests/roms/src/gba-overworld-probe.s"
OUTPUT = ROOT / "tests/roms/gba-overworld-probe.gba"


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        elf, binary, linker = tmpdir / "p.elf", tmpdir / "p.bin", tmpdir / "p.ld"
        linker.write_text(
            "ENTRY(_start)\n"
            "MEMORY { rom : ORIGIN = 0x08000000, LENGTH = 32M }\n"
            "SECTIONS { .text : { *(.text.boot) *(.text*) *(.rodata*) } > rom }\n"
        )
        subprocess.run(
            [
                "arm-none-eabi-gcc", "-x", "assembler-with-cpp", "-marm",
                "-mcpu=arm7tdmi", "-nostdlib", "-nostartfiles",
                "-T", str(linker), "-o", str(elf), str(SOURCE),
            ],
            check=True,
        )
        subprocess.run(
            ["arm-none-eabi-objcopy", "-O", "binary", str(elf), str(binary)],
            check=True,
        )
        code = binary.read_bytes()

    # Round up to a whole number of kilobytes; cartridges are not odd sizes.
    rom = bytearray(code + b"\xff" * (-len(code) % 1024))

    # 0x04..0xA0 is the Nintendo logo the real BIOS checks. It is not ours to
    # reproduce and emulators booting a cartridge directly do not look at it.
    rom[0xA0:0xAC] = b"SCROLLPROB".ljust(12, b"\x00")
    rom[0xAC:0xB0] = b"CSCP"
    rom[0xB0:0xB2] = b"01"
    rom[0xB2] = 0x96
    rom[0xB3:0xBD] = bytes(10)
    rom[0xBD] = (-(0x19 + sum(rom[0xA0:0xBD]))) & 0xFF

    OUTPUT.write_bytes(rom)
    print(f"wrote {OUTPUT} ({len(rom)} bytes, {len(code)} bytes of code)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
