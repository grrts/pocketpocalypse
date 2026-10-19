// The apocalypse's history. One global outbreak reaches the country through
// its airports, ports and borders, then spreads city to city (gravity model)
// until each city collapses. The result is computed once per world and frozen
// for single-player; a multiplayer server would keep advancing it.

import { lonLatDistanceM } from '../core/geo';
import { Rng } from '../core/rng';
import type { CountryProfile } from '../country/profile';
import type { CityInfo } from '../data/types';

export type CityFate = 'overrun' | 'quarantine-fell' | 'evacuated' | 'burned';

export interface CityHistory {
  name: string;
  lon: number;
  lat: number;
  pop: number;
  infectedDay: number;
  declaredDay: number;
  collapseDay: number;
  fate: CityFate;
  military: number;
  evacuation: number;
  fire: number;
  /** undead density factor 0..1 */
  intensity: number;
}

export interface OutbreakHistory {
  version: 1;
  seed: number;
  strain: string;
  origin: string;
  /** Days between the first global case and the first case in this country */
  arrivalDay: number;
  /** "Now", in days since the first case in the country. Frozen in single-player. */
  presentDay: number;
  entry: string;
  cities: CityHistory[];
  timeline: { day: number; text: string }[];
}

const ORIGINS = ['Lagos', 'Mumbai', 'Jakarta', 'Guangzhou', 'Mexico City', 'São Paulo', 'Karachi', 'Manila', 'Cairo', 'Dhaka'];
const STRAINS = ['Grey Fever', 'Lethe Syndrome', 'Ashen Rabies', 'Hollow Flu', 'Rot Measles', 'Pale Sleep'];

