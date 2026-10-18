// Item definitions and loot tables. Container contents are rolled
// deterministically from (world seed, container id) the first time they are
// opened, and only stored once the player changes them.

import { Rng, hashString } from '../core/rng';

export type ItemCategory = 'food' | 'drink' | 'medical' | 'weapon' | 'ammo' | 'misc';

export interface WeaponStats {
  kind: 'melee' | 'gun';
  damage: number;
  /** metres */
  range: number;
  /** seconds between attacks */
  cooldown: number;
  /** metres a zombie can hear it from */
  noise: number;
  ammo?: string;
  knockback?: number;
}

export interface ItemDef {
  id: string;
  name: string;
  cat: ItemCategory;
  stack: number;
  color: string;
  hunger?: number;
  thirst?: number;
  heal?: number;
  weapon?: WeaponStats;
}

export const ITEMS: Record<string, ItemDef> = Object.fromEntries(
  ([
    { id: 'water_bottle', name: 'Water bottle', cat: 'drink', stack: 4, color: '#6fb3d9', thirst: 45 },
    { id: 'soda', name: 'Can of soda', cat: 'drink', stack: 6, color: '#c94b3b', thirst: 25, hunger: 5 },
    { id: 'juice', name: 'Carton of juice', cat: 'drink', stack: 4, color: '#e0a23a', thirst: 30, hunger: 8 },
    { id: 'canned_beans', name: 'Canned beans', cat: 'food', stack: 5, color: '#b5652e', hunger: 35 },
    { id: 'canned_soup', name: 'Canned soup', cat: 'food', stack: 5, color: '#c47a3a', hunger: 30, thirst: 8 },
    { id: 'crisps', name: 'Bag of crisps', cat: 'food', stack: 6, color: '#e3c64a', hunger: 15, thirst: -5 },
    { id: 'chocolate', name: 'Chocolate bar', cat: 'food', stack: 8, color: '#6b3f2a', hunger: 18 },
    { id: 'stroopwafel', name: 'Stroopwafels', cat: 'food', stack: 6, color: '#d39b4d', hunger: 22 },
    { id: 'rice', name: 'Bag of rice', cat: 'food', stack: 3, color: '#ece6d2', hunger: 40, thirst: -10 },
    { id: 'mre', name: 'Military ration', cat: 'food', stack: 3, color: '#6b6a3a', hunger: 60, thirst: 10 },
    { id: 'bandage', name: 'Bandage', cat: 'medical', stack: 8, color: '#e8e2d5', heal: 15 },
    { id: 'painkillers', name: 'Painkillers', cat: 'medical', stack: 6, color: '#d9d9e6', heal: 10 },
    { id: 'first_aid', name: 'First aid kit', cat: 'medical', stack: 2, color: '#c43b3b', heal: 50 },
    { id: 'kitchen_knife', name: 'Kitchen knife', cat: 'weapon', stack: 1, color: '#b8bcc4', weapon: { kind: 'melee', damage: 16, range: 1.0, cooldown: 0.45, noise: 2 } },
    { id: 'hammer', name: 'Claw hammer', cat: 'weapon', stack: 1, color: '#8a6a4a', weapon: { kind: 'melee', damage: 22, range: 1.1, cooldown: 0.6, noise: 3, knockback: 0.3 } },
    { id: 'crowbar', name: 'Crowbar', cat: 'weapon', stack: 1, color: '#7a3030', weapon: { kind: 'melee', damage: 26, range: 1.3, cooldown: 0.7, noise: 3, knockback: 0.5 } },
    { id: 'bat', name: 'Baseball bat', cat: 'weapon', stack: 1, color: '#b08a5a', weapon: { kind: 'melee', damage: 24, range: 1.4, cooldown: 0.65, noise: 3, knockback: 0.8 } },
    { id: 'hockey_stick', name: 'Field hockey stick', cat: 'weapon', stack: 1, color: '#3a6ab0', weapon: { kind: 'melee', damage: 20, range: 1.5, cooldown: 0.55, noise: 3, knockback: 0.6 } },
    { id: 'fire_axe', name: 'Fire axe', cat: 'weapon', stack: 1, color: '#c43b2e', weapon: { kind: 'melee', damage: 45, range: 1.4, cooldown: 0.95, noise: 4, knockback: 0.6 } },
    { id: 'machete', name: 'Machete', cat: 'weapon', stack: 1, color: '#9aa0a6', weapon: { kind: 'melee', damage: 34, range: 1.3, cooldown: 0.6, noise: 2 } },
    { id: 'pistol', name: 'Glock 17', cat: 'weapon', stack: 1, color: '#2e3034', weapon: { kind: 'gun', damage: 55, range: 28, cooldown: 0.35, noise: 70, ammo: 'ammo_9mm' } },
    { id: 'rifle', name: 'Diemaco C7', cat: 'weapon', stack: 1, color: '#3d4030', weapon: { kind: 'gun', damage: 70, range: 45, cooldown: 0.16, noise: 110, ammo: 'ammo_556' } },
    { id: 'ammo_9mm', name: '9mm rounds', cat: 'ammo', stack: 60, color: '#c9a640' },
    { id: 'ammo_556', name: '5.56mm rounds', cat: 'ammo', stack: 90, color: '#a89040' },
    { id: 'batteries', name: 'Batteries', cat: 'misc', stack: 10, color: '#4a4a4a' },
    { id: 'lighter', name: 'Lighter', cat: 'misc', stack: 3, color: '#d94a8a' },
    { id: 'duct_tape', name: 'Duct tape', cat: 'misc', stack: 4, color: '#9a9a9a' },
    { id: 'cash', name: 'Euro notes (worthless)', cat: 'misc', stack: 999, color: '#7aa36a' },
  ] as ItemDef[]).map((d) => [d.id, d]),
);

