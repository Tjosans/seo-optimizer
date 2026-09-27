"""
Draws the app icon: a magnifying glass over a check, on a navy tile.

    python apps/desktop/scripts/make-icon.py      # needs Pillow

Writes apps/desktop/build/icon.ico, which electron-builder puts on the exe,
the installer and the shortcuts, and build/icon.png, the window's icon when
run from a checkout. Both are committed; run this again only to change the
design.

Every size in the .ico is drawn on its own rather than scaled from the
largest, and the small ones with heavier strokes, so the lens and the check
are still legible in a 16px taskbar slot.
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "build"
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
SUPERSAMPLE = 8

TOP = (30, 64, 175)  # tile gradient, top
BOTTOM = (11, 31, 77)  # and bottom
GLASS = (255, 255, 255)
CHECK = (74, 222, 128)


def draw(size: int) -> Image.Image:
    s = size * SUPERSAMPLE
    k = s / 1024  # the design is laid out on a 1024 grid
    # Small icons lose thin strokes to resampling; thicken them.
    bold = 1.0 if size >= 48 else 1.25 if size >= 24 else 1.5

    gradient = Image.new("RGB", (1, s))
    for y in range(s):
        t = y / (s - 1)
        gradient.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    tile = gradient.resize((s, s))

    mask = Image.new("L", (s, s), 0)
    margin = 24 * k
    ImageDraw.Draw(mask).rounded_rectangle(
        (margin, margin, s - margin, s - margin), radius=210 * k, fill=255
    )
    icon = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    icon.paste(tile, (0, 0), mask)

    d = ImageDraw.Draw(icon)
    cx, cy, r = 450 * k, 450 * k, 245 * k
    ring = 80 * k * bold
    # Handle first, so the ring overlaps its end cleanly.
    handle = 118 * k * bold
    start = (cx + r * 0.72, cy + r * 0.72)
    end = (815 * k, 815 * k)
    d.line([start, end], fill=GLASS, width=round(handle))
    d.ellipse(
        (end[0] - handle / 2, end[1] - handle / 2, end[0] + handle / 2, end[1] + handle / 2),
        fill=GLASS,
    )
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=GLASS, width=round(ring))

    check = 72 * k * bold
    points = [(335 * k, 462 * k), (420 * k, 548 * k), (572 * k, 368 * k)]
    d.line(points, fill=CHECK, width=round(check), joint="curve")
    for x, y in (points[0], points[-1]):
        d.ellipse((x - check / 2, y - check / 2, x + check / 2, y + check / 2), fill=CHECK)

    return icon.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    images = [draw(size) for size in ICO_SIZES]
    largest = images[-1]
    largest.save(OUT / "icon.ico", sizes=[(n, n) for n in ICO_SIZES], append_images=images[:-1])
    draw(512).save(OUT / "icon.png")
    print(f"wrote {OUT / 'icon.ico'} ({', '.join(map(str, ICO_SIZES))}) and icon.png")


if __name__ == "__main__":
    main()
