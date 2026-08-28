#!/usr/bin/env python3
"""Generate the PWA icon set.

Deliberately dependency-free (stdlib zlib/struct only) so `npm run gen:icons`
works in CI and in a bare container without Pillow. Re-run after changing the
palette below; the PNGs are committed so the build never depends on Python.
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "icons"

BG = (0x10, 0x16, 0x1D, 255)
SHELL = (0x1B, 0x24, 0x2F, 255)
BEZEL = (0x0B, 0x0F, 0x14, 255)
SCREEN_LIGHT = (0x9B, 0xBC, 0x0F, 255)
SCREEN_DARK = (0x30, 0x62, 0x30, 255)
BUTTON = (0x3A, 0x46, 0x57, 255)


class Canvas:
    def __init__(self, size: int, fill: tuple[int, int, int, int]) -> None:
        self.size = size
        self.px = bytearray(fill * size * size)

    def _blend(self, x: int, y: int, color: tuple[int, int, int, int], alpha: float) -> None:
        if alpha <= 0 or x < 0 or y < 0 or x >= self.size or y >= self.size:
            return
        a = min(1.0, alpha) * (color[3] / 255)
        i = (y * self.size + x) * 4
        for c in range(3):
            self.px[i + c] = round(self.px[i + c] * (1 - a) + color[c] * a)
        self.px[i + 3] = max(self.px[i + 3], round(255 * a))

    def rounded_rect(
        self,
        x0: float,
        y0: float,
        x1: float,
        y1: float,
        radius: float,
        color: tuple[int, int, int, int],
    ) -> None:
        """Anti-aliased rounded rectangle via a signed distance field."""
        for y in range(max(0, int(y0 - 2)), min(self.size, int(y1 + 3))):
            for x in range(max(0, int(x0 - 2)), min(self.size, int(x1 + 3))):
                px, py = x + 0.5, y + 0.5
                # Distance from the rounded box surface.
                dx = max(x0 + radius - px, px - (x1 - radius), 0.0)
                dy = max(y0 + radius - py, py - (y1 - radius), 0.0)
                dist = math.hypot(dx, dy) - radius
                self._blend(x, y, color, 0.5 - dist)

    def vertical_gradient(
        self,
        x0: float,
        y0: float,
        x1: float,
        y1: float,
        radius: float,
        top: tuple[int, int, int, int],
        bottom: tuple[int, int, int, int],
    ) -> None:
        """Same shape as rounded_rect, but the fill colour lerps top -> bottom."""
        for y in range(max(0, int(y0 - 2)), min(self.size, int(y1 + 3))):
            t = min(1.0, max(0.0, (y + 0.5 - y0) / max(1.0, y1 - y0)))
            color = (
                round(top[0] * (1 - t) + bottom[0] * t),
                round(top[1] * (1 - t) + bottom[1] * t),
                round(top[2] * (1 - t) + bottom[2] * t),
                round(top[3] * (1 - t) + bottom[3] * t),
            )
            for x in range(max(0, int(x0 - 2)), min(self.size, int(x1 + 3))):
                px, py = x + 0.5, y + 0.5
                dx = max(x0 + radius - px, px - (x1 - radius), 0.0)
                dy = max(y0 + radius - py, py - (y1 - radius), 0.0)
                dist = math.hypot(dx, dy) - radius
                self._blend(x, y, color, 0.5 - dist)

    def to_png(self) -> bytes:
        raw = bytearray()
        stride = self.size * 4
        for y in range(self.size):
            raw.append(0)  # filter type 0 (None)
            raw.extend(self.px[y * stride : (y + 1) * stride])

        def chunk(tag: bytes, data: bytes) -> bytes:
            return (
                struct.pack(">I", len(data))
                + tag
                + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
            )

        ihdr = struct.pack(">IIBBBBB", self.size, self.size, 8, 6, 0, 0, 0)
        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b"")
        )


def draw_icon(size: int, maskable: bool) -> Canvas:
    """A stylised handheld: shell, screen, d-pad and two buttons."""
    canvas = Canvas(size, (0, 0, 0, 0))
    s = size

    if maskable:
        # Full bleed background, artwork inside the central 80% safe zone.
        canvas.rounded_rect(0, 0, s, s, 0, BG)
        inset, scale = s * 0.18, 0.64
    else:
        canvas.rounded_rect(0, 0, s, s, s * 0.22, BG)
        inset, scale = s * 0.10, 0.80

    def u(v: float) -> float:
        """Map a 0..1 artwork coordinate into the drawable area."""
        return inset + v * scale * s

    canvas.rounded_rect(u(0.06), u(0.02), u(0.94), u(0.98), s * 0.09 * scale, SHELL)
    canvas.rounded_rect(u(0.14), u(0.10), u(0.86), u(0.50), s * 0.03 * scale, BEZEL)
    canvas.vertical_gradient(
        u(0.19), u(0.15), u(0.81), u(0.45), s * 0.015 * scale, SCREEN_LIGHT, SCREEN_DARK
    )

    # D-pad.
    arm = 0.055
    cx, cy = 0.30, 0.72
    canvas.rounded_rect(
        u(cx - arm), u(cy - arm * 3), u(cx + arm), u(cy + arm * 3), s * 0.012 * scale, BUTTON
    )
    canvas.rounded_rect(
        u(cx - arm * 3), u(cy - arm), u(cx + arm * 3), u(cy + arm), s * 0.012 * scale, BUTTON
    )

    # A/B buttons.
    r = 0.055
    for bx, by in ((0.63, 0.76), (0.78, 0.68)):
        canvas.rounded_rect(u(bx - r), u(by - r), u(bx + r), u(by + r), r * scale * s, BUTTON)

    return canvas


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, False),
        ("favicon-32.png", 32, False),
    ]
    for name, size, maskable in targets:
        path = OUT_DIR / name
        path.write_bytes(draw_icon(size, maskable).to_png())
        print(f"wrote {path.relative_to(OUT_DIR.parent.parent)} ({size}x{size})")


if __name__ == "__main__":
    main()
