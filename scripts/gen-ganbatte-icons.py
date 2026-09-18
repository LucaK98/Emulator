#!/usr/bin/env python3
"""Generate the icon set for the Ganbatte PWA.

Like scripts/gen-icons.py, deliberately dependency-free (stdlib zlib/struct
only), so the icons can be regenerated in CI or in a bare container without
Pillow. The PNGs are committed; the build never runs Python.

Motif: a cream speech bubble on a terracotta-to-sun gradient with a small sun
inside - talking plus Mediterranean warmth, which is the whole app in one
picture. Everything is drawn from signed distance fields so the shapes stay
crisp at 32 px and at 512 px.
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "ganbatte" / "icons"

CLAY = (0xC8, 0x55, 0x3D, 255)
SUN = (0xF4, 0xA2, 0x59, 255)
CREAM = (0xFF, 0xF8, 0xEE, 255)
GOLD = (0xF7, 0xC5, 0x48, 255)


class Canvas:
    def __init__(self, size: int, fill: tuple[int, int, int, int]) -> None:
        self.size = size
        self.px = bytearray(fill * size * size)

    def _blend(self, x: int, y: int, color, alpha: float) -> None:
        if alpha <= 0 or x < 0 or y < 0 or x >= self.size or y >= self.size:
            return
        a = min(1.0, alpha) * (color[3] / 255)
        i = (y * self.size + x) * 4
        for c in range(3):
            self.px[i + c] = round(self.px[i + c] * (1 - a) + color[c] * a)
        self.px[i + 3] = max(self.px[i + 3], round(255 * a))

    @staticmethod
    def _box_distance(px: float, py: float, x0, y0, x1, y1, radius: float) -> float:
        """Signed distance to a rounded box: negative inside, positive outside.

        Signed matters: a distance that is merely clamped at 0 leaves the whole
        interior at the 0.5 coverage of the shape's edge, and a full-bleed fill
        comes out half transparent.
        """
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        hw = max((x1 - x0) / 2 - radius, 0.0)
        hh = max((y1 - y0) / 2 - radius, 0.0)
        qx = abs(px - cx) - hw
        qy = abs(py - cy) - hh
        return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - radius

    def rounded_rect(self, x0, y0, x1, y1, radius, color) -> None:
        for y in range(max(0, int(y0 - 2)), min(self.size, int(y1 + 3))):
            for x in range(max(0, int(x0 - 2)), min(self.size, int(x1 + 3))):
                dist = self._box_distance(x + 0.5, y + 0.5, x0, y0, x1, y1, radius)
                self._blend(x, y, color, 0.5 - dist)

    def gradient_rect(self, x0, y0, x1, y1, radius, top, bottom) -> None:
        """Rounded rect whose fill lerps diagonally from `top` to `bottom`."""
        for y in range(max(0, int(y0 - 2)), min(self.size, int(y1 + 3))):
            for x in range(max(0, int(x0 - 2)), min(self.size, int(x1 + 3))):
                t = min(1.0, max(0.0, ((x - x0) * 0.35 + (y - y0) * 0.65) / max(1.0, y1 - y0)))
                color = tuple(round(top[i] * (1 - t) + bottom[i] * t) for i in range(4))
                dist = self._box_distance(x + 0.5, y + 0.5, x0, y0, x1, y1, radius)
                self._blend(x, y, color, 0.5 - dist)

    def circle(self, cx, cy, r, color) -> None:
        for y in range(max(0, int(cy - r - 2)), min(self.size, int(cy + r + 3))):
            for x in range(max(0, int(cx - r - 2)), min(self.size, int(cx + r + 3))):
                dist = math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r
                self._blend(x, y, color, 0.5 - dist)

    def ray(self, cx, cy, angle, r0, r1, w0, w1, color) -> None:
        """A tapered ray, stamped from overlapping discs.

        Stamping instead of a rotated rectangle keeps the ends round and the
        edges anti-aliased at every angle, which is what makes the sun still
        look like a sun at 32 px.
        """
        steps = max(4, int((r1 - r0) * 2))
        for i in range(steps + 1):
            t = i / steps
            self.circle(
                cx + math.cos(angle) * (r0 + (r1 - r0) * t),
                cy + math.sin(angle) * (r0 + (r1 - r0) * t),
                w0 + (w1 - w0) * t,
                color,
            )

    def triangle(self, points, color) -> None:
        """Flat triangle with 4x4 supersampling - used for the bubble's tail."""
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        (ax, ay), (bx, by), (cx, cy) = points
        det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(det) < 1e-9:
            return
        for y in range(max(0, int(min(ys)) - 1), min(self.size, int(max(ys)) + 2)):
            for x in range(max(0, int(min(xs)) - 1), min(self.size, int(max(xs)) + 2)):
                inside = 0
                for sy in range(4):
                    for sx in range(4):
                        px = x + (sx + 0.5) / 4
                        py = y + (sy + 0.5) / 4
                        w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det
                        w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det
                        if w0 >= 0 and w1 >= 0 and w0 + w1 <= 1:
                            inside += 1
                if inside:
                    self._blend(x, y, color, inside / 16)

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
    canvas = Canvas(size, (0, 0, 0, 0))
    s = size

    if maskable:
        # Full bleed; the artwork stays inside the central 80% safe zone, because
        # Android may crop the icon to a circle.
        canvas.gradient_rect(0, 0, s, s, 0, SUN, CLAY)
        inset, scale = s * 0.18, 0.64
    else:
        canvas.gradient_rect(0, 0, s, s, s * 0.22, SUN, CLAY)
        inset, scale = s * 0.10, 0.80

    def u(v: float) -> float:
        """Map a 0..1 artwork coordinate into the drawable area."""
        return inset + v * scale * s

    def d(v: float) -> float:
        """Scale a length into the drawable area."""
        return v * scale * s

    # Speech bubble.
    canvas.rounded_rect(u(0.04), u(0.06), u(0.96), u(0.72), d(0.19), CREAM)
    canvas.triangle(
        [(u(0.28), u(0.62)), (u(0.54), u(0.62)), (u(0.30), u(0.96))],
        CREAM,
    )

    # Sun inside the bubble: disc plus eight rays, the "talking in the south"
    # half of the motif.
    cx, cy = u(0.50), u(0.38)
    canvas.circle(cx, cy, d(0.150), GOLD)
    for i in range(8):
        angle = i * math.pi / 4
        canvas.ray(cx, cy, angle, d(0.205), d(0.285), d(0.030), d(0.016), GOLD)

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
        print(f"wrote {path.relative_to(OUT_DIR.parent.parent.parent)} ({size}x{size})")


if __name__ == "__main__":
    main()
