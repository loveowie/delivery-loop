#!/usr/bin/env python3
"""Icon candidates for the market tile: SVG -> headless Chrome -> PNG.

Geometry is computed, not hand-written, so tuning a radius or an arrowhead does
not mean re-deriving coordinates by hand.
"""
import json
import math
import pathlib
import subprocess

HERE = pathlib.Path(__file__).parent
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

TEAL = "#0B6E69"
AQUA = "#3FD8C6"
INK = "#0F1F1E"
WHITE = "#FFFFFF"
PAPER = "#F7F8F7"
C = 90.0  # canvas centre


def pt(deg, radius, cx=C, cy=C):
    """Screen coordinates (y down) for an angle measured clockwise from 3 o'clock."""
    a = math.radians(deg)
    return cx + radius * math.cos(a), cy + radius * math.sin(a)


def arc(d_deg, sweep, radius, cx=C, cy=C):
    """Path data for a clockwise arc."""
    x0, y0 = pt(d_deg, radius, cx, cy)
    x1, y1 = pt(d_deg + sweep, radius, cx, cy)
    large = 1 if abs(sweep) > 180 else 0
    sweep_flag = 1 if sweep > 0 else 0
    return f"M {x0:.2f} {y0:.2f} A {radius} {radius} 0 {large} {sweep_flag} {x1:.2f} {y1:.2f}"


def tangent(deg):
    """Screen-space unit tangent for clockwise travel."""
    a = math.radians(deg)
    return -math.sin(a), math.cos(a)


def arrow_at(deg, radius, length=17.0, half=9.0, cx=C, cy=C):
    """Filled triangle whose tip continues clockwise travel from `deg`."""
    px, py = pt(deg, radius, cx, cy)
    tx, ty = tangent(deg)
    nx, ny = -ty, tx
    tipx, tipy = px + tx * length, py + ty * length
    b1x, b1y = px + nx * half, py + ny * half
    b2x, b2y = px - nx * half, py - ny * half
    return f"M {tipx:.2f} {tipy:.2f} L {b1x:.2f} {b1y:.2f} L {b2x:.2f} {b2y:.2f} Z"


def tile(fill, radius=40):
    return f'<rect width="180" height="180" rx="{radius}" fill="{fill}"/>'


CANDIDATES = {}

# 1 — ring that closes on a check. Brand teal, continues the shipped icon.svg.
CANDIDATES["c1"] = (
    "1 ring+check / teal",
    tile(TEAL)
    + f'<path d="{arc(0, 268, 47)}" fill="none" stroke="{WHITE}" stroke-width="15" stroke-linecap="round"/>'
    + f'<path d="{arrow_at(268, 47, length=16, half=9)}" fill="{WHITE}"/>'
    + f'<path d="M 71 91 L 87 107 L 113 75" fill="none" stroke="{WHITE}" stroke-width="15"'
    ' stroke-linecap="round" stroke-linejoin="round"/>',
)

# 1b — the same mark on ink, to judge the surface rather than the shape.
CANDIDATES["c1b"] = (
    "1b ring+check / ink",
    tile(INK)
    + f'<path d="{arc(0, 268, 47)}" fill="none" stroke="{AQUA}" stroke-width="15" stroke-linecap="round"/>'
    + f'<path d="{arrow_at(268, 47, length=16, half=9)}" fill="{AQUA}"/>'
    + f'<path d="M 71 91 L 87 107 L 113 75" fill="none" stroke="{WHITE}" stroke-width="15"'
    ' stroke-linecap="round" stroke-linejoin="round"/>',
)

# 2 — the ring is cut into stages, all of them ending in one check.
CANDIDATES["c2"] = (
    "2 staged ring / ink",
    tile(INK)
    + f'<path d="{arc(0, 95, 50)}" fill="none" stroke="{AQUA}" stroke-width="14" stroke-linecap="round"/>'
    + f'<path d="{arc(120, 95, 50)}" fill="none" stroke="{AQUA}" stroke-width="14" stroke-linecap="round" opacity="0.55"/>'
    + f'<path d="{arc(240, 95, 50)}" fill="none" stroke="{AQUA}" stroke-width="14" stroke-linecap="round" opacity="0.28"/>'
    + f'<path d="M 74 92 L 86 104 L 108 80" fill="none" stroke="{WHITE}" stroke-width="13"'
    ' stroke-linecap="round" stroke-linejoin="round"/>',
)

# 3 — the board itself: grouped rows, the last one accepted.
CANDIDATES["c3"] = (
    "3 board rows / paper",
    tile(PAPER)
    + f'<rect x="38" y="37" width="104" height="17" rx="8.5" fill="{TEAL}"/>'
    + f'<rect x="38" y="65" width="76" height="17" rx="8.5" fill="{TEAL}" fill-opacity="0.52"/>'
    + f'<path d="M 46.5 117 L 64.5 135 L 94.5 101" fill="none" stroke="{TEAL}" stroke-width="17"'
    ' stroke-linecap="round" stroke-linejoin="round"/>',
)

# 4 — round mark: one solid disc, one check. The loudest option.
CANDIDATES["c4"] = (
    "4 solid disc / teal",
    f'<circle cx="90" cy="90" r="82" fill="{TEAL}"/>'
    + f'<path d="M 56 92 L 80 116 L 126 62" fill="none" stroke="{WHITE}" stroke-width="16"'
    ' stroke-linecap="round" stroke-linejoin="round"/>',
)

def svg(body: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" '
        'viewBox="0 0 180 180">' + body + "</svg>"
    )


def render(name: str, body: str) -> None:
    document = svg(body)
    (HERE / f"{name}.svg").write_text(document, encoding="utf-8")
    html = HERE / f"{name}.html"
    html.write_text(
        '<!doctype html><html><body style="margin:0;background:transparent">'
        + document
        + "</body></html>",
        encoding="utf-8",
    )
    subprocess.run(
        [
            CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
            "--default-background-color=00000000", "--force-device-scale-factor=4",
            "--window-size=180,180", f"--screenshot={HERE / f'{name}@4x.png'}",
            html.as_uri(),
        ],
        check=True, capture_output=True,
    )


if __name__ == "__main__":
    for name, (title, body) in CANDIDATES.items():
        render(name, body)
        print(f"{name}: {title}")
