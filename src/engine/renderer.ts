import { CHUNK_TEXELS, lonLatToWorld, metersPerTexel, type Vec2 } from '../core/geo';
import type { PackManifest } from '../data/types';
import type { GameWorld } from '../game/world';
import { SpriteBank, type Sprite } from '../render/sprites';
import type { OutbreakHistory } from '../sim/outbreak';
import { vehicleSize } from '../world/chunkgen';
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

    if (world && cam.zoom >= 17) this.drawEntities(world, smoothstep(17, 18, cam.zoom), now);

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

  private drawEntities(world: GameWorld, alpha: number, now: number) {
    const { ctx, cam } = this;
    const sp = this.sprites;
    const p = world.player;
    const tpm = 1 / metersPerTexel(cam.center.y);
    // sprite pixel = half a texel, rescaled from metres where size matters
    const spx = 0.5 * (tpm / 2.7);
    ctx.globalAlpha = alpha;
    const b = cam.bounds(40);
    const inView = (x: number, y: number) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1;

    for (const c of world.allCorpses()) {
      if (inView(c.x, c.y)) this.drawSprite(sp.corpse(c.kind, c.id.length + c.id.charCodeAt(c.id.length - 1)), c.x, c.y, c.angle, spx);
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
      if (c.kind === 'building') this.drawSprite(sp.door(world.isSearched(c) && !c.items?.length), c.x, c.y, 0, spx);
      else if (c.kind === 'crate') this.drawSprite(sp.crate(), c.x, c.y, 0, spx);
      else if (c.kind === 'drop') this.drawSprite(sp.bag(), c.x, c.y, 0, spx);
      else if (c.kind === 'playercorpse') {
        this.drawSprite(sp.corpse('civilian', 9), c.x, c.y, 0.4, spx);
        const q = cam.worldToScreen(c.x, c.y);
        const pulse = 0.5 + 0.5 * Math.sin(now / 250);
        ctx.strokeStyle = `rgba(255,200,80,${0.4 + pulse * 0.5})`;
        ctx.lineWidth = 2 * cam.dpr;
        ctx.beginPath();
        ctx.arc(q.x, q.y, (6 + pulse * 3) * cam.ppt, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (c === near) {
        const q = cam.worldToScreen(c.x, c.y);
        ctx.strokeStyle = searched ? 'rgba(200,200,200,0.7)' : 'rgba(255,230,140,0.95)';
        ctx.lineWidth = Math.max(1, cam.dpr);
        const r = Math.max(4, 3 * cam.ppt);
        ctx.strokeRect(Math.round(q.x - r), Math.round(q.y - r), Math.round(r * 2), Math.round(r * 2));
      }
    }
    for (const z of world.allZombies()) {
      if (!inView(z.x, z.y)) continue;
      const frame = z.state === 'chase' || z.state === 'wander' ? 1 + (Math.floor(z.anim * 2) % 2) : 0;
      this.drawSprite(sp.zombie(z.kind, z.variant, frame), z.x, z.y, z.angle, spx);
      if (z.hp < z.maxHp) {
        const q = cam.worldToScreen(z.x, z.y);
        const w = 7 * cam.ppt;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(q.x - w / 2, q.y - 6 * cam.ppt, w, Math.max(2, cam.ppt * 0.8));
        ctx.fillStyle = '#b8352c';
        ctx.fillRect(q.x - w / 2, q.y - 6 * cam.ppt, (w * Math.max(0, z.hp)) / z.maxHp, Math.max(2, cam.ppt * 0.8));
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
        const s = Math.max(2, cam.ppt * 0.8);
        ctx.fillRect(Math.round(q.x), Math.round(q.y - (1 - k) * 4 * cam.ppt), s, s);
      } else if (e.kind === 'flash') {
        ctx.fillStyle = `rgba(255,230,150,${k})`;
        ctx.beginPath();
        ctx.arc(q.x, q.y, 2.5 * cam.ppt, 0, Math.PI * 2);
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
        ctx.arc(q.x, q.y, 3.6 * cam.ppt, e.angle - 1, e.angle + 1);
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
