"""Bake a static "country pack" for the overview LOD levels.

The pack covers the zoom range between space and street level: land/sea, large
water bodies, land cover, land use, major roads, rail and waterways, plus a
city list (with population) for the outbreak simulation. Street-level detail is
streamed at runtime from OpenStreetMap instead (see src/data/overpass.ts).

Output (under public/data/<country>/):
  manifest.json            country metadata, outline, cities, tile index
  pack/<z>/<x>/<y>.json    overview tiles at z5, z8 and z10

Usage:
  python tools/geobake/build_pack.py --country nl --out public/data/nl
"""
import argparse
import gzip
import json
import math
import os
import pickle
import sys
import time

import numpy as np
import pyarrow.compute as pc
import shapely
from shapely.strtree import STRtree

sys.path.insert(0, os.path.dirname(__file__))
from countries import COUNTRIES  # noqa: E402
from overture import read  # noqa: E402
from mercator import EXTENT, lonlat_to_norm, encode_tile, tile_range, tile_bounds_norm, m_per_norm  # noqa: E402

# Overview levels: tile zoom -> simplification (m), min polygon area (m2), road classes.
LEVELS = {
    5: dict(tol=250.0, min_area=8e6, roads={"motorway"}, rail=False, waterways=set(), cover="cover7"),
    8: dict(tol=60.0, min_area=3e5, roads={"motorway", "trunk", "primary"}, rail=True, waterways={"river"}, cover="cover8"),
    10: dict(tol=18.0, min_area=1e4, roads={"motorway", "trunk", "primary", "secondary"}, rail=True,
             waterways={"river", "canal"}, cover="cover8"),
}

COVER = {"forest": "forest", "shrub": "scrub", "grass": "grass", "moss": "grass", "crop": "farm", "wetland": "wetland",
         "barren": "sand", "urban": "urban", "snow": "sand", "mangrove": "wetland"}

LANDUSE = {
    "residential": "residential", "garages": "residential",
    "commercial": "commercial", "retail": "commercial", "education": "commercial", "school": "commercial",
    "university": "commercial", "college": "commercial", "hospital": "commercial", "religious": "commercial",
    "industrial": "industrial", "port": "industrial", "depot": "industrial", "construction": "industrial",
    "brownfield": "industrial", "landfill": "industrial", "quarry": "industrial", "greenhouse_horticulture": "farm",
    "farmland": "farm", "farmyard": "farm", "orchard": "farm", "vineyard": "farm", "plant_nursery": "farm",
    "allotments": "park", "meadow": "grass", "grass": "grass", "village_green": "grass", "recreation_ground": "park",
    "park": "park", "garden": "park", "golf_course": "grass", "pitch": "park", "playground": "park", "stadium": "park",
    "forest": "forest", "wood": "forest", "scrub": "scrub", "heath": "scrub", "wetland": "wetland", "marsh": "wetland",
    "beach": "sand", "sand": "sand", "dune": "sand", "cemetery": "cemetery", "grave_yard": "cemetery",
    "military": "military", "railway": "rail",
}

# Draw order for the renderer (lower first). Exported in manifest.
AREA_ORDER = ["land", "farm", "grass", "urban", "sand", "wetland", "scrub", "forest", "park", "cemetery",
              "residential", "commercial", "industrial", "military", "rail", "water"]
