"""Bake street-level demo tiles as Overpass-API-format JSON.

The game normally streams street-level data from the Overpass API at runtime.
This script produces identical-looking responses from Overture Maps (OSM-derived
GeoParquet) so a few areas work offline and in CI, and so the very same parser
(src/data/overpass.ts) is exercised on real data.

Usage:
  python tools/geobake/bake_detail.py --out public/data/nl/detail --center 5.1214,52.0907 --radius 1
"""
import argparse
import gzip
import json
import math
import os
import sys

import shapely

sys.path.insert(0, os.path.dirname(__file__))
from overture import read  # noqa: E402

Z = 15

RAIL = {"standard_gauge": "rail", "tram": "tram", "light_rail": "light_rail", "subway": "subway", "narrow_gauge": "narrow_gauge"}

# Overture place categories -> OSM tags (substring match, first wins)
POI = [
    (("supermarket", "grocery", "convenience", "bakery", "butcher"), ("shop", "supermarket")),
    (("pharmacy", "drugstore"), ("amenity", "pharmacy")),
    (("hospital",), ("amenity", "hospital")),
    (("clinic", "doctor", "dentist", "medical"), ("amenity", "clinic")),
    (("police",), ("amenity", "police")),
    (("fire_station", "fire_department"), ("amenity", "fire_station")),
    (("gas_station", "fuel"), ("amenity", "fuel")),
    (("hardware", "home_improvement", "diy"), ("shop", "hardware")),
    (("sporting", "outdoor"), ("shop", "sports")),
    (("auto_repair", "car_dealer", "automotive"), ("shop", "car_repair")),
    (("restaurant", "cafe", "coffee", "bar", "pub", "fast_food", "eat_and_drink"), ("amenity", "restaurant")),
    (("school", "college", "university"), ("amenity", "school")),
    (("clothing", "fashion"), ("shop", "clothes")),
    (("store", "shop", "retail", "shopping"), ("shop", "yes")),
]


def tile_bbox(x, y, z=Z):
    n = 2 ** z
    def lon(xx): return xx / n * 360 - 180
    def lat(yy): return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))
    return (lon(x), lat(y + 1), lon(x + 1), lat(y))


def lonlat_tile(lon, lat, z=Z):
    n = 2 ** z
    r = math.radians(lat)
    return int((lon + 180) / 360 * n), int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)


def geom_list(coords):
    return [{"lat": round(c[1], 7), "lon": round(c[0], 7)} for c in coords]


class Emitter:
    def __init__(self):
        self.next_id = 1

    def nid(self):
        self.next_id += 1
        return self.next_id

    def area(self, geom, tags):
        out = []
        for p in shapely.get_parts(geom):
            if p.geom_type != "Polygon":
                continue
            if len(p.interiors) == 0:
                out.append({"type": "way", "id": self.nid(), "tags": tags, "geometry": geom_list(p.exterior.coords)})
            else:
                members = [{"type": "way", "ref": self.nid(), "role": "outer", "geometry": geom_list(p.exterior.coords)}]
                members += [{"type": "way", "ref": self.nid(), "role": "inner", "geometry": geom_list(r.coords)} for r in p.interiors]
                out.append({"type": "relation", "id": self.nid(), "tags": {**tags, "type": "multipolygon"}, "members": members})
        return out

    def line(self, geom, tags):
        return [{"type": "way", "id": self.nid(), "tags": tags, "geometry": geom_list(l.coords)}
                for l in shapely.get_parts(geom) if l.geom_type == "LineString"]


