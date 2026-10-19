"""Web Mercator helpers shared by the bake scripts (mirrors src/core/geo.ts)."""
import math

import numpy as np
import shapely

EXTENT = 4096
EARTH_CIRCUMFERENCE = 40075016.686


def lonlat_to_norm(lon, lat):
    lon = np.asarray(lon, dtype=float)
    lat = np.clip(np.asarray(lat, dtype=float), -85.05112878, 85.05112878)
    x = (lon + 180.0) / 360.0
    r = np.radians(lat)
    y = (1.0 - np.log(np.tan(r) + 1.0 / np.cos(r)) / math.pi) / 2.0
    return x, y


def m_per_norm(lat):
    """Ground metres per normalized mercator unit at latitude."""
    return EARTH_CIRCUMFERENCE * math.cos(math.radians(lat))


def tile_bounds_norm(z, x, y, buffer=0.0):
    n = 2 ** z
    return ((x - buffer) / n, (y - buffer) / n, (x + 1 + buffer) / n, (y + 1 + buffer) / n)


def tile_range(z, bbox):
    w, s, e, n = bbox
    x0, y0 = lonlat_to_norm(w, n)
    x1, y1 = lonlat_to_norm(e, s)
    k = 2 ** z
    return [(x, y) for x in range(int(x0 * k), int(x1 * k) + 1) for y in range(int(y0 * k), int(y1 * k) + 1)]


def _flat(coords, z, x, y):
    k = 2 ** z
    a = np.asarray(coords)[:, :2]
    q = np.round((a * k - np.array([x, y])) * EXTENT).astype(np.int64)
    # drop consecutive duplicates introduced by quantization
    if len(q) > 1:
        keep = np.ones(len(q), dtype=bool)
        keep[1:] = np.any(q[1:] != q[:-1], axis=1)
        q = q[keep]
    # delta-encode: first point absolute, the rest relative to the previous one
    d = q.copy()
    d[1:] = q[1:] - q[:-1]
    return d.reshape(-1).tolist()


def encode_tile(z, x, y, feats, area_order, line_order):
    """feats: list of (class, shapely geom in normalized mercator, is_area)."""
    classes = []
    cidx = {}
    areas = []
    lines = []

    def ci(c):
        if c not in cidx:
            cidx[c] = len(classes)
            classes.append(c)
        return cidx[c]

    for c, g, is_area in feats:
        if is_area:
            polys = [p for p in shapely.get_parts(g) if p.geom_type == "Polygon"]
            for p in polys:
                rings = [_flat(p.exterior.coords, z, x, y)] + [_flat(r.coords, z, x, y) for r in p.interiors]
                rings = [r for r in rings if len(r) >= 6]
                if rings:
                    areas.append((area_order.index(c) if c in area_order else 99, ci(c), rings))
        else:
            for part in shapely.get_parts(g):
                if part.geom_type != "LineString":
                    continue
                pts = _flat(part.coords, z, x, y)
                if len(pts) >= 4:
                    lines.append((line_order.index(c) if c in line_order else 99, ci(c), pts))
    if not areas and not lines:
        return None
    areas.sort(key=lambda a: a[0])
    lines.sort(key=lambda a: a[0])
    return {"z": z, "x": x, "y": y, "enc": "delta", "k": classes,
            "a": [[a[1]] + a[2] for a in areas],
            "l": [[l[1], l[2]] for l in lines]}
