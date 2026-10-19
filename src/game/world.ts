// Gameplay state: the survivor, the undead, and every lootable thing in the
// streamed chunks, plus their persistence as per-chunk deltas.

import { CHUNK_TEXELS, chunkKey, metersPerTexel, type Vec2 } from '../core/geo';
import { Rng, hashString } from '../core/rng';
import type { Chunk, ChunkListener, ChunkManager } from '../engine/chunks';
import { C } from '../render/materials';
import { emptyDelta, type ChunkDelta, type Drop, type PlayerCorpse, type PlayerSave, type WorldSave, type WorldStore } from '../persist/worldStore';
import type { CorpseKind, SpawnCorpse, SpawnVehicle, ZombieKind } from '../world/spawnTypes';
import { vehicleSize } from '../world/chunkgen';
import { ITEMS, itemName, rollLoot, type ItemStack } from './items';
import { Juice } from './juice';

export interface Zombie {
  id: string;
  home: string;
  x: number;
  y: number;
  sx: number;
  sy: number;
  hp: number;
  maxHp: number;
  kind: ZombieKind;
  variant: number;
  angle: number;
  state: 'idle' | 'wander' | 'chase' | 'feed';
  target: Vec2 | null;
  timer: number;
  attackCd: number;
  stun: number;
  anim: number;
  moved: boolean;
  dead: boolean;
  /** knockback slide, texels per second */
  kx: number;
  ky: number;
  /** bite wind-up: counts up from 0 while the zombie rears back; 0 = not winding up */
  windup: number;
  /** last way it was hit from, for the kill burst */
  hitDx: number;
  hitDy: number;
}

/** How long a zombie rears back before it bites: the window to step away or hit it first. */
export function windupTime(kind: ZombieKind): number {
  return kind === 'runner' ? 0.32 : kind === 'soldier' ? 0.5 : 0.45;
}

const GROANS = ['GRRR', 'HRRNN', 'UURGH', 'GRAAH', 'HNNGH'];

export type ContainerKind = 'building' | 'vehicle' | 'corpse' | 'crate' | 'drop' | 'playercorpse';

export interface Container {
  id: string;
  kind: ContainerKind;
  x: number;
  y: number;
  type: string;
  label: string;
  scavenged: number;
  chunk: string;
  items?: ItemStack[];
  /** interaction radius in texels */
  reach: number;
}

interface ChunkEnts {
  key: string;
  delta: ChunkDelta;
  dirty: boolean;
  containers: Container[];
  vehicles: SpawnVehicle[];
  corpses: SpawnCorpse[];
  zombies: Zombie[];
}

export interface Effect {
  kind: 'blood' | 'flash' | 'swing' | 'text' | 'tracer';
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  angle?: number;
  t: number;
  life: number;
  text?: string;
}

export interface Input {
  moveX: number;
  moveY: number;
  sprint: boolean;
  aim: Vec2;
  attack: boolean;
  interact: boolean;
}

export const MAX_SLOTS = 16;

const VEHICLE_LABEL: Record<string, string> = {
  car: 'Abandoned car', van: 'Abandoned van', truck: 'Lorry', bus: 'Bus', police: 'Police car', ambulance: 'Ambulance', military: 'Army vehicle',
};

export class Player {
  x = 0;
  y = 0;
  angle = 0;
  hp = 100;
  stamina = 100;
  hunger = 85;
  thirst = 85;
  inventory: ItemStack[] = [];
  equipped: string | null = null;
  alive = true;
  survivor = 1;
  kills = 0;
  timeAlive = 0;
  spawn: Vec2 = { x: 0, y: 0 };
  spawnName = '';
  attackCd = 0;
  anim = 0;
  moving = false;
  sprinting = false;
  hurt = 0;
  noise = 0;
  /** velocity in texels per second: instant starts, a short glide on stopping */
  vx = 0;
  vy = 0;

  toSave(): PlayerSave {
    return {
      x: this.x, y: this.y, spawn: this.spawn, spawnName: this.spawnName, hp: this.hp, stamina: this.stamina, hunger: this.hunger,
      thirst: this.thirst, inventory: this.inventory, equipped: this.equipped, alive: this.alive, survivor: this.survivor,
      kills: this.kills, timeAlive: this.timeAlive,
    };
  }

  load(s: PlayerSave) {
    Object.assign(this, {
      x: s.x, y: s.y, spawn: s.spawn, spawnName: s.spawnName, hp: s.hp, stamina: s.stamina, hunger: s.hunger, thirst: s.thirst,
      inventory: s.inventory, equipped: s.equipped, alive: s.alive, survivor: s.survivor, kills: s.kills, timeAlive: s.timeAlive ?? 0,
    });
  }

