"""Generate the Cadence app icon (build/icon.ico + build/icon.png).

A rounded-square app icon with a warm dark gradient tile and the Cadence mark: a
node-graph shaped into a 'C' (nodes connected by edges). It reads as a dev/network
tool and doubles as the Cadence monogram. The geometry is kept in sync with
src/renderer/src/assets/cadence-mark.svg and the inline CadenceMark component in
src/renderer/src/App.tsx — update all three together if the shape changes.

Requires Pillow:  pip install pillow
Run:              python scripts/generate-icon.py
Then rebuild the app (pnpm dist / pnpm release) to embed the new icon.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parent.parent / "build"
S = 1024          # final design size (px)
SS = 4            # supersample factor for crisp antialiasing
R = S * SS        # render size

# Warm dark tile, matching the app theme (--surface ramp), lighter top-left.
C_TL = (0x2C, 0x26, 0x22)
C_BR = (0x17, 0x13, 0x10)
# Off-white mark, matching --text-1 (#EDE8E5).
C_MARK = (0xED, 0xE8, 0xE5, 0xFF)

# Node-graph 'C' geometry in a 0..100 box (mirrored by cadence-mark.svg / CadenceMark).
# Six nodes connected in sequence trace an open-right 'C'.
NODES = [(64, 27), (41, 23), (25, 41), (25, 59), (41, 77), (64, 73)]
EDGE_W = 5.0      # connecting-edge thickness
NODE_R = 7.0      # node radius
# Fraction of the tile the 100x100 mark box occupies (centered).
MARK_SCALE = 0.62


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def draw_mark(img, color):
    """Draw the node-graph 'C' into a 0..100 box centered in `img`, in `color`."""
    a = MARK_SCALE * img.width
    off = (img.width - a) / 2

    def mx(v):
        return off + (v / 100.0) * a

    draw = ImageDraw.Draw(img)
    pts = [(mx(x), mx(y)) for (x, y) in NODES]

    # Edges with round caps + joints.
    w = max(1, int(round((EDGE_W / 100.0) * a)))
    ipts = [(int(round(x)), int(round(y))) for (x, y) in pts]
    draw.line(ipts, fill=color, width=w, joint="curve")
    rr = w / 2
    for (x, y) in ipts:
        draw.ellipse([x - rr, y - rr, x + rr, y + rr], fill=color)

    # Nodes on top.
    nr = (NODE_R / 100.0) * a
    for (x, y) in pts:
        draw.ellipse([x - nr, y - nr, x + nr, y + nr], fill=color)


def build_icon():
    # Diagonal gradient (computed small, scaled up smoothly).
    g = 96
    grad = Image.new("RGB", (g, g))
    gp = grad.load()
    for y in range(g):
        for x in range(g):
            gp[x, y] = lerp(C_TL, C_BR, (x + y) / (2 * (g - 1)))
    grad = grad.resize((R, R), Image.BILINEAR)

    # Rounded-square mask.
    mask = Image.new("L", (R, R), 0)
    radius = int(0.225 * R)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, R - 1, R - 1], radius=radius, fill=255)

    icon = Image.new("RGBA", (R, R), (0, 0, 0, 0))
    icon.paste(grad, (0, 0), mask)

    mark = Image.new("RGBA", (R, R), (0, 0, 0, 0))
    draw_mark(mark, C_MARK)
    icon = Image.alpha_composite(icon, mark)

    return icon.resize((S, S), Image.LANCZOS)


def build_mark():
    """Transparent off-white mark only (no tile), for general/marketing use."""
    mark = Image.new("RGBA", (R, R), (0, 0, 0, 0))
    draw_mark(mark, C_MARK)
    return mark.resize((S, S), Image.LANCZOS)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    icon = build_icon()
    icon.save(OUT_DIR / "icon.png")
    icon.save(
        OUT_DIR / "icon.ico",
        sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
    )
    build_mark().save(OUT_DIR / "cadence-mark.png")
    print(f"Wrote {OUT_DIR / 'icon.ico'}, {OUT_DIR / 'icon.png'}, {OUT_DIR / 'cadence-mark.png'}")


if __name__ == "__main__":
    main()
