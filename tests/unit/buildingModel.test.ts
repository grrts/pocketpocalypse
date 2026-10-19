import { describe, expect, it } from 'vitest';
import { sampleBuildings } from './buildingSamples';
import {
  buildModel, coverageOf, groupRows, outerSpans, sideLength, toWorld,
  type BuildingModel, type ModelInput,
} from '../../src/world/buildingModel';

// ---------------------------------------------------------------- synthetic footprints

const TPM = 2.7;
let nextId = 0;
/** A footprint given in metres (x east, y south) as a world-texel input; the door on the south side by default. */
function input(pts: number[], door: [number, number, number, number], cls = 'house', id = `t${nextId++}`): ModelInput {
  const ring = pts.map((v) => v * TPM + 100000);
  ring.push(ring[0], ring[1]);
  return { id, rings: [ring], cls, seed: 12345, burnt: false, tpm: TPM, door: { x: door[0] * TPM + 100000, y: door[1] * TPM + 100000, nx: door[2], ny: door[3] } };
}
const rect = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1];
const ridgeWorldDir = (m: BuildingModel, wi = 0): [number, number] => (m.wings[wi].ridgeAlongS ? [m.ux, m.uy] : [-m.uy, m.ux]);

describe('building model of simple footprints', () => {
  it('turns a rectangle into one wing that matches it', () => {
    const m = buildModel(input(rect(0, 0, 10, 8), [5, 8, 0, 1]))!;
    expect(m.wings.length).toBe(1);
    const c = coverageOf(m);
    expect(c.cover).toBeGreaterThan(0.99);
    expect(c.over).toBeLessThan(0.01);
  });

  it('squares up a slightly crooked outline and an L', () => {
    const crooked = buildModel(input([0, 0, 10, 0.3, 9.8, 8.2, -0.2, 8], [5, 8, 0, 1]))!;
    expect(crooked.wings.length).toBe(1);
    const L = buildModel(input([0, 0, 12, 0, 12, 6, 5, 6, 5, 12, 0, 12], [6, 0, 0, -1]))!;
    expect(L.wings.length).toBe(2);
    const c = coverageOf(L);
    expect(c.cover).toBeGreaterThan(0.98);
    expect(c.over).toBeLessThan(0.02);
  });

  it('drops slivers instead of making thin wings', () => {
    // a 0.6 m deep bay on a house
    const m = buildModel(input([0, 0, 10, 0, 10, 8, 6.5, 8, 6.5, 8.6, 3.5, 8.6, 3.5, 8, 0, 8], [5, 8.6, 0, 1]))!;
    expect(m.wings.length).toBe(1);
    for (const w of m.wings) expect(Math.min(w.box.s1 - w.box.s0, w.box.d1 - w.box.d0)).toBeGreaterThanOrEqual(1.5);
  });

  it('puts a detached house under a roof that suits it, the door on the street side', () => {
    const m = buildModel(input(rect(0, 0, 12, 7), [6, 7, 0, 1]))!;
    expect(m.type).toBe('detached');
    expect(m.wings[0].roof).toBe('gable');
    // ridge along the long side, rise about half the span
    const [rx] = ridgeWorldDir(m);
    expect(Math.abs(rx)).toBeGreaterThan(0.99);
    expect(m.wings[0].roofH).toBeGreaterThan(7 * 0.4);
    expect(m.wings[0].roofH).toBeLessThan(7 * 0.6);
    const door = m.openings.find((o) => o.kind === 'door')!;
    const b = m.wings[door.wing].box;
    const along = door.side === 0 || door.side === 2;
    const [, y] = along ? toWorld(m, b.s0 + door.at, door.side === 0 ? b.d0 : b.d1) : toWorld(m, door.side === 1 ? b.s1 : b.s0, b.d0 + door.at);
    expect(Math.abs((y - 100000) / TPM - 7)).toBeLessThan(0.3);
  });

  it('gives a square detached house a hip roof and a big box a flat one', () => {
    expect(buildModel(input(rect(0, 0, 9, 8.5), [4, 8.5, 0, 1]))!.wings[0].roof).toBe('hip');
    const hall = buildModel(input(rect(0, 0, 60, 40), [30, 40, 0, 1], 'industrial'))!;
    expect(hall.type).toBe('hall');
    expect(hall.wings[0].roof).toBe('flat');
  });

  it('makes a terrace of touching houses into one row with one roof line', () => {
    // five 5.5 m wide houses along a street to the south, the middle one a little deeper
    const houses = [0, 1, 2, 3, 4].map((i) => input(rect(i * 5.5, 0, (i + 1) * 5.5, i === 2 ? 10.4 : 10), [i * 5.5 + 1, 10, 0, 1], 'house', `row${i}`));
    const models = houses.map((h) => buildModel(h)!);
    groupRows(models);
    const row = models[0].row;
    expect(row).not.toBe('');
    for (const m of models) {
      expect(m.row).toBe(row);
      expect(m.type).toBe('terrace');
      // the ridge runs along the street
      expect(Math.abs(ridgeWorldDir(m)[0])).toBeGreaterThan(0.99);
      expect(m.wings[0].wallH).toBe(models[0].wings[0].wallH);
      expect(m.wings[0].roofH).toBeCloseTo(models[0].wings[0].roofH, 5);
      expect(m.style).toBe(models[0].style);
    }
    // party walls exactly on the shared walls: neighbours' wings meet without gap or overlap
    for (let i = 0; i + 1 < models.length; i++) {
      const a = models[i], b = models[i + 1];
      const xs = (m: BuildingModel) => { const b = m.wings[0].box; return [[b.s0, b.d0], [b.s1, b.d0], [b.s1, b.d1], [b.s0, b.d1]].map(([s, d]) => toWorld(m, s, d)[0]); };
      const ea = Math.max(...xs(a)), eb = Math.min(...xs(b));
      expect(Math.abs(ea - eb) / TPM).toBeLessThan(0.05);
    }
    // inner houses have party walls on both sides and no windows there
    for (const m of models.slice(1, -1)) {
      const party = m.wings[0].party!;
      expect(party.filter(Boolean).length).toBe(2);
      for (const o of m.openings) expect(party[o.side] && o.wing === 0).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- real buildings

const infos = sampleBuildings();
const inputs: ModelInput[] = infos.map((b) => ({ id: b.id, rings: b.rings, cls: b.cls, seed: b.seed, burnt: b.burnt, tpm: b.tpm, door: b.door }));
const built = inputs.map((i) => buildModel(i)).filter((m): m is BuildingModel => !!m);
const grouped = built.slice();
groupRows(grouped);

const overlaps = (a: BuildingModel['wings'][0]['box'], b: BuildingModel['wings'][0]['box']) =>
  Math.min(a.s1, b.s1) - Math.max(a.s0, b.s0) > 1e-6 && Math.min(a.d1, b.d1) - Math.max(a.d0, b.d0) > 1e-6;

describe('building models of real Utrecht buildings', () => {
  it('builds a model for nearly every footprint', () => {
    expect(inputs.length).toBeGreaterThan(800);
    expect(built.length).toBeGreaterThan(inputs.length * 0.98);
  });

  it('covers the real footprints closely with a few clean wings', () => {
    let A = 0, cov = 0, over = 0, wings = 0, poor = 0;
    for (const m of grouped) {
      const c = coverageOf(m);
      A += c.area; cov += c.cover * c.area; over += c.over * c.area; wings += m.wings.length;
      if (c.cover < 0.85 || c.over > 0.15) poor++;
    }
    expect(cov / A).toBeGreaterThan(0.93);
    expect(over / A).toBeLessThan(0.06);
    expect(poor / grouped.length).toBeLessThan(0.1);
    expect(wings / grouped.length).toBeLessThan(2);
  });

  it('draws wings that do not overlap, with no slivers, on a 25 cm grid', () => {
    const bad: string[] = [];
    for (const m of built) {
      m.wings.forEach((w, i) => {
        const lo = Math.min(w.box.s1 - w.box.s0, w.box.d1 - w.box.d0);
        if (lo < 0.6) bad.push(`${m.id} wing ${i} ${lo.toFixed(2)} m thin`);
        for (const v of [w.box.s0, w.box.s1, w.box.d0, w.box.d1]) if (m.radius === undefined && Math.abs(v / 0.25 - Math.round(v / 0.25)) > 1e-6) bad.push(`${m.id} off grid ${v}`);
        for (let j = i + 1; j < m.wings.length; j++) if (overlaps(w.box, m.wings[j].box)) bad.push(`${m.id} wings ${i} ${j} overlap`);
      });
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('keeps wing roofs under the main ridge and flat roofs flat', () => {
    const bad: string[] = [];
    for (const m of grouped) {
      const top = m.wings[0].wallH + m.wings[0].roofH;
      m.wings.forEach((w, i) => {
        if (w.roof === 'flat' && w.roofH !== 0) bad.push(`${m.id} flat with rise`);
        if (i > 0 && (w.roof === 'gable' || w.roof === 'hip') && w.wallH + w.roofH > top + 1e-6) bad.push(`${m.id} wing ${i} above the main ridge`);
        if (w.wallH < 2 || w.wallH > 200) bad.push(`${m.id} wall ${w.wallH}`);
      });
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('gives every building a door on an outside wall, and windows clear of corners, doors and each other', () => {
    const bad: string[] = [];
    for (const m of grouped) {
      const doors = m.openings.filter((o) => o.kind === 'door' || o.kind === 'garage');
      if (!doors.length && m.type !== 'canopy' && m.type !== 'tank') bad.push(`${m.id} ${m.type} has no door`);
      for (const o of m.openings) {
        const spans = outerSpans(m, o.wing, o.side);
        const L = sideLength(m.wings[o.wing].box, o.side);
        if (o.at - o.w / 2 < -1e-6 || o.at + o.w / 2 > L + 1e-6) bad.push(`${m.id} ${o.kind} off its wall`);
        if (o.kind !== 'shopfront' && !spans.some(([a, b]) => o.at >= a - 1e-6 && o.at <= b + 1e-6)) bad.push(`${m.id} ${o.kind} on an inner or party wall`);
      }
      const wins = m.openings.filter((o) => o.kind === 'window');
      for (let i = 0; i < wins.length; i++) for (let j = i + 1; j < wins.length; j++) {
        const a = wins[i], b = wins[j];
        if (a.wing === b.wing && a.side === b.side && a.storey === b.storey && Math.abs(a.at - b.at) < (a.w + b.w) / 2) bad.push(`${m.id} windows overlap`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('finds terraces and finishes each row as one', () => {
    const rows = new Map<string, BuildingModel[]>();
    for (const m of grouped) if (m.row) { if (!rows.has(m.row)) rows.set(m.row, []); rows.get(m.row)!.push(m); }
    expect(rows.size).toBeGreaterThan(30);
    const bad: string[] = [];
    for (const [id, ms] of rows) {
      if (ms.length < 2) bad.push(`${id} has one member`);
      for (const m of ms) {
        if (Math.abs(m.ux - ms[0].ux) > 1e-9 || Math.abs(m.uy - ms[0].uy) > 1e-9) bad.push(`${id} frames differ`);
        if (m.style !== ms[0].style) bad.push(`${id} styles differ`);
        const pitched = (x: BuildingModel) => x.wings[0].roof !== 'flat' && x.wings[0].roof !== 'shed';
        if (pitched(m) && pitched(ms[0]) && m.type === ms[0].type && m.wings[0].ridgeAlongS !== ms[0].wings[0].ridgeAlongS) bad.push(`${id} ridges differ`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('is deterministic and does not depend on the order of the buildings', () => {
    const again = inputs.map((i) => buildModel(i)).filter((m): m is BuildingModel => !!m);
    const shuffled = again.slice().reverse();
    groupRows(shuffled);
    const byId = new Map(shuffled.map((m) => [m.id, JSON.stringify(m)]));
    let diff = 0;
    for (const m of grouped) if (byId.get(m.id) !== JSON.stringify(m)) diff++;
    expect(diff).toBe(0);
  });

  it('agrees with itself across an area edge for buildings well inside the area', () => {
    // group a window of the sample; buildings 60 m inside its edge must come out as in the whole
    const tpm = grouped[0].tpm;
    const xs = grouped.map((m) => m.ox).sort((a, b) => a - b);
    const ys = grouped.map((m) => m.oy).sort((a, b) => a - b);
    const cx = xs[xs.length >> 1], cy = ys[ys.length >> 1], R = 150 * tpm, inner = 90 * tpm;
    const part = inputs.filter((i) => Math.abs(i.rings[0][0] - cx) < R && Math.abs(i.rings[0][1] - cy) < R).map((i) => buildModel(i)!).filter(Boolean);
    groupRows(part);
    const whole = new Map(grouped.map((m) => [m.id, m]));
    let n = 0, same = 0;
    for (const m of part) {
      const src = m.src!.rings[0];
      if (Math.abs(src[0] - cx) > inner || Math.abs(src[1] - cy) > inner) continue;
      n++;
      if (JSON.stringify(m) === JSON.stringify(whole.get(m.id))) same++;
    }
    expect(n).toBeGreaterThan(50);
    expect(same / n).toBeGreaterThan(0.97);
  });

  it('is quick', () => {
    const t0 = performance.now();
    const ms = inputs.map((i) => buildModel(i)).filter((m): m is BuildingModel => !!m);
    groupRows(ms);
    const per = (performance.now() - t0) / inputs.length;
    // well under a millisecond per building, also on a slow test machine
    expect(per).toBeLessThan(0.6);
  });
});
