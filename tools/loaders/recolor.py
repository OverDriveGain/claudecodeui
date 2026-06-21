#!/usr/bin/env python3
"""Recolor provided Lotties into the brand-purple set and strip baked text."""
import json, sys

PURPLE = [170/255, 136/255, 221/255]   # #AA88DD
LIGHT  = [200/255, 184/255, 230/255]   # lighter purple for dark-bg line art

def is_grayish(c):
    r, g, b = c[0], c[1], c[2]
    return max(r, g, b) - min(r, g, b) < 0.08

def walk(node, mode):
    if isinstance(node, dict):
        # strip text layers/shapes
        if node.get("ty") == 5 or "t" in node and isinstance(node.get("t"), dict) and "d" in node["t"]:
            node["_drop"] = True
        # solid color fields 'c'/'sc' that are static color arrays
        for key in ("c", "sc"):
            v = node.get(key)
            if isinstance(v, dict) and v.get("a") == 0 and isinstance(v.get("k"), list) and len(v["k"]) >= 3:
                c = v["k"]
                if mode == "atom":            # cyan/blue -> purple, leave grays
                    if not is_grayish(c):
                        v["k"] = PURPLE + c[3:]
                elif mode == "cubes":         # near-black strokes -> light purple
                    if max(c[0], c[1], c[2]) < 0.25:
                        v["k"] = LIGHT + c[3:]
                    elif not is_grayish(c):
                        v["k"] = PURPLE + c[3:]
        for v in list(node.values()):
            walk(v, mode)
    elif isinstance(node, list):
        for v in node:
            walk(v, mode)

def drop_marked(node):
    if isinstance(node, dict):
        for k in ("layers", "shapes", "it"):
            if isinstance(node.get(k), list):
                node[k] = [x for x in node[k] if not (isinstance(x, dict) and x.get("_drop"))]
        for v in node.values():
            drop_marked(v)
    elif isinstance(node, list):
        for v in node:
            drop_marked(v)

src, dst, mode = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(src))
walk(d, mode)
drop_marked(d)
json.dump(d, open(dst, "w"), separators=(",", ":"))
print(f"recolored {mode}: {dst}")
