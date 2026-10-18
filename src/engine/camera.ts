import { TEXEL_ZOOM, type Vec2 } from '../core/geo';

/**
 * Camera over the world texel plane. `zoom` uses slippy-map units: at zoom z a
 * texel is 2^(z-18) CSS pixels wide, so ~3 is the whole planet and ~20.5 is the
 * on-foot view.
 */
export class Camera {
  center: Vec2 = { x: 0, y: 0 };
  zoom = 6;
  /** device pixels */
  width = 1;
  height = 1;
  dpr = 1;

  get ppt(): number {
    return 2 ** (this.zoom - TEXEL_ZOOM) * this.dpr;
  }

  worldToScreen(x: number, y: number): Vec2 {
    const s = this.ppt;
    return { x: (x - this.center.x) * s + this.width / 2, y: (y - this.center.y) * s + this.height / 2 };
  }

  screenToWorld(x: number, y: number): Vec2 {
    const s = this.ppt;
    return { x: (x - this.width / 2) / s + this.center.x, y: (y - this.height / 2) / s + this.center.y };
  }

  /** Visible world rectangle */
  bounds(margin = 0): { x0: number; y0: number; x1: number; y1: number } {
    const s = this.ppt;
    const hw = this.width / 2 / s + margin, hh = this.height / 2 / s + margin;
    return { x0: this.center.x - hw, y0: this.center.y - hh, x1: this.center.x + hw, y1: this.center.y + hh };
  }

  /** World units spanned by the larger screen dimension. */
  span(zoom = this.zoom): number {
    return Math.max(this.width, this.height) / (2 ** (zoom - TEXEL_ZOOM) * this.dpr);
  }

  zoomForSpan(w: number): number {
    return TEXEL_ZOOM + Math.log2(Math.max(this.width, this.height) / (w * this.dpr));
  }
}

/**
 * Smooth zoom-and-pan path (van Wijk & Nuij, "Smooth and efficient zooming and
 * panning"), the same curve d3 and Mapbox use for fly-to animations. It zooms
 * out while panning so the motion feels like a single continuous flight.
 */
export class FlyTo {
  readonly duration: number;
  private fn: (t: number) => [number, number, number];

  constructor(cam: Camera, from: { center: Vec2; zoom: number }, to: { center: Vec2; zoom: number }, speed = 1) {
    const rho = Math.SQRT2, rho2 = 2, rho4 = 4;
    const ux0 = from.center.x, uy0 = from.center.y, w0 = cam.span(from.zoom);
    const ux1 = to.center.x, uy1 = to.center.y, w1 = cam.span(to.zoom);
    const dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy;
    let S: number;
    if (d2 < 1e-6) {
      S = Math.log(w1 / w0) / rho;
      this.fn = (t) => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(rho * t * S)];
    } else {
      const d1 = Math.sqrt(d2);
      const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
      const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
      const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
      const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
      S = (r1 - r0) / rho;
      const coshr0 = Math.cosh(r0), sinhr0 = Math.sinh(r0);
      this.fn = (t) => {
        const s = t * S;
        const u = (w0 / (rho2 * d1)) * (coshr0 * Math.tanh(rho * s + r0) - sinhr0);
        return [ux0 + u * dx, uy0 + u * dy, (w0 * coshr0) / Math.cosh(rho * s + r0)];
      };
    }
    this.duration = Math.max(0.6, (Math.abs(S) * 0.85) / speed);
    this.toZoom = (w) => cam.zoomForSpan(w);
  }

  private toZoom: (w: number) => number;

  at(t: number): { center: Vec2; zoom: number } {
    const [x, y, w] = this.fn(Math.max(0, Math.min(1, t)));
    return { center: { x, y }, zoom: this.toZoom(w) };
  }
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
