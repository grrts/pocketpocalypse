"""Bake street-level map data for a whole country into bundles.

One bundle per z10 tile holds every z15 data tile inside it: buildings (with
levels/height), roads, rail, waterways, water bodies, land use, natural cover
and points of interest, all from the local Overture extract made by
extract.py, plus the overview pack tile for the same z10 tile. Features keep
OpenStreetMap-style tags so the game classifies them with the same code it
uses for live Overpass data (src/data/osm.ts).

Each feature is stored once, in the z15 tile that holds the centre of its
bounding box; features bigger than half a tile are cut at tile edges instead.
The game merges neighbouring tiles when it draws near a tile edge.

Bundle bytes (integers little-endian):
  "PPG2" | u32 header length | header JSON | tile blobs...
  header = {"v":2, "z":15, "q":Q, "tags":[tagset strings], "names":[...],
            "tiles":[[x,y,offset,length],...], "pack": overview pack tile or null}
  tagset string = "k=v" pairs joined with "\x1f"
  tile blob = varint count, then per feature:
    u8 type (0 area, 1 line, 2 point) | varint tagset | varint name+1 (0 = none)
    area: varint rings, per ring varint n + n zigzag-varint (dx,dy) pairs
    line: varint n + n pairs;  point: one pair (n = 1)
  Coordinates are in units of Q texels (z18 Web Mercator pixels, ~0.37 m in
  NL) relative to the z15 tile origin. The first point of each ring or line is
  relative to the first point of the previous one in the tile; the rest are
  relative to the point before.
The bundle is stored as the pixels of an 8-bit greyscale PNG (4096 wide), which
compresses it and lets it be served anywhere images can.

Usage: python tools/geobake/bake_bundles.py --country nl --src .geobake-cache/nl --out public/data/nl/geo [--only 525,336]
"""
import argparse
import json
import math
import os
import struct
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pyarrow.compute as pc
import pyarrow.dataset as pads
import shapely
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from bake_detail import POI, RAIL  # noqa: E402
from countries import COUNTRIES  # noqa: E402
from mercator import tile_range  # noqa: E402

WORLD = 256 * 2 ** 18  # texels around the world
T15 = 2 ** (18 - 15) * 256  # texels per z15 tile (2048)
Q = 2  # coordinate grid in texels (~0.75 m)
BIG = T15 / 2  # features wider than this are cut at tile edges
KEEP_KEYS = {"building", "landuse", "natural", "leisure", "amenity", "water", "waterway", "aeroway", "man_made", "place"}
LINE_WATERWAYS = {"river", "canal", "stream", "ditch", "drain"}


def lonlat_bounds(z, x, y):
    n = 2 ** z
    def lon(xx): return xx / n * 360 - 180
    def lat(yy): return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))
    return lon(x), lat(y + 1), lon(x + 1), lat(y)


def to_texels(geoms):
    def f(c):
        lon, lat = c[:, 0], np.clip(c[:, 1], -85.05, 85.05)
        x = (lon + 180) / 360 * WORLD
        r = np.radians(lat)
        y = (1 - np.log(np.tan(r) + 1 / np.cos(r)) / math.pi) / 2 * WORLD
        return np.column_stack([x, y])
    return shapely.transform(geoms, f)


def varint(out, v):
    while v >= 0x80:
        out.append((v & 0x7F) | 0x80)
        v >>= 7
    out.append(v)


def zz(v):
    return (v << 1) ^ (v >> 63)


def put_coords(out, xy, ox, oy):
    q = np.rint(xy - (ox, oy)).astype(np.int64)
    if len(q) > 1:
        keep = np.ones(len(q), bool)
        keep[1:] = np.any(q[1:] != q[:-1], axis=1)
        q = q[keep]
    d = q.copy()
    d[1:] -= q[:-1]
    varint(out, len(d))
    for a, b in d.tolist():
        varint(out, zz(a))
        varint(out, zz(b))
    return len(d)


def str_tags(d):
    if d is None:
        return {}
    items = d if isinstance(d, list) else d.items()
    return {str(k): str(v) for k, v in items if v is not None}