LINE_ORDER = ["stream", "canal", "river", "rail", "tertiary", "secondary", "primary", "trunk", "motorway"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def to_norm(geoms):
    return shapely.transform(np.asarray(geoms, dtype=object), lambda c: np.column_stack(lonlat_to_norm(c[:, 0], c[:, 1])))


class Layer:
    """A set of (class, geometry-in-normalized-mercator) features."""

    def __init__(self):
        self.cls = []
        self.geom = []

    def add(self, cls, geoms):
        for c, g in zip(cls, geoms):
            if g is not None and not g.is_empty:
                self.cls.append(c)
                self.geom.append(g)


def fetch_region(bbox, cover_zoom_lo=(7, 8)):
    """Read every overview layer for bbox once; returns dict of Layer per name.

    Set GEOBAKE_CACHE to a directory to keep the downloads between runs."""
    cache = os.environ.get("GEOBAKE_CACHE")
    if cache:
        key = os.path.join(cache, "region_" + "_".join(f"{v:.4f}" for v in bbox) + ".pkl")
        if os.path.exists(key):
            with open(key, "rb") as f:
                return pickle.load(f)
        out = _fetch_region(bbox, cover_zoom_lo)
        os.makedirs(cache, exist_ok=True)
        with open(key, "wb") as f:
            pickle.dump(out, f)
        return out
    return _fetch_region(bbox, cover_zoom_lo)


def _fetch_region(bbox, cover_zoom_lo):
    w, s, e, n = bbox
    out = {}

    log("  land (countries)")
    rows = read("divisions", "division_area", bbox, ["subtype", "country", "is_land"],
                (pc.field("subtype") == "country") & (pc.field("is_land") == True))  # noqa: E712
    out["land"] = Layer()
    out["land"].add(["land"] * len(rows), to_norm([r["geometry"] for r in rows]))

    log("  land_cover")
    rows = read("base", "land_cover", bbox, ["subtype", "cartography"])
    for zlo in sorted(set(cover_zoom_lo)):
        lay = Layer()
        sel = [r for r in rows if (r["cartography"] or {}).get("min_zoom", 0) <= zlo <= (r["cartography"] or {}).get("max_zoom", 99)]
        lay.add([COVER.get(r["subtype"], None) for r in sel], to_norm([r["geometry"] for r in sel]))
        out[f"cover{zlo}"] = lay

    log("  land_use")
    rows = read("base", "land_use", bbox, ["class", "subtype"])
    lay = Layer()
    sel = [r for r in rows if LANDUSE.get(r["class"]) and r["geometry"].geom_type in ("Polygon", "MultiPolygon")]
    lay.add([LANDUSE[r["class"]] for r in sel], to_norm([r["geometry"] for r in sel]))
    out["use"] = lay

    log("  water")
    rows = read("base", "water", bbox, ["subtype", "class"])
    polys = [r for r in rows if r["geometry"].geom_type in ("Polygon", "MultiPolygon") and r["subtype"] != "ocean"]
    lines = [r for r in rows if r["geometry"].geom_type in ("LineString", "MultiLineString")]
    lay = Layer()
    lay.add(["water"] * len(polys), to_norm([r["geometry"] for r in polys]))
    out["water"] = lay
    lay = Layer()
    lay.add([r["class"] if r["class"] in ("river", "canal", "stream") else None for r in lines], to_norm([r["geometry"] for r in lines]))
    out["waterway"] = lay

    log("  transportation")
    rows = read("transportation", "segment", bbox, ["subtype", "class"],
                pc.field("class").isin(["motorway", "trunk", "primary", "secondary", "tertiary", "standard_gauge"]))
    lay = Layer()
    lay.add([("rail" if r["subtype"] == "rail" else r["class"]) for r in rows], to_norm([r["geometry"] for r in rows]))
    out["roads"] = lay
    return out


def build_tiles(layers, z, tiles, cfg, lat_mid, mask=None):
    """Clip, simplify and encode the given layers into tiles at zoom z."""
    mpn = m_per_norm(lat_mid)
    tol = cfg["tol"] / mpn
    min_area = cfg["min_area"] / (mpn * mpn)
    feats = []  # (class, geom, is_area)

    def add_areas(layer, keep):
        for c, g in zip(layer.cls, layer.geom):
            if c is None or not keep(c):
                continue
            if g.geom_type not in ("Polygon", "MultiPolygon"):
                continue
            if c != "land" and g.area < min_area:
                continue
            feats.append((c, g, True))

    add_areas(layers["land"], lambda c: True)
    add_areas(layers[cfg["cover"]], lambda c: True)
    if z >= 8:
        # meadows and fields come from land cover; OSM parcels would bloat the pack
        add_areas(layers["use"], lambda c: c not in ("grass", "farm"))
    add_areas(layers["water"], lambda c: True)
    for c, g in zip(layers["roads"].cls, layers["roads"].geom):
        if c in cfg["roads"] or (c == "rail" and cfg["rail"]):
            feats.append((c, g, False))
    for c, g in zip(layers["waterway"].cls, layers["waterway"].geom):
        if c in cfg["waterways"]:
            feats.append((c, g, False))

    geoms = shapely.simplify(np.array([f[1] for f in feats], dtype=object), tol, preserve_topology=False)
    tree = STRtree(geoms)
    result = {}
    for (tx, ty) in tiles:
        bx0, by0, bx1, by1 = tile_bounds_norm(z, tx, ty, buffer=1 / 64)
        idx = tree.query(shapely.box(bx0, by0, bx1, by1))
        if len(idx) == 0:
            continue
        clipped = shapely.clip_by_rect(geoms[idx], bx0, by0, bx1, by1)
        tile_mask = None
        if mask is not None:
            tile_mask = shapely.clip_by_rect(mask, bx0, by0, bx1, by1)
            if tile_mask.is_empty:
                tile_mask = None
                idx = [i for i in idx if feats[i][0] == "land"]
                clipped = [shapely.clip_by_rect(geoms[i], bx0, by0, bx1, by1) for i in idx]
        groups = {}
        for i, g in zip(idx, clipped):
            if g is None or g.is_empty:
                continue
            groups.setdefault((feats[i][0], feats[i][2]), []).append(g)
        tile_feats = []
        # Dissolve each class: thousands of adjacent parcels become a few shapes.
        for (c, is_area) in sorted(groups):
            parts = groups[(c, is_area)]
            if is_area:
                parts = [p for p in parts if p.geom_type in ("Polygon", "MultiPolygon")]
                if not parts:
                    continue
                u = shapely.union_all(shapely.buffer(np.array(parts, dtype=object), tol * 0.75, quad_segs=1))
                u = shapely.simplify(shapely.buffer(u, -tol * 0.75, quad_segs=1), tol)
                if c != "land" and tile_mask is not None:
                    u = shapely.intersection(u, tile_mask)
                for p in shapely.get_parts(u):
                    if p.geom_type == "Polygon" and (c == "land" or p.area >= min_area):
                        tile_feats.append((c, p, True))
            else:
                u = shapely.line_merge(shapely.union_all(np.array(parts, dtype=object)))
                if tile_mask is not None:
                    u = shapely.intersection(u, tile_mask)
                tile_feats.extend((c, p, False) for p in shapely.get_parts(u))
        if not tile_feats:
            continue
        enc = encode_tile(z, tx, ty, tile_feats, AREA_ORDER, LINE_ORDER)
        if enc:
            result[(tx, ty)] = enc
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--country", default="nl")
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", help="limit to one z8 tile x,y (for testing)")
    args = ap.parse_args()
    cfg = COUNTRIES[args.country]
    W, S, E, N = cfg["bbox"]
    out = args.out
    os.makedirs(out, exist_ok=True)
    lat_mid = (S + N) / 2

    index = {5: [], 8: [], 10: []}
    low_layers = {k: Layer() for k in ["land", "cover7", "use", "water", "waterway", "roads"]}

    # Only keep detail inside the country (plus a margin); neighbours get plain land.
    mask = country_mask(cfg, lat_mid)
    z8_tiles = tile_range(8, cfg["bbox"])
    if args.only:
        x, y = map(int, args.only.split(","))
        z8_tiles = [(x, y)]
    z8_tiles = [t for t in z8_tiles if shapely.intersects(mask, shapely.box(*tile_bounds_norm(8, *t)))]
    for (x8, y8) in z8_tiles:
        b = tile_lonlat_bbox(8, x8, y8, buffer=0.02)
        log(f"z8 tile {x8},{y8} bbox={tuple(round(v, 3) for v in b)}")
        layers = fetch_region(b)
        for name in low_layers:
            src = layers.get(name)
            if src:
                low_layers[name].cls += src.cls
                low_layers[name].geom += src.geom
        for z in (8, 10):
            k = 2 ** (z - 8)
            tiles = [(x8 * k + i, y8 * k + j) for i in range(k) for j in range(k)]
            res = build_tiles(layers, z, tiles, LEVELS[z], lat_mid, mask)
            for (tx, ty), data in res.items():
                write_tile(out, z, tx, ty, data)
                index[z].append([tx, ty])
            log(f"  z{z}: {len(res)} tiles")

    # z5 overview: everything in one or two tiles, heavily simplified.
    log("z5")
    res = build_tiles(low_layers, 5, tile_range(5, cfg["bbox"]), LEVELS[5], lat_mid, mask)
    for (tx, ty), data in res.items():
        write_tile(out, 5, tx, ty, data)
        index[5].append([tx, ty])

    log("outline + cities")
    outline = country_outline(cfg)
    cities = country_cities(cfg)
    manifest = {
        "id": args.country,
        "name": cfg["name"],
        "bbox": cfg["bbox"],
        "extent": EXTENT,
        "levels": sorted(index.keys()),
        "tiles": {str(z): sorted(v) for z, v in index.items()},
        "areaOrder": AREA_ORDER,
        "lineOrder": LINE_ORDER,
        "outline": outline,
        "cities": cities,
        "attribution": "Map data © OpenStreetMap contributors (ODbL) via Overture Maps Foundation; land cover © ESA WorldCover",
    }
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, separators=(",", ":"))
    log("done")


