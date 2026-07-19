#!/usr/bin/env python3
"""Generate the BLDR app mark (BTI identity: red B on a black tile) in every
icon/logo size the app references, plus the vector SVGs. Re-run to regenerate."""
import os
from PIL import Image, ImageDraw, ImageFont

PUB = os.path.join(os.path.dirname(__file__), "..", "public")
BLACK = (20, 20, 20, 255)      # #141414 BTI black tile
RED = (213, 32, 39, 255)       # #D52027 BTI red
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

def draw_mark(size: int) -> Image.Image:
    # supersample for crisp edges
    S = size * 4
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(S * 0.22)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=BLACK)
    # the "B"
    f = ImageFont.truetype(FONT, int(S * 0.66))
    box = d.textbbox((0, 0), "B", font=f)
    w, h = box[2] - box[0], box[3] - box[1]
    x = (S - w) / 2 - box[0]
    y = (S - h) / 2 - box[1]
    d.text((x, y), "B", font=f, fill=RED)
    # thin red "build baseline" accent
    by = int(S * 0.80)
    d.rounded_rectangle([int(S*0.30), by, int(S*0.70), by + int(S*0.022)],
                        radius=int(S*0.011), fill=RED)
    return img.resize((size, size), Image.LANCZOS)

# size -> output path(s)
PNG_TARGETS = {
    16:  ["favicon-16x16.png"],
    32:  ["favicon-32x32.png", "logo-32.png"],
    64:  ["favicon.png", "logo-64.png"],
    72:  ["icons/icon-72x72.png"],
    96:  ["icons/icon-96x96.png"],
    128: ["icons/icon-128x128.png", "logo-128.png"],
    144: ["icons/icon-144x144.png"],
    152: ["icons/icon-152x152.png"],
    180: ["apple-touch-icon.png"],
    192: ["icons/icon-192x192.png", "android-chrome-192x192.png"],
    256: ["logo-256.png"],
    384: ["icons/icon-384x384.png"],
    512: ["icons/icon-512x512.png", "android-chrome-512x512.png", "logo-512.png"],
}

cache = {}
for size, names in PNG_TARGETS.items():
    if size not in cache:
        cache[size] = draw_mark(size)
    for n in names:
        p = os.path.join(PUB, n)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        cache[size].save(p)
        print("png", n)

SVG = '''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" fill="none">
  <!-- BLDR app mark — BTI identity: red "B" on a black tile -->
  <rect width="512" height="512" rx="112" fill="#141414"/>
  <text x="256" y="372" text-anchor="middle" font-family="'DejaVu Sans','Arial Black',Arial,sans-serif" font-weight="bold" font-size="338" fill="#D52027">B</text>
  <rect x="154" y="410" width="204" height="11" rx="5" fill="#D52027"/>
</svg>
'''
SVG_TARGETS = ["favicon.svg", "icons/icon-template.svg"] + [
    f"icons/icon-{s}x{s}.svg" for s in (72, 96, 128, 144, 152, 192, 384, 512)
]
for n in SVG_TARGETS:
    p = os.path.join(PUB, n)
    with open(p, "w") as f:
        f.write(SVG)
    print("svg", n)
print("done")
