// The shared arcade palette (docs/ART_STYLE.md section 0). Re-exported from
// materials.ts; kept in its own module so anything can import it at load time.

type RGB = [number, number, number];

/**
 * The shared arcade palette (docs/ART_STYLE.md section 0): bright, saturated,
 * flat colours with a light / base / dark tone per surface. Every engineer
 * draws from these names so the world reads as one game.
 */
export const PALETTE = {
  /** dark outline on everything that stands up; never pure black */
  outline: '#1b1a2e',
  /** drop shadows: the outline colour laid over the ground at SHADOW_ALPHA */
  shadow: '#1b1a2e',

  // grass and fields
  grassLight: '#86d65a', grass: '#5dba45', grassDark: '#459f3c', grassDeep: '#2f7d36',
  meadow: '#69bf47', crop: '#4caa3c', wheat: '#efc95a', wheatDark: '#d4a83f',
  soil: '#a8714a', soilDark: '#87573a', bed: '#8a5638',
  forest: '#357f3b', forestDark: '#28663a', litter: '#9a7444', scrub: '#74b049', scrubDark: '#4f8f3c',
  wetland: '#5faa76', pool: '#4fb4dc',
  flowerYellow: '#ffd84a', flowerRed: '#ff5f6d', flowerWhite: '#ffffff', flowerPurple: '#b98cff',

  // water
  water: '#3aa2de', waterDeep: '#2d88cc', waterLight: '#9be0f8', foam: '#e8f9ff', sea: '#2f8fd2',
  flood: '#5aa8a0', quay: '#ddd7c6', quayDark: '#9e9686',

  // streets
  asphalt: '#5e6679', asphaltLight: '#6d778c', asphaltDark: '#4c5366', crack: '#363b4d', motorway: '#565e72',
  bridge: '#7f8494', marking: '#f6f3ea', markingYellow: '#f5c542',
  brick: '#cf6a43', brickLight: '#de7d52', brickDark: '#ad5236', bay: '#a8584c', bayDark: '#8e4a40',
  sidewalk: '#d9d4c8', sidewalkJoint: '#bdb7aa', curb: '#f3f0e8',
  path: '#e0cfa6', cycle: '#d24f40', track: '#c39463', pavers: '#cdc5b6', parking: '#a5abb8', slabs: '#b8b5ab',
  yard: '#c6a679', construction: '#d6a465', urban: '#c3bcae',

  // sand, rail, debris
  sand: '#f3d98f', sandLight: '#fbeab8', beach: '#f7e3a3',
  ballast: '#9b968f', ballastDark: '#77736f', sleeper: '#8a6240', steel: '#d0d6de', rust: '#b06a3c',
  rubble: '#9a8f84', rubbleDark: '#6a625c', sandbag: '#c9ab6e',

  // roofs (base colours; buildingArt.ts shades them)
  roofRed: '#c4473b', roofBrown: '#a65c3b', roofGray: '#7a8294', roofFlat: '#8e8b88', roofMetal: '#a7b2bd',
  roofSlate: '#4f6079', roofTeal: '#3f8f8c', glass: '#9fd6e6', roofBurnt: '#2e2a2c', roofDark: '#474a5c',
  wall: '#2a2638',

  // gameplay feedback
  pickup: '#ffd84a', danger: '#ff4a4a', zombie: '#8fd14f', zombieDark: '#5f9a35', blood: '#c0242c',
  bloodDark: '#7d1420', hitFlash: '#ffffff',
} as const;

/** Opacity of drop shadows (PALETTE.shadow laid over the ground). */
export const SHADOW_ALPHA = 0.4;

/** A palette colour as [r, g, b]. */
export const rgbOf = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];


