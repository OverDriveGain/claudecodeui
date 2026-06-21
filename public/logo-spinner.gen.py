#!/usr/bin/env python3
"""Render a subtle, professional logo spinner: static logo + orbiting comet arc."""
import math, os
from PIL import Image, ImageDraw

SRC   = "/home/manar/Projects/claudecodeui/public/logo-512.png"
OUT   = "/tmp/logo_spin/frames"
SIZE  = 128          # final canvas px
SS    = 4            # supersample factor
N     = 48           # frames (one full revolution)
PURPLE = (170, 136, 221)   # #AA88DD brand accent

S = SIZE * SS
C = S / 2
LOGO   = int(0.586 * S)    # logo box  (~150px @256)
R      = int(0.437 * S)    # orbit radius, center of stroke (~112px @256)
STROKE = max(2, int(0.0215 * S))  # arc thickness (~5.5px @256)
ARC    = 265               # comet sweep in degrees
TRACK_A = 30               # faint track ring alpha

os.makedirs(OUT, exist_ok=True)

# ---- static base: faint track ring + centered logo -------------------------
base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(base)
# faint full track ring
bbox = [C - R, C - R, C + R, C + R]
d.ellipse(bbox, outline=PURPLE + (TRACK_A,), width=STROKE)

logo = Image.open(SRC).convert("RGBA").resize((LOGO, LOGO), Image.LANCZOS)
base.alpha_composite(logo, (int(C - LOGO / 2), int(C - LOGO / 2)))

# ---- comet arc sprite (head bright -> tail transparent) --------------------
comet = Image.new("RGBA", (S, S), (0, 0, 0, 0))
cd = ImageDraw.Draw(comet)
dot = STROKE / 2.0
steps = ARC * 3                       # fine sampling for a smooth stroke
for i in range(steps + 1):
    t = i / steps                     # 0 = head, 1 = tail
    ang = math.radians(-90 + t * ARC) # head starts at top, sweeps clockwise
    x = C + R * math.cos(ang)
    y = C + R * math.sin(ang)
    # ease the fade so the head holds, then tapers — cubic falloff
    a = int(255 * (1 - t) ** 1.6)
    cd.ellipse([x - dot, y - dot, x + dot, y + dot], fill=PURPLE + (a,))

# ---- compose frames --------------------------------------------------------
for f in range(N):
    angle = -f * (360 / N)            # rotate clockwise
    arc = comet.rotate(angle, resample=Image.BICUBIC, center=(C, C))
    frame = base.copy()
    frame.alpha_composite(arc)
    frame = frame.resize((SIZE, SIZE), Image.LANCZOS)
    frame.save(f"{OUT}/f{f:03d}.png")

print(f"rendered {N} frames @ {SIZE}px -> {OUT}")
