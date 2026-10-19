// Arcade feedback state: hit-stop, screen shake, camera kick, damage numbers,
// gore, blood that stays on the ground, kill streaks and pickup pop-ups. The
// simulation pushes events in here; main.ts reads the camera bits and
// render/effects.ts draws the rest. Nothing here is saved.

import type { Vec2 } from '../core/geo';

/** A floating pop-up: damage numbers, groans, pickups, "x3!". */
export interface Pop {
  x: number;
  y: number;
  text: string;
  color: string;
  /** art-pixel scale multiplier (crits are bigger) */
  size: number;
  t: number;
  life: number;
  /** sideways drift in metres over its life */
  vx: number;
  /** how high it arcs, metres */
  rise: number;
  /** item colour swatch drawn before the text */
  swatch?: string;
  /** stacked line, so pops born together don't overlap */
  row: number;
}

/** A flying chunk or droplet: x, y and velocity in texels, z (height) and size in metres. */
export interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  color: string;
  t: number;
  /** leaves a splat where it lands */
  splat: boolean;
}

/** Blood on the ground that lingers. */
export interface Splat {
  x: number;
  y: number;
  r: number;
  seed: number;
  t: number;
  life: number;
  color: string;
}

export interface Burst {
  x: number;
  y: number;
  t: number;
  life: number;
  color: string;
  r: number;
}

const SPLAT_MAX = 140;
const STREAK_WINDOW = 3;

export class Juice {
  /** seconds of hit-stop left; the world (not the player) runs slowed while > 0 */
  hitstop = 0;
  /** 0..1 shake energy; the offset is trauma² × max */
  trauma = 0;
  /** camera kick, in metres, decays quickly */
  kick: Vec2 = { x: 0, y: 0 };
  pops: Pop[] = [];
  parts: Particle[] = [];
  splats: Splat[] = [];
  bursts: Burst[] = [];
  streak = 0;
  streakT = 0;
  bestStreak = 0;
  /** search progress for the ring around the survivor */
  search: { t: number; dur: number } | null = null;
  /** time since the last search finished, for the ring's pop */
  searchDone = 9;
  private groanBudget = 0;
  private seq = 0;

  /** Freeze the action for a moment. Never stacks: long fights don't stutter. */
  stop(sec: number) {
    this.hitstop = Math.max(this.hitstop, Math.min(0.09, sec));
  }

