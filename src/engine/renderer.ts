import { CHUNK_TEXELS, lonLatToWorld, metersPerTexel, type Vec2 } from '../core/geo';
import type { PackManifest } from '../data/types';
import type { GameWorld, Zombie } from '../game/world';
import { ITEMS } from '../game/items';
import { SpriteBank, type PixelSprite, type Sprite } from '../render/sprites';
import { ART_PPM, CHEAT, WEAPON_OF_ITEM, headingIndex, type Pose } from '../render/people';
import type { OutbreakHistory } from '../sim/outbreak';
import { shadeRaster } from '../render/materials';
import { IdRaster } from '../render/raster';
import type { BuildingInfo } from '../world/spawnTypes';
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
  private indoor: BuildingInfo | null = null;
  private indoorFade = 0;
  private lastIndoorT = 0;
  private interiorCache = new Map<string, HTMLCanvasElement>();
  /** zombies seen last frame, to notice the ones that just died */
  private seenZombies = new Set<Zombie>();
  private dying: { z: Zombie; t0: number }[] = [];
  private zMotion = new WeakMap<Zombie, { anim: number; at: number; last?: PixelSprite }>();
  private shadowImg: HTMLCanvasElement | null = null;

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
      this.drawIndoor(world, detailAlpha);
      this.drawEntities(world, smoothstep(17, 18, cam.zoom), now);
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

  /** Art-grid sprite at whole device pixels: anchor snapped, scale `k` device px per art px. */
  private drawPixel(s: PixelSprite, x: number, y: number, k: number) {
    const { ctx, cam } = this;
    const p = cam.worldToScreen(x, y);
    const ax = Math.round(p.x), ay = Math.round(p.y);
    if (ax + s.img.width * k < 0 || ay + s.img.height * k < 0 || ax - s.img.width * k > cam.width || ay - s.img.height * k > cam.height) return;
    ctx.drawImage(s.img, ax - Math.round(s.ox * k), ay - Math.round(s.oy * k), Math.round(s.img.width * k), Math.round(s.img.height * k));
  }

  /** Soft contact shadow, cast to the south-east by the north-west sun (about 0.5 x height). */
  private drawShadow(x: number, y: number, pxPerM: number, lenM: number) {
    const { ctx, cam } = this;
    if (!this.shadowImg) {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 32;
      const g = c.getContext('2d')!;
      g.scale(2, 1);
      const gr = g.createRadialGradient(16, 16, 1, 16, 16, 16);
      gr.addColorStop(0, 'rgba(0,0,0,0.36)');
      gr.addColorStop(0.55, 'rgba(0,0,0,0.28)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 32, 32);
      this.shadowImg = c;
    }
    const p = cam.worldToScreen(x, y);
    const L = (lenM + 0.35) * pxPerM, W = 0.6 * pxPerM;
    ctx.save();
    ctx.translate(p.x + lenM * 0.32 * pxPerM, p.y + lenM * 0.32 * pxPerM);
    ctx.rotate(Math.PI / 4);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.shadowImg, -L / 2, -W / 2, L, W);
    ctx.restore();
    ctx.imageSmoothingEnabled = false;
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
    sp.beginFrame();
    const p = world.player;
    const tpm = 1 / metersPerTexel(cam.center.y);
    // Real-world sizes. People, bodies and loose items are drawn on the art grid
    // of 11 px per metre (a person is ~0.7 m across the shoulders, ~8 art px).
    // One art pixel covers a whole number of device pixels once it is big enough.
    const pxPerM = tpm * cam.ppt;
    const kRaw = pxPerM / ART_PPM;
    const K = kRaw >= 1.5 ? Math.round(kRaw) : kRaw;
    ctx.globalAlpha = alpha;
    const b = cam.bounds(40);
    const inView = (x: number, y: number) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1;

    for (const c of world.allCorpses()) {
      if (inView(c.x, c.y) && !this.underOtherRoof(c.x, c.y)) this.drawPixel(sp.corpse(c.kind, c.id.length + c.id.charCodeAt(c.id.length - 1), headingIndex(c.angle)), c.x, c.y, K);
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
      if (c.kind === 'crate') this.drawPixel(sp.crate(), c.x, c.y, K);
      else if (c.kind === 'drop') this.drawPixel(sp.bag(), c.x, c.y, K);
      else if (c.kind === 'playercorpse') {
        this.drawPixel(sp.corpse('survivor', 0, 1), c.x, c.y, K);
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
    // Standing people: shadows first, then bodies sorted by their feet so the
    // one further south overlaps (the 3/4 cheat draws them rising up the screen).
    const people: { x: number; y: number; s: PixelSprite; z?: Zombie; fade?: number; flat?: boolean }[] = [];
    const t = now / 1000;
    const cur = new Set<Zombie>();
    for (const z of world.allZombies()) {
      cur.add(z);
      if (!inView(z.x, z.y) || this.underOtherRoof(z.x, z.y)) continue;
      people.push({ x: z.x, y: z.y, s: this.zombieSprite(z, t), z });
    }
    for (const z of this.seenZombies) if (!cur.has(z) && z.dead) this.dying.push({ z, t0: t });
    this.seenZombies = cur;
    this.dying = this.dying.filter((d) => t - d.t0 < 40);
    for (const d of this.dying) {
      const z = d.z;
      if (!inView(z.x, z.y) || this.underOtherRoof(z.x, z.y)) continue;
      const f = Math.min(3, Math.floor((t - d.t0) / 0.13));
      people.push({ x: z.x, y: z.y, flat: f >= 3, s: sp.zombie(z.kind, z.variant, { act: 'death', frame: f }, headingIndex(z.angle), t - d.t0 < 0.1), fade: Math.min(1, (40 - (t - d.t0)) / 8) });
    }
    if (p.alive) people.push({ x: p.x, y: p.y, s: this.playerSprite(world, now) });
    // bodies already on the ground go under everyone standing
    people.sort((a, c) => (a.flat ? -1e9 : a.y) - (c.flat ? -1e9 : c.y));
    for (const q of people) if (!q.flat) this.drawShadow(q.x, q.y, pxPerM, 0.75);
    for (const q of people) {
      if (q.fade !== undefined) ctx.globalAlpha = alpha * q.fade;
      this.drawPixel(q.s, q.x, q.y, K);
      ctx.globalAlpha = alpha;
      const z = q.z;
      if (z && z.hp < z.maxHp) {
        const r = cam.worldToScreen(z.x, z.y);
        const w = 0.8 * pxPerM, top = r.y - 2.0 * pxPerM, bh = Math.max(2, 0.1 * pxPerM);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(r.x - w / 2, top, w, bh);
        ctx.fillStyle = '#b8352c';
        ctx.fillRect(r.x - w / 2, top, (w * Math.max(0, z.hp)) / z.maxHp, bh);
      }
    }
    // hands, guns and wounds are about chest height on screen
    const lift = 1.15 * CHEAT * pxPerM;
    for (const e of world.effects) {
      const q = cam.worldToScreen(e.x, e.y);
      const k = 1 - e.t / e.life;
      if (e.kind === 'blood') {
        ctx.fillStyle = `rgba(150,20,16,${k})`;
        const s = Math.max(2, 0.08 * tpm * cam.ppt);
        ctx.fillRect(Math.round(q.x), Math.round(q.y - lift * 0.8 + (1 - k) * 0.6 * pxPerM), s, s);
      } else if (e.kind === 'flash') {
        ctx.fillStyle = `rgba(255,230,150,${k})`;
        ctx.beginPath();
        ctx.arc(q.x, q.y - lift, 0.25 * pxPerM, 0, Math.PI * 2);
        ctx.fill();
      } else if (e.kind === 'tracer' && e.x2 !== undefined && e.y2 !== undefined) {
        const q2 = cam.worldToScreen(e.x2, e.y2);
        ctx.strokeStyle = `rgba(255,240,180,${k * 0.8})`;
        ctx.lineWidth = Math.max(1, cam.ppt * 0.3);
        ctx.beginPath();
        ctx.moveTo(q.x, q.y - lift);
        ctx.lineTo(q2.x, q2.y - lift);
        ctx.stroke();
      } else if (e.kind === 'swing' && e.angle !== undefined) {
        ctx.strokeStyle = `rgba(230,230,220,${k * 0.6})`;
        ctx.lineWidth = Math.max(1, cam.ppt * 0.5);
        ctx.beginPath();
        ctx.ellipse(q.x, q.y - lift, 0.9 * pxPerM, 0.9 * pxPerM * 0.7, 0, e.angle - 1, e.angle + 1);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  private playerSprite(world: GameWorld, now: number): PixelSprite {
    const p = world.player;
    const weapon = p.equipped ? WEAPON_OF_ITEM[p.equipped] ?? null : null;
    const cd = (p.equipped ? ITEMS[p.equipped]?.weapon?.cooldown : undefined) ?? 0.5;
    const since = cd - p.attackCd;
    let pose: Pose;
    if (p.hurt > 0.15) pose = { act: 'hit', frame: 0, weapon };
    else if (p.attackCd > 0 && since >= 0 && since < 0.27) pose = { act: 'attack', frame: Math.min(2, Math.floor(since / 0.09)), weapon };
    else if (p.moving) pose = p.sprinting ? { act: 'run', frame: Math.floor(p.anim * 0.8) % 4, weapon } : { act: 'walk', frame: Math.floor(p.anim) % 4, weapon };
    else pose = { act: 'idle', frame: Math.floor(now / 700) % 2, weapon };
    const flash = p.hurt > 0 && Math.floor(p.hurt * 16) % 2 === 0;
    return this.sprites.player(pose, headingIndex(p.angle), flash);
  }

  private zombieSprite(z: Zombie, t: number): PixelSprite {
    let m = this.zMotion.get(z);
    if (!m) this.zMotion.set(z, (m = { anim: z.anim, at: -1 }));
    if (m.anim !== z.anim) {
      m.anim = z.anim;
      m.at = t;
    }
    const moving = t - m.at < 0.2;
    let pose: Pose;
    if (z.stun > 0) pose = { act: 'hit', frame: 0 };
    else if (z.attackCd > 0.85) pose = { act: 'lunge', frame: Math.min(2, Math.floor((1.15 - z.attackCd) / 0.1)) };
    else if (z.state === 'feed' && !moving) pose = { act: 'feed', frame: Math.floor(t * 2.2 + z.variant) % 2 };
    else if (moving) pose = { act: z.kind === 'runner' && z.state === 'chase' ? 'run' : 'shamble', frame: Math.floor(z.anim * 1.4) % 4 };
    else pose = { act: 'shamble', frame: z.variant % 2 ? 1 : 3 };
    return (m.last = this.sprites.zombie(z.kind, z.variant, pose, headingIndex(z.angle), z.stun > 0.22, m.last));
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