export function simulateOutbreak(seed: number, country: CountryProfile, citiesIn: CityInfo[], presentDay = 75): OutbreakHistory {
  const rng = new Rng(seed ^ 0x5eed);
  const cities = citiesIn.slice(0, 400);
  const n = cities.length;
  const origin = rng.pick(ORIGINS);
  const strain = rng.pick(STRAINS);
  const arrivalDay = rng.int(9, 18);

  // Static per-city traits
  const military = new Float64Array(n);
  const fireProne = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = cities[i];
    let m = rng.next() * 0.35 + Math.min(0.35, Math.log10(Math.max(1, c.pop / 20000)) * 0.25);
    for (const b of country.militaryBases) {
      const d = lonLatDistanceM(c, b) / 1000;
      if (d < 25) m += 0.45 * (1 - d / 25);
    }
    military[i] = Math.min(1, m);
    fireProne[i] = rng.next() * 0.6 + Math.min(0.4, c.pop / 1_500_000);
  }

  // Pairwise coupling (gravity model)
  const coupling: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const row = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = lonLatDistanceM(cities[i], cities[j]) / 1000;
      row[j] = (Math.pow(cities[i].pop, 0.55) * Math.pow(cities[j].pop, 0.25)) / Math.pow(d + 8, 2.1);
    }
    coupling.push(row);
  }

  const I = new Float64Array(n);
  const infectedDay = new Float64Array(n).fill(Infinity);
  const declaredDay = new Float64Array(n).fill(Infinity);
  const collapseDay = new Float64Array(n).fill(Infinity);
  const timeline: { day: number; text: string }[] = [];

  // Seed the entry point
  const entry = rng.weighted(country.entryPoints.map((e) => [e, e.weight] as const));
  const nearest = (p: { lon: number; lat: number }) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = lonLatDistanceM(p, cities[i]);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const first = nearest(entry);
  I[first] = 2e-4;
  infectedDay[first] = 0;
  timeline.push({ day: 0, text: `First confirmed case of ${strain} near ${entry.name}.` });
  // Secondary importations through other entry points over the first two weeks
  for (const e of country.entryPoints) {
    if (e === entry) continue;
    if (rng.chance(Math.min(0.9, e.weight / 4))) {
      const k = nearest(e);
      const d = rng.int(3, 16);
      if (infectedDay[k] > d) infectedDay[k] = -d; // negative = scheduled import
    }
  }

  const beta = 0.42 + rng.next() * 0.1;
  for (let day = 0; day <= presentDay; day++) {
    for (let i = 0; i < n; i++) {
      if (infectedDay[i] < 0 && -infectedDay[i] === day) {
        I[i] = Math.max(I[i], 2e-4);
        infectedDay[i] = day;
      }
    }
    const next = Float64Array.from(I);
    for (let j = 0; j < n; j++) {
      if (I[j] === 0) {
        let force = 0;
        for (let i = 0; i < n; i++) if (I[i] > 0) force += coupling[i][j] * I[i];
        if (rng.next() < 1 - Math.exp(-force * 0.9)) {
          next[j] = 1e-4;
          infectedDay[j] = day;
        }
      } else {
        // military response slows growth while the city still holds
        const damp = day < collapseDay[j] && declaredDay[j] < day ? 1 - military[j] * 0.45 : 1;
        next[j] = Math.min(1, I[j] + beta * damp * I[j] * (1 - I[j]));
      }
      const c = cities[j];
      if (next[j] > 0.01 && declaredDay[j] === Infinity) {
        declaredDay[j] = day;
        if (c.pop > 120000) timeline.push({ day, text: `Emergency declared in ${c.name}.` });
      }
      const threshold = 0.3 + military[j] * 0.45;
      if (next[j] > threshold && collapseDay[j] === Infinity) {
        collapseDay[j] = day;
        if (c.pop > 120000) timeline.push({ day, text: `${c.name} has fallen.` });
      }
    }
    I.set(next);
  }

  const result: CityHistory[] = cities.map((c, i) => {
    const declared = Math.min(declaredDay[i], presentDay);
    const collapse = Math.min(collapseDay[i], presentDay);
    const gap = Math.max(0, collapse - declared);
    const evacuation = Math.min(1, gap / 12) * (0.5 + 0.5 * rng.next());
    const fire = Math.min(1, fireProne[i] * (0.5 + (presentDay - collapse) / 60));
    let fate: CityFate = 'overrun';
    if (military[i] > 0.62) fate = 'quarantine-fell';
    else if (evacuation > 0.6) fate = 'evacuated';
    else if (fire > 0.7) fate = 'burned';
    const intensity = Math.min(1, 0.35 + Math.log10(Math.max(1, c.pop / 5000)) * 0.25) * (1 - evacuation * 0.35);
    return {
      name: c.name, lon: c.lon, lat: c.lat, pop: c.pop,
      infectedDay: Math.min(infectedDay[i] === Infinity ? presentDay : infectedDay[i], presentDay),
      declaredDay: declared, collapseDay: collapse, fate, military: military[i], evacuation, fire, intensity,
    };
  });
  timeline.sort((a, b) => a.day - b.day);
  const fallen = result.filter((c) => c.collapseDay < presentDay).length;
  timeline.push({ day: presentDay, text: `Day ${presentDay}. ${fallen} of ${n} towns have fallen. You are alone.` });

  return { version: 1, seed, strain, origin, arrivalDay, presentDay, entry: entry.name, cities: result, timeline };
}

export interface RegionState {
  city: CityHistory | null;
  distanceKm: number;
  /** 0..1, how urban/close to a city centre this point is */
  urban: number;
  /** undead density factor */
  intensity: number;
  daysSinceCollapse: number;
  evacuation: number;
  military: number;
  fire: number;
}

/** Interpolated state of the world at a location, derived from the city histories. */
export function regionStateAt(h: OutbreakHistory, lon: number, lat: number): RegionState {
  let best: CityHistory | null = null;
  let bestScore = -1, bestD = Infinity, urban = 0;
  let military = 0, fire = 0, evac = 0;
  for (const c of h.cities) {
    const dKm = lonLatDistanceM({ lon, lat }, c) / 1000;
    const r = 1.2 + 3.2 * Math.sqrt(c.pop / 100000);
    const w = Math.exp(-dKm / r);
    const score = w * Math.pow(c.pop, 0.3);
    if (score > bestScore) { bestScore = score; best = c; bestD = dKm; }
    urban = Math.max(urban, w);
    military = Math.max(military, c.military * Math.exp(-dKm / (r * 1.6)));
    fire = Math.max(fire, c.fire * w);
    evac = Math.max(evac, c.evacuation * Math.exp(-dKm / 18));
  }
  const city = best;
  const intensity = Math.min(1, 0.12 + (city ? city.intensity * urban : 0));
  const daysSinceCollapse = city ? Math.max(0, h.presentDay - city.collapseDay) : h.presentDay;
  return { city, distanceKm: bestD, urban, intensity, daysSinceCollapse, evacuation: evac, military, fire };
}