export interface ItemStack {
  id: string;
  qty: number;
}

type Entry = [id: string, weight: number, min: number, max: number];

interface LootTable {
  rolls: [number, number];
  /** chance the place was already picked clean */
  emptyChance: number;
  entries: Entry[];
}

const FOOD: Entry[] = [['canned_beans', 3, 1, 2], ['canned_soup', 2, 1, 2], ['crisps', 3, 1, 2], ['chocolate', 2, 1, 2], ['stroopwafel', 2, 1, 1], ['rice', 1, 1, 1]];
const DRINK: Entry[] = [['water_bottle', 4, 1, 2], ['soda', 3, 1, 3], ['juice', 2, 1, 1]];
const MED: Entry[] = [['bandage', 4, 1, 3], ['painkillers', 3, 1, 2], ['first_aid', 1, 1, 1]];
const JUNK: Entry[] = [['batteries', 2, 1, 4], ['lighter', 2, 1, 1], ['duct_tape', 1, 1, 1], ['cash', 2, 5, 120]];

export const LOOT: Record<string, LootTable> = {
  house: { rolls: [1, 4], emptyChance: 0.3, entries: [...FOOD, ...DRINK, ['bandage', 2, 1, 2], ['painkillers', 1, 1, 1], ['kitchen_knife', 2, 1, 1], ['hammer', 1, 1, 1], ['bat', 0.6, 1, 1], ['hockey_stick', 0.8, 1, 1], ...JUNK] },
  apartments: { rolls: [2, 6], emptyChance: 0.25, entries: [...FOOD, ...DRINK, ['bandage', 2, 1, 2], ['painkillers', 2, 1, 1], ['kitchen_knife', 2, 1, 1], ['hammer', 0.6, 1, 1], ['bat', 0.4, 1, 1], ...JUNK] },
  grocery: { rolls: [3, 8], emptyChance: 0.45, entries: [...FOOD.map((e) => [e[0], e[1] * 2, e[2], e[3] + 1] as Entry), ...DRINK.map((e) => [e[0], e[1] * 2, e[2], e[3] + 1] as Entry), ['kitchen_knife', 0.5, 1, 1], ['lighter', 1, 1, 2]] },
  pharmacy: { rolls: [2, 6], emptyChance: 0.5, entries: [...MED.map((e) => [e[0], e[1] * 2, e[2], e[3] + 1] as Entry), ['water_bottle', 1, 1, 1]] },
  medical: { rolls: [2, 5], emptyChance: 0.35, entries: [...MED, ['first_aid', 2, 1, 1], ['water_bottle', 1, 1, 1]] },
  hardware: { rolls: [2, 5], emptyChance: 0.3, entries: [['hammer', 3, 1, 1], ['crowbar', 3, 1, 1], ['fire_axe', 1, 1, 1], ['machete', 1, 1, 1], ['duct_tape', 3, 1, 2], ['batteries', 2, 1, 4], ['lighter', 1, 1, 1]] },
  outdoor: { rolls: [2, 5], emptyChance: 0.35, entries: [['machete', 2, 1, 1], ['bat', 2, 1, 1], ['hockey_stick', 2, 1, 1], ['water_bottle', 3, 1, 2], ['mre', 1, 1, 1], ['lighter', 2, 1, 1]] },
  police: { rolls: [2, 5], emptyChance: 0.4, entries: [['pistol', 2, 1, 1], ['ammo_9mm', 5, 6, 24], ['first_aid', 1, 1, 1], ['bandage', 2, 1, 2], ['crowbar', 1, 1, 1]] },
  fire_station: { rolls: [2, 4], emptyChance: 0.25, entries: [['fire_axe', 4, 1, 1], ['first_aid', 2, 1, 1], ['bandage', 2, 1, 3], ['water_bottle', 2, 1, 2]] },
  military: { rolls: [2, 6], emptyChance: 0.2, entries: [['rifle', 1, 1, 1], ['pistol', 1.5, 1, 1], ['ammo_556', 3, 10, 30], ['ammo_9mm', 3, 8, 24], ['mre', 4, 1, 3], ['first_aid', 2, 1, 1], ['water_bottle', 2, 1, 2]] },
  fuel: { rolls: [1, 4], emptyChance: 0.5, entries: [...DRINK, ['crisps', 3, 1, 2], ['chocolate', 3, 1, 2], ['lighter', 2, 1, 1], ['batteries', 1, 1, 2]] },
  food_service: { rolls: [1, 4], emptyChance: 0.4, entries: [...FOOD, ...DRINK, ['kitchen_knife', 2, 1, 1]] },
  shop: { rolls: [1, 4], emptyChance: 0.45, entries: [...JUNK, ['soda', 2, 1, 2], ['chocolate', 2, 1, 1], ['hockey_stick', 0.5, 1, 1]] },
  office: { rolls: [1, 3], emptyChance: 0.4, entries: [['soda', 2, 1, 2], ['crisps', 2, 1, 1], ['first_aid', 0.6, 1, 1], ['painkillers', 1, 1, 1], ['batteries', 1, 1, 2], ['cash', 2, 5, 80]] },
  school: { rolls: [1, 4], emptyChance: 0.3, entries: [['juice', 3, 1, 2], ['crisps', 2, 1, 2], ['hockey_stick', 2, 1, 1], ['bat', 1, 1, 1], ['bandage', 1, 1, 2]] },
  industrial: { rolls: [1, 4], emptyChance: 0.35, entries: [['crowbar', 2, 1, 1], ['hammer', 2, 1, 1], ['duct_tape', 2, 1, 2], ['fire_axe', 0.5, 1, 1], ['water_bottle', 1, 1, 1], ['batteries', 1, 1, 3]] },
  farm: { rolls: [1, 4], emptyChance: 0.25, entries: [['machete', 1, 1, 1], ['fire_axe', 1, 1, 1], ['water_bottle', 2, 1, 2], ['canned_beans', 2, 1, 2], ['rice', 1, 1, 1], ['hammer', 1, 1, 1]] },
  church: { rolls: [0, 2], emptyChance: 0.5, entries: [['water_bottle', 2, 1, 2], ['bandage', 2, 1, 2], ['canned_soup', 2, 1, 1]] },
  garage: { rolls: [0, 3], emptyChance: 0.4, entries: [['crowbar', 1, 1, 1], ['hammer', 1, 1, 1], ['duct_tape', 2, 1, 1], ['batteries', 1, 1, 2]] },
  car: { rolls: [0, 3], emptyChance: 0.35, entries: [['water_bottle', 2, 1, 1], ['soda', 2, 1, 1], ['chocolate', 2, 1, 1], ['crisps', 1, 1, 1], ['bandage', 1, 1, 1], ['first_aid', 0.4, 1, 1], ['batteries', 1, 1, 2], ['crowbar', 0.3, 1, 1], ['cash', 1, 5, 50]] },
  police_car: { rolls: [1, 3], emptyChance: 0.35, entries: [['ammo_9mm', 3, 4, 15], ['pistol', 0.8, 1, 1], ['first_aid', 1, 1, 1], ['bandage', 2, 1, 2]] },
  military_vehicle: { rolls: [1, 4], emptyChance: 0.3, entries: [['ammo_556', 3, 10, 30], ['rifle', 0.7, 1, 1], ['mre', 3, 1, 2], ['water_bottle', 2, 1, 2], ['first_aid', 1, 1, 1]] },
  ambulance: { rolls: [2, 4], emptyChance: 0.3, entries: [...MED, ['first_aid', 2, 1, 1]] },
  corpse: { rolls: [0, 2], emptyChance: 0.4, entries: [['cash', 3, 5, 60], ['chocolate', 1, 1, 1], ['water_bottle', 1, 1, 1], ['bandage', 1, 1, 1], ['kitchen_knife', 0.5, 1, 1], ['lighter', 1, 1, 1]] },
  corpse_soldier: { rolls: [1, 3], emptyChance: 0.2, entries: [['ammo_556', 3, 5, 20], ['ammo_9mm', 2, 4, 12], ['mre', 2, 1, 1], ['rifle', 0.5, 1, 1], ['pistol', 0.5, 1, 1], ['bandage', 1, 1, 2]] },
  corpse_police: { rolls: [1, 3], emptyChance: 0.25, entries: [['ammo_9mm', 3, 4, 15], ['pistol', 0.7, 1, 1], ['bandage', 1, 1, 2]] },
  crate: { rolls: [2, 5], emptyChance: 0.1, entries: [['mre', 3, 1, 3], ['water_bottle', 3, 1, 3], ['ammo_556', 2, 10, 30], ['ammo_9mm', 2, 8, 24], ['first_aid', 2, 1, 1], ['rifle', 0.4, 1, 1]] },
};