  shake(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Push the camera, metres, in direction (dx, dy). */
  push(dx: number, dy: number, m: number) {
    this.kick.x += dx * m;
    this.kick.y += dy * m;
  }

  /** Current screen-shake offset in metres. */
  shakeOffset(time: number): Vec2 {
    const s = this.trauma * this.trauma * 0.45;
    if (s < 1e-3) return { x: this.kick.x, y: this.kick.y };
    // smooth noise from a few sines so it rattles instead of jitters randomly
    const nx = Math.sin(time * 61.3) * 0.6 + Math.sin(time * 37.1 + 1.7) * 0.4;
    const ny = Math.sin(time * 53.7 + 4.1) * 0.6 + Math.sin(time * 29.3 + 0.3) * 0.4;
    return { x: nx * s + this.kick.x, y: ny * s + this.kick.y };
  }

  pop(x: number, y: number, text: string, color: string, size = 1, life = 0.85, rise = 1.0, swatch?: string) {
    this.seq++;
    const vx = (((this.seq * 7919) % 13) / 13 - 0.5) * 0.9;
    this.pops.push({ x, y, text, color, size, t: 0, life, vx, rise, swatch, row: this.rowAt(x, y) });
    if (this.pops.length > 40) this.pops.shift();
  }

  damage(x: number, y: number, dmg: number, crit: boolean) {
    const n = Math.max(1, Math.round(dmg));
    if (crit) this.pop(x, y, `${n}!`, '#ffd23a', 2, 1.0, 1.4);
    else this.pop(x, y, `${n}`, '#ffffff', 1.4, 0.75, 1.0);
  }

  groan(x: number, y: number, text: string) {
    if (this.groanBudget > 0) return;
    this.groanBudget = 0.6;
    this.pop(x, y, text, '#9be86a', 1, 1.2, 0.6);
  }

  /** Blood spray from a hit, in direction (dx, dy). */
  blood(x: number, y: number, dx: number, dy: number, n: number, rng: () => number, tpm: number) {
    for (let i = 0; i < n; i++) {
      const sp = 1 + rng() * 2.2;
      const a = Math.atan2(dy, dx) + (rng() - 0.5) * 1.4;
      this.parts.push({
        x, y, z: 1.1 + rng() * 0.3, vx: Math.cos(a) * sp * tpm, vy: Math.sin(a) * sp * tpm, vz: 0.5 + rng() * 2,
        size: 0.08 + rng() * 0.08, color: rng() < 0.3 ? '#e0302a' : '#a8141a', t: 0, splat: i % 2 === 0,
      });
    }
    this.cap();
  }

  /** A zombie bursts: chunks, droplets, a big splat and a ring. */
  gore(x: number, y: number, dx: number, dy: number, rng: () => number, tpm: number) {
    for (let i = 0; i < 14; i++) {
      const chunk = i < 6;
      const sp = 1 + rng() * (chunk ? 3 : 5);
      const a = Math.atan2(dy, dx) + (rng() - 0.5) * (chunk ? 3.2 : 2.2);
      this.parts.push({
        x, y, z: 0.6 + rng() * 0.8, vx: Math.cos(a) * sp * tpm, vy: Math.sin(a) * sp * tpm, vz: 2 + rng() * 3,
        size: chunk ? 0.14 + rng() * 0.1 : 0.06 + rng() * 0.06,
        color: chunk ? (rng() < 0.5 ? '#6fbf3a' : '#7a1a1e') : rng() < 0.4 ? '#e0302a' : '#a8141a', t: 0, splat: true,
      });
    }
    this.splat(x, y, 0.55 + rng() * 0.2, rng);
    this.bursts.push({ x, y, t: 0, life: 0.28, color: '#ffffff', r: 1.3 });
    this.cap();
  }

  splat(x: number, y: number, r: number, rng: () => number, color = '#8e1418') {
    this.splats.push({ x, y, r, seed: (rng() * 1e6) | 0, t: 0, life: 45, color });
    if (this.splats.length > SPLAT_MAX) this.splats.shift();
  }

  kill() {
    this.streak = this.streakT > 0 ? this.streak + 1 : 1;
    this.streakT = STREAK_WINDOW;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
  }

  pickup(x: number, y: number, text: string, color: string, i: number) {
    this.pops.push({ x, y, text, color: '#fff3b0', size: 1, t: -i * 0.1, life: 1.6, vx: 0, rise: 1.4, swatch: color, row: i });
  }

  /** The first free line among pops just born at about the same spot. */
  private rowAt(x: number, y: number): number {
    let row = 0;
    for (const p of this.pops) if (p.t < 0.45 && Math.abs(p.x - x) + Math.abs(p.y - y) < 40 && p.row >= row) row = p.row + 1;
    return row % 4;
  }

  private cap() {
    if (this.parts.length > 220) this.parts.splice(0, this.parts.length - 220);
  }

  /** Advance everything. `dt` is the slowed world time; `real` is wall time. */
  update(dt: number, real: number, rng: () => number) {
    this.hitstop = Math.max(0, this.hitstop - real);
    this.trauma = Math.max(0, this.trauma - real * 1.9);
    const kd = Math.exp(-real * 16);
    this.kick.x *= kd;
    this.kick.y *= kd;
    this.groanBudget = Math.max(0, this.groanBudget - real);
    this.searchDone += real;
    if (this.streakT > 0) {
      this.streakT -= real;
      if (this.streakT <= 0) this.streak = 0;
    }
    for (const p of this.pops) p.t += real;
    this.pops = this.pops.filter((p) => p.t < p.life);
    for (const b of this.bursts) b.t += dt;
    this.bursts = this.bursts.filter((b) => b.t < b.life);
    for (const s of this.splats) s.t += real;
    if (this.splats.length && this.splats[0].t > this.splats[0].life) this.splats = this.splats.filter((s) => s.t < s.life);
    const keep: Particle[] = [];
    for (const p of this.parts) {
      p.t += dt;
      p.vz -= 14 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.z <= 0) {
        if (p.splat) this.splat(p.x, p.y, p.size * (2.2 + rng() * 1.5), rng, p.color === '#6fbf3a' ? '#3f6a26' : '#8e1418');
        continue;
      }
      keep.push(p);
    }
    this.parts = keep;
  }
}