  count(id: string): number {
    return this.inventory.filter((s) => s.id === id).reduce((a, s) => a + s.qty, 0);
  }

  /** Add items; returns how many did not fit. */
  add(id: string, qty: number): number {
    const def = ITEMS[id];
    const max = def?.stack ?? 99;
    for (const s of this.inventory) {
      if (s.id !== id || s.qty >= max) continue;
      const n = Math.min(qty, max - s.qty);
      s.qty += n;
      qty -= n;
      if (!qty) return 0;
    }
    while (qty > 0 && this.inventory.length < MAX_SLOTS) {
      const n = Math.min(qty, max);
      this.inventory.push({ id, qty: n });
      qty -= n;
    }
    return qty;
  }

  remove(id: string, qty: number): boolean {
    if (this.count(id) < qty) return false;
    for (let i = this.inventory.length - 1; i >= 0 && qty > 0; i--) {
      const s = this.inventory[i];
      if (s.id !== id) continue;
      const n = Math.min(qty, s.qty);
      s.qty -= n;
      qty -= n;
      if (!s.qty) this.inventory.splice(i, 1);
    }
    if (this.equipped && !this.count(this.equipped)) this.equipped = null;
    return true;
  }
}

export class GameWorld implements ChunkListener {
  readonly player = new Player();
  readonly juice = new Juice();
  readonly ents = new Map<string, ChunkEnts>();
  effects: Effect[] = [];
  /** messages for the HUD log */
  log: { text: string; t: number }[] = [];
  time = 0;
  paused = true;
  private saveTimer = 0;
  private loadingDeltas = new Set<string>();
  onDeath?: () => void;

  constructor(readonly save: WorldSave, readonly store: WorldStore, readonly chunks: ChunkManager) {}

  get seed() {
    return this.save.seed;
  }

  say(text: string) {
    this.log.push({ text, t: this.time });
    if (this.log.length > 6) this.log.shift();
  }

  // ---- chunk lifecycle ------------------------------------------------------

  onChunkReady(c: Chunk): void {
    if (!c.spawns) return;
    const key = c.key;
    this.loadingDeltas.add(key);
    this.store.loadChunk(key).then((d) => {
      this.loadingDeltas.delete(key);
      if (this.chunks.chunks.get(key) !== c || c.state !== 'ready') return;
      this.attach(c, d ?? emptyDelta());
    });
  }

  private attach(c: Chunk, delta: ChunkDelta) {
    const s = c.spawns!;
    const tpm = 1 / metersPerTexel(c.cy * CHUNK_TEXELS);
    const containers: Container[] = [];
    for (const sc of s.containers) {
      containers.push({
        id: sc.id, kind: sc.type === 'crate' ? 'crate' : 'building', x: sc.x, y: sc.y, type: sc.type, label: sc.label,
        scavenged: sc.scavenged, chunk: c.key, items: delta.containers[sc.id], reach: 1.6 * tpm,
      });
    }
    for (const v of s.vehicles) {
      if (!v.lootType) continue;
      const [L] = vehicleSize(v.model);
      containers.push({
        id: v.id, kind: 'vehicle', x: v.x, y: v.y, type: v.lootType, label: VEHICLE_LABEL[v.model] ?? 'Vehicle', scavenged: 0,
        chunk: c.key, items: delta.containers[v.id], reach: (L / 2 + 1.2) * tpm,
      });
    }
    for (const k of s.corpses) {
      containers.push({
        id: k.id, kind: 'corpse', x: k.x, y: k.y, type: k.lootType, label: corpseLabel(k.kind), scavenged: 0, chunk: c.key,
        items: delta.containers[k.id], reach: 1.5 * tpm,
      });
    }
    for (const d of delta.drops) {
      containers.push({ id: d.id, kind: 'drop', x: d.x, y: d.y, type: 'drop', label: 'Dropped items', scavenged: 0, chunk: c.key, items: d.items, reach: 1.4 * tpm });
    }
    const zombies: Zombie[] = [];
    for (const z of s.zombies) {
      const st = delta.zombies[z.id];
      if (st === 0) continue;
      const h = hashString(z.id);
      zombies.push({
        id: z.id, home: c.key, x: st ? st.x : z.x, y: st ? st.y : z.y, sx: z.x, sy: z.y, hp: st ? st.hp : z.hp, maxHp: z.hp,
        kind: z.kind, variant: h % 6, angle: (h % 628) / 100, state: 'idle', target: null, timer: (h % 50) / 10,
        attackCd: 0, stun: 0, anim: (h % 100) / 100, moved: false, dead: false, kx: 0, ky: 0, windup: 0, hitDx: 1, hitDy: 0,
      });
    }
    this.ents.set(c.key, { key: c.key, delta, dirty: false, containers, vehicles: s.vehicles, corpses: s.corpses, zombies });
  }

