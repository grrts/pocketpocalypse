// A tiny scanline rasterizer that writes material ids (no anti-aliasing). Every
// map texture in the game — street chunks and overview tiles — is drawn through
// this, which gives crisp pixel-art edges, a collision grid for free, and runs
// in workers and in Node tests without a canvas.

export interface Transform {
  /** world texel -> raster pixel: px = (x - ox) * scale */
  ox: number;
  oy: number;
  scale: number;
}

// Reused edge buffers (rasterization is single-threaded per worker)
const scratch = {
  cap: 0,
  ex0: new Float64Array(0), ey0: new Float64Array(0), ex1: new Float64Array(0), ey1: new Float64Array(0),
  top: new Float64Array(0), order: new Uint32Array(0),
};
function growScratch(n: number) {
  const cap = Math.max(n, scratch.cap * 2, 1024);
  scratch.cap = cap;
  scratch.ex0 = new Float64Array(cap); scratch.ey0 = new Float64Array(cap);
  scratch.ex1 = new Float64Array(cap); scratch.ey1 = new Float64Array(cap);
  scratch.top = new Float64Array(cap); scratch.order = new Uint32Array(cap);
}

export class IdRaster {
  readonly ids: Uint8Array;
  /** Optional per-pixel payload (building height) */
  readonly aux: Uint8Array;

