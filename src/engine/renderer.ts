import { CHUNK_TEXELS, lonLatToWorld, metersPerTexel, type Vec2 } from '../core/geo';
import type { PackManifest } from '../data/types';
import type { GameWorld } from '../game/world';
import { SpriteBank, type Sprite } from '../render/sprites';
import type { OutbreakHistory } from '../sim/outbreak';
import { shadeRaster } from '../render/materials';
import { IdRaster } from '../render/raster';
import type { BuildingInfo } from '../world/spawnTypes';
import { vehicleSize } from '../world/chunkgen';
import { FloraBank } from '../render/flora';
import { ART, VEG_STRIDE, VK, isTree } from '../world/vegetation';
import type { Camera } from './camera';
import type { ChunkManager } from './chunks';
import type { OverviewLayer } from './overviewLayer';

export interface RenderOptions {
  debug: boolean;
  showCities: boolean;
  marker: Vec2 | null;
  hover: Vec2 | null;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites = new SpriteBank();
  private stars: { x: number; y: number; b: number }[] = [];
  private cityPts: { x: number; y: number; name: string; pop: number; collapse: number; fate: string }[] = [];
  private outline: Vec2[][] = [];
  frameMs = 0;
  private indoor: BuildingInfo | null = null;
  private indoorFade = 0;
  private lastIndoorT = 0;
  private interiorCache = new Map<string, HTMLCanvasElement>();
  readonly flora = new FloraBank();
  /** vegetation records in view this frame: (chunk array, record offset), sorted by base y */
  private floraVis: { a: Int32Array; i: number }[] = [];
  private canopyLayer: HTMLCanvasElement | null = null;
  /** 0..1 how far the canopy has opened around the player */
  private canopyHole = 0;
  private lastFloraT = 0;
  floraCount = 0;

