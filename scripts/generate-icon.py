"""Generate the AI Dashboard app icon (build/icon.ico + build/icon.png).

A rounded-square app icon with a violet->indigo diagonal gradient, a soft glassy
top sheen, and a white terminal-prompt ">_" glyph with a subtle drop shadow.

Requires Pillow:  pip install pillow
Run:              python scripts/generate-icon.py
Then rebuild the app (pnpm dist / pnpm release) to embed the new icon.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

OUT_DIR = Path(__file__).resolve().parent.parent / "build"
S = 1024          # final design size (px)
SS = 4            # supersample factor for crisp antialiasing
R = S * SS        # render size

C_TL = (0x8B, 0x5C, 0xF6)   # violet  #8B5CF6 (top-left)
C_BR = (0x43, 0x38, 0xCA)   # indigo  #4338CA (bottom-right)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def stroke(draw, pts, w, fill):
    """Polyline with round joints and round end caps."""
    draw.line(pts, fill=fill, width=w, joint="curve")
    r = w / 2
    for (x, y) in pts:
        draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)


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

    # Smooth top sheen (vertical fade, no hard edge).
    sheen = Image.new("L", (R, R), 0)
    sp = sheen.load()
    peak, fade_end = 54, 0.62
    for y in range(R):
        t = y / (R * fade_end)
        a = int(peak * (1 - t)) if t < 1 else 0
        if a > 0:
            for x in range(R):
                sp[x, y] = a
    sheen = Image.composite(sheen, Image.new("L", (R, R), 0), mask)
    white = Image.new("RGBA", (R, R), (255, 255, 255, 255))
    icon = Image.alpha_composite(icon, Image.merge("RGBA", (*white.split()[:3], sheen)))

    # Glyph geometry: terminal prompt  >_
    w = int(0.092 * R)
    chevron = [
        (int(0.345 * R), int(0.345 * R)),
        (int(0.545 * R), int(0.50 * R)),
        (int(0.345 * R), int(0.655 * R)),
    ]
    underscore = [(int(0.585 * R), int(0.655 * R)), (int(0.735 * R), int(0.655 * R))]

    # Soft drop shadow behind the glyph.
    shadow = Image.new("RGBA", (R, R), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    off = int(0.012 * R)
    sh = (10, 8, 40, 150)
    stroke(sdraw, [(x + off, y + off) for (x, y) in chevron], w, sh)
    stroke(sdraw, [(x + off, y + off) for (x, y) in underscore], w, sh)
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(0.018 * R)))
    shadow.putalpha(shadow.split()[3].point(lambda a: int(a * 0.55)))
    icon = Image.alpha_composite(icon, Image.composite(shadow, Image.new("RGBA", (R, R), (0, 0, 0, 0)), mask))

    # White glyph.
    gl = Image.new("RGBA", (R, R), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gl)
    fg = (255, 255, 255, 255)
    stroke(gd, chevron, w, fg)
    stroke(gd, underscore, w, fg)
    icon = Image.alpha_composite(icon, gl)

    return icon.resize((S, S), Image.LANCZOS)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    icon = build_icon()
    icon.save(OUT_DIR / "icon.png")
    icon.save(
        OUT_DIR / "icon.ico",
        sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
    )
    print(f"Wrote {OUT_DIR / 'icon.ico'} and {OUT_DIR / 'icon.png'}")


if __name__ == "__main__":
    main()
