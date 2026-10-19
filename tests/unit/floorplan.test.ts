import { describe, expect, it } from 'vitest';
import { sampleBuildings } from './buildingSamples';
import { buildInterior, floorPlanOf } from '../../src/world/interior';
import { boxArea, boxD, boxW, mainPart, roomFits, sharedSegs, type Box } from '../../src/world/floorplan';
import { ringArea } from '../../src/core/geo';

// real buildings around Utrecht centre and a residential street
const buildings = sampleBuildings();
const plans = buildings.map((b) => ({ b, ...floorPlanOf(b)! }));

const overlap = (a: Box, b: Box) => Math.min(a.s1, b.s1) - Math.max(a.s0, b.s0) > 1e-6 && Math.min(a.d1, b.d1) - Math.max(a.d0, b.d0) > 1e-6;

function distToOutline(rings: number[][], s: number, d: number): number {
  let best = Infinity;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = r[j * 2], ay = r[j * 2 + 1], bx = r[i * 2], by = r[i * 2 + 1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((s - ax) * dx + (d - ay) * dy) / l2));
      best = Math.min(best, Math.hypot(s - ax - t * dx, d - ay - t * dy));
    }
  }
  return best;
}

describe('floor plans of real buildings', () => {
  it('covers every kind of building in the sample', () => {
    expect(plans.length).toBeGreaterThan(800);
    const cls = new Set(plans.map((p) => p.b.cls));
    for (const c of ['house', 'apartments', 'school', 'shop', 'industrial', 'church']) expect(cls.has(c), c).toBe(true);
  });

  it('gives every room at least the minimum size for its use, and no slivers', () => {
    const bad: string[] = [];
    for (const { b, plan } of plans) {
      for (const r of plan.rooms) {
        const m = mainPart(r.parts);
        const lo = Math.min(boxW(m), boxD(m)), hi = Math.max(boxW(m), boxD(m));
        // a building too small for a programme is one open room; even then no slivers
        if (r.kind !== 'hall' && hi / lo > 4 + 1e-6) bad.push(`${b.id} ${r.kind} sliver ${boxW(m).toFixed(1)}x${boxD(m).toFixed(1)}`);
        if (!r.free && !roomFits(r.kind, r.parts)) bad.push(`${b.id} ${r.kind} ${boxW(m).toFixed(1)}x${boxD(m).toFixed(1)}`);
        for (const p of r.parts) if (Math.min(boxW(p), boxD(p)) < 0.8) bad.push(`${b.id} ${r.kind} part ${boxW(p).toFixed(2)}x${boxD(p).toFixed(2)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('only uses open rooms for buildings too small for anything else', () => {
    let free = 0, rooms = 0;
    for (const { plan } of plans) for (const r of plan.rooms) { rooms++; if (r.free) free++; }
    expect(free / rooms).toBeLessThan(0.08);
  });

  it('lays rooms out without overlaps, inside the footprint', () => {
    const bad: string[] = [];
    for (const { b, plan, rings } of plans) {
      const parts = plan.rooms.flatMap((r) => r.parts);
      const ext = plan.rooms.flatMap((r) => r.ext);
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (overlap(parts[i], parts[j])) bad.push(`${b.id} parts ${i} ${j}`);
      for (let i = 0; i < ext.length; i++) for (let j = i + 1; j < ext.length; j++) if (overlap(ext[i], ext[j])) bad.push(`${b.id} ext ${i} ${j}`);
      // the rooms proper cover most of the floor; the rest is rooms reaching out to slanted walls
      const area = Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((t, r) => t + Math.abs(ringArea(r)), 0);
      const covered = parts.reduce((t, p) => t + boxArea(p), 0);
      if (covered > area * 1.02) bad.push(`${b.id} rooms bigger than the building`);
    }
    expect(bad).toEqual([]);
  });

  it('connects every room to the front door through doors clear of the corners', () => {
    const bad: string[] = [];
    for (const { b, plan } of plans) {
      const roots = plan.rooms.filter((r) => r.parent < 0).length;
      if (roots !== 1) bad.push(`${b.id} has ${roots} rooms behind the front door`);
      plan.rooms.forEach((r, i) => {
        // follow doors back to the front door
        let k = i, steps = 0;
        while (k >= 0 && steps++ < plan.rooms.length) k = plan.rooms[k].parent;
        if (k >= 0) bad.push(`${b.id} room ${i} loops`);
        if (r.parent < 0) return;
        const d = plan.doors.find((d) => d.a === i);
        if (!d) { bad.push(`${b.id} ${r.kind} has no door`); return; }
        // the door sits in a wall the two rooms share, 0.3 m or more from its ends
        const segs = sharedSegs(r.parts, plan.rooms[r.parent].parts);
        const ok = segs.some((s) => s.along === d.along && Math.abs((d.along === 0 ? d.d : d.s) - s.c) < 1e-6 &&
          (d.along === 0 ? d.s : d.d) - d.w / 2 >= s.a + 0.3 - 1e-6 && (d.along === 0 ? d.s : d.d) + d.w / 2 <= s.b - 0.3 + 1e-6);
        if (!ok) bad.push(`${b.id} ${r.kind} door off its wall`);
        if (d.w < 0.6) bad.push(`${b.id} ${r.kind} door ${d.w.toFixed(2)} wide`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('builds straight walls that end at another wall or the outer wall', () => {
    const bad: string[] = [];
    for (const { b, plan, rings } of plans) {
      const w = plan.walls;
      for (let i = 0; i < w.length; i += 4) {
        if (Math.abs(w[i] - w[i + 2]) > 1e-6 && Math.abs(w[i + 1] - w[i + 3]) > 1e-6) bad.push(`${b.id} slanted wall`);
        for (const e of [0, 2]) {
          const s = w[i + e], d = w[i + e + 1];
          if (distToOutline(rings, s, d) < 0.06) continue;
          // meets another wall
          let met = false;
          for (let j = 0; j < w.length && !met; j += 4) {
            if (j === i) continue;
            const s0 = Math.min(w[j], w[j + 2]), s1 = Math.max(w[j], w[j + 2]), d0 = Math.min(w[j + 1], w[j + 3]), d1 = Math.max(w[j + 1], w[j + 3]);
            if (s >= s0 - 0.02 && s <= s1 + 0.02 && d >= d0 - 0.02 && d <= d1 + 0.02) met = true;
          }
          if (!met) bad.push(`${b.id} wall ends in a room at ${s.toFixed(2)},${d.toFixed(2)}`);
        }
      }
    }
    expect(bad.length, bad.slice(0, 10).join('\n')).toBeLessThan(plans.length * 0.01);
  });

  it('plans each building type sensibly', () => {
    const kinds = (cls: string) => {
      const out = new Map<string, number>();
      for (const { b, plan } of plans) if (b.cls === cls) for (const r of plan.rooms) out.set(r.kind, (out.get(r.kind) ?? 0) + 1);
      return out;
    };
    const school = kinds('school');
    expect(school.get('class')!).toBeGreaterThan(30);
    expect(school.get('hall')!).toBeGreaterThan(10);
    expect(school.get('toilet')!).toBeGreaterThan(5);
    const house = kinds('house');
    for (const k of ['hall', 'living', 'kitchen', 'toilet']) expect(house.get(k)!, k).toBeGreaterThan(50);
    const flats = kinds('apartments');
    for (const k of ['hall', 'living', 'bath', 'bed']) expect(flats.get(k)!, k).toBeGreaterThan(50);
    const shop = kinds('shop');
    expect(shop.get('store')!).toBeGreaterThan(15);
    expect(shop.get('toilet')!).toBeGreaterThan(15);
  });

  it('is quick enough to build insides on the main thread', () => {
    const big = [...buildings].sort((a, c) => Math.abs(ringArea(c.rings[0])) - Math.abs(ringArea(a.rings[0]))).slice(0, 8);
    for (const b of big) buildInterior(b.rings, b.cls, b.door, b.seed, b.tpm);
    let worst = 0, worstPlan = 0;
    for (const b of big) {
      let t = performance.now();
      floorPlanOf(b);
      worstPlan = Math.max(worstPlan, performance.now() - t);
      t = performance.now();
      buildInterior(b.rings, b.cls, b.door, b.seed, b.tpm);
      worst = Math.max(worst, performance.now() - t);
    }
    expect(worstPlan).toBeLessThan(15);
    expect(worst).toBeLessThan(150);
  });
});