/** Map a building class (osm.ts) to a loot table. */
export function buildingLootType(cls: string): string {
  switch (cls) {
    case 'house': case 'residential': return 'house';
    case 'apartments': return 'apartments';
    case 'grocery': case 'supermarket': return 'grocery';
    case 'pharmacy': return 'pharmacy';
    case 'medical': case 'hospital': return 'medical';
    case 'hardware': case 'mechanic': return 'hardware';
    case 'outdoor': return 'outdoor';
    case 'police': return 'police';
    case 'fire_station': return 'fire_station';
    case 'military': return 'military';
    case 'fuel': return 'fuel';
    case 'food_service': return 'food_service';
    case 'shop': case 'retail': case 'commercial': return 'shop';
    case 'office': case 'civic': return 'office';
    case 'school': return 'school';
    case 'industrial': case 'warehouse': return 'industrial';
    case 'farm': case 'greenhouse': return 'farm';
    case 'church': return 'church';
    case 'garage': case 'shed': return 'garage';
    default: return 'house';
  }
}

export function rollLoot(worldSeed: number, containerId: string, type: string, scavenged = 0): ItemStack[] {
  const table = LOOT[type] ?? LOOT.house;
  const rng = new Rng(hashString(containerId) ^ worldSeed);
  if (rng.chance(Math.min(0.9, table.emptyChance + scavenged * 0.25))) return [];
  const rolls = rng.int(table.rolls[0], table.rolls[1]);
  const out = new Map<string, number>();
  for (let i = 0; i < rolls; i++) {
    const e = rng.weighted(table.entries.map((en) => [en, en[1]] as const));
    out.set(e[0], (out.get(e[0]) ?? 0) + rng.int(e[2], e[3]));
  }
  return [...out].map(([id, qty]) => ({ id, qty }));
}

export function itemName(id: string): string {
  return ITEMS[id]?.name ?? id;
}