def tile_lonlat_bbox(z, x, y, buffer=0.0):
    n = 2 ** z
    def lon(xx): return xx / n * 360 - 180
    def lat(yy): return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))
    b = buffer
    return (lon(x - b), lat(y + 1 + b), lon(x + 1 + b), lat(y - b))


def write_tile(out, z, x, y, data):
    d = os.path.join(out, "pack", str(z), str(x))
    os.makedirs(d, exist_ok=True)
    # gzip-compressed JSON; the client inflates it with DecompressionStream
    with gzip.open(os.path.join(d, f"{y}.json.gz"), "wt", compresslevel=9) as f:
        json.dump(data, f, separators=(",", ":"))


def country_mask(cfg, lat_mid, margin_m=2500):
    rows = read("divisions", "division_area", cfg["bbox"], ["subtype", "country", "is_land"],
                (pc.field("subtype") == "country") & (pc.field("country") == cfg["iso"]))
    g = shapely.union_all(to_norm([r["geometry"] for r in rows]))
    m = margin_m / m_per_norm(lat_mid)
    return shapely.simplify(shapely.buffer(shapely.simplify(g, m / 10), m, quad_segs=2), m / 10)


def country_outline(cfg):
    rows = read("divisions", "division_area", cfg["bbox"], ["subtype", "country", "is_land"],
                (pc.field("subtype") == "country") & (pc.field("country") == cfg["iso"]) & (pc.field("is_land") == True))  # noqa: E712
    g = shapely.union_all([r["geometry"] for r in rows])
    g = shapely.simplify(g, 0.004)
    polys = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
    W, S, E, N = cfg["bbox"]
    res = []
    for p in polys:
        if p.area < 1e-4:
            continue
        c = p.centroid
        if not (W <= c.x <= E and S <= c.y <= N):
            continue
        res.append([[round(x, 4), round(y, 4)] for x, y in p.exterior.coords])
    return res


def country_cities(cfg):
    rows = read("divisions", "division", cfg["bbox"], ["names", "subtype", "country", "population", "class"],
                (pc.field("country") == cfg["iso"]) & (pc.field("subtype") == "locality"))
    res = []
    for r in rows:
        pop = r["population"] or 0
        if pop < cfg.get("min_city_pop", 10000):
            continue
        g = r["geometry"]
        p = g if g.geom_type == "Point" else g.representative_point()
        res.append({"name": r["names"]["primary"], "lon": round(p.x, 5), "lat": round(p.y, 5), "pop": int(pop)})
    res.sort(key=lambda c: -c["pop"])
    return res


if __name__ == "__main__":
    main()
