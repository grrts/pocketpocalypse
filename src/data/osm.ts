// OpenStreetMap tag -> game feature classification. Kept free of any data
// source specifics so it applies to Overpass responses and to baked tiles alike.

import type { AreaKind, LineKind } from './types';

export type Tags = Record<string, string>;

export interface AreaClass {
  kind: AreaKind;
  cls: string;
}

export interface LineClass {
  kind: LineKind;
  cls: string;
  width: number;
}

const LANDUSE: Record<string, string> = {
  residential: 'residential', garages: 'industrial',
  commercial: 'commercial', retail: 'commercial', education: 'commercial', religious: 'commercial',
  industrial: 'industrial', port: 'industrial', depot: 'industrial',
  construction: 'construction', brownfield: 'construction', landfill: 'construction', quarry: 'construction',
  farmland: 'farm', greenhouse_horticulture: 'farm', plant_nursery: 'farm', vineyard: 'farm', farmyard: 'farmyard',
  orchard: 'orchard', meadow: 'grass', grass: 'grass', village_green: 'grass', recreation_ground: 'grass',
  flowerbed: 'park', forest: 'forest', cemetery: 'cemetery', military: 'military', railway: 'rail',
  allotments: 'allotments',
};

const NATURAL: Record<string, string> = {
  wood: 'forest', scrub: 'scrub', heath: 'scrub', grassland: 'grass', wetland: 'wetland',
  sand: 'sand', beach: 'beach', dune: 'sand', bare_rock: 'sand', scree: 'sand', shingle: 'beach',
};

const LEISURE: Record<string, string> = {
  park: 'park', garden: 'park', playground: 'park', dog_park: 'park', pitch: 'pitch',
  golf_course: 'grass', sports_centre: 'pitch', stadium: 'pitch', track: 'pitch', common: 'grass',
};

const AMENITY_AREA: Record<string, string> = {
  parking: 'parking', school: 'commercial', university: 'commercial', college: 'commercial',
  hospital: 'commercial', grave_yard: 'cemetery', kindergarten: 'commercial',
};

/** Surface draw order: later entries paint over earlier ones. */
export const SURFACE_ORDER = [
  'farm', 'farmyard', 'orchard', 'grass', 'residential', 'commercial', 'industrial', 'construction',
  'military', 'rail', 'allotments', 'scrub', 'wetland', 'sand', 'beach', 'forest', 'cemetery', 'park', 'pitch', 'parking',
];

const BUILDING: Record<string, string> = {
  house: 'house', detached: 'house', semidetached_house: 'house', terrace: 'house', bungalow: 'house',
  residential: 'residential', apartments: 'apartments', dormitory: 'apartments',
  commercial: 'commercial', office: 'office', retail: 'retail', supermarket: 'supermarket', kiosk: 'retail',
  industrial: 'industrial', warehouse: 'warehouse', factory: 'industrial', manufacture: 'industrial',
  church: 'church', chapel: 'church', cathedral: 'church', mosque: 'church', religious: 'church',
  school: 'school', university: 'school', college: 'school', kindergarten: 'school',
  hospital: 'hospital', clinic: 'hospital',
  civic: 'civic', public: 'civic', government: 'civic', townhall: 'civic', train_station: 'civic', transportation: 'civic',
  fire_station: 'fire_station', police: 'police', military: 'military',
  farm: 'farm', barn: 'farm', farm_auxiliary: 'farm', stable: 'farm', greenhouse: 'greenhouse',
  garage: 'garage', garages: 'garage', carport: 'garage', shed: 'shed', hut: 'shed', roof: 'shed',
  service: 'shed', hotel: 'apartments', parking: 'garage',
};

/** Building class refined by the amenity/shop that occupies it. */
export function poiClass(tags: Tags): string | null {
  const shop = tags.shop;
  if (shop) {
    if (shop === 'supermarket' || shop === 'convenience' || shop === 'bakery' || shop === 'butcher' || shop === 'greengrocer') return 'grocery';
    if (shop === 'chemist' || shop === 'pharmacy' || shop === 'medical_supply') return 'pharmacy';
    if (shop === 'hardware' || shop === 'doityourself' || shop === 'trade' || shop === 'garden_centre') return 'hardware';
    if (shop === 'outdoor' || shop === 'sports') return 'outdoor';
    if (shop === 'car_repair' || shop === 'car' || shop === 'car_parts') return 'mechanic';
    return 'shop';
  }
  switch (tags.amenity) {
    case 'pharmacy': return 'pharmacy';
    case 'hospital': case 'clinic': case 'doctors': case 'dentist': return 'medical';
    case 'police': return 'police';
    case 'fire_station': return 'fire_station';
    case 'fuel': return 'fuel';
    case 'restaurant': case 'cafe': case 'fast_food': case 'bar': case 'pub': return 'food_service';
    case 'school': case 'college': case 'university': case 'kindergarten': return 'school';
  }
  if (tags.military) return 'military';
  return null;
}

