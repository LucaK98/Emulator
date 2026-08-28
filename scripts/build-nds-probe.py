#!/usr/bin/env python3
"""Assemble and pack tests/roms/nds-probe.nds.

A Nintendo DS cartridge is a 512-byte header followed by one binary per CPU.
Nothing about that needs a full SDK, so the probe is built straight from two
small assembly files and this packer.

Requires arm-none-eabi-gcc (Debian/Ubuntu: gcc-arm-none-eabi). The finished
.nds is committed, so the test suite never needs the assembler.
"""

from __future__ import annotations

import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tests" / "roms" / "src"
OUT = ROOT / "tests" / "roms" / "nds-probe.nds"

ARM9_ADDRESS = 0x02000000
ARM7_ADDRESS = 0x02380000
HEADER_SIZE = 0x200
# Past the secure area, where plain (unencrypted) code is expected.
ARM9_ROM_OFFSET = 0x8000


def assemble(name: str, arch: str, address: int, workdir: Path) -> bytes:
    obj = workdir / f"{name}.o"
    elf = workdir / f"{name}.elf"
    binary = workdir / f"{name}.bin"

    subprocess.run(
        ["arm-none-eabi-gcc", "-c", f"-march={arch}", "-o", str(obj), str(SRC / f"{name}.s")],
        check=True,
    )
    subprocess.run(
        ["arm-none-eabi-ld", f"-Ttext={address:#x}", "-o", str(elf), str(obj)], check=True
    )
    subprocess.run(
        ["arm-none-eabi-objcopy", "-O", "binary", str(elf), str(binary)], check=True
    )
    return binary.read_bytes()


def crc16(data: bytes) -> int:
    """The CRC-16 the DS header carries, as documented in GBATEK."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc & 0xFFFF


def build() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        arm9 = assemble("nds-probe-arm9", "armv5te", ARM9_ADDRESS, workdir)
        arm7 = assemble("nds-probe-arm7", "armv4t", ARM7_ADDRESS, workdir)

    arm7_rom_offset = ARM9_ROM_OFFSET + ((len(arm9) + 0x1FF) & ~0x1FF)
    total = arm7_rom_offset + ((len(arm7) + 0x1FF) & ~0x1FF)

    header = bytearray(HEADER_SIZE)
    header[0x00:0x0C] = b"NDSPROBE\0\0\0\0"
    header[0x0C:0x10] = b"PROB"
    header[0x10:0x12] = b"\0\0"
    header[0x12] = 0x00  # unit code: plain NDS
    header[0x14] = 0x00  # device capacity; nothing reads it here

    struct.pack_into("<IIII", header, 0x20, ARM9_ROM_OFFSET, ARM9_ADDRESS, ARM9_ADDRESS, len(arm9))
    struct.pack_into("<IIII", header, 0x30, arm7_rom_offset, ARM7_ADDRESS, ARM7_ADDRESS, len(arm7))

    struct.pack_into("<I", header, 0x80, total)  # application end offset
    struct.pack_into("<I", header, 0x84, 0x4000)  # header size
    struct.pack_into("<H", header, 0x15E, crc16(bytes(header[0:0x15E])))

    rom = bytearray(total)
    rom[0:HEADER_SIZE] = header
    rom[ARM9_ROM_OFFSET : ARM9_ROM_OFFSET + len(arm9)] = arm9
    rom[arm7_rom_offset : arm7_rom_offset + len(arm7)] = arm7

    OUT.write_bytes(bytes(rom))
    print(f"wrote {OUT.relative_to(ROOT)} ({total} bytes, ARM9 {len(arm9)} B, ARM7 {len(arm7)} B)")


if __name__ == "__main__":
    try:
        build()
    except FileNotFoundError:
        print("arm-none-eabi-gcc not found (Debian/Ubuntu: apt install gcc-arm-none-eabi)", file=sys.stderr)
        raise SystemExit(1)