class Bundle:
    def __init__(self):
        self.tags, self.tag_idx = [], {}
        self.names, self.name_idx = [], {}
        self.tiles = {}  # (x,y) -> list of encoded features (bytes)

    def tagset(self, tags):
        key = "\x1f".join(f"{k}={v}" for k, v in sorted(tags.items()))
        i = self.tag_idx.get(key)
        if i is None:
            i = self.tag_idx[key] = len(self.tags)
            self.tags.append(key)
        return i

    def name(self, n):
        if not n:
            return 0
        i = self.name_idx.get(n)
        if i is None:
            i = self.name_idx[n] = len(self.names)
            self.names.append(n)
        return i + 1

    def add(self, tile, typ, tags, name, geom):
        """Queue a feature; geometry is encoded when the tile is written (after sorting)."""
        if typ == 0:
            rings = []
            for p in shapely.get_parts(geom):
                if p.geom_type != "Polygon" or p.is_empty:
                    continue
                rings.append(np.asarray(p.exterior.coords)[:-1])
                rings.extend(np.asarray(r.coords)[:-1] for r in p.interiors)
            parts = [[r for r in rings if len(r) >= 3]]
        elif typ == 1:
            parts = [[np.asarray(l.coords)] for l in shapely.get_parts(geom) if l.geom_type == "LineString" and not l.is_empty]
        else:
            parts = [[np.asarray([[geom.x, geom.y]])]]
        ox, oy = tile[0] * T15, tile[1] * T15
        for rings in parts:
            q = []
            for r in rings:
                g = np.rint((r - (ox, oy)) / Q).astype(np.int64)
                if len(g) > 1:
                    keep = np.ones(len(g), bool)
                    keep[1:] = np.any(g[1:] != g[:-1], axis=1)
                    g = g[keep]
                if typ == 0 and len(g) > 1 and (g[0] == g[-1]).all():
                    g = g[:-1]
                if (typ == 0 and len(g) >= 3) or (typ == 1 and len(g) >= 2) or typ == 2:
                    q.append(g)
            if q:
                self.tiles.setdefault(tile, []).append((typ, self.tagset(tags), self.name(name), q))

    def write(self, path, pack=None):
        blobs, index, off = [], [], 0
        for (x, y) in sorted(self.tiles):
            feats = sorted(self.tiles[(x, y)], key=lambda f: (f[0], f[1], int(f[3][0][0][1]) >> 5, int(f[3][0][0][0])))
            raw = bytearray()
            varint(raw, len(feats))
            lx = ly = 0
            for typ, ts, nm, rings in feats:
                raw.append(typ)
                varint(raw, ts)
                varint(raw, nm)
                if typ == 0:
                    varint(raw, len(rings))
                for g in rings:
                    d = g.copy()
                    d[1:] -= g[:-1]
                    d[0] -= (lx, ly)
                    lx, ly = int(g[0][0]), int(g[0][1])
                    varint(raw, len(d))
                    for a, b in d.tolist():
                        varint(raw, zz(a))
                        varint(raw, zz(b))
            index.append([x, y, off, len(raw)])
            blobs.append(bytes(raw))
            off += len(raw)
        header = json.dumps({"v": 2, "z": 15, "q": Q, "tags": self.tags, "names": self.names, "tiles": index, "pack": pack},
                            separators=(",", ":"), ensure_ascii=False).encode()
        data = b"PPG2" + struct.pack("<I", len(header)) + header + b"".join(blobs)
        W = 4096
        H = (len(data) + W - 1) // W
        px = np.zeros(W * H, np.uint8)
        px[: len(data)] = np.frombuffer(data, np.uint8)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        Image.fromarray(px.reshape(H, W), "L").save(path + ".part.png", compress_level=9)
        os.replace(path + ".part.png", path)
        return os.path.getsize(path)


def read_layer(src, name, bounds, columns):
    w, s, e, n = bounds
    ds = pads.dataset(os.path.join(src, f"{name}.parquet"), format="parquet")
    f = (pc.field("bbox", "xmin") < e) & (pc.field("bbox", "xmax") > w) & (pc.field("bbox", "ymin") < n) & (pc.field("bbox", "ymax") > s)
    t = ds.to_table(filter=f, columns=columns + ["geometry"])
    geoms = shapely.from_wkb(t.column("geometry").to_numpy(zero_copy_only=False))
    return t.drop(["geometry"]).to_pylist(), geoms


