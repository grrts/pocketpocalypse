"""Bake terrain height for a country from the public AWS Terrain Tiles.

Fetches Terrarium-encoded z11 tiles (metres = R*256 + G + B/256 - 32768) and
stitches each 4x4 block into one 1024 px tile at z9, so the game ships about
60 files instead of 900 and never fetches elevation at runtime.

Usage: python tools/geobake/elevation.py --country nl --out public/data/nl/elev
"""
import argparse
import io
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from countries import COUNTRIES  # noqa: E402
from mercator import tile_range  # noqa: E402

URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
SRC_Z, OUT_Z = 11, 9
K = 2 ** (SRC_Z - OUT_Z)


def fetch(z, x, y, cache):
    path = os.path.join(cache, f"{z}_{x}_{y}.png")
    if not os.path.exists(path):
        with urllib.request.urlopen(URL.format(z=z, x=x, y=y), timeout=60) as r:
            data = r.read()
        with open(path + ".part", "wb") as f:
            f.write(data)
        os.replace(path + ".part", path)
    return np.asarray(Image.open(path).convert("RGB"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--country", default="nl")
    ap.add_argument("--out", required=True)
    ap.add_argument("--cache", default=".geobake-cache/terrarium")
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    tiles = tile_range(OUT_Z, COUNTRIES[a.country]["bbox"])
    written = []

    def bake(t):
        x, y = t
        img = np.zeros((256 * K, 256 * K, 3), np.uint8)
        for j in range(K):
            for i in range(K):
                img[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256] = fetch(SRC_Z, x * K + i, y * K + j, a.cache)
        d = os.path.join(a.out, str(OUT_Z), str(x))
        os.makedirs(d, exist_ok=True)
        Image.fromarray(img).save(os.path.join(d, f"{y}.png"), optimize=True)
        return [x, y]

    with ThreadPoolExecutor(8) as ex:
        for r in ex.map(bake, tiles):
            written.append(r)
            print("z9", r, flush=True)
    with open(os.path.join(a.out, "index.json"), "w") as f:
        json.dump({"z": OUT_Z, "size": 256 * K, "encoding": "terrarium", "tiles": written,
                   "attribution": "AWS Terrain Tiles (Mapzen Terrarium)"}, f)


if __name__ == "__main__":
    main()
