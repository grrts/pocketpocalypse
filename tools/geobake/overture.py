"""Thin reader for Overture Maps GeoParquet releases on the public AWS bucket.

Overture's base, buildings and transportation themes are largely derived from
OpenStreetMap, and land/water rows keep their original OSM tags in
``source_tags``. Reads are filtered by bbox so only matching row groups are
downloaded.
"""
import os
from urllib.parse import urlparse

import pyarrow.compute as pc
import pyarrow.dataset as pads
import pyarrow.fs as pafs
import shapely

RELEASE = os.environ.get("OVERTURE_RELEASE", "2026-09-23.0")
BUCKET = "overturemaps-us-west-2"


def _fs():
    opts = {}
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if proxy:
        p = urlparse(proxy)
        opts["proxy_options"] = {"scheme": p.scheme or "http", "host": p.hostname, "port": p.port}
    return pafs.S3FileSystem(anonymous=True, region="us-west-2", **opts)


_FS = None


def read(theme, typ, bbox, columns, extra=None):
    """Return a list of dicts (with ``geometry`` decoded to shapely) intersecting bbox=(W,S,E,N)."""
    global _FS
    if _FS is None:
        _FS = _fs()
    w, s, e, n = bbox
    ds = pads.dataset(f"{BUCKET}/release/{RELEASE}/theme={theme}/type={typ}/", filesystem=_FS, format="parquet")
    f = (pc.field("bbox", "xmin") < e) & (pc.field("bbox", "xmax") > w) & (pc.field("bbox", "ymin") < n) & (pc.field("bbox", "ymax") > s)
    if extra is not None:
        f = f & extra
    cols = list(dict.fromkeys(columns + ["geometry"]))
    table = ds.to_table(filter=f, columns=cols)
    geoms = shapely.from_wkb(table.column("geometry").to_numpy(zero_copy_only=False))
    rows = table.drop(["geometry"]).to_pylist()
    for r, g in zip(rows, geoms):
        r["geometry"] = g
    return rows
