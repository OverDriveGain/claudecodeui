#!/usr/bin/env python3
"""Design an original brand-purple 'orbit' loader as a native Lottie (vector, looping)."""
import json, math

SIZE = 200
FR   = 60
OP   = 60                      # 1.0s loop
N    = 12                      # dots
R    = 66                      # orbit radius
DOT  = 15                      # dot diameter
CX = CY = SIZE / 2
PURPLE = [170/255, 136/255, 221/255]   # #AA88DD

def opacity_track(phase):
    """Bright pulse travels around the ring -> rotating loader."""
    kf = []
    for k in range(N + 1):
        b = 0.5 + 0.5 * math.cos(2 * math.pi * ((k - phase) / N))  # 0..1
        op = round(18 + 82 * (b ** 2.2), 2)
        kf.append({"t": round(k / N * OP, 3), "s": [op]})
    # hold keys (linear interp) -> add bezier ease for smoothness
    for i in range(len(kf) - 1):
        kf[i]["i"] = {"x": [0.6], "y": [1]}
        kf[i]["o"] = {"x": [0.4], "y": [0]}
    return kf

def scale_track(phase):
    kf = []
    for k in range(N + 1):
        b = 0.5 + 0.5 * math.cos(2 * math.pi * ((k - phase) / N))
        s = round(62 + 48 * (b ** 2.2), 2)
        kf.append({"t": round(k / N * OP, 3), "s": [s, s]})
    for i in range(len(kf) - 1):
        kf[i]["i"] = {"x": [0.6, 0.6], "y": [1, 1]}
        kf[i]["o"] = {"x": [0.4, 0.4], "y": [0, 0]}
    return kf

groups = []
for i in range(N):
    ang = 2 * math.pi * i / N - math.pi / 2
    x = round(CX + R * math.cos(ang), 2)
    y = round(CY + R * math.sin(ang), 2)
    groups.append({
        "ty": "gr", "nm": f"dot{i}", "it": [
            {"ty": "el", "p": {"a": 0, "k": [0, 0]}, "s": {"a": 0, "k": [DOT, DOT]}},
            {"ty": "fl", "c": {"a": 0, "k": PURPLE + [1]}, "o": {"a": 0, "k": 100}},
            {"ty": "tr",
             "p": {"a": 0, "k": [x, y]},
             "a": {"a": 0, "k": [0, 0]},
             "s": {"a": 1, "k": scale_track(i)},
             "r": {"a": 0, "k": 0},
             "o": {"a": 1, "k": opacity_track(i)}},
        ]
    })

doc = {
    "v": "5.7.0", "fr": FR, "ip": 0, "op": OP, "w": SIZE, "h": SIZE,
    "nm": "M Orbit Loader", "ddd": 0, "assets": [],
    "layers": [{
        "ddd": 0, "ind": 1, "ty": 4, "nm": "orbit", "sr": 1,
        "ks": {"o": {"a": 0, "k": 100}, "r": {"a": 0, "k": 0},
               "p": {"a": 0, "k": [0, 0]}, "a": {"a": 0, "k": [0, 0]},
               "s": {"a": 0, "k": [100, 100]}},
        "ao": 0, "ip": 0, "op": OP, "st": 0, "bm": 0,
        "shapes": groups,
    }],
}
out = "/tmp/lottie_prev/orbit.json"
json.dump(doc, open(out, "w"), separators=(",", ":"))
print("wrote", out, "bytes:", len(json.dumps(doc)))
