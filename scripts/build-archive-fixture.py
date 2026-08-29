#!/usr/bin/env python3
"""Builds tests/roms/packed-probe.7z, the fixture for archive import.

Why 7z and not rar, when RAR is what the feature was asked for: both go through
the same libarchive reader in the app, but no free tool creates a RAR archive —
the format is proprietary on the compression side. A 7z fixture is therefore
the only reproducible way to exercise that reader in CI. The RAR reader itself
was checked by hand against real RAR4, RAR5 and solid archives.

The archive holds a cartridge next to the files a ROM-hack release usually
ships with, so the import's "find the ROM among the clutter" logic is exercised
too.

Requires py7zr (pip install py7zr). The finished .7z is committed, so the test
suite needs neither py7zr nor a 7z binary.
"""

from __future__ import annotations

from pathlib import Path

import py7zr

ROOT = Path(__file__).resolve().parent.parent
ROM = ROOT / "tests/roms/arm.gba"
OUTPUT = ROOT / "tests/roms/packed-probe.7z"


def main() -> int:
    with py7zr.SevenZipFile(OUTPUT, "w") as archive:
        archive.writestr(ROM.read_bytes(), "Rising Sun/Rising Sun.gba")
        archive.writestr(
            "Diese Datei gehoert nicht zur ROM.\n", "Rising Sun/liesmich.txt"
        )
    print(f"wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