  constructor(readonly canvas: HTMLCanvasElement, readonly cam: Camera, private overview: OverviewLayer, private chunks: ChunkManager) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    for (let i = 0; i < 260; i++) this.stars.push({ x: Math.random(), y: Math.random(), b: Math.random() });
  }

  setCountry(manifest: PackManifest, history: OutbreakHistory | null) {
    this.outline = manifest.outline.map((r) => r.map(([lon, lat]) => lonLatToWorld(lon, lat)));
    const byName = new Map(history?.cities.map((c) => [c.name, c]) ?? []);
    this.cityPts = manifest.cities.slice(0, 60).map((c) => {
      const w = lonLatToWorld(c.lon, c.lat);
      const h = byName.get(c.name);
      return { ...w, name: c.name, pop: c.pop, collapse: h ? h.collapseDay : 0, fate: h?.fate ?? '' };
    });
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(this.canvas.clientWidth * dpr), h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.cam.width = w;
    this.cam.height = h;
    this.cam.dpr = dpr;
  }

  render(world: GameWorld | null, opts: RenderOptions, now: number) {
    const t0 = performance.now();
    const { ctx, cam } = this;
    ctx.imageSmoothingEnabled = false;
    // space
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, cam.width, cam.height);
    const spaceFade = 1 - smoothstep(4.5, 6.5, cam.zoom);
    if (spaceFade > 0) {
      ctx.fillStyle = '#fff';
      for (const s of this.stars) {
        ctx.globalAlpha = spaceFade * (0.3 + s.b * 0.7);
        ctx.fillRect(Math.floor(s.x * cam.width), Math.floor(s.y * cam.height), cam.dpr, cam.dpr);
      }
      ctx.globalAlpha = 1;
    }

    this.overview.draw(ctx, cam, now);

    // street-level chunks fade in as we descend
    const detailAlpha = smoothstep(this.chunks.minZoom, this.chunks.minZoom + 0.8, cam.zoom);
    if (detailAlpha > 0) {
      const b = cam.bounds();
      for (const c of this.chunks.chunks.values()) {
        if (c.state !== 'ready' || !c.bitmap) continue;
        const x0 = c.cx * CHUNK_TEXELS, y0 = c.cy * CHUNK_TEXELS;
        if (x0 > b.x1 || y0 > b.y1 || x0 + CHUNK_TEXELS < b.x0 || y0 + CHUNK_TEXELS < b.y0) continue;
        const a = cam.worldToScreen(x0, y0), e = cam.worldToScreen(x0 + CHUNK_TEXELS, y0 + CHUNK_TEXELS);
        const ax = Math.round(a.x), ay = Math.round(a.y);
        ctx.globalAlpha = detailAlpha * Math.min(1, (now - c.readyAt) / 350);
        ctx.imageSmoothingEnabled = cam.ppt < 0.75;
        ctx.drawImage(c.bitmap, ax, ay, Math.round(e.x) - ax, Math.round(e.y) - ay);
        ctx.imageSmoothingEnabled = false;
      }
      ctx.globalAlpha = 1;
    }

    if (world && cam.zoom >= 17) {
      // trees and bushes only at street level; overview tiles show forest from afar
      const floraK = smoothstep(17.2, 17.8, cam.zoom) * detailAlpha;
      if (floraK > 0) {
        this.collectFlora();
        this.drawFloraBase(floraK);
      }
      this.drawIndoor(world, detailAlpha);
      this.drawEntities(world, smoothstep(17, 18, cam.zoom), now);
      if (floraK > 0) {
        this.drawFloraFront(world, floraK);
        this.drawCanopies(world, floraK * (1 - 0.6 * this.indoorFade));
      }
    }

    // atmosphere: grey overcast tint and vignette
    const ground = smoothstep(14, 18, cam.zoom);
    if (ground > 0) {
      ctx.fillStyle = `rgba(28,34,30,${0.12 * ground})`;
      ctx.fillRect(0, 0, cam.width, cam.height);
    }
    const g = ctx.createRadialGradient(cam.width / 2, cam.height / 2, Math.min(cam.width, cam.height) * 0.35, cam.width / 2, cam.height / 2, Math.max(cam.width, cam.height) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${0.55 * ground + 0.35 * spaceFade})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cam.width, cam.height);

    if (world?.player.hurt) {
      ctx.fillStyle = `rgba(140,10,10,${world.player.hurt})`;
      ctx.fillRect(0, 0, cam.width, cam.height);
    }

    if (opts.showCities || cam.zoom < 15) this.drawMapOverlay(world, opts, 1 - smoothstep(14, 16, cam.zoom));
    if (opts.debug) this.drawDebug(world);
    this.frameMs = performance.now() - t0;
  }

  /** Gather vegetation whose art may reach the screen, sorted by base y. */
  private collectFlora() {
    const { cam } = this;
    const tpm = 1 / metersPerTexel(cam.center.y);
    const b = cam.bounds();
    // a tree's art reaches ~16 m north of its base and ~7 m to the sides
    const yMin = (b.y0 - 2 * tpm) * ART, yMax = (b.y1 + 16 * tpm) * ART;
    const xMin = (b.x0 - 7 * tpm) * ART, xMax = (b.x1 + 7 * tpm) * ART;
    const out = this.floraVis;
    out.length = 0;
    for (const c of this.chunks.chunks.values()) {
      const a = c.veg;
      if (c.state !== 'ready' || !a || !a.length) continue;
      const x0 = c.cx * CHUNK_TEXELS * ART, y0 = c.cy * CHUNK_TEXELS * ART, S = CHUNK_TEXELS * ART;
      if (x0 > xMax || x0 + S < xMin || y0 > yMax || y0 + S < yMin) continue;
      // records are sorted by y: binary search the first one in range
      let lo = 0, hi = a.length / VEG_STRIDE;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid * VEG_STRIDE + 1] < yMin) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo * VEG_STRIDE; i < a.length; i += VEG_STRIDE) {
        if (a[i + 1] > yMax) break;
        const x = a[i];
        if (x < xMin || x > xMax) continue;
        out.push({ a, i });
      }
    }
    out.sort((p, q) => p.a[p.i + 1] - q.a[q.i + 1]);
    this.floraCount = out.length;
  }

  /** Draw a flora sprite whose anchor sits at world art-px (x, y). */
  private drawFlora(s: { width: number; height: number; ax: number; ay: number } & CanvasImageSource, x: number, y: number, g = this.ctx) {
    const { cam } = this;
    const k = cam.ppt / ART;
    const sx = (x / ART - cam.center.x) * cam.ppt + cam.width / 2 - s.ax * k;
    const sy = (y / ART - cam.center.y) * cam.ppt + cam.height / 2 - s.ay * k;
    const w = s.width * k, h = s.height * k;
    if (sx > cam.width || sy > cam.height || sx + w < 0 || sy + h < 0) return;
    const rx = Math.round(sx), ry = Math.round(sy);
    g.drawImage(s, rx, ry, Math.round(sx + w) - rx, Math.round(sy + h) - ry);
  }

  /** Is the art of this ground-standing record on screen at all? (cheap pre-cull before building sprites) */
  private floraOnScreen(a: Int32Array, i: number, top: number, half: number): boolean {
    const { cam } = this;
    const k = cam.ppt / ART;
    const sx = (a[i] / ART - cam.center.x) * cam.ppt + cam.width / 2;
    const sy = (a[i + 1] / ART - cam.center.y) * cam.ppt + cam.height / 2;
    return sx + half * k > 0 && sx - half * k < cam.width && sy + half * k > 0 && sy - top * k < cam.height;
  }

  private drawStanding(a: Int32Array, i: number) {
    const kind = a[i + 2], r = a[i + 3];
    if (isTree(kind)) {
      if (!this.floraOnScreen(a, i, a[i + 5] + r, a[i + 6] + 4)) return;
      this.drawFlora(this.flora.trunk(kind, a[i + 5], a[i + 6], r), a[i], a[i + 1]);
    } else if (kind === VK.BUSH) {
      if (!this.floraOnScreen(a, i, r * 2, r * 1.2)) return;
      this.drawFlora(this.flora.bush(r, a[i + 4]), a[i], a[i + 1]);
    } else if (kind === VK.FERN) {
      if (!this.floraOnScreen(a, i, r, r)) return;
      this.drawFlora(this.flora.fern(r, a[i + 4]), a[i], a[i + 1]);
    } else if (kind === VK.HEDGE) {
      const dx = a[i + 5], dy = a[i + 6];
      if (!this.floraOnScreen(a, i, Math.abs(dy) + r * 4, Math.abs(dx) + Math.abs(dy) + r * 3)) return;
      this.drawFlora(this.flora.hedge(dx, dy, r, a[i + 4], 0.5), a[i], a[i + 1]);
    }
  }

  /** Trunks, bushes, hedges and ferns: below the people. */
  private drawFloraBase(alpha: number) {
    this.ctx.globalAlpha = alpha;
    for (const { a, i } of this.floraVis) this.drawStanding(a, i);
    this.ctx.globalAlpha = 1;
  }

  /** Redraw trunks and bushes that stand in front of (south of) someone, so they hide that person's legs. */
  private drawFloraFront(world: GameWorld, alpha: number) {
    const people: { x: number; y: number }[] = [];
    const b = this.cam.bounds();
    if (world.player.alive) people.push(world.player);
    for (const z of world.allZombies()) if (z.x > b.x0 && z.x < b.x1 && z.y > b.y0 && z.y < b.y1) people.push(z);
    if (!people.length) return;
    const tpm = 1 / metersPerTexel(this.cam.center.y);
    const body = 0.45 * tpm * ART;
    this.ctx.globalAlpha = alpha;
    for (const { a, i } of this.floraVis) {
      const kind = a[i + 2];
      if (kind === VK.FERN) continue;
      const x = a[i], y = a[i + 1], r = a[i + 3];
      let half: number, top: number, x0 = x, x1 = x;
      if (isTree(kind)) { half = a[i + 6] + body; top = a[i + 5]; }
      else if (kind === VK.BUSH) { half = r + body; top = r * 1.6; }
      else { half = r + body; top = r * 2.4; x0 = Math.min(x, x + a[i + 5]); x1 = Math.max(x, x + a[i + 5]); }
      const yb = kind === VK.HEDGE ? Math.max(y, y + a[i + 6]) : y;
      for (const p of people) {
        const px = p.x * ART, py = p.y * ART;
        if (py < yb && py > yb - top - body && px > x0 - half && px < x1 + half) {
          this.drawStanding(a, i);
          break;
        }
      }
    }
    this.ctx.globalAlpha = 1;
  }

  /** Tree crowns above everyone; they open up in a soft circle around the player underneath. */
  private drawCanopies(world: GameWorld, alpha: number) {
    const { cam, ctx } = this;
    const p = world.player;
    const tpm = 1 / metersPerTexel(cam.center.y);
    const A = tpm * ART;
    const px = p.x * ART, py = (p.y - 0.4 * tpm) * ART;
    let under = false;
    for (const { a, i } of this.floraVis) {
      if (!isTree(a[i + 2])) continue;
      const r = a[i + 3];
      const cy = a[i + 1] - a[i + 5] - r * 0.8;
      const dx = a[i] - px, dy = cy - py, rr = r * 0.95 + 0.6 * A;
      if (dx * dx + dy * dy < rr * rr) { under = true; break; }
    }
    const t = performance.now();
    const dt = Math.min(0.1, (t - this.lastFloraT) / 1000);
    this.lastFloraT = t;
    this.canopyHole = Math.max(0, Math.min(1, this.canopyHole + (under && p.alive ? dt : -dt) * 4));

    let g = ctx;
    if (this.canopyHole > 0.01) {
      if (!this.canopyLayer) this.canopyLayer = document.createElement('canvas');
      const L = this.canopyLayer;
      if (L.width !== cam.width || L.height !== cam.height) { L.width = cam.width; L.height = cam.height; }
      g = L.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, L.width, L.height);
      g.imageSmoothingEnabled = false;
      g.globalAlpha = 1;
    } else ctx.globalAlpha = alpha;

    for (const { a, i } of this.floraVis) {
      const kind = a[i + 2];
      if (!isTree(kind)) continue;
      const r = a[i + 3];
      const cyA = a[i + 1] - a[i + 5] - Math.round(r * 0.8);
      // cull by the crown's own circle before building its sprite
      const k = cam.ppt / ART;
      const sx = (a[i] / ART - cam.center.x) * cam.ppt + cam.width / 2, sy = (cyA / ART - cam.center.y) * cam.ppt + cam.height / 2;
      const rs = r * 1.1 * k;
      if (sx + rs < 0 || sy + rs < 0 || sx - rs > cam.width || sy - rs > cam.height) continue;
      this.drawFlora(this.flora.canopy(kind, r, a[i + 4]), a[i], cyA, g);
    }

    if (g !== ctx) {
      // cut a soft window to about 30% opacity around the player
      const q = cam.worldToScreen(p.x, p.y - 0.5 * tpm);
      const r0 = 1.3 * tpm * cam.ppt, r1 = 3.2 * tpm * cam.ppt;
      const grad = g.createRadialGradient(q.x, q.y, r0, q.x, q.y, r1);
      grad.addColorStop(0, `rgba(0,0,0,${0.7 * this.canopyHole})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = grad;
      g.fillRect(q.x - r1, q.y - r1, r1 * 2, r1 * 2);
      g.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.canopyLayer!, 0, 0);
    }
    ctx.globalAlpha = 1;
  }

  private drawSprite(s: Sprite, x: number, y: number, angle: number, scale: number) {
    const { ctx, cam } = this;
    const p = cam.worldToScreen(x, y);
    const k = cam.ppt * scale;
    if (p.x < -s.width * k || p.y < -s.width * k || p.x > cam.width + s.width * k || p.y > cam.height + s.width * k) return;
    ctx.save();
    ctx.translate(Math.round(p.x), Math.round(p.y));
    ctx.rotate(angle);
    ctx.drawImage(s, (-s.width / 2) * k, (-s.height / 2) * k, s.width * k, s.height * k);
    ctx.restore();
  }

  /** Roof lifts off the building you are in, showing its rooms; the outside dims. */
  private drawIndoor(world: GameWorld, alpha: number) {
    const { ctx, cam } = this;
    const p = world.player;
    const here = cam.zoom >= 18 ? this.chunks.buildingAt(p.x, p.y) : null;
    if (here) this.indoor = here;
    const dt = Math.min(0.1, (performance.now() - this.lastIndoorT) / 1000);
    this.lastIndoorT = performance.now();
    this.indoorFade = Math.max(0, Math.min(1, this.indoorFade + (here ? dt : -dt) * 5));
    const b = this.indoor;
    if (!b || this.indoorFade <= 0) return;
    const k = this.indoorFade * alpha;
    ctx.fillStyle = `rgba(6,8,10,${0.45 * k})`;
    ctx.fillRect(0, 0, cam.width, cam.height);
    const img = this.interiorImage(b);
    const a = cam.worldToScreen(b.x0, b.y0), e = cam.worldToScreen(b.x0 + b.w, b.y0 + b.h);
    ctx.globalAlpha = k;
    ctx.drawImage(img, Math.round(a.x), Math.round(a.y), Math.round(e.x) - Math.round(a.x), Math.round(e.y) - Math.round(a.y));
    ctx.globalAlpha = 1;
  }

  private interiorImage(b: BuildingInfo): HTMLCanvasElement {
    let img = this.interiorCache.get(b.id);
    if (img) return img;
    const R = new IdRaster(b.w, b.h);
    R.ids.set(b.ids);
    const rgba = new Uint8ClampedArray(b.w * b.h * 4);
    shadeRaster(R, rgba, { wx0: b.x0, wy0: b.y0, tpp: 1, damage: b.burnt ? 1 : 0.4, overgrowth: 0, detail: true });
    for (let i = 0; i < b.ids.length; i++) if (!b.ids[i]) rgba[i * 4 + 3] = 0;
    img = document.createElement('canvas');
    img.width = b.w;
    img.height = b.h;
    img.getContext('2d')!.putImageData(new ImageData(rgba, b.w, b.h), 0, 0);
    this.interiorCache.set(b.id, img);
    if (this.interiorCache.size > 12) this.interiorCache.delete(this.interiorCache.keys().next().value!);
    return img;
  }

  /** Under a roof you're not under: hidden from view. */
  private underOtherRoof(x: number, y: number): boolean {
    const b = this.chunks.buildingAt(x, y);
    return !!b && !(this.indoorFade > 0.5 && b === this.indoor);
  }

  private drawEntities(world: GameWorld, alpha: number, now: number) {
    const { ctx, cam } = this;
    const sp = this.sprites;
    const p = world.player;
    const tpm = 1 / metersPerTexel(cam.center.y);
    // Real-world sizes: a person is about 0.7 m across the shoulders from above
    // (their 14 px sprite spans ~0.77 m), small objects about 0.1 m per sprite pixel.
    const spx = 0.055 * tpm;
    const opx = 0.1 * tpm;
    ctx.globalAlpha = alpha;
    const b = cam.bounds(40);
    const inView = (x: number, y: number) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1;

    for (const c of world.allCorpses()) {
      if (inView(c.x, c.y) && !this.underOtherRoof(c.x, c.y)) this.drawSprite(sp.corpse(c.kind, c.id.length + c.id.charCodeAt(c.id.length - 1)), c.x, c.y, c.angle, opx * 1.05);
    }
    for (const v of world.allVehicles()) {
      if (!inView(v.x, v.y)) continue;
      const s = sp.vehicle(v.model, v.color, v.burnt);
      const [L] = vehicleSize(v.model);
      this.drawSprite(s, v.x, v.y, v.angle, (L * tpm) / (s.width - 2));
    }
    const near = world.nearestInteractable();
    for (const c of world.allContainers()) {
      if (!inView(c.x, c.y)) continue;
      const searched = world.isSearched(c) && !(c.items && c.items.length);
      // buildings are searched from inside; their roof is the marker
      if (c.kind === 'building') continue;
      if (this.underOtherRoof(c.x, c.y)) continue;
      if (c.kind === 'crate') this.drawSprite(sp.crate(), c.x, c.y, 0, opx);
      else if (c.kind === 'drop') this.drawSprite(sp.bag(), c.x, c.y, 0, opx * 0.8);
      else if (c.kind === 'playercorpse') {
        this.drawSprite(sp.corpse('civilian', 9), c.x, c.y, 0.4, opx * 1.05);
        const q = cam.worldToScreen(c.x, c.y);
        const pulse = 0.5 + 0.5 * Math.sin(now / 250);
        ctx.strokeStyle = `rgba(255,200,80,${0.4 + pulse * 0.5})`;
        ctx.lineWidth = 2 * cam.dpr;
        ctx.beginPath();
        ctx.arc(q.x, q.y, (1.1 + pulse * 0.4) * tpm * cam.ppt, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (c === near) {
        const q = cam.worldToScreen(c.x, c.y);
        ctx.strokeStyle = searched ? 'rgba(200,200,200,0.7)' : 'rgba(255,230,140,0.95)';
        ctx.lineWidth = Math.max(1, cam.dpr);
        const r = Math.max(4, 0.6 * tpm * cam.ppt);
        ctx.strokeRect(Math.round(q.x - r), Math.round(q.y - r), Math.round(r * 2), Math.round(r * 2));
      }
    }
    for (const z of world.allZombies()) {
      if (!inView(z.x, z.y) || this.underOtherRoof(z.x, z.y)) continue;
      const frame = z.state === 'chase' || z.state === 'wander' ? 1 + (Math.floor(z.anim * 2) % 2) : 0;
      this.drawSprite(sp.zombie(z.kind, z.variant, frame), z.x, z.y, z.angle, spx);
      if (z.hp < z.maxHp) {
        const q = cam.worldToScreen(z.x, z.y);
        const w = 0.9 * tpm * cam.ppt, top = q.y - 0.75 * tpm * cam.ppt, bh = Math.max(2, 0.12 * tpm * cam.ppt);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(q.x - w / 2, top, w, bh);
        ctx.fillStyle = '#b8352c';
        ctx.fillRect(q.x - w / 2, top, (w * Math.max(0, z.hp)) / z.maxHp, bh);
      }
    }
    if (p.alive) {
      const frame = p.moving ? 1 + (Math.floor(p.anim) % 2) : 0;
      this.drawSprite(sp.player(frame, !!p.equipped), p.x, p.y, p.angle, spx);
    }
    for (const e of world.effects) {
      const q = cam.worldToScreen(e.x, e.y);
      const k = 1 - e.t / e.life;
      if (e.kind === 'blood') {
        ctx.fillStyle = `rgba(150,20,16,${k})`;
        const s = Math.max(2, 0.08 * tpm * cam.ppt);
        ctx.fillRect(Math.round(q.x), Math.round(q.y - (1 - k) * 0.4 * tpm * cam.ppt), s, s);
      } else if (e.kind === 'flash') {
        ctx.fillStyle = `rgba(255,230,150,${k})`;
        ctx.beginPath();
        ctx.arc(q.x, q.y, 0.35 * tpm * cam.ppt, 0, Math.PI * 2);
        ctx.fill();
      } else if (e.kind === 'tracer' && e.x2 !== undefined && e.y2 !== undefined) {
        const q2 = cam.worldToScreen(e.x2, e.y2);
        ctx.strokeStyle = `rgba(255,240,180,${k * 0.8})`;
        ctx.lineWidth = Math.max(1, cam.ppt * 0.3);
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(q2.x, q2.y);
        ctx.stroke();
      } else if (e.kind === 'swing' && e.angle !== undefined) {
        ctx.strokeStyle = `rgba(230,230,220,${k * 0.6})`;
        ctx.lineWidth = Math.max(1, cam.ppt * 0.5);
        ctx.beginPath();
        ctx.arc(q.x, q.y, 0.9 * tpm * cam.ppt, e.angle - 1, e.angle + 1);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawMapOverlay(world: GameWorld | null, opts: RenderOptions, alpha: number) {
    const { ctx, cam } = this;
    if (alpha <= 0.01) return;
    ctx.globalAlpha = alpha;
    // country outline
    ctx.strokeStyle = 'rgba(255,220,150,0.55)';
    ctx.lineWidth = 1.5 * cam.dpr;
    for (const r of this.outline) {
      ctx.beginPath();
      r.forEach((p, i) => {
        const q = cam.worldToScreen(p.x, p.y);
        if (i) ctx.lineTo(q.x, q.y);
        else ctx.moveTo(q.x, q.y);
      });
      ctx.closePath();
      ctx.stroke();
    }
    // cities, coloured by how they fell
    if (opts.showCities && cam.zoom > 6 && cam.zoom < 14) {
      ctx.font = `${11 * cam.dpr}px ui-monospace, monospace`;
      ctx.textBaseline = 'middle';
      const limit = cam.zoom < 8 ? 12 : cam.zoom < 9 ? 25 : 60;
      for (const c of this.cityPts.slice(0, limit)) {
        const q = cam.worldToScreen(c.x, c.y);
        if (q.x < -50 || q.y < -50 || q.x > cam.width + 50 || q.y > cam.height + 50) continue;
        const r = (2 + Math.sqrt(c.pop / 40000) * 2) * cam.dpr;
        const col = c.fate === 'quarantine-fell' ? '#d9b44a' : c.fate === 'burned' ? '#e0602a' : c.fate === 'evacuated' ? '#7aa6c9' : '#c8382e';
        ctx.fillStyle = col;
        ctx.globalAlpha = alpha * 0.35;
        ctx.beginPath();
        ctx.arc(q.x, q.y, r * 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = alpha;
        ctx.fillRect(Math.round(q.x - r / 2), Math.round(q.y - r / 2), Math.round(r), Math.round(r));
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.fillText(c.name, q.x + r + 3 * cam.dpr + 1, q.y + 1);
        ctx.fillStyle = '#f2e8d0';
        ctx.fillText(c.name, q.x + r + 3 * cam.dpr, q.y);
      }
    }
    const markers: { p: Vec2; color: string }[] = [];
    if (opts.marker) markers.push({ p: opts.marker, color: '#ffd166' });
    if (opts.hover) markers.push({ p: opts.hover, color: 'rgba(255,255,255,0.7)' });
    if (world) {
      markers.push({ p: { x: world.player.x, y: world.player.y }, color: '#ff8c3a' });
      for (const pc of world.save.playerCorpses) markers.push({ p: pc, color: '#e04040' });
    }
    for (const m of markers) {
      const q = cam.worldToScreen(m.p.x, m.p.y);
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 2 * cam.dpr;
      const s = 7 * cam.dpr;
      ctx.beginPath();
      ctx.moveTo(q.x - s, q.y); ctx.lineTo(q.x - 2 * cam.dpr, q.y);
      ctx.moveTo(q.x + s, q.y); ctx.lineTo(q.x + 2 * cam.dpr, q.y);
      ctx.moveTo(q.x, q.y - s); ctx.lineTo(q.x, q.y - 2 * cam.dpr);
      ctx.moveTo(q.x, q.y + s); ctx.lineTo(q.x, q.y + 2 * cam.dpr);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawDebug(world: GameWorld | null) {
    const { ctx, cam } = this;
    ctx.strokeStyle = 'rgba(255,0,255,0.6)';
    ctx.lineWidth = 1;
    ctx.font = `${10 * cam.dpr}px monospace`;
    ctx.fillStyle = '#f0f';
    for (const c of this.chunks.chunks.values()) {
      const a = cam.worldToScreen(c.cx * CHUNK_TEXELS, c.cy * CHUNK_TEXELS);
      const s = CHUNK_TEXELS * cam.ppt;
      if (a.x > cam.width || a.y > cam.height || a.x + s < 0 || a.y + s < 0) continue;
      ctx.strokeRect(a.x, a.y, s, s);
      ctx.fillText(`${c.key} ${c.state} ${c.stats ? c.stats.ms + 'ms ' + c.stats.source : ''}`, a.x + 4, a.y + 12 * cam.dpr);
    }
    void world;
  }
}