  onChunkUnload(c: Chunk): void {
    const e = this.ents.get(c.key);
    if (!e) return;
    this.recordZombies(e);
    if (e.dirty) void this.store.saveChunk(e.key, e.delta);
    this.ents.delete(c.key);
  }

  private recordZombies(e: ChunkEnts) {
    for (const z of e.zombies) {
      if (z.dead) continue;
      if (z.moved || z.hp !== z.maxHp) {
        e.delta.zombies[z.id] = { x: Math.round(z.x * 10) / 10, y: Math.round(z.y * 10) / 10, hp: Math.round(z.hp) };
        e.dirty = true;
        z.moved = false;
      }
    }
  }

  /** Persist everything that changed (called periodically and on page hide). */
  async flush(): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const e of this.ents.values()) {
      this.recordZombies(e);
      if (e.dirty) {
        e.dirty = false;
        jobs.push(this.store.saveChunk(e.key, e.delta));
      }
    }
    jobs.push(this.store.savePlayer(this.player.toSave()));
    await Promise.all(jobs);
  }

  isAttached(cx: number, cy: number): boolean {
    return this.ents.has(chunkKey(cx, cy));
  }

  // ---- queries ------------------------------------------------------------------

  *allZombies(): Iterable<Zombie> {
    for (const e of this.ents.values()) for (const z of e.zombies) if (!z.dead) yield z;
  }

  *allContainers(): Iterable<Container> {
    for (const e of this.ents.values()) yield* e.containers;
    for (const pc of this.save.playerCorpses) {
      yield {
        id: pc.id, kind: 'playercorpse', x: pc.x, y: pc.y, type: 'playercorpse', label: `Your body (survivor #${pc.survivor})`,
        scavenged: 0, chunk: '', items: pc.items, reach: 1.6 / metersPerTexel(pc.y),
      };
    }
  }

  *allVehicles(): Iterable<SpawnVehicle> {
    for (const e of this.ents.values()) yield* e.vehicles;
  }

  *allCorpses(): Iterable<SpawnCorpse> {
    for (const e of this.ents.values()) yield* e.corpses;
  }

  nearestInteractable(): Container | null {
    const p = this.player;
    let best: Container | null = null, bd = Infinity;
    const indoor = this.chunks.buildingAt(p.x, p.y);
    for (const c of this.allContainers()) {
      let d = Math.hypot(c.x - p.x, c.y - p.y);
      // a building is searched from anywhere inside it, and never through its walls
      if (c.kind === 'building') {
        if (!indoor || c.id !== `b:${indoor.id}`) continue;
        d = Math.min(d, 1);
      } else if (d > c.reach) continue;
      // Your own body wins over anything else in reach, and emptied things lose to unsearched ones
      const score = d + (c.kind === 'playercorpse' ? -1000 : 0) + (c.items && !c.items.length ? 1000 : 0);
      if (score < bd) { bd = score; best = c; }
    }
    return best;
  }

  /** Contents, rolling them from the seed the first time. */
  contents(c: Container): ItemStack[] {
    if (c.items) return c.items;
    c.items = rollLoot(this.seed, c.id, c.type, c.scavenged);
    this.persistContainer(c);
    return c.items;
  }

  isSearched(c: Container): boolean {
    return c.items !== undefined;
  }

  persistContainer(c: Container) {
    if (c.kind === 'playercorpse') {
      const pc = this.save.playerCorpses.find((x) => x.id === c.id);
      if (pc) {
        pc.items = c.items ?? [];
        if (!pc.items.length) {
          this.save.playerCorpses = this.save.playerCorpses.filter((x) => x !== pc);
          this.say('You recovered everything from your old body.');
        }
        void this.store.saveWorld(this.save);
      }
      return;
    }
    const e = this.ents.get(c.chunk);
    if (!e) return;
    if (c.kind === 'drop') {
      const d = e.delta.drops.find((x) => x.id === c.id);
      if (d) d.items = c.items ?? [];
      e.delta.drops = e.delta.drops.filter((x) => x.items.length);
      if (!c.items?.length) e.containers = e.containers.filter((x) => x !== c);
    } else {
      e.delta.containers[c.id] = c.items ?? [];
    }
    e.dirty = true;
  }

  take(c: Container, index: number | 'all'): void {
    const items = this.contents(c);
    const idx = index === 'all' ? items.map((_, i) => i) : [index];
    let full = false;
    let taken = 0;
    for (const i of idx.sort((a, b) => b - a)) {
      const s = items[i];
      if (!s) continue;
      const left = this.player.add(s.id, s.qty);
      if (left) {
        s.qty = left;
        full = true;
      } else {
        items.splice(i, 1);
        this.say(`Took ${s.qty > 1 ? s.qty + '× ' : ''}${itemName(s.id)}`);
        this.juice.pickup(this.player.x, this.player.y, `+${s.qty > 1 ? s.qty + ' ' : ''}${itemName(s.id)}`, ITEMS[s.id]?.color ?? '#ccc', taken++);
        if (!this.player.equipped && ITEMS[s.id]?.weapon) this.equip(s.id);
      }
    }
    if (full) this.say('Your pack is full.');
    this.persistContainer(c);
    void this.store.savePlayer(this.player.toSave());
  }

  dropItem(index: number): void {
    const p = this.player;
    const s = p.inventory[index];
    if (!s) return;
    p.inventory.splice(index, 1);
    if (p.equipped === s.id && !p.count(s.id)) p.equipped = null;
    const key = chunkKey(Math.floor(p.x / CHUNK_TEXELS), Math.floor(p.y / CHUNK_TEXELS));
    const e = this.ents.get(key);
    if (!e) return;
    const tpm = 1 / metersPerTexel(p.y);
    let drop = e.containers.find((c) => c.kind === 'drop' && Math.hypot(c.x - p.x, c.y - p.y) < 1.2 * tpm);
    if (!drop) {
      const d: Drop = { id: `d:${Date.now().toString(36)}:${Math.floor(Math.random() * 1e6)}`, x: p.x, y: p.y, items: [] };
      e.delta.drops.push(d);
      drop = { id: d.id, kind: 'drop', x: d.x, y: d.y, type: 'drop', label: 'Dropped items', scavenged: 0, chunk: key, items: d.items, reach: 1.4 * tpm };
      e.containers.push(drop);
    }
    drop.items!.push({ ...s });
    this.persistContainer(drop);
    this.say(`Dropped ${itemName(s.id)}`);
  }

  equip(id: string | null) {
    this.player.equipped = id;
    if (id) this.say(`Equipped ${itemName(id)}`);
  }

  useItem(index: number): void {
    const p = this.player;
    const s = p.inventory[index];
    if (!s) return;
    const def = ITEMS[s.id];
    if (!def) return;
    if (def.weapon) {
      this.equip(p.equipped === s.id ? null : s.id);
      return;
    }
    if (def.cat === 'food' || def.cat === 'drink' || def.cat === 'medical') {
      p.hunger = clamp(p.hunger + (def.hunger ?? 0), 0, 100);
      p.thirst = clamp(p.thirst + (def.thirst ?? 0), 0, 100);
      p.hp = clamp(p.hp + (def.heal ?? 0), 0, 100);
      p.remove(s.id, 1);
      this.say(`${def.cat === 'medical' ? 'Used' : def.cat === 'drink' ? 'Drank' : 'Ate'} ${def.name}`);
    }
  }

  // ---- simulation -----------------------------------------------------------

  update(dt: number, input: Input): void {
    if (this.paused) return;
    // Hit-stop slows the world, never the survivor: controls stay instant.
    const wdt = this.juice.hitstop > 0 ? dt * 0.08 : dt;
    this.time += wdt;
    const p = this.player;
    const tpm = 1 / metersPerTexel(p.y);
    p.noise = 0;
    if (p.alive) this.updatePlayer(dt, input, tpm);
    this.updateZombies(wdt, tpm);
    this.effects = this.effects.filter((e) => (e.t += wdt) < e.life);
    this.juice.update(wdt, dt, Math.random);
    this.saveTimer += dt;
    if (this.saveTimer > 5) {
      this.saveTimer = 0;
      void this.flush();
    }
  }

  private updatePlayer(dt: number, input: Input, tpm: number) {
    const p = this.player;
    p.timeAlive += dt;
    p.hurt = Math.max(0, p.hurt - dt);
    p.attackCd = Math.max(0, p.attackCd - dt);
    p.hunger = Math.max(0, p.hunger - dt * 0.037);
    p.thirst = Math.max(0, p.thirst - dt * 0.055);
    if (p.hunger <= 0 || p.thirst <= 0) this.damagePlayer(dt * 0.4, 'starvation');
    else if (p.hunger > 50 && p.thirst > 50 && p.hp < 100) p.hp = Math.min(100, p.hp + dt * 0.12);

    let mx = input.moveX, my = input.moveY;
    const len = Math.hypot(mx, my);
    p.moving = len > 0.01;
    p.sprinting = p.moving && input.sprint && p.stamina > 1;
    if (p.sprinting) p.stamina = Math.max(0, p.stamina - dt * 15);
    else p.stamina = Math.min(100, p.stamina + dt * (p.moving ? 20 : 32));
    if (p.moving) {
      // a half-pushed stick walks slower; anything past halfway is full speed
      const push = Math.min(1, len * 1.6);
      mx /= len;
      my /= len;
      const ground = this.chunks.collisionAt(p.x, p.y);
      const terrain = ground === C.SLOW ? 0.6 : ground === C.ROUGH ? 0.8 : 1;
      const speed = (p.sprinting ? 4.0 : 2.2 * push) * terrain * tpm;
      p.vx = mx * speed;
      p.vy = my * speed;
      p.anim += dt * (p.sprinting ? 11 : 7);
      p.noise = (p.sprinting ? 10 : 3.5) * tpm;
    } else {
      // a quick glide to a stop
      const k = Math.exp(-dt * 22);
      p.vx *= k;
      p.vy *= k;
      if (Math.hypot(p.vx, p.vy) < 0.05 * tpm) p.vx = p.vy = 0;
    }
    if (p.vx || p.vy) {
      const np = this.moveCircle(p.x, p.y, p.vx * dt, p.vy * dt, 0.3 * tpm);
      if (np.x === p.x) p.vx = 0;
      if (np.y === p.y) p.vy = 0;
      p.x = np.x;
      p.y = np.y;
    }
    p.angle = Math.atan2(input.aim.y - p.y, input.aim.x - p.x);
    if (input.attack && p.attackCd <= 0) this.attack(tpm);
  }

  damagePlayer(amount: number, cause: string) {
    const p = this.player;
    if (!p.alive) return;
    p.hp -= amount;
    if (amount >= 2) {
      p.hurt = 0.35;
      this.juice.shake(Math.min(0.6, 0.2 + amount * 0.025));
      this.juice.stop(0.05);
      this.juice.flash(p, 0.06);
      this.juice.pop(p.x, p.y, `-${Math.round(amount)}`, '#ff4a3a', 1.4, 0.8, 1.1);
    }
    if (p.hp <= 0) this.die(cause);
  }

  private die(cause: string) {
    const p = this.player;
    p.hp = 0;
    p.alive = false;
    const items = p.inventory.filter((s) => s.qty > 0);
    if (items.length) {
      const corpse: PlayerCorpse = { id: `pc:${p.survivor}:${Date.now().toString(36)}`, x: p.x, y: p.y, items, diedAt: Date.now(), cause, survivor: p.survivor };
      this.save.playerCorpses.push(corpse);
      if (this.save.playerCorpses.length > 5) this.save.playerCorpses.shift();
    }
    p.inventory = [];
    p.equipped = null;
    // the killers stay to feed
    for (const z of this.allZombies()) {
      if (Math.hypot(z.x - p.x, z.y - p.y) < 6 / metersPerTexel(p.y)) {
        z.state = 'feed';
        z.target = { x: p.x, y: p.y };
        z.timer = 40;
      }
    }
    void this.store.saveWorld(this.save);
    void this.flush();
    this.onDeath?.();
  }

  /** Start a new survivor at the hideout. Returns the respawn point. */
  respawn(): Vec2 {
    const p = this.player;
    p.survivor++;
    p.alive = true;
    p.hp = 100;
    p.stamina = 100;
    p.hunger = 80;
    p.thirst = 80;
    p.timeAlive = 0;
    p.inventory = [];
    p.add('water_bottle', 1);
    p.add('stroopwafel', 1);
    p.add('bandage', 1);
    p.equipped = null;
    p.vx = p.vy = 0;
    p.x = p.spawn.x;
    p.y = p.spawn.y;
    void this.store.savePlayer(p.toSave());
    this.say(`Survivor #${p.survivor} wakes up at ${p.spawnName}.`);
    return { x: p.x, y: p.y };
  }

  private attack(tpm: number) {
    const p = this.player;
    const J = this.juice;
    const w = p.equipped ? ITEMS[p.equipped]?.weapon : undefined;
    const weapon = w ?? { kind: 'melee' as const, damage: 9, range: 0.9, cooldown: 0.42, noise: 2, knockback: 0.3 };
    if (weapon.kind === 'gun') {
      if (weapon.ammo && !p.remove(weapon.ammo, 1)) {
        this.say('Out of ammo. *click*');
        J.pop(p.x, p.y, 'CLICK', '#c8c8c8', 1, 0.6, 0.8);
        p.attackCd = 0.4;
        return;
      }
      p.attackCd = weapon.cooldown;
      const range = weapon.range * tpm;
      const dx = Math.cos(p.angle), dy = Math.sin(p.angle);
      // walls stop bullets
      let wall = range;
      for (let s = 2; s < range; s += 1) {
        if (this.chunks.collisionAt(p.x + dx * s, p.y + dy * s) === C.SOLID) { wall = s; break; }
      }
      let hit: Zombie | null = null, hd = wall;
      for (const z of this.allZombies()) {
        const rx = z.x - p.x, ry = z.y - p.y;
        const along = rx * dx + ry * dy;
        if (along < 0 || along > hd) continue;
        // a forgiving hitbox: arcade aim
        if (Math.abs(rx * dy - ry * dx) < 0.6 * tpm) { hit = z; hd = along; }
      }
      this.effects.push({ kind: 'tracer', x: p.x + dx * 0.6 * tpm, y: p.y + dy * 0.6 * tpm, x2: p.x + dx * hd, y2: p.y + dy * hd, t: 0, life: 0.09 });
      this.effects.push({ kind: 'flash', x: p.x + dx * 0.7 * tpm, y: p.y + dy * 0.7 * tpm, t: 0, life: 0.07 });
      // kick the camera back against the shot
      J.push(-dx, -dy, weapon.damage > 60 ? 0.12 : 0.18);
      J.shake(weapon.damage > 60 ? 0.12 : 0.2);
      if (hit) {
        const crit = Math.random() < 0.2;
        this.hurtZombie(hit, weapon.damage * (crit ? 1.6 : 1), dx, dy, 0.9 * tpm, crit);
      }
      this.makeNoise(p.x, p.y, weapon.noise * tpm);
      return;
    }
    p.attackCd = weapon.cooldown;
    const reach = (weapon.range + 0.45) * tpm;
    // Swing at whatever is in front; a target just out of reach pulls you in a step.
    const arc = 1.3;
    const inArc = (z: Zombie, r: number) => {
      const d = Math.hypot(z.x - p.x, z.y - p.y);
      if (d > r) return false;
      let da = Math.atan2(z.y - p.y, z.x - p.x) - p.angle;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      return Math.abs(da) < arc;
    };
    let hits: Zombie[] = [];
    for (const z of this.allZombies()) if (inArc(z, reach)) hits.push(z);
    if (!hits.length) {
      let best: Zombie | null = null, bd = reach + 1.1 * tpm;
      for (const z of this.allZombies()) {
        const d = Math.hypot(z.x - p.x, z.y - p.y);
        if (d < bd && inArc(z, bd)) { bd = d; best = z; }
      }
      if (best) {
        const step = Math.min(0.75 * tpm, bd - reach * 0.8);
        if (step > 0) {
          const np = this.moveCircle(p.x, p.y, Math.cos(p.angle) * step, Math.sin(p.angle) * step, 0.3 * tpm);
          p.x = np.x;
          p.y = np.y;
        }
        if (Math.hypot(best.x - p.x, best.y - p.y) <= reach) hits = [best];
      }
    }
    this.effects.push({ kind: 'swing', x: p.x, y: p.y, angle: p.angle, t: 0, life: 0.16 });
    hits.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
    for (const z of hits.slice(0, 3)) {
      const d = Math.hypot(z.x - p.x, z.y - p.y) || 1;
      const crit = Math.random() < 0.15;
      const dmg = weapon.damage * (0.85 + Math.random() * 0.3) * (crit ? 2 : 1);
      const knock = ((weapon.knockback ?? 0.3) * 1.6 + 0.5) * (crit ? 1.5 : 1) * tpm;
      this.hurtZombie(z, dmg, (z.x - p.x) / d, (z.y - p.y) / d, knock, crit);
    }
    if (hits.length) {
      const big = Math.min(1, weapon.damage / 45);
      J.stop(0.035 + big * 0.03);
      J.shake(0.18 + big * 0.22);
      J.push(Math.cos(p.angle), Math.sin(p.angle), 0.06);
    }
    if (weapon.noise > 2) this.makeNoise(p.x, p.y, weapon.noise * tpm);
  }

  private hurtZombie(z: Zombie, dmg: number, dx: number, dy: number, knock: number, crit = false) {
    const J = this.juice;
    z.hp -= dmg;
    z.stun = crit ? 0.5 : 0.35;
    J.flash(z, crit ? 0.12 : 0.08);
    z.windup = 0;
    z.state = 'chase';
    z.target = { x: this.player.x, y: this.player.y };
    // knockback as a short slide (distance = speed / decay rate)
    z.kx = dx * knock * 10;
    z.ky = dy * knock * 10;
    z.hitDx = dx;
    z.hitDy = dy;
    z.moved = true;
    const tpm = 1 / metersPerTexel(z.y);
    J.damage(z.x, z.y, dmg, crit);
    J.blood(z.x, z.y, dx, dy, crit ? 10 : 6, Math.random, tpm);
    if (crit) J.shake(0.15);
    for (let i = 0; i < 3; i++) this.effects.push({ kind: 'blood', x: z.x + (Math.random() - 0.5) * 3, y: z.y + (Math.random() - 0.5) * 3, t: 0, life: 0.5 + Math.random() * 0.4 });
    if (z.hp <= 0) {
      z.dead = true;
      this.player.kills++;
      J.gore(z.x, z.y, dx, dy, Math.random, tpm);
      J.kill();
      J.stop(0.075);
      J.shake(0.25);
      const e = this.ents.get(z.home);
      if (e) {
        e.delta.zombies[z.id] = 0;
        e.dirty = true;
      }
    }
  }

  makeNoise(x: number, y: number, radius: number) {
    for (const z of this.allZombies()) {
      if (Math.hypot(z.x - x, z.y - y) < radius && z.state !== 'feed') {
        z.state = 'chase';
        z.target = { x, y };
        z.timer = 8;
      }
    }
  }

  private lineOfSight(ax: number, ay: number, bx: number, by: number): boolean {
    const d = Math.hypot(bx - ax, by - ay);
    const steps = Math.ceil(d / 2);
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      if (this.chunks.collisionAt(ax + (bx - ax) * f, ay + (by - ay) * f) === C.SOLID) return false;
    }
    return true;
  }

  private updateZombies(dt: number, tpm: number) {
    const p = this.player;
    const active: Zombie[] = [];
    const activeR = 110 * tpm;
    for (const z of this.allZombies()) if (Math.abs(z.x - p.x) < activeR && Math.abs(z.y - p.y) < activeR) active.push(z);
    const sight = 17 * tpm;
    for (const z of active) {
      z.attackCd = Math.max(0, z.attackCd - dt);
      if (z.kx || z.ky) {
        const np = this.moveCircle(z.x, z.y, z.kx * dt, z.ky * dt, 0.28 * tpm);
        z.x = np.x;
        z.y = np.y;
        const k = Math.exp(-dt * 10);
        z.kx *= k;
        z.ky *= k;
        if (Math.hypot(z.kx, z.ky) < 0.1 * tpm) z.kx = z.ky = 0;
      }
      if (z.stun > 0) {
        z.stun -= dt;
        continue;
      }
      const dist = Math.hypot(p.x - z.x, p.y - z.y);
      if (p.alive && z.state !== 'feed') {
        const sees = dist < sight && this.lineOfSight(z.x, z.y, p.x, p.y);
        const hears = dist < p.noise;
        if (sees || hears) {
          if (z.state !== 'chase' && dist < 14 * tpm) this.juice.groan(z.x, z.y, GROANS[hashString(z.id + Math.floor(this.time)) % GROANS.length]);
          z.state = 'chase';
          z.target = { x: p.x, y: p.y };
          z.timer = 6;
        }
      }
      let speed = 0;
      z.timer -= dt;
      switch (z.state) {
        case 'idle':
          if (z.timer <= 0) {
            z.state = 'wander';
            const r = new Rng(hashString(z.id) + Math.floor(this.time));
            z.target = { x: z.sx + r.range(-10, 10) * tpm, y: z.sy + r.range(-10, 10) * tpm };
            z.timer = r.range(4, 9);
          }
          break;
        case 'wander':
          speed = 0.6;
          if (z.timer <= 0 || !z.target || Math.hypot(z.target.x - z.x, z.target.y - z.y) < 0.5 * tpm) {
            z.state = 'idle';
            z.timer = 2 + (hashString(z.id) % 40) / 10;
          }
          break;
        case 'chase':
          // shamblers lose to a walk, runners only to a sprint
          speed = z.kind === 'runner' ? 3.5 : z.kind === 'soldier' ? 1.5 : 1.7;
          if (z.target && Math.hypot(z.target.x - z.x, z.target.y - z.y) < 0.6 * tpm && z.timer <= 0) {
            z.state = 'idle';
            z.timer = 3;
          }
          if (z.timer < -12) z.state = 'idle';
          if (z.windup > 0) {
            // rearing back: stand still, then bite whatever is still in reach
            speed = 0;
            z.windup += dt;
            if (p.alive) z.angle = Math.atan2(p.y - z.y, p.x - z.x);
            if (z.windup >= windupTime(z.kind)) {
              z.windup = 0;
              z.attackCd = 1.15;
              if (p.alive && dist < 1.15 * tpm) {
                this.damagePlayer(z.kind === 'soldier' ? 12 : 9 + Math.random() * 4, 'zombie');
                this.effects.push({ kind: 'blood', x: p.x, y: p.y, t: 0, life: 0.6 });
                this.juice.blood(p.x, p.y, p.x - z.x, p.y - z.y, 5, Math.random, tpm);
              } else this.juice.pop(z.x, z.y, 'MISS', '#bfe6ff', 1, 0.6, 0.7);
            }
          } else if (p.alive && dist < 0.95 * tpm && z.attackCd <= 0) {
            z.windup = 1e-3;
          }
          break;
        case 'feed':
          if (z.target && Math.hypot(z.target.x - z.x, z.target.y - z.y) > 0.9 * tpm) speed = 0.6;
          if (z.timer <= 0) z.state = 'idle';
          break;
      }
      if (speed > 0 && z.target) {
        const dx = z.target.x - z.x, dy = z.target.y - z.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.4 * tpm) {
          const want = Math.atan2(dy, dx);
          const step = speed * tpm * dt;
          // try straight, then veer around obstacles
          for (const off of [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9]) {
            const a = want + off;
            const np = this.moveCircle(z.x, z.y, Math.cos(a) * step, Math.sin(a) * step, 0.28 * tpm);
            if (Math.hypot(np.x - z.x, np.y - z.y) > step * 0.5) {
              z.x = np.x;
              z.y = np.y;
              z.angle = a;
              z.moved = true;
              break;
            }
          }
          z.anim += dt * speed * 3;
        }
      } else if (z.state === 'chase' && p.alive) {
        z.angle = Math.atan2(p.y - z.y, p.x - z.x);
      }
    }
    // keep the crowd from stacking up
    const minD = 0.6 * tpm;
    for (let i = 0; i < active.length; i++) {
      const a = active[i];
      for (let j = i + 1; j < active.length; j++) {
        const b = active[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        if (Math.abs(dx) > minD || Math.abs(dy) > minD) continue;
        const d = Math.hypot(dx, dy) || 0.01;
        if (d < minD) {
          const push = (minD - d) / 2;
          a.x -= (dx / d) * push; a.y -= (dy / d) * push;
          b.x += (dx / d) * push; b.y += (dy / d) * push;
        }
      }
      if (p.alive) {
        const dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy);
        const pd = 0.5 * tpm;
        if (d < pd && d > 0.001) {
          const np = this.moveCircle(a.x, a.y, -(dx / d) * (pd - d), -(dy / d) * (pd - d), 0.25 * tpm);
          a.x = np.x;
          a.y = np.y;
        }
      }
    }
  }

  /** Circle movement against the collision grid, sliding along walls. */
  moveCircle(x: number, y: number, dx: number, dy: number, r: number): Vec2 {
    const blocked = (px: number, py: number) => {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const c = this.chunks.collisionAt(px + Math.cos(a) * r, py + Math.sin(a) * r);
        if (c === C.SOLID || c === C.DEEP) return true;
      }
      return false;
    };
    // already stuck (e.g. spawned inside something): allow escaping
    if (blocked(x, y)) return { x: x + dx, y: y + dy };
    let nx = x, ny = y;
    if (!blocked(x + dx, y)) nx = x + dx;
    if (!blocked(nx, y + dy)) ny = y + dy;
    return { x: nx, y: ny };
  }
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function corpseLabel(k: CorpseKind): string {
  return k === 'soldier' ? 'Dead soldier' : k === 'police' ? 'Dead police officer' : 'Corpse';
}
