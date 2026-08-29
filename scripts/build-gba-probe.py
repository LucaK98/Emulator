#!/usr/bin/env python3
"""Assembles and packs tests/roms/gba-farcart-probe.gba.

The probe reads its palette from markers spread across a 16 MiB cartridge, so
this script does three things: assemble the code, write a valid GBA header
around it, and drop the markers at their absolute offsets.

Requires arm-none-eabi-gcc (Debian/Ubuntu: apt install gcc-arm-none-eabi).
The finished .gba is committed, so the test suite does not need the assembler.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "tests/roms/src/gba-farcart-probe.s"
OUTPUT = ROOT / "tests/roms/gba-farcart-probe.gba"

ROM_SIZE = 16 * 1024 * 1024

# Offset within the cartridge -> the XBGR1555 colour stored there. The
# addresses in the assembly are these offsets plus the 0x08000000 cartridge
# base. Bright and fully saturated so a band is unmistakable.
MARKERS = {
    0x400000: 0x001F,  # red
    0x800000: 0x03E0,  # green
    0xC00000: 0x7C00,  # blue
    0xFF0000: 0x7FFF,  # white
}

def assemble() -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        elf = tmpdir / "probe.elf"
        binary = tmpdir / "probe.bin"
        linker = tmpdir / "probe.ld"

        # Cartridge code runs from 0x08000000; the entry point is the start.
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
        return binary.read_bytes()


def header_checksum(rom: bytearray) -> int:
    """The GBA header's own check byte, over 0xA0..0xBC."""
    return (-(0x19 + sum(rom[0xA0:0xBD]))) & 0xFF


def main() -> int:
    code = assemble()
    rom = bytearray(b"\xff" * ROM_SIZE)
    rom[: len(code)] = code

    # --- Cartridge header ---
    #
    # 0x04..0xA0 holds the Nintendo logo, which the real BIOS compares before
    # it hands control to the cartridge. Emulators that boot a ROM directly do
    # not check it, and it is not ours to reproduce, so it stays as padding.
    # That makes this probe an emulator test ROM, not something a console would
    # accept.
    rom[0xA0:0xAC] = b"FARCARTPROB"[:12].ljust(12, b"\x00")
    rom[0xAC:0xB0] = b"CFCP"
    rom[0xB0:0xB2] = b"01"
    rom[0xB2] = 0x96
    rom[0xB3:0xBD] = bytes(10)
    rom[0xBD] = header_checksum(rom)
    rom[0xBE:0xC0] = bytes(2)

    # --- Far markers ---
    for offset, colour in MARKERS.items():
        if offset < len(code):
            print(f"marker at {offset:#x} would overwrite code", file=sys.stderr)
            return 1
        rom[offset] = colour & 0xFF
        rom[offset + 1] = (colour >> 8) & 0xFF

    if len(rom) != ROM_SIZE:
        print(f"header writes resized the ROM to {len(rom)}", file=sys.stderr)
        return 1

    OUTPUT.write_bytes(rom)
    print(f"wrote {OUTPUT} ({len(rom)} bytes, {len(code)} bytes of code)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