def str_tags(d):
    return {str(k): str(v) for k, v in (d or [])} if isinstance(d, list) else {str(k): str(v) for k, v in (d or {}).items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--center", required=True, help="lon,lat")
    ap.add_argument("--radius", type=int, default=1, help="tiles around the centre tile")
    args = ap.parse_args()
    lon, lat = map(float, args.center.split(","))
    cx, cy = lonlat_tile(lon, lat)
    tiles = [(cx + i, cy + j) for i in range(-args.radius, args.radius + 1) for j in range(-args.radius, args.radius + 1)]
    x0, y0 = min(t[0] for t in tiles), min(t[1] for t in tiles)
    x1, y1 = max(t[0] for t in tiles), max(t[1] for t in tiles)
    W, _, _, N = tile_bbox(x0, y0)
    _, S, E, _ = tile_bbox(x1, y1)
    bbox = (W, S, E, N)
    print("bbox", bbox, len(tiles), "tiles", flush=True)

    feats = []  # (geom, element-producing callable)
    em = Emitter()

    print("buildings", flush=True)
    for r in read("buildings", "building", bbox, ["class", "subtype", "num_floors", "height", "is_underground"]):
        if r.get("is_underground"):
            continue
        tags = {"building": r["class"] or r["subtype"] or "yes"}
        if r["num_floors"]:
            tags["building:levels"] = str(r["num_floors"])
        elif r["height"]:
            tags["height"] = str(round(r["height"], 1))
        feats.append((r["geometry"], lambda g, t=tags: em.area(g, t)))

    print("transportation", flush=True)
    for r in read("transportation", "segment", bbox, ["subtype", "class", "road_flags"]):
        flags = set()
        for rf in r["road_flags"] or []:
            flags.update(rf["values"] or [])
        if r["subtype"] == "road":
            tags = {"highway": r["class"] if r["class"] not in (None, "unknown") else "road"}
        elif r["subtype"] == "rail" and r["class"] in RAIL:
            tags = {"railway": RAIL[r["class"]]}
        else:
            continue
        if "is_bridge" in flags:
            tags["bridge"] = "yes"
        if "is_tunnel" in flags:
            tags["tunnel"] = "yes"
        feats.append((r["geometry"], lambda g, t=tags: em.line(g, t)))

    print("land_use + water", flush=True)
    for theme, typ in (("base", "land_use"), ("base", "water")):
        for r in read(theme, typ, bbox, ["source_tags", "class", "subtype"]):
            tags = str_tags(r["source_tags"])
            if not tags:
                continue
            g = r["geometry"]
            if g.geom_type in ("Polygon", "MultiPolygon"):
                feats.append((g, lambda g, t=tags: em.area(g, t)))
            elif g.geom_type in ("LineString", "MultiLineString"):
                feats.append((g, lambda g, t=tags: em.line(g, t)))

    print("places", flush=True)
    for r in read("places", "place", bbox, ["names", "basic_category", "taxonomy", "confidence"]):
        if (r["confidence"] or 0) < 0.5:
            continue
        cat = (r["basic_category"] or "") + " " + ((r["taxonomy"] or {}).get("primary") or "")
        tag = next((t for keys, t in POI if any(k in cat for k in keys)), None)
        if not tag:
            continue
        p = r["geometry"]
        tags = {tag[0]: tag[1]}
        if r["names"] and r["names"].get("primary"):
            tags["name"] = r["names"]["primary"]
        feats.append((p, lambda g, t=tags: [{"type": "node", "id": em.nid(), "lat": round(g.y, 7), "lon": round(g.x, 7), "tags": t}]))

    print(len(feats), "features; writing tiles", flush=True)
    geoms = [f[0] for f in feats]
    tree = shapely.STRtree(geoms)
    elements_cache = {}
    os.makedirs(os.path.join(args.out, str(Z)), exist_ok=True)
    for (tx, ty) in tiles:
        idx = tree.query(shapely.box(*tile_bbox(tx, ty)), predicate="intersects")
        elements = []
        for i in sorted(idx):
            if i not in elements_cache:
                elements_cache[i] = feats[i][1](geoms[i])
            elements.extend(elements_cache[i])
        d = os.path.join(args.out, str(Z), str(tx))
        os.makedirs(d, exist_ok=True)
        with gzip.open(os.path.join(d, f"{ty}.json.gz"), "wt", compresslevel=9) as f:
            json.dump({"version": 0.6, "generator": "pocketpocalypse bake_detail (Overture)", "elements": elements}, f, separators=(",", ":"))
        print(f"  {tx},{ty}: {len(elements)} elements", flush=True)

    index_path = os.path.join(args.out, "index.json")
    existing = []
    if os.path.exists(index_path):
        with open(index_path) as f:
            existing = json.load(f).get("tiles", [])
    allt = sorted({tuple(t) for t in existing} | set(tiles))
    with open(index_path, "w") as f:
        json.dump({"zoom": Z, "tiles": [list(t) for t in allt],
                   "attribution": "© OpenStreetMap contributors (ODbL) via Overture Maps Foundation"}, f)


if __name__ == "__main__":
    main()