export function classifyArea(tags: Tags): AreaClass | null {
  const b = tags.building;
  if (b && b !== 'no') {
    if (tags.location === 'underground') return null;
    const poi = poiClass(tags);
    return { kind: 'building', cls: poi ?? BUILDING[b] ?? 'other' };
  }
  if (tags['building:part']) return null;
  if (tags.natural === 'water' || tags.waterway === 'riverbank' || tags.landuse === 'reservoir' || tags.landuse === 'basin') {
    return { kind: 'water', cls: tags.water ?? 'water' };
  }
  if (tags.natural === 'coastline') return null;
  if (tags.leisure && LEISURE[tags.leisure]) return { kind: 'surface', cls: LEISURE[tags.leisure] };
  if (tags.amenity && AMENITY_AREA[tags.amenity]) return { kind: 'surface', cls: AMENITY_AREA[tags.amenity] };
  if (tags.landuse && LANDUSE[tags.landuse]) return { kind: 'surface', cls: LANDUSE[tags.landuse] };
  if (tags.natural && NATURAL[tags.natural]) return { kind: 'surface', cls: NATURAL[tags.natural] };
  if (tags.aeroway === 'apron' || tags.aeroway === 'runway' || tags.aeroway === 'taxiway') return { kind: 'surface', cls: 'parking' };
  return null;
}

const ROAD_WIDTH: Record<string, number> = {
  motorway: 24, trunk: 16, primary: 11, secondary: 9, tertiary: 7.5, minor: 6, residential: 6,
  service: 4, track: 3, pedestrian: 6, cycleway: 2.6, footway: 2, path: 1.6, link: 7,
};

const HIGHWAY: Record<string, string> = {
  motorway: 'motorway', trunk: 'trunk', primary: 'primary', secondary: 'secondary', tertiary: 'tertiary',
  motorway_link: 'link', trunk_link: 'link', primary_link: 'link', secondary_link: 'link', tertiary_link: 'link',
  unclassified: 'minor', road: 'minor', residential: 'residential', living_street: 'residential',
  service: 'service', track: 'track', pedestrian: 'pedestrian', footway: 'footway', steps: 'footway',
  cycleway: 'cycleway', path: 'path', bridleway: 'path',
};

const RAIL: Record<string, [string, number]> = {
  rail: ['rail', 4], light_rail: ['tram', 3], tram: ['tram', 2.6], narrow_gauge: ['rail', 3], subway: ['rail', 4],
};

const WATERWAY: Record<string, [string, number]> = {
  river: ['river', 18], canal: ['canal', 12], stream: ['stream', 2.5], ditch: ['ditch', 1.6], drain: ['ditch', 1.6],
};

function parseWidth(tags: Tags): number | null {
  const w = parseFloat(tags.width ?? '');
  if (isFinite(w) && w > 0.5 && w < 200) return w;
  const lanes = parseInt(tags.lanes ?? '', 10);
  if (isFinite(lanes) && lanes > 0 && lanes < 12) return lanes * 3.3;
  return null;
}

export function classifyLine(tags: Tags): LineClass | null {
  if (tags.tunnel === 'yes' || tags.tunnel === 'culvert' || tags.location === 'underground') return null;
  const hw = tags.highway;
  if (hw && HIGHWAY[hw] && tags.area !== 'yes') {
    const cls = HIGHWAY[hw];
    const w = cls === 'motorway' || cls === 'trunk' ? null : parseWidth(tags);
    return { kind: 'road', cls, width: w ?? ROAD_WIDTH[cls] };
  }
  const rw = tags.railway;
  if (rw && RAIL[rw]) {
    if (rw === 'subway' && tags.tunnel !== 'no' && !tags.bridge) return null;
    return { kind: 'rail', cls: RAIL[rw][0], width: RAIL[rw][1] };
  }
  const ww = tags.waterway;
  if (ww && WATERWAY[ww]) {
    return { kind: 'waterway', cls: WATERWAY[ww][0], width: parseWidth(tags) ?? WATERWAY[ww][1] };
  }
  return null;
}

/** True when a closed way should be treated as an area rather than a line. */
export function isAreaWay(tags: Tags, closed: boolean): boolean {
  if (!closed) return false;
  if (tags.area === 'no') return false;
  if (tags.highway || tags.railway || tags.barrier) return tags.area === 'yes' && !tags.highway;
  if (tags.waterway && tags.waterway !== 'riverbank') return false;
  return classifyArea(tags) !== null;
}