  constructor(readonly w: number, readonly h: number, fill = 0) {
    this.ids = new Uint8Array(w * h);
    this.aux = new Uint8Array(w * h);
    if (fill) this.ids.fill(fill);
  }

  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 255;
    return this.ids[y * this.w + x];
  }

  set(x: number, y: number, id: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.ids[y * this.w + x] = id;
  }

  /** Even-odd fill of one or more rings given as flat [x0,y0,x1,y1,...] arrays. */
  fillPolygon(rings: ArrayLike<number>[], id: number, t: Transform, aux = -1, mask?: (cur: number) => boolean): void {
    // Cheap reject before allocating anything: most features of a data tile miss this raster
    {
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const r of rings) {
        for (let i = 0; i < r.length; i += 2) {
          const x = r[i], y = r[i + 1];
          if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
          if (y < by0) by0 = y; if (y > by1) by1 = y;
        }
      }
      if (bx0 === Infinity) return;
      if ((bx1 - t.ox) * t.scale < 0 || (bx0 - t.ox) * t.scale > this.w || (by1 - t.oy) * t.scale < 0 || (by0 - t.oy) * t.scale > this.h) return;
    }
    // Build edge list in pixel space
    let ymin = Infinity, ymax = -Infinity;
    let n = 0;
    for (const r of rings) n += r.length / 2;
    if (n > scratch.cap) growScratch(n);
    const { ex0, ey0, ex1, ey1, top, order } = scratch;
    let e = 0;
    let xmin = Infinity, xmax = -Infinity;
    for (const r of rings) {
      const m = r.length / 2;
      if (m < 3) continue;
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        const ax = (r[i * 2] - t.ox) * t.scale, ay = (r[i * 2 + 1] - t.oy) * t.scale;
        const bx = (r[j * 2] - t.ox) * t.scale, by = (r[j * 2 + 1] - t.oy) * t.scale;
        if (ay === by) continue;
        // edges entirely above or below the raster never matter
        if ((ay < 0 && by < 0) || (ay > this.h && by > this.h)) continue;
        ex0[e] = ax; ey0[e] = ay; ex1[e] = bx; ey1[e] = by; e++;
        if (ay < ymin) ymin = ay; if (by < ymin) ymin = by;
        if (ay > ymax) ymax = ay; if (by > ymax) ymax = by;
        if (ax < xmin) xmin = ax; if (bx < xmin) xmin = bx;
        if (ax > xmax) xmax = ax; if (bx > xmax) xmax = bx;
      }
    }
    if (e === 0 || xmax < 0 || xmin > this.w || ymax < 0 || ymin > this.h) return;
    const y0 = Math.max(0, Math.floor(ymin)), y1 = Math.min(this.h - 1, Math.ceil(ymax));
    // Sort edges by their top y so we can sweep with an active list
    for (let i = 0; i < e; i++) {
      top[i] = Math.min(ey0[i], ey1[i]);
      order[i] = i;
    }
    order.subarray(0, e).sort((a, b) => top[a] - top[b]);
    const active: number[] = [];
    const xs: number[] = [];
    let k = 0;
    const W = this.w, ids = this.ids, auxb = this.aux;
    for (let y = y0; y <= y1; y++) {
      const sy = y + 0.5;
      while (k < e && top[order[k]] <= sy) active.push(order[k++]);
      xs.length = 0;
      for (let a = active.length - 1; a >= 0; a--) {
        const i = active[a];
        const ya = ey0[i], yb = ey1[i];
        if (Math.max(ya, yb) <= sy) {
          active.splice(a, 1);
          continue;
        }
        if ((ya <= sy && yb > sy) || (yb <= sy && ya > sy)) {
          xs.push(ex0[i] + ((sy - ya) / (yb - ya)) * (ex1[i] - ex0[i]));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      const row = y * W;
      for (let p = 0; p + 1 < xs.length; p += 2) {
        const xa = Math.max(0, Math.ceil(xs[p] - 0.5));
        const xb = Math.min(W - 1, Math.floor(xs[p + 1] - 0.5));
        for (let x = xa; x <= xb; x++) {
          if (mask && !mask(ids[row + x])) continue;
          ids[row + x] = id;
          if (aux >= 0) auxb[row + x] = aux;
        }
      }
    }
  }

  fillDisk(cx: number, cy: number, r: number, id: number, mask?: (cur: number) => boolean): void {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(this.w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(this.h - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dy * dy <= r2) {
          const i = y * this.w + x;
          if (mask && !mask(this.ids[i])) continue;
          this.ids[i] = id;
        }
      }
    }
  }

  /** Thick polyline with round joins. width is in raster pixels. */
  fillPolyline(pts: ArrayLike<number>, width: number, id: number, t: Transform, mask?: (cur: number) => boolean): void {
    const hw = width / 2;
    const n = pts.length / 2;
    if (n < 2) return;
    if (hw < 0.71) {
      for (let i = 0; i + 1 < n; i++) {
        this.line((pts[i * 2] - t.ox) * t.scale, (pts[i * 2 + 1] - t.oy) * t.scale,
          (pts[i * 2 + 2] - t.ox) * t.scale, (pts[i * 2 + 3] - t.oy) * t.scale, id, mask);
      }
      return;
    }
    const ident: Transform = { ox: 0, oy: 0, scale: 1 };
    for (let i = 0; i + 1 < n; i++) {
      const ax = (pts[i * 2] - t.ox) * t.scale, ay = (pts[i * 2 + 1] - t.oy) * t.scale;
      const bx = (pts[i * 2 + 2] - t.ox) * t.scale, by = (pts[i * 2 + 3] - t.oy) * t.scale;
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      // cull segments far outside the raster
      if (Math.max(ax, bx) < -hw || Math.min(ax, bx) > this.w + hw || Math.max(ay, by) < -hw || Math.min(ay, by) > this.h + hw) continue;
      const nx = (-dy / len) * hw, ny = (dx / len) * hw;
      this.fillPolygon([[ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny]], id, ident, -1, mask);
      if (hw >= 1.5) this.fillDisk(bx, by, hw, id, mask);
    }
    if (hw >= 1.5) this.fillDisk((pts[0] - t.ox) * t.scale, (pts[1] - t.oy) * t.scale, hw, id, mask);
  }

  /** 1px line (Bresenham-ish DDA). */
  line(ax: number, ay: number, bx: number, by: number, id: number, mask?: (cur: number) => boolean): void {
    const steps = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)));
    if (steps > 8192) return;
    for (let s = 0; s <= steps; s++) {
      const f = steps ? s / steps : 0;
      const x = Math.floor(ax + (bx - ax) * f), y = Math.floor(ay + (by - ay) * f);
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
      const i = y * this.w + x;
      if (mask && !mask(this.ids[i])) continue;
      this.ids[i] = id;
    }
  }

  strokeRings(rings: ArrayLike<number>[], id: number, t: Transform, mask?: (cur: number) => boolean): void {
    for (const r of rings) {
      const m = r.length / 2;
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        this.line((r[i * 2] - t.ox) * t.scale, (r[i * 2 + 1] - t.oy) * t.scale, (r[j * 2] - t.ox) * t.scale, (r[j * 2 + 1] - t.oy) * t.scale, id, mask);
      }
    }
  }
}
