#!/usr/bin/env python3
"""Downscale the 4x renders to the sizes a storefront and a plugin row use,
then compose one comparison sheet at true pixel sizes."""
import pathlib
from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).parent
ORDER = [
    ("c1", "1  ring + check   teal"),
    ("c1b", "1b  same mark   ink"),
    ("c2", "2  staged ring   ink"),
    ("c3", "3  board rows   paper"),
    ("c4", "4  solid disc   teal"),
]
SIZES = [180, 96, 40, 24]
BG = (226, 230, 229)
LABEL = (28, 34, 33)
MUTED = (96, 104, 102)


def font(size, bold=False):
    for family in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else None,
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        if family is None:
            continue
        try:
            return ImageFont.truetype(family, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main():
    for name, _ in ORDER:
        raw = Image.open(HERE / f"{name}@4x.png").convert("RGBA")
        assert raw.size == (720, 720), raw.size
        for size in SIZES:
            raw.resize((size, size), Image.LANCZOS).save(HERE / f"{name}-{size}.png")
        raw.resize((180, 180), Image.LANCZOS).save(HERE / f"{name}-icon180.png")

    pad, label_w, gap = 28, 250, 26
    row_h = 180 + 30
    width = pad + label_w + sum(SIZES) + gap * len(SIZES) + pad
    height = pad * 2 + row_h * len(ORDER) + 46
    sheet = Image.new("RGBA", (width, height), BG + (255,))
    draw = ImageDraw.Draw(sheet)

    head = font(15, bold=True)
    x = pad + label_w
    for size in SIZES:
        draw.text((x, pad - 6), f"{size}px", font=head, fill=MUTED)
        x += size + gap
    draw.text((pad, pad - 6), "option", font=head, fill=MUTED)

    y = pad + 34
    for name, label in ORDER:
        draw.text((pad, y + 78), label, font=font(17, bold=True), fill=LABEL)
        x = pad + label_w
        for size in SIZES:
            icon = Image.open(HERE / f"{name}-{size}.png").convert("RGBA")
            # centre every size on the same optical line
            sheet.alpha_composite(icon, (x, y + (180 - size) // 2))
            x += size + gap
        y += row_h

    sheet.convert("RGB").save(HERE / "sheet.png")
    print("sheet:", sheet.size)


if __name__ == "__main__":
    main()