def bake_tile(args):
    z10x, z10y, src, out, mask_wkb, pack_dir = args
    t0 = time.time()
    path = os.path.join(out, "10", str(z10x), f"{z10y}.png")
    bounds = lonlat_bounds(10, z10x, z10y)
    mask = shapely.from_wkb(mask_wkb)
    tile_box = shapely.box(*bounds)
    if not mask.intersects(tile_box):
        return (z10x, z10y, 0, 0, 0.0)
    clip_mask = shapely.intersection(mask, tile_box.buffer(0.01))
    shapely.prepare(clip_mask)
    b = Bundle()
    # z15 tiles of this z10 tile: 32x32
    tx0, ty0 = z10x * 32, z10y * 32
    count = 0

    def assign(rows, geoms, fn, simplify):
        nonlocal count
        if not len(geoms):
            return
        keep = shapely.intersects(clip_mask, geoms)
        geoms = to_texels(geoms[keep])
        rows = [r for r, k in zip(rows, keep) if k]
        if simplify:
            geoms = shapely.simplify(geoms, simplify, preserve_topology=True)
        bxy = shapely.bounds(geoms)
        for r, g, bb in zip(rows, geoms, bxy):
            if g is None or g.is_empty:
                continue
            res = fn(r, g)
            if not res:
                continue
            typ, tags, name = res
            big = typ != 2 and ((bb[2] - bb[0]) > BIG or (bb[3] - bb[1]) > BIG)
            if not big:
                tx, ty = int(((bb[0] + bb[2]) / 2) // T15), int(((bb[1] + bb[3]) / 2) // T15)
                if tx0 <= tx < tx0 + 32 and ty0 <= ty < ty0 + 32:
                    b.add((tx, ty), typ, tags, name, g)
                    count += 1
                continue
            for x in range(max(int(bb[0] // T15), tx0), min(int(bb[2] // T15), tx0 + 31) + 1):
                for y in range(max(int(bb[1] // T15), ty0), min(int(bb[3] // T15), ty0 + 31) + 1):
                    gg = shapely.clip_by_rect(g, x * T15, y * T15, (x + 1) * T15, (y + 1) * T15)
                    if gg.is_empty:
                        continue
                    if typ == 0:
                        gg = shapely.make_valid(gg) if not gg.is_valid else gg
                    b.add((x, y), typ, tags, name, gg)
                    count += 1

    # Land use / natural cover / water bodies / infrastructure areas
    def area_from_source(r, g):
        tags = {k: v for k, v in str_tags(r.get("source_tags")).items() if k in KEEP_KEYS or k in ("water", "wetland", "sport", "surface")}
        if not any(k in KEEP_KEYS for k in tags):
            return None
        if g.geom_type in ("Polygon", "MultiPolygon"):
            return (0, tags, None)
        if g.geom_type in ("LineString", "MultiLineString") and tags.get("waterway") in LINE_WATERWAYS:
            return (1, {k: v for k, v in tags.items() if k in ("waterway", "width")}, None)
        return None

    for layer in ("land", "land_use", "water", "infrastructure"):
        rows, geoms = read_layer(src, layer, bounds, ["source_tags"])
        assign(rows, geoms, area_from_source, 3.0)

    # Roads and rail
    def segment(r, g):
        flags = set()
        for rf in r["road_flags"] or []:
            flags.update(rf["values"] or [])
        cls, sub = r["class"], r["subclass"]
        if r["subtype"] == "road" and sub in ("sidewalk", "crossing"):
            return None
        if r["subtype"] == "road":
            hw = cls if cls not in (None, "unknown") else "road"
            if sub == "link" and hw in ("motorway", "trunk", "primary", "secondary", "tertiary"):
                hw += "_link"
            tags = {"highway": hw}
            for wr in r["width_rules"] or []:
                if wr["value"] and not wr["between"]:
                    tags["width"] = f"{wr['value']:.1f}"
        elif r["subtype"] == "rail" and cls in RAIL:
            tags = {"railway": RAIL[cls]}
        else:
            return None
        if "is_tunnel" in flags:
            tags["tunnel"] = "yes"
        elif "is_bridge" in flags:
            tags["bridge"] = "yes"
        name = (r["names"] or {}).get("primary") if r["subtype"] == "road" else None
        return (1, tags, name)

    rows, geoms = read_layer(src, "segments", bounds, ["subtype", "class", "subclass", "road_flags", "width_rules", "names"])
    assign(rows, geoms, segment, 1.0)

    # Buildings
    def building(r, g):
        if r["is_underground"]:
            return None
        tags = {"building": r["class"] or r["subtype"] or "yes"}
        if r["num_floors"]:
            tags["building:levels"] = str(min(int(r["num_floors"]), 60))
        elif r["height"]:
            tags["height"] = str(int(round(r["height"])))
        return (0, tags, None)

    rows, geoms = read_layer(src, "buildings", bounds, ["class", "subtype", "num_floors", "height", "is_underground"])
    assign(rows, geoms, building, 0.8)

    # Points of interest (refine what a building is: shop, pharmacy, police...)
    def place(r, g):
        if (r["confidence"] or 0) < 0.5:
            return None
        cat = (r["basic_category"] or "") + " " + ((r["taxonomy"] or {}).get("primary") or "")
        tag = next((t for keys, t in POI if any(k in cat for k in keys)), None)
        if not tag or g.geom_type != "Point":
            return None
        return (2, {tag[0]: tag[1]}, (r["names"] or {}).get("primary"))

    rows, geoms = read_layer(src, "places", bounds, ["names", "basic_category", "taxonomy", "confidence"])
    assign(rows, geoms, place, 0)

    if not b.tiles:
        return (z10x, z10y, 0, 0, time.time() - t0)
    pack = None
    pp = os.path.join(pack_dir, "10", str(z10x), f"{z10y}.json.gz") if pack_dir else None
    if pp and os.path.exists(pp):
        import gzip
        pack = json.load(gzip.open(pp))
    size = b.write(path, pack)
    return (z10x, z10y, len(b.tiles), size, time.time() - t0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--country", default="nl")
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--manifest", default=None, help="pack manifest with the country outline (default: <out>/../manifest.json)")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    a = ap.parse_args()
    cfg = COUNTRIES[a.country]
    man = json.load(open(a.manifest or os.path.join(os.path.dirname(a.out.rstrip("/")), "manifest.json")))
    outline = shapely.union_all([shapely.make_valid(shapely.Polygon(r)) for r in man["outline"]])
    mask = shapely.buffer(outline, 0.03)  # ~2-3 km around the border and coast
    tiles = tile_range(10, cfg["bbox"])
    if a.only:
        tiles = [tuple(map(int, t.split(","))) for t in a.only]
    pack_dir = os.path.join(os.path.dirname(a.manifest or os.path.join(os.path.dirname(a.out.rstrip("/")), "manifest.json")), "pack")
    jobs = [(x, y, a.src, a.out, shapely.to_wkb(mask), pack_dir) for (x, y) in tiles]
    done = []
    total = 0
    with ProcessPoolExecutor(a.workers) as ex:
        for x, y, n, size, dt in ex.map(bake_tile, jobs):
            if n:
                done.append([x, y])
                total += size
                print(f"10/{x}/{y}: {n} tiles, {size / 1e6:.2f} MB, {dt:.0f}s (total {total / 1e6:.0f} MB)", flush=True)
    index_path = os.path.join(a.out, "index.json")
    prev = []
    if a.only and os.path.exists(index_path):
        prev = json.load(open(index_path))["bundles"]
    allb = sorted({tuple(t) for t in prev} | {tuple(t) for t in done})
    with open(index_path, "w") as f:
        json.dump({"v": 2, "bundleZoom": 10, "dataZoom": 15, "ext": ".png", "bundles": [list(t) for t in allb],
                   "attribution": "© OpenStreetMap contributors (ODbL), Overture Maps Foundation"}, f)


if __name__ == "__main__":
    main()
