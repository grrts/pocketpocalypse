"""Cloud-free Sentinel-2 summer colour mosaic, cut into Web Mercator JPEG tiles.

Reads the public Sentinel-2 L2A COGs on AWS (s3://sentinel-cogs). For every
100 km grid square over the country it takes the clearest summer scenes, masks
clouds and shadows with the scene classification layer, takes a per-pixel
median, and warps the result into z8 and z10 Web Mercator tiles. The game uses
these to colour open ground the way it looks from orbit.

Usage: python tools/geobake/sentinel.py --country nl --out public/data/nl/sat
"""
import argparse
import json
import os
import sys
import urllib.request

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from countries import COUNTRIES  # noqa: E402
from mercator import tile_range  # noqa: E402

BUCKET = "https://sentinel-cogs.s3.us-west-2.amazonaws.com"
PREFIX = "sentinel-s2-l2a-cogs"
HALF = 20037508.342789244
# SCL classes to drop: no data, saturated, cloud shadow, cloud (medium/high), cirrus, snow
BAD_SCL = {0, 1, 3, 8, 9, 10, 11}
LEVELS = {8: 1024, 10: 1024}  # tile zoom -> pixels per tile (z10 at 1024 px ≈ 23 m per pixel in NL)


def get(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()


def list_prefixes(prefix):
    import re
    xml = get(f"{BUCKET}/?list-type=2&prefix={prefix}&delimiter=/").decode()
    return re.findall(r"<Prefix>([^<]+)</Prefix>", xml)[1:]


def scenes(square, years, months):
    zone, band, sq = square[:2], square[2], square[3:]
    out = []
    for y in years:
        for m in months:
            for p in list_prefixes(f"{PREFIX}/{zone}/{band}/{sq}/{y}/{m}/"):
                name = p.rstrip("/").split("/")[-1]
                try:
                    meta = json.loads(get(f"{BUCKET}/{p}{name}.json"))
                except Exception:
                    continue
                pr = meta["properties"]
                out.append({
                    "name": name, "url": f"{BUCKET}/{p}", "cloud": pr.get("eo:cloud_cover", 100),
                    "nodata": pr.get("s2:nodata_pixel_percentage", 100), "bbox": meta["bbox"],
                })
    return out


def composite(square, picks, decim=2):
    """Median of the picked scenes at 10 m * decim, masked by SCL. Returns (rgb uint8 HxWx3, transform, crs)."""
    scenes_rgb, masks = [], []
    transform = crs = None
    for s in picks:
        with rasterio.open(f"/vsicurl/{s['url']}TCI.tif") as src:
            h, w = src.height // decim, src.width // decim
            rgb = src.read(out_shape=(3, h, w), resampling=Resampling.average)
            transform = src.transform * src.transform.scale(src.width / w, src.height / h)
            crs = src.crs
        with rasterio.open(f"/vsicurl/{s['url']}SCL.tif") as src:
            scl = src.read(1, out_shape=(h, w), resampling=Resampling.nearest)
        bad = np.isin(scl, list(BAD_SCL)) | (rgb.sum(axis=0) == 0)
        scenes_rgb.append(rgb)
        masks.append(bad)
        print(f"    {s['name']} cloud {s['cloud']:.1f}% masked {bad.mean() * 100:.0f}%", flush=True)
    out = np.zeros((h, w, 4), np.uint8)
    # per-pixel median over the clear observations, in strips to bound memory
    for y0 in range(0, h, 256):
        y1 = min(h, y0 + 256)
        st = np.stack([r[:, y0:y1].astype(np.float32) for r in scenes_rgb])
        for k, m in enumerate(masks):
            st[k][:, m[y0:y1]] = np.nan
        with np.errstate(all="ignore"):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                med = np.nanmedian(st, axis=0)
        valid = ~np.isnan(med[0])
        out[y0:y1, :, :3] = np.nan_to_num(np.moveaxis(med, 0, -1)).clip(0, 255).astype(np.uint8)
        out[y0:y1, :, 3] = valid * 255
    return out, transform, crs


def merc_bounds(z, x, y):
    n = 2 ** z
    size = 2 * HALF / n
    return (-HALF + x * size, HALF - (y + 1) * size, -HALF + (x + 1) * size, HALF - y * size)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--country", default="nl")
    ap.add_argument("--out", required=True)
    ap.add_argument("--cache", default=".geobake-cache/sentinel")
    ap.add_argument("--squares", nargs="*", default=["31UES", "31UET", "31UEU", "31UEV", "31UFS", "31UFT", "31UFU",
                                                     "31UFV", "31UGS", "31UGT", "31UGU", "31UGV", "32ULC", "32ULD", "32ULE"])
    ap.add_argument("--per-square", type=int, default=5)
    a = ap.parse_args()
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    os.environ.setdefault("GDAL_HTTP_MULTIRANGE", "YES")
    os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
    os.environ.setdefault("VSI_CACHE", "TRUE")
    W, S, E, N = COUNTRIES[a.country]["bbox"]
    os.makedirs(a.cache, exist_ok=True)

    # 1. per-square composites, cached as GeoTIFF
    comps = []
    for sq in a.squares:
        path = os.path.join(a.cache, f"{sq}.tif")
        if not os.path.exists(path):
            cands = scenes(sq, [2025, 2024], [5, 6, 7, 8, 9])
            cands = [c for c in cands if c["bbox"][0] < E and c["bbox"][2] > W and c["bbox"][1] < N and c["bbox"][3] > S]
            if not cands:
                print(sq, "outside the country", flush=True)
                continue
            cands = [c for c in cands if c["nodata"] < 40] or cands
            picks = sorted(cands, key=lambda c: c["cloud"])[: a.per_square]
            print(sq, f"{len(cands)} scenes, using", [p["name"] for p in picks], flush=True)
            rgba, transform, crs = composite(sq, picks)
            with rasterio.open(path + ".part", "w", driver="GTiff", width=rgba.shape[1], height=rgba.shape[0], count=4,
                               dtype="uint8", crs=crs, transform=transform, compress="deflate") as dst:
                dst.write(np.moveaxis(rgba, -1, 0))
            os.replace(path + ".part", path)
        comps.append(path)

    # 2. warp into Web Mercator tiles; squares overlap, so fill only still-empty pixels
    from rasterio.warp import transform_bounds
    meta, data = {}, {}
    for path in comps:
        with rasterio.open(path) as src:
            meta[path] = (src.transform, src.crs, transform_bounds(src.crs, "EPSG:3857", *src.bounds))
    written = {}
    for z, px in LEVELS.items():
        tiles = tile_range(z, (W, S, E, N))
        for (x, y) in tiles:
            b = merc_bounds(z, x, y)
            dst_t = from_bounds(*b, px, px)
            acc = np.zeros((4, px, px), np.uint8)
            for path in comps:
                st, crs, mb = meta[path]
                if mb[0] > b[2] or mb[2] < b[0] or mb[1] > b[3] or mb[3] < b[1]:
                    continue
                if path not in data:
                    with rasterio.open(path) as src:
                        data[path] = src.read()
                tmp = np.zeros((4, px, px), np.uint8)
                reproject(data[path], tmp, src_transform=st, src_crs=crs, dst_transform=dst_t,
                          dst_crs="EPSG:3857", resampling=Resampling.average)
                take = (acc[3] < 128) & (tmp[3] >= 128)
                acc[:, take] = tmp[:, take]
            if (acc[3] >= 128).mean() < 0.02:
                continue
            d = os.path.join(a.out, str(z), str(x))
            os.makedirs(d, exist_ok=True)
            Image.fromarray(np.moveaxis(acc[:3], 0, -1)).save(os.path.join(d, f"{y}.jpg"), quality=82, optimize=True)
            written.setdefault(str(z), []).append([x, y])
            # coverage mask is implied: black (0,0,0) means no data
        print(f"z{z}: done", flush=True)
    with open(os.path.join(a.out, "index.json"), "w") as f:
        json.dump({"levels": list(LEVELS), "size": LEVELS, "tiles": written,
                   "attribution": "Contains modified Copernicus Sentinel data (2024–2025)"}, f)


if __name__ == "__main__":
    main()
