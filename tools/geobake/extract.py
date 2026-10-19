"""Download one country's slice of the Overture themes the game uses into local
GeoParquet files (WKB geometry kept as-is), so full-country bakes can run
repeatedly without re-reading the S3 release.

Usage: python tools/geobake/extract.py --country nl --out .geobake-cache/nl [--only buildings]
"""
import argparse
import os
import sys
import time

import pyarrow.compute as pc
import pyarrow.dataset as pads
import pyarrow.parquet as pq

sys.path.insert(0, os.path.dirname(__file__))
from countries import COUNTRIES  # noqa: E402
from overture import BUCKET, RELEASE, _fs  # noqa: E402

LAYERS = {
    "buildings": ("buildings", "building", ["id", "class", "subtype", "num_floors", "height", "is_underground", "bbox"]),
    "parts": ("buildings", "building_part", ["id", "building_id", "num_floors", "height", "min_height", "is_underground", "bbox"]),
    "segments": ("transportation", "segment", ["id", "subtype", "class", "subclass", "road_flags", "road_surface", "width_rules", "names", "bbox"]),
    "land_use": ("base", "land_use", ["id", "subtype", "class", "source_tags", "bbox"]),
    "water": ("base", "water", ["id", "subtype", "class", "source_tags", "bbox"]),
    "infrastructure": ("base", "infrastructure", ["id", "subtype", "class", "source_tags", "bbox"]),
    "land": ("base", "land", ["id", "subtype", "class", "source_tags", "bbox"]),
    "places": ("places", "place", ["id", "names", "basic_category", "taxonomy", "confidence", "bbox"]),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--country", default="nl")
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args()
    w, s, e, n = COUNTRIES[a.country]["bbox"]
    os.makedirs(a.out, exist_ok=True)
    fs = _fs()
    for name, (theme, typ, cols) in LAYERS.items():
        if a.only and name not in a.only:
            continue
        path = os.path.join(a.out, f"{name}.parquet")
        if os.path.exists(path):
            print(name, "exists", flush=True)
            continue
        t0 = time.time()
        ds = pads.dataset(f"{BUCKET}/release/{RELEASE}/theme={theme}/type={typ}/", filesystem=fs, format="parquet")
        have = set(ds.schema.names)
        f = (pc.field("bbox", "xmin") < e) & (pc.field("bbox", "xmax") > w) & (pc.field("bbox", "ymin") < n) & (pc.field("bbox", "ymax") > s)
        use = [c for c in cols if c in have] + ["geometry"]
        writer = None
        rows = 0
        for batch in ds.to_batches(filter=f, columns=use, batch_size=65536, fragment_readahead=8):
            if batch.num_rows == 0:
                continue
            if writer is None:
                writer = pq.ParquetWriter(path + ".part", batch.schema, compression="zstd")
            writer.write_batch(batch)
            rows += batch.num_rows
        if writer:
            writer.close()
            os.replace(path + ".part", path)
        print(f"{name}: {rows} rows, {time.time() - t0:.0f}s, missing cols {set(cols) - have}", flush=True)


if __name__ == "__main__":
    main()
